// Logic thuần của promptCacheTtl, không gọi engine ($) nên test thẳng được.
// Các hàm decideTtl, accountOf, isCachingDisabled, missReason, observeTtl, nextToastMark,
// byTurn, segments, lifeColor port từ plugin prompt-cache-control (MIT, claude-code-templates).
import type { Sample, Ttl } from '../types'

export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 }
// Ngưỡng cảnh báo mặc định theo TTL khi không đặt warnSeconds
export const DEFAULT_WARN_MS: Record<Ttl, number> = { '5m': 60 * 1000, '1h': 5 * 60 * 1000 }
// Toast đếm ngược thêm ở các mốc giây này, sau mốc ngưỡng cảnh báo
export const COUNTDOWN_MARKS = [10, 3, 2, 1]
// Request bắt đầu tính từ lúc gửi: chừa chút trễ để một hit sát mốc 5 phút không bị coi là bằng chứng của 1h
const SLACK_MS = 10_000

export const asTtl = (v: unknown): Ttl | undefined => (v === '5m' || v === '1h' ? v : undefined)
export const isOn = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true'

// Biến môi trường Claude Code đọc để chọn TTL hoặc tắt caching
export type CacheEnv = {
  enable1h?: string
  force5m?: string
  ttlVar?: string
  disableAll?: string
  disableHaiku?: string
  disableSonnet?: string
  disableOpus?: string
}

// Tài khoản tính tiền theo kiểu gì, đoán từ các cửa sổ rate limit của response gần nhất
export type Account = 'subscription' | 'credits' | 'other'
export type TtlChoice = { ttl: Ttl; source: string }

// TTL Claude Code dùng cho main thread khi không đọc được từ transcript, theo thứ tự trong tài liệu:
// FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, setting promptCacheTtl, ENABLE_PROMPT_CACHING_1H,
// rồi mặc định của tài khoản: 1h với subscription còn trong hạn mức, 5m với usage credits / API key / cloud
export function decideTtl(env: CacheEnv, setting?: unknown, account?: Account): TtlChoice {
  if (isOn(env.force5m)) return { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' }
  const fromVar = asTtl(env.ttlVar)
  if (fromVar) return { ttl: fromVar, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  const fromSetting = asTtl(setting)
  if (fromSetting) return { ttl: fromSetting, source: 'setting promptCacheTtl' }
  if (isOn(env.enable1h)) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' }
  if (account === 'subscription') return { ttl: '1h', source: 'mặc định của subscription' }
  if (account === 'credits') return { ttl: '5m', source: 'mặc định khi dùng usage credits' }
  return { ttl: '1h', source: 'mặc định' }
}

// Cửa sổ five_hour / seven_day nghĩa là subscription; một cửa sổ đã 100% nghĩa là đang trừ usage credits
export function accountOf(windows: readonly { kind: string; percentUsed: number }[]): Account {
  const plan = windows.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day')
  if (plan.length === 0) return 'other'
  return plan.some(w => w.percentUsed >= 100) ? 'credits' : 'subscription'
}

// Caching bị tắt cho model này bằng DISABLE_PROMPT_CACHING*
export function isCachingDisabled(model: string, env: CacheEnv): boolean {
  if (isOn(env.disableAll)) return true
  const name = model.toLowerCase()
  if (name.includes('haiku')) return isOn(env.disableHaiku)
  if (name.includes('sonnet')) return isOn(env.disableSonnet)
  if (name.includes('opus')) return isOn(env.disableOpus)
  return false
}

export const promptTokens = (s: Sample) => s.read + s.write + s.fresh

export function hitRatio(s: Sample): number {
  const total = promptTokens(s)
  return total === 0 ? 0 : s.read / total
}

// Vì sao request lẽ ra đọc cache lại phải ghi mới; undefined khi không miss.
// Prompt co lại (/compact, /clear) không tính là miss; request đầu tiên không có gì để đọc.
export function missReason(prev: Sample | undefined, cur: Sample, ttl: Ttl): string | undefined {
  if (!prev) return undefined
  const before = promptTokens(prev)
  if (before === 0 || promptTokens(cur) < before * 0.7) return undefined
  if (cur.read >= before * 0.5 || cur.write === 0) return undefined
  if (cur.model !== prev.model) return `đổi model (${prev.model} → ${cur.model})`
  if (cur.sentAt - prev.sentAt > TTL_MS[ttl]) return `cache ${ttl} đã hết hạn`
  return 'prefix prompt thay đổi (effort, tool, system prompt hoặc CLAUDE.md)'
}

// TTL suy từ nhịp request khi transcript không cho biết:
// - hit hơn 5 phút sau request trước chứng minh TTL 1h (không bị miss về sau lật lại)
// - miss 5–60 phút sau request trước, cùng model, prompt không co: cache đã hết hạn nên là 5m (hit về sau lật lại)
export function observeTtl(prev: Sample | undefined, cur: Sample, known: Ttl | undefined): Ttl | undefined {
  if (!prev || prev.read + prev.write === 0 || cur.model !== prev.model) return known
  const gap = cur.sentAt - prev.sentAt
  const before = promptTokens(prev)
  if (gap <= TTL_MS['5m'] + SLACK_MS) return known
  if (cur.read >= before * 0.5) return '1h'
  if (known === '1h') return known
  const lapsed = cur.write > 0 && promptTokens(cur) >= before * 0.7 && gap < TTL_MS['1h'] + SLACK_MS
  return lapsed ? '5m' : known
}

// Mốc toast cần bắn bây giờ (giây), hoặc undefined. level là mốc đã bắn gần nhất cho mốc cache này
// (Infinity khi chưa bắn); tick trễ thì nhảy thẳng tới mốc mới nhất, không bắn lại mốc cũ
export function nextToastMark(secsLeft: number, warnSecs: number, level: number): number | undefined {
  const marks = [warnSecs, ...COUNTDOWN_MARKS].filter(m => m <= warnSecs)
  const due = marks.filter(m => secsLeft <= m && m < level)
  return due.length ? Math.min(...due) : undefined
}

// Màu đồng hồ: đỏ từ ngưỡng cảnh báo, vàng khi còn dưới 40% TTL, xanh còn lại
export function lifeColor(leftMs: number, ttl: Ttl, warnMs: number): 'green' | 'yellow' | 'red' {
  if (leftMs <= warnMs) return 'red'
  return leftMs / TTL_MS[ttl] <= 0.4 ? 'yellow' : 'green'
}

export function lifeRatio(leftMs: number, ttl: Ttl): number {
  return Math.min(1, Math.max(0, leftMs / TTL_MS[ttl]))
}

// Độ rộng 3 đoạn read/wrote/new trên thanh width ô: tỷ lệ, đoạn khác 0 ít nhất 1 ô, tổng đúng width
export function segments(read: number, write: number, fresh: number, width: number): [number, number, number] {
  const total = read + write + fresh
  if (total === 0 || width <= 0) return [0, 0, 0]
  const parts = [read, write, fresh]
  const cells = parts.map(p => (p > 0 ? Math.max(1, Math.round((p / total) * width)) : 0))
  let over = cells.reduce((a, b) => a + b, 0) - width
  while (over !== 0) {
    const i = over > 0 ? cells.indexOf(Math.max(...cells)) : parts.indexOf(Math.max(...parts))
    cells[i] += over > 0 ? -1 : 1
    over += over > 0 ? -1 : 1
  }
  return [cells[0], cells[1], cells[2]]
}

export type TurnRow = { turnId: string; steps: number; read: number; write: number; fresh: number }

// Gom request theo lượt, cũ trước, cộng dồn token trong lượt
export function byTurn(samples: readonly Sample[]): TurnRow[] {
  const rows: TurnRow[] = []
  for (const s of samples) {
    let row = rows[rows.length - 1]
    if (!row || row.turnId !== s.turnId) {
      row = { turnId: s.turnId, steps: 0, read: 0, write: 0, fresh: 0 }
      rows.push(row)
    }
    row.steps += 1
    row.read += s.read
    row.write += s.write
    row.fresh += s.fresh
  }
  return rows
}

export const rowRatio = (r: TurnRow) => {
  const total = r.read + r.write + r.fresh
  return total === 0 ? 0 : r.read / total
}

// 950, 84.2k, 182k, 1.2M
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// m:ss, hoặc h:mm:ss từ 1 giờ trở lên
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`
}

// mm:ss cố định (status line và footer)
export function clockText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// Thanh tỷ lệ: █ phần đầy, ░ phần còn lại
export function bar(ratio: number, cells: number): string {
  const full = Math.round(Math.max(0, Math.min(1, ratio)) * cells)
  return '█'.repeat(full) + '░'.repeat(cells - full)
}

export function fit(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

// TTL của cache write trong một usage (API trả cache_creation tách 5m/1h); null khi không có
export function ttlFromUsage(usage: unknown): Ttl | null {
  const written = (usage as { cache_creation?: Record<string, number> } | null)?.cache_creation
  if (!written) return null
  if (written.ephemeral_1h_input_tokens > 0) return '1h'
  if (written.ephemeral_5m_input_tokens > 0) return '5m'
  return null
}

// Từ các dòng transcript: thời điểm gửi request main-thread cuối và TTL của cache write gần nhất
export function parseTranscript(text: string): { sentAt: number; ttl: Ttl | null } | null {
  let sentAt: number | null = null
  let ttl: Ttl | null = null
  let lastUserAt: number | null = null
  let lastId: string | null = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      // Dòng đầu của đoạn tail thường bị cắt
      continue
    }
    if (row.isSidechain) continue
    const at = Date.parse(row.timestamp)
    if (Number.isNaN(at)) continue
    // Prompt hoặc tool result được ghi ngay trước request mang nó
    if (row.type === 'user') {
      lastUserAt = at
      continue
    }
    if (row.type !== 'assistant') continue
    const message = row.message ?? {}
    if (!message.usage || message.model === '<synthetic>') continue
    // Một response được ghi thành nhiều dòng cùng id
    if (message.id !== lastId) {
      lastId = message.id
      sentAt = lastUserAt ?? at
    }
    ttl = ttlFromUsage(message.usage) ?? ttl
  }
  return sentAt === null ? null : { sentAt, ttl }
}
