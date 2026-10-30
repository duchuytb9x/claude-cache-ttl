import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Compacted, Sample, Ttl } from '../types'
import {
  DEFAULT_WARN_MS,
  TTL_MS,
  accountOf,
  asTtl,
  bar,
  byTurn,
  clockText,
  decideTtl,
  fit,
  fmtClock,
  fmtTokens,
  hitRatio,
  isCachingDisabled,
  lifeColor,
  lifeRatio,
  marquee,
  missReason,
  nextToastMark,
  observeTtl,
  parseTranscript,
  promptTokens,
  rowRatio,
  segments,
  ttlFromUsage,
} from './cache.ts'
import type { Account, CacheEnv } from './cache.ts'

// Lệnh /cache-ttl và pane bảng theo lượt nó mở
const COMMAND = 'cache-ttl'
const PANE = 'cache-ttl'
// Số request giữ lại cho bảng theo lượt
const KEEP = 200
// $.fs.read từ chối file > 4 MiB; transcript lớn hơn thì đọc đuôi bằng tail (nếu máy có)
const FS_READ_MAX = 4 * 1024 * 1024
const TAIL_BYTES = '4000000'
// Claude Code cắt tên thư mục project (slug của cwd) ở độ dài này
const PROJECT_SLUG_MAX = 200
// Dải phía trên ô prompt hẹp hơn chừng này cột thì thanh ngắn lại
const NARROW_COLUMNS = 90
// Chữ chạy ở cuối dải: mỗi bước một ký tự, đứng yên vài bước ở đầu vòng để kịp đọc; luôn chừa ít nhất chừng này cột
const MARQUEE_MS = 350
const MARQUEE_PAUSE = 8
const TAIL_MIN_COLUMNS = 10

// Thời điểm gửi request gần nhất của main thread (hoặc đọc từ transcript khi resume); null khi chưa có
const lastAt = atom({ plugin: 'promptCacheTtl', key: 'lastAt' } as const, null)
// TTL của lần cache write gần nhất, đọc từ usage/transcript (chính xác); null khi chưa thấy
const detectedTtl = atom({ plugin: 'promptCacheTtl', key: 'ttl' } as const, null)
// TTL suy từ nhịp request, dùng khi không đọc được transcript
const observedTtl = atom({ plugin: 'promptCacheTtl', key: 'observed' } as const, null)
// Các request main thread gần nhất, cũ trước
const samplesAtom = atom({ plugin: 'promptCacheTtl', key: 'samples' } as const, [])
// Lý do cache miss của request gần nhất; null khi request đó đọc được cache
const lastMiss = atom({ plugin: 'promptCacheTtl', key: 'miss' } as const, null)
// Lần compact gần nhất của main thread
const compactedAtom = atom({ plugin: 'promptCacheTtl', key: 'compacted' } as const, null)

// Tuỳ chọn của plugin (userConfig), đọc lúc register
type Options = {
  ttl: string
  warnSeconds: number
  compactAtTokens: number
  toastMinTokens: number
  band: boolean
  footer: boolean
  toast: boolean
}
let opts: Options = { ttl: 'auto', warnSeconds: 0, compactAtTokens: 100_000, toastMinTokens: 20_000, band: true, footer: true, toast: true }
// TTL chọn bằng /cache-ttl 5m|1h, dùng chung mọi session; null là tự động
let override: Ttl | null = null
let env: CacheEnv = {}
let setting: unknown
let account: Account = 'other'
// Toast đếm ngược: mốc cache đang theo dõi và mốc giây đã bắn gần nhất
let toastedFor = 0
let toastLevel = Infinity
// Text đang hiện (chỉ vẽ lại khi đổi); surface đã vẽ footer chưa; pane /cache-ttl có đang mở
let shownText: string | undefined
let footerSeen = false
let isPaneOpen = false
let timer: { cancel: () => void } | undefined
// Dải vừa vẽ có chữ chạy không; có thì vẽ lại theo nhịp MARQUEE_MS
let isScrolling = false
let scrollTimer: { cancel: () => void } | undefined

function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

function warnMs(ttl: Ttl) {
  return opts.warnSeconds > 0 ? opts.warnSeconds * 1000 : DEFAULT_WARN_MS[ttl]
}

// TTL đang dùng và nguồn của nó: /cache-ttl hoặc tuỳ chọn ttl, rồi transcript, rồi nhịp request, rồi môi trường/tài khoản
async function ttlInfo($: EngineInterface): Promise<{ ttl: Ttl; source: string }> {
  if (override) return { ttl: override, source: 'đặt bằng /cache-ttl' }
  const pinned = asTtl(opts.ttl)
  if (pinned) return { ttl: pinned, source: 'tuỳ chọn ttl' }
  const detected = await read($, detectedTtl)
  if (detected) return { ttl: detected, source: 'transcript (cache_creation)' }
  const observed = await read($, observedTtl)
  if (observed) return { ttl: observed, source: 'suy từ nhịp request' }
  return decideTtl(env, setting, account)
}

type Kind = 'cold' | 'off' | 'compacted' | 'uncached' | 'expired' | 'soon' | 'miss' | 'warm'
type Snapshot = {
  kind: Kind
  ttl: Ttl
  source: string
  left: number
  last: number | null
  sample: Sample | undefined
  samples: Sample[]
  miss: string | null
  compacted: Compacted | null
  advice: string
}

// Trạng thái cache lúc này, dùng chung cho status, footer, dải, pane và toast
async function snapshot($: EngineInterface): Promise<Snapshot> {
  const { ttl, source } = await ttlInfo($)
  const last = await read($, lastAt)
  const samples = await read($, samplesAtom)
  const sample = samples[samples.length - 1]
  const miss = await read($, lastMiss)
  const compacted = await read($, compactedAtom)
  const now = await $.clock.now()
  const left = last === null ? 0 : last + TTL_MS[ttl] - now
  const base = { ttl, source, left, last, sample, samples, miss, compacted }
  const size = sample ? promptTokens(sample) : 0
  if (isCachingDisabled(sample?.model ?? '', env)) {
    return { ...base, kind: 'off', advice: 'prompt caching is off for this model (DISABLE_PROMPT_CACHING*)' }
  }
  if (last === null) return { ...base, kind: 'cold', advice: 'no request yet: the first one writes the cache' }
  if (compacted && compacted.at > last) {
    const sizes = compacted.before && compacted.after ? ` (${fmtTokens(compacted.before)} → summary ${fmtTokens(compacted.after)})` : ''
    const how = compacted.trigger === 'idle' ? 'compacted while idle' : 'compacted'
    return { ...base, left: 0, kind: 'compacted', advice: `${how}${sizes}: the next message starts from the summary` }
  }
  // Request đầu tiên sau compact: hit thấp vì bản tóm tắt phải ghi mới, không phải miss
  const afterCompact =
    compacted?.prompt && compacted.before && sample && sample.sentAt >= compacted.at && samples.filter(x => x.sentAt >= compacted.at).length === 1
      ? `compacted ${fmtTokens(compacted.before)} → ${fmtTokens(compacted.prompt)}, `
      : ''
  if (sample && sample.read + sample.write === 0) {
    return { ...base, kind: 'uncached', advice: 'this request was not cached (prompt under the model minimum, or caching off)' }
  }
  if (left <= 0) {
    const advice = !sample
      ? 'expired: the next message writes the cache again'
      : size >= opts.compactAtTokens
        ? `expired: the next message rewrites ${fmtTokens(size)} tokens. /compact first, or /clear if the task is done`
        : `expired: only ${fmtTokens(size)} tokens to rebuild, just keep going`
    return { ...base, kind: 'expired', advice }
  }
  if (left <= warnMs(ttl)) return { ...base, kind: 'soon', advice: 'expires soon: any message refreshes it for free' }
  if (miss) return { ...base, kind: 'miss', advice: `cache missed: ${miss}` }
  return { ...base, kind: 'warm', advice: `warm: ${afterCompact}keep going` }
}

// Có đồng hồ đếm ngược không (đang có mốc cache sống hoặc vừa hết hạn)
const counting = (s: Snapshot) => s.kind !== 'cold' && s.kind !== 'off' && s.kind !== 'compacted' && s.kind !== 'uncached'

// Màu chữ wrote: cam đậm cố định, đọc rõ trên cả nền sáng lẫn tối (key "warning" trên desktop ra gần như xám)
const WROTE_COLOR = '#D97706'

const KIND_COLOR: Record<Kind, string | undefined> = {
  cold: undefined,
  off: undefined,
  compacted: undefined,
  uncached: undefined,
  expired: 'red',
  soon: 'yellow',
  miss: 'red',
  warm: 'green',
}
const KIND_GLYPH: Record<Kind, string> = {
  cold: '○',
  off: '○',
  compacted: '○',
  uncached: '○',
  expired: '✖',
  soon: '▲',
  miss: '✖',
  warm: '●',
}

// Status line dạng text (surface không vẽ footer như VS Code, claude -p)
function statusLine(s: Snapshot): string {
  if (s.kind === 'cold') return '🕒 chưa có request'
  if (s.kind === 'off') return '🕒 caching đang tắt (DISABLE_PROMPT_CACHING)'
  if (s.kind === 'compacted') return `🕒 đã compact${s.compacted?.before && s.compacted.after ? ` (${fmtTokens(s.compacted.before)} → tóm tắt ${fmtTokens(s.compacted.after)})` : ''}`
  const head = s.left > 0 ? `🕒 ${clockText(s.left)} · ${s.ttl}` : '🕒 cache hết hạn'
  if (!s.sample) return head
  if (s.kind === 'uncached') return `${head} · không cache (n${fmtTokens(s.sample.fresh)})`
  const tokens = ` · ${Math.round(hitRatio(s.sample) * 100)}% · r${fmtTokens(s.sample.read)} w${fmtTokens(s.sample.write)} n${fmtTokens(s.sample.fresh)}`
  return s.miss ? `${head}${tokens} · ✖ miss: ${s.miss}` : `${head}${tokens}`
}

function show($: EngineInterface, text: string) {
  if (text === shownText) return
  shownText = text
  $.ui.invalidate('ui.render')
  if (!footerSeen) $.ui.status(text)
}

// Mỗi giây: vẽ lại khi text đổi; toast ở ngưỡng cảnh báo rồi 10, 3, 2, 1 giây cuối, chỉ với prompt đủ lớn
async function tick($: EngineInterface) {
  // Timer chữ chạy chỉ sống khi dải đang có chữ chạy
  if (isScrolling && !scrollTimer) {
    scrollTimer = $.clock.every(MARQUEE_MS, () => {
      $.ui.invalidate('ui.render')
    })
  } else if (!isScrolling && scrollTimer) {
    scrollTimer.cancel()
    scrollTimer = undefined
  }
  const s = await snapshot($)
  show($, statusLine(s))
  if (!opts.toast || !counting(s) || s.left <= 0 || !s.sample || s.last === null) return
  if (promptTokens(s.sample) < opts.toastMinTokens) return
  if (toastedFor !== s.last) {
    toastedFor = s.last
    toastLevel = Infinity
  }
  const secs = Math.ceil(s.left / 1000)
  const mark = nextToastMark(secs, warnMs(s.ttl) / 1000, toastLevel)
  if (mark === undefined) return
  toastLevel = mark
  const when = secs >= 60 ? clockText(s.left) : `${secs} giây`
  const tail = secs <= 10 ? 'gửi tin ngay để giữ cache' : `gửi tin để giữ ${fmtTokens(promptTokens(s.sample))} token còn ấm`
  $.ui.toast(`Prompt cache còn ${when}: ${tail}`)
}

async function readTranscript($: EngineInterface, path: string): Promise<string | null> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat) return null
  if (stat.size <= FS_READ_MAX) return (await $.fs.read(path)) as string
  try {
    const out = await $.process.run(['tail', '-c', TAIL_BYTES, path])
    return out.exitCode === 0 ? out.stdout : null
  } catch {
    // Máy không có tail (Windows thuần): TTL lấy từ nhịp request / môi trường
    return null
  }
}

async function learnFromTranscript($: EngineInterface, path: string | undefined) {
  if (!path) return
  const text = await readTranscript($, path).catch(() => null)
  if (!text) return
  const found = parseTranscript(text)
  if (!found) return
  if (found.ttl) await update($, detectedTtl, () => found.ttl)
  await update($, lastAt, prev => Math.max(prev ?? 0, found.sentAt))
}

async function homeDir($: EngineInterface): Promise<string | undefined> {
  return ((await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined))) || undefined
}

// Transcript của session hiện tại: <config>/projects/<slug của cwd>/<session id>.jsonl
async function transcriptPath($: EngineInterface): Promise<string | undefined> {
  const home = await homeDir($)
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : undefined)
  if (!configDir) return undefined
  const projects = `${configDir}/projects/`
  const file = `/${await $.session.id()}.jsonl`
  const slug = (await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= PROJECT_SLUG_MAX) {
    return (await $.fs.exists(projects + slug + file)) ? projects + slug + file : undefined
  }
  // Slug dài bị cắt và thêm hash: tìm thư mục chứa session
  const prefix = slug.slice(0, PROJECT_SLUG_MAX) + '-'
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind === 'dir' && entry.name.startsWith(prefix) && (await $.fs.exists(projects + entry.name + file))) {
      return projects + entry.name + file
    }
  }
  return undefined
}

// Setting promptCacheTtl từ file settings đầu tiên có đặt (local, project, rồi user)
async function readTtlSetting($: EngineInterface): Promise<unknown> {
  const home = await homeDir($)
  const cwd = await $.session.cwd().catch(() => undefined)
  const files = [cwd && `${cwd}/.claude/settings.local.json`, cwd && `${cwd}/.claude/settings.json`, home && `${home}/.claude/settings.json`]
  for (const file of files) {
    if (!file) continue
    try {
      const json = JSON.parse((await $.fs.read(file)) as string)
      if (asTtl(json.promptCacheTtl)) return json.promptCacheTtl
    } catch {
      // Không có hoặc không đọc được: file kế tiếp
    }
  }
  return undefined
}

async function readEnv($: EngineInterface): Promise<CacheEnv> {
  // $.env.get phải nhận tên biến literal để engine liệt kê được biến plugin đọc
  const none = () => undefined
  return {
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
    ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
    disableAll: await $.env.get('DISABLE_PROMPT_CACHING').catch(none),
    disableHaiku: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU').catch(none),
    disableSonnet: await $.env.get('DISABLE_PROMPT_CACHING_SONNET').catch(none),
    disableOpus: await $.env.get('DISABLE_PROMPT_CACHING_OPUS').catch(none),
  }
}

async function refreshAccount($: EngineInterface) {
  account = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
}

// /clear mở hội thoại mới trong cùng process: cache của nó là cache mới
async function resetConversation($: EngineInterface) {
  await update($, lastAt, () => null)
  await update($, samplesAtom, () => [])
  await update($, lastMiss, () => null)
  await update($, compactedAtom, () => null)
  await update($, observedTtl, () => null)
  toastedFor = 0
  toastLevel = Infinity
  await tick($)
}

// Trả lời cho /cache-ttl: TTL, nguồn và trạng thái hiện tại
async function statusReply($: EngineInterface): Promise<string> {
  const s = await snapshot($)
  return `TTL ${s.ttl} (${s.source}) · ${s.advice} · /${COMMAND} 5m|1h|auto đổi TTL, /${COMMAND} stop đóng bảng`
}

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

// Một đoạn chữ có màu/kiểu
type Span = { text: string; color?: string; bold?: boolean; dimColor?: boolean }
const spansWidth = (spans: Span[]) => spans.reduce((n, sp) => n + [...sp.text].length, 0)

// Footer dưới ô prompt. compact: bản gọn cho ô footer hẹp của desktop (~20 ký tự), đồng hồ đứng đầu
function footerSpans(s: Snapshot, compact: boolean): Span[] {
  if (s.kind === 'cold') return [{ text: '🕒 chưa có request', dimColor: true }]
  if (s.kind === 'off') return [{ text: '○ caching tắt', dimColor: true }]
  if (s.kind === 'compacted') return [{ text: '○ đã compact', dimColor: true }]
  const clockColor = s.left <= 0 ? 'red' : s.left <= warnMs(s.ttl) ? 'yellow' : 'green'
  const level = s.miss ? 'red' : clockColor
  const sample = s.sample
  if (!sample) return [{ text: s.left > 0 ? `⏱ ${clockText(s.left)}` : '⏱ hết hạn', color: clockColor, bold: true }, { text: ` ${s.ttl}`, dimColor: true }]
  const cached = s.kind !== 'uncached'
  const ratio = hitRatio(sample)
  if (compact) {
    const head: Span[] = [
      { text: `${KIND_GLYPH[s.kind]} `, color: level, bold: true },
      { text: s.left > 0 ? clockText(s.left) : 'hết hạn', color: clockColor, bold: true },
      { text: cached ? ` ${Math.round(ratio * 100)}%` : ' không cache', bold: cached, dimColor: !cached },
    ]
    return [
      ...head,
      { text: ` r${fmtTokens(sample.read)}`, color: 'green' },
      { text: ` w${fmtTokens(sample.write)}`, color: WROTE_COLOR },
      { text: ` n${fmtTokens(sample.fresh)}`, color: 'cyan' },
      ...(s.miss ? [{ text: ' ✖ miss', color: 'red', bold: true }] : []),
    ]
  }
  const spans: Span[] = [
    { text: `${KIND_GLYPH[s.kind]} `, color: level, bold: true },
    { text: 'cache ', color: 'cyan', bold: true },
  ]
  if (cached) spans.push({ text: `${bar(ratio, 6)} `, color: level }, { text: `${Math.round(ratio * 100)}% `, bold: true })
  else spans.push({ text: 'không cache ', dimColor: true })
  spans.push(
    { text: s.left > 0 ? `⏱ ${clockText(s.left)}` : '⏱ hết hạn', color: clockColor, bold: true },
    { text: ` read ${fmtTokens(sample.read)}`, color: 'green' },
    { text: ` wrote ${fmtTokens(sample.write)}`, color: WROTE_COLOR },
    { text: ` new ${fmtTokens(sample.fresh)}`, color: 'cyan' },
    { text: ` ${s.ttl}`, dimColor: true },
  )
  if (s.miss) spans.push({ text: ` ✖ miss: ${s.miss}`, color: 'red' })
  return spans
}

async function drawFooter($: EngineInterface, e: RenderEvent, compact: boolean) {
  const { Box, Text } = $.ui.resolve(e)
  const spans = footerSpans(await snapshot($), compact)
  // ⏱ và 🕒 rộng 2 ô
  const width = spansWidth(spans) + 1
  return (
    <Box flexShrink={0} minWidth={width} width={width}>
      <Text wrap="truncate-end">
        {spans.map(sp => (
          <Text color={sp.color} bold={sp.bold} dimColor={sp.dimColor}>{sp.text}</Text>
        ))}
      </Text>
    </Box>
  )
}

// Dải phía trên ô prompt, bố cục theo prompt-cache-control (MIT):
// ● cache ██████████ 100% read 384k wrote 722 new 2 ⏱ 59:38 1h · warm: keep going
// read/wrote/new và đồng hồ nằm trong Box không co để luôn cùng một hàng và luôn hiện; hẹp dưới 90 cột thì thanh còn 6 ô, phần sau đồng hồ dài quá thì thành chữ chạy
async function drawBand($: EngineInterface, e: RenderEvent, columns: number) {
  const { Box, Text } = $.ui.resolve(e)
  const s = await snapshot($)
  if (s.kind === 'cold') return null
  if (!s.sample || s.kind === 'off' || s.kind === 'compacted') {
    return <Text dimColor wrap="truncate-end">{`cache: ${s.advice}`}</Text>
  }
  const sample = s.sample
  const wide = columns >= NARROW_COLUMNS
  const color = KIND_COLOR[s.kind]
  const ratio = hitRatio(sample)
  const barText = bar(ratio, wide ? 10 : 6)
  const percent = `${Math.round(ratio * 100)}%`
  const clock = !counting(s) ? null : s.left > 0 ? `⏱ ${fmtClock(s.left)}` : '⏱ 0:00'
  const tail = `${s.ttl} · ${s.advice}`
  const tokens = `read ${fmtTokens(sample.read)} wrote ${fmtTokens(sample.write)} new ${fmtTokens(sample.fresh)}`
  // Cột còn lại sau đồng hồ: mỗi phần cộng một cột gap, ⏱ rộng 2 ô
  const used = [KIND_GLYPH[s.kind], 'cache', barText, percent, tokens, ...(clock ? [`${clock} `] : [])].reduce((n, t) => n + [...t].length + 1, 0)
  const room = Math.max(TAIL_MIN_COLUMNS, columns - used)
  isScrolling = [...tail].length > room
  const shown = marquee(tail, room, Math.floor((await $.clock.now()) / MARQUEE_MS), MARQUEE_PAUSE)
  return (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      <Text bold color={color}>{KIND_GLYPH[s.kind]}</Text>
      <Text bold color="cyan">cache</Text>
      <Text color={color}>{barText}</Text>
      <Text bold>{percent}</Text>
      <Box flexShrink={0}>
        <Text wrap="truncate-end">
          <Text color="green">{`read ${fmtTokens(sample.read)}`}</Text>
          <Text>{' '}</Text>
          <Text color={WROTE_COLOR}>{`wrote ${fmtTokens(sample.write)}`}</Text>
          <Text>{' '}</Text>
          <Text color="cyan">{`new ${fmtTokens(sample.fresh)}`}</Text>
        </Text>
      </Box>
      {clock ? (
        <Box flexShrink={0}>
          <Text bold color={lifeColor(s.left, s.ttl, warnMs(s.ttl))}>{clock}</Text>
        </Box>
      ) : null}
      <Text dimColor wrap="truncate-end">{shown}</Text>
    </Box>
  )
}

// Pane /cache-ttl: đồng hồ, thanh thời gian còn lại, thanh read/wrote/new của request cuối, bảng theo lượt
async function drawPane($: EngineInterface, e: RenderEvent, bodyColumns: number, rowsAvailable: number) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const s = await snapshot($)
  const width = Math.max(30, bodyColumns - 1)
  // HTML gộp khoảng trắng liên tiếp và cắt hai đầu text; no-break space giữ chúng
  const sp = (t: string) => (e.surface === 'terminal' ? t : t.replace(/ /g, ' '))
  const isCounting = counting(s)
  const clockColor = isCounting ? lifeColor(s.left, s.ttl, warnMs(s.ttl)) : undefined
  const stateColor = s.kind === 'expired' || s.kind === 'miss' ? 'red' : (clockColor ?? KIND_COLOR[s.kind])
  const hitColor = (pct: number) => (pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red')
  // Thanh đặc là các Box tô nền, không dùng ký tự khối, để HTML không có khe giữa các ô
  const solid = (key: string, parts: [number, string | undefined][]) => (
    <Box key={key} flexDirection="row" height={1} flexShrink={0}>
      {parts.map(([w, c], i) => (w > 0 ? <Box key={`${key}:${i}`} width={w} height={1} flexShrink={0} backgroundColor={c} /> : null))}
    </Box>
  )
  const cell = (key: string, w: number, text: string, c?: string, bold = false) => (
    <Box key={key} width={w} flexShrink={0} justifyContent="flex-end">
      <Text color={c} bold={bold} dimColor={!c}>{sp(text)}</Text>
    </Box>
  )
  const barW = Math.min(width, 40)
  const life = lifeRatio(s.left, s.ttl)
  const lifeFilled = Math.round(life * barW)
  const last = s.sample
  const [sr, sw, sn] = last ? segments(last.read, last.write, last.fresh, barW) : [0, 0, 0]
  const all = byTurn(s.samples)
  const rows = all.slice(-Math.max(3, rowsAvailable - 14))
  return (
    <Box flexDirection="column">
      <Box key="title" flexDirection="row" columnGap={1}>
        <Text bold color="cyan">{sp('⚡ PROMPT CACHE')}</Text>
        <Text dimColor>{sp(`· TTL ${s.ttl} (${s.source})`)}</Text>
      </Box>

      <Box key="clock" flexDirection="column" marginTop={1}>
        <Text bold color={clockColor}>{sp(isCounting ? `⏱ ${s.left > 0 ? fmtClock(s.left) : '0:00'}` : '⏱ --:--')}</Text>
        {isCounting ? (
          <Box flexDirection="row" columnGap={1}>
            {solid('life', [[lifeFilled, clockColor], [barW - lifeFilled, 'gray']])}
            <Text dimColor>{sp(`${Math.round(life * 100)}%`)}</Text>
          </Box>
        ) : null}
      </Box>

      <Box key="advice" marginTop={1} flexDirection="column">
        <Text bold color={stateColor}>{sp(`${KIND_GLYPH[s.kind]} ${s.advice}`)}</Text>
        {last ? <Text dimColor>{sp(fit(`${last.model} · prompt ${fmtTokens(promptTokens(last))} tokens`, width))}</Text> : null}
      </Box>

      {last ? (
        <Box key="stack" flexDirection="column" marginTop={1}>
          <Box flexDirection="row" columnGap={1}>
            {solid('stack', [[sr, 'green'], [sw, WROTE_COLOR], [sn, 'cyan']])}
            <Text bold color={hitColor(Math.round(hitRatio(last) * 100))}>{sp(`${Math.round(hitRatio(last) * 100)}% hit`)}</Text>
          </Box>
          <Box flexDirection="row" columnGap={2}>
            <Text color="green">{sp(`■ read ${fmtTokens(last.read)}`)}</Text>
            <Text color={WROTE_COLOR}>{sp(`■ wrote ${fmtTokens(last.write)}`)}</Text>
            <Text color="cyan">{sp(`■ new ${fmtTokens(last.fresh)}`)}</Text>
          </Box>
        </Box>
      ) : null}

      <Box key="table" flexDirection="column" marginTop={1}>
        <Box key="head" flexDirection="row" columnGap={1}>
          {cell('h:turn', 4, 'turn', 'cyan', true)}
          {cell('h:steps', 5, 'steps', 'cyan', true)}
          {cell('h:read', 6, 'read', 'green', true)}
          {cell('h:wrote', 6, 'wrote', WROTE_COLOR, true)}
          {cell('h:new', 5, 'new', 'cyan', true)}
          {cell('h:hit', 4, 'hit', 'magenta', true)}
        </Box>
        {rows.length === 0 ? <Text dimColor>{sp('chưa có request')}</Text> : null}
        {rows.map((row, i) => {
          const n = all.length - rows.length + i + 1
          const pct = Math.round(rowRatio(row) * 100)
          return (
            <Box key={`t:${row.turnId}:${n}`} flexDirection="row" columnGap={1}>
              {cell(`c:turn:${n}`, 4, String(n))}
              {cell(`c:steps:${n}`, 5, String(row.steps))}
              {cell(`c:read:${n}`, 6, fmtTokens(row.read), 'green')}
              {cell(`c:wrote:${n}`, 6, fmtTokens(row.write), WROTE_COLOR)}
              {cell(`c:new:${n}`, 5, fmtTokens(row.fresh), 'cyan')}
              {cell(`c:hit:${n}`, 4, `${pct}%`, hitColor(pct), true)}
            </Box>
          )
        })}
      </Box>

      <Box key="foot" marginTop={1} flexDirection="column">
        <Button key="close" label="đóng" onPress={() => {}} />
        <Box key="legend" marginTop={1} flexDirection="column">
          <Text color="green">{sp('■ read: cache phục vụ')}</Text>
          <Text color={WROTE_COLOR}>{sp('■ wrote: ghi mới vào cache')}</Text>
          <Text color="cyan">{sp('■ new: gửi không qua cache')}</Text>
        </Box>
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  opts = {
    ttl: typeof options.ttl === 'string' ? options.ttl : 'auto',
    warnSeconds: positive(options.warnSeconds, 0),
    compactAtTokens: positive(options.compactAtTokens, 100_000),
    toastMinTokens: positive(options.toastMinTokens, 20_000),
    band: options.band !== false,
    footer: options.footer !== false,
    toast: options.toast !== false,
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    env = await readEnv($)
    setting = await readTtlSetting($)
    await refreshAccount($)
    const saved = await $.store.get('override').catch(() => undefined)
    override = asTtl(saved) ?? null
    // Sau reload/resume: lấy lại mốc và TTL từ transcript
    try {
      await learnFromTranscript($, await transcriptPath($))
    } catch {
      // Chưa có transcript: request đầu tiên sẽ bắt đầu đếm
    }
    await $.command
      .register({
        name: COMMAND,
        description: 'Prompt cache: bảng theo lượt và thời gian còn lại; /cache-ttl 5m|1h|auto đổi TTL, stop đóng bảng',
        argumentHint: '[5m|1h|auto|stop]',
        immediate: true,
      })
      .catch(() => undefined)
    await tick($)
    timer?.cancel()
    timer = $.clock.every(1_000, () => tick($))
    isScrolling = false
    scrollTimer?.cancel()
    scrollTimer = undefined
    return result
  })

  // /clear: hội thoại mới, cache mới
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetConversation($)
    return next(e)
  })

  // Compact main thread thay thế những gì cache đang giữ; trigger "idle" là Claude Code tự compact khi để yên
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    const trigger = String(e.trigger)
    if (e.agentId || trigger === 'precompute' || 'skip' in r) return r
    const compacted: Compacted = { at: await $.clock.now(), trigger, before: r.tokensBefore, after: r.tokensAfter }
    await update($, compactedAtom, () => compacted)
    if (opts.toast) {
      const sizes = r.tokensBefore && r.tokensAfter ? ` ${fmtTokens(r.tokensBefore)} token, bản tóm tắt ${fmtTokens(r.tokensAfter)}` : ''
      const how = trigger === 'idle' ? 'Claude Code tự compact khi để yên' : 'Đã compact'
      $.ui.toast(`${how}${sizes}: tin tiếp theo bắt đầu từ bản tóm tắt`)
    }
    await tick($)
    return r
  })

  // Footer dưới ô prompt (cạnh model/effort), giữ nguyên nhãn mode của Claude Code phía trước
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!opts.footer) return next(e)
    if (!footerSeen) {
      footerSeen = true
      $.ui.status(undefined)
    }
    // Desktop đã có dòng đầy đủ ở dải phía trên ô prompt: footer để nguyên của Claude Code
    if (e.surface === 'desktop' && opts.band) return next(e)
    // Desktop tắt dải thì ô footer (khoá ~20 ký tự) hiện bản gọn; terminal hiện bản đầy đủ
    const mine = await drawFooter($, e, e.surface === 'desktop')
    if (e.props.modes.length === 0) return mine
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return (
      <Box flexDirection="row" alignItems="center">
        {theirs}
        <Text dimColor>{' · '}</Text>
        {mine}
      </Box>
    )
  })

  // Dải phía trên ô prompt trên desktop (terminal đã có bản đầy đủ ở footer).
  // Dải chỉ có một: giữ phần các plugin khác vẽ (next) bên dưới dòng của mình; nhường khi có survey hoặc pane đang mở
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    isScrolling = false
    if (!opts.band || e.surface !== 'desktop' || e.props.hasSurvey || isPaneOpen) return next(e)
    const mine = await drawBand($, e, e.props.bodyColumns)
    if (!mine) return next(e)
    const { Box } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    return drawPane($, e, e.props.bodyColumns, e.viewport?.rows ?? 24)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isPaneOpen = false
    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    if (e.plugin !== $.plugin.name || e.requestId !== PANE) return next(e)
    if (e.element === 'close') {
      isPaneOpen = false
      await $.ui.close({ id: PANE }).catch(() => undefined)
    }
    return next(e)
  })

  // /cache-ttl: mở bảng; 5m|1h đặt TTL cố định (mọi session); auto về tự động; stop đóng bảng
  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'stop') {
      isPaneOpen = false
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return { text: 'Đã đóng bảng cache' }
    }
    if (arg === '5m' || arg === '1h') {
      override = arg
      await $.store.set('override', arg)
    } else if (arg === 'auto') {
      override = null
      await $.store.delete('override')
    } else if (arg) {
      return { text: `Dùng /${COMMAND}, /${COMMAND} 5m, /${COMMAND} 1h, /${COMMAND} auto hoặc /${COMMAND} stop` }
    } else {
      isPaneOpen = true
      await $.ui.open({ id: PANE, title: 'cache', focus: true })
    }
    shownText = undefined
    await tick($)
    return { text: await statusReply($) }
  })

  // Startup, /resume, /clear, compaction: có sẵn đường dẫn transcript
  on('classic.SessionStart', async ($, e, next) => {
    await learnFromTranscript($, e.transcript_path)
    return next(e)
  })

  // Trả lời xong: transcript đã có cache write của lượt này
  on('classic.Stop', async ($, e, next) => {
    await learnFromTranscript($, e.transcript_path)
    await tick($)
    return next(e)
  })

  // Mỗi request lên model: request có usage nghĩa là đã đọc/ghi cache, TTL tính lại từ lúc gửi
  on('turn.step', async function* ($, e, next) {
    // Subagent cache prefix riêng; đồng hồ chỉ theo main thread
    if (e.agentId !== undefined) return yield* next(e)
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    if (result.usage) {
      const written = ttlFromUsage(result.usage)
      if (written) await update($, detectedTtl, () => written)
      const sample: Sample = {
        turnId: e.turnId,
        index: e.index,
        model: result.usage.model || e.model,
        sentAt,
        read: result.usage.cache_read_input_tokens,
        write: result.usage.cache_creation_input_tokens,
        fresh: result.usage.input_tokens,
      }
      const samples = await read($, samplesAtom)
      const prev = samples[samples.length - 1]
      const observed = observeTtl(prev, sample, (await read($, observedTtl)) ?? undefined) ?? null
      await update($, observedTtl, () => observed)
      // Tài khoản có thể đổi giữa session: subscription hết hạn mức chuyển sang usage credits
      await refreshAccount($)
      const miss = missReason(prev, sample, (await ttlInfo($)).ttl) ?? null
      await update($, samplesAtom, prevSamples => [...prevSamples, sample].slice(-KEEP))
      await update($, lastMiss, () => miss)
      await update($, lastAt, prevAt => Math.max(prevAt ?? 0, sentAt))
      // Request đầu tiên sau compact cho biết prompt thật sau compact (cả system prompt, tool, file đính kèm lại)
      const compacted = await read($, compactedAtom)
      if (compacted && compacted.prompt === undefined && sentAt >= compacted.at) {
        const prompt = promptTokens(sample)
        await update($, compactedAtom, c => (c ? { ...c, prompt } : c))
        if (opts.toast && compacted.before) {
          $.ui.toast(
            `Sau compact: ${fmtTokens(compacted.before)} → ${fmtTokens(prompt)} token (đọc cache ${fmtTokens(sample.read)}, ghi mới ${fmtTokens(sample.write)})`,
          )
        }
      }
      if (miss && opts.toast && sample.write >= opts.toastMinTokens) {
        $.ui.toast(`Cache miss, ghi lại ${fmtTokens(sample.write)} token: ${miss}`)
      }
      await tick($)
    }
    return result
  })
}
