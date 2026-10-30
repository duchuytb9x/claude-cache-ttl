import { describe, expect, mock, test } from 'claude-code/testing'
import { accountOf, byTurn, decideTtl, marquee, missReason, nextToastMark, observeTtl, segments } from '../hooks/cache.ts'

const MIN = 60_000
const START = Date.parse('2026-10-30T06:00:00Z')
// Prompt nhỏ (dưới ngưỡng toast 20k)
const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 100,
  model: 'claude-opus-5-5',
}
// Prompt lớn (trên ngưỡng toast)
const BIG = { ...USAGE, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 1_000, input_tokens: 300 }

function assistantRow(at: string, id: string, ttl: '5m' | '1h') {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: {
        ...USAGE,
        cache_creation: {
          ephemeral_1h_input_tokens: ttl === '1h' ? 100 : 0,
          ephemeral_5m_input_tokens: ttl === '5m' ? 100 : 0,
        },
      },
    },
  })
}

type World = {
  transcript?: string
  usages?: (typeof USAGE)[]
  env?: Record<string, string>
  rateLimits?: { kind: string; percentUsed: number }[]
}

// Thế giới bên dưới mod: đồng hồ giả, transcript tùy chọn, model trả usage cho mọi request
function world(on: any, w: World = {}) {
  const usages = w.usages ?? [USAGE]
  let call = 0
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  mock.env(on, { USERPROFILE: 'C:/Users/test', ...(w.env ?? {}) })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'session-1' }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [], toolResults: [] }], tokensBefore: 240_000, tokensAfter: 30_000 }))
  on('session.cwd', () => ({ value: 'D:\\work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => ({ value: { startedAt: START, context: {}, rateLimits: w.rateLimits ?? [] } }))
  on('fs.exists', () => ({ value: w.transcript !== undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: w.transcript?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_$: any, e: any) => {
    // Chỉ có transcript; file settings không tồn tại
    if (String(e.path).endsWith('.jsonl') && w.transcript !== undefined) return { value: w.transcript }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('classic.Stop', () => ({}))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  // Claude Code tự vẽ nhãn mode trong footer
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usages[Math.min(call++, usages.length - 1)] }
  })
  return { clock, statuses, toasts, lastStatus: () => statuses[statuses.length - 1] }
}

async function start($: any) {
  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
}

async function step($: any, opts: { agentId?: string; turnId?: string } = {}) {
  const s = $.turn.step({ turnId: opts.turnId ?? 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2, ...(opts.agentId ? { agentId: opts.agentId } : {}) })
  for await (const _ of s) {
  }
  return s.result
}

// Màu của span có đúng đoạn text này; null khi span không màu, undefined khi không có span
async function colorOf(ui: any, text: string) {
  const span = (await ui.findAll({ type: 'Text' })).find((t: any) => t.text === text)
  return span ? (span.props?.color ?? null) : undefined
}

const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)

const BAND = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 8 } }
const band = ($: any, props = BAND) => $.ui.mount({ plugin: 'promptCacheTtl', surface: 'desktop', component: 'AbovePrompt', props })
const footer = ($: any, surface: 'terminal' | 'desktop', modes: string[] = []) =>
  $.ui.mount({ plugin: 'promptCacheTtl', surface, component: 'SessionMode', props: { modes } })

describe('cache.ts', () => {
  test('Should_Marquee_OnlyWhenTextIsTooLong', () => {
    const nbsp = (t: string) => t.replace(/ /g, ' ')
    expect(marquee('warm: keep going', 16, 99)).toBe('warm: keep going')
    expect(marquee('abcdefgh', 4, 0)).toBe('abcd')
    expect(marquee('abcdefgh', 4, 2)).toBe('cdef')
    // Nối vòng bằng " · " rồi quay lại đầu
    expect(marquee('abcdefgh', 4, 6)).toBe(nbsp('gh ·'))
    expect(marquee('abcdefgh', 4, 11)).toBe('abcd')
    // Đứng yên trong lúc pause, rồi mới trượt
    expect(marquee('abcdefgh', 4, 3, 8)).toBe('abcd')
    expect(marquee('abcdefgh', 4, 10, 8)).toBe('cdef')
  })

  test('Should_DecideTtl_InClaudeCodeOrder', () => {
    expect(decideTtl({ force5m: '1', enable1h: '1' }).ttl).toBe('5m')
    expect(decideTtl({ ttlVar: '1h', force5m: '0' }).ttl).toBe('1h')
    expect(decideTtl({}, '5m').ttl).toBe('5m')
    expect(decideTtl({ enable1h: 'true' }).ttl).toBe('1h')
    expect(decideTtl({}, undefined, 'subscription').ttl).toBe('1h')
    expect(decideTtl({}, undefined, 'credits').ttl).toBe('5m')
  })

  test('Should_ReadAccount_FromRateLimitWindows', () => {
    expect(accountOf([])).toBe('other')
    expect(accountOf([{ kind: 'five_hour', percentUsed: 12 }])).toBe('subscription')
    expect(accountOf([{ kind: 'seven_day', percentUsed: 100 }])).toBe('credits')
  })

  test('Should_ObserveTtl_FromRequestTiming', () => {
    const prev = { turnId: 'a', index: 0, model: 'm', sentAt: 0, read: 100_000, write: 1_000, fresh: 10 }
    // Hit sau 10 phút: chắc chắn 1h
    expect(observeTtl(prev, { ...prev, sentAt: 10 * MIN }, undefined)).toBe('1h')
    // Miss sau 10 phút, cùng model, prompt không co: cache đã hết hạn nên 5m
    expect(observeTtl(prev, { ...prev, sentAt: 10 * MIN, read: 0, write: 101_000 }, undefined)).toBe('5m')
    // Đã biết 1h thì miss về sau không lật lại
    expect(observeTtl(prev, { ...prev, sentAt: 10 * MIN, read: 0, write: 101_000 }, '1h')).toBe('1h')
    // Trong 5 phút thì không kết luận gì
    expect(observeTtl(prev, { ...prev, sentAt: 2 * MIN }, undefined)).toBe(undefined)
  })

  test('Should_PickToastMarks_WithoutReplaying', () => {
    expect(nextToastMark(299, 300, Infinity)).toBe(300)
    expect(nextToastMark(200, 300, 300)).toBe(undefined)
    expect(nextToastMark(9, 300, 300)).toBe(10)
    // Tick trễ nhảy thẳng tới mốc mới nhất
    expect(nextToastMark(1, 300, 300)).toBe(1)
  })

  test('Should_GroupSamplesByTurn_AndSplitBar', () => {
    const s = (turnId: string, read: number) => ({ turnId, index: 0, model: 'm', sentAt: 0, read, write: 10, fresh: 1 })
    const rows = byTurn([s('a', 100), s('a', 200), s('b', 50)])
    expect(rows.map(r => [r.turnId, r.steps, r.read])).toEqual([['a', 2, 300], ['b', 1, 50]])
    expect(segments(80, 15, 5, 20).reduce((a, b) => a + b, 0)).toBe(20)
  })

  test('Should_NotReportMiss_WhenFirstRequest_OrPromptShrank', () => {
    const prev = { turnId: 'a', index: 0, model: 'm', sentAt: 0, read: 200_000, write: 0, fresh: 0 }
    expect(missReason(undefined, prev, '1h')).toBe(undefined)
    expect(missReason(prev, { ...prev, read: 0, write: 30_000 }, '1h')).toBe(undefined)
  })
})

describe('promptCacheTtl', () => {
  test('Should_ShowNoRequest_BeforeFirstStep', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.lastStatus()).toBe('🕒 chưa có request')
  })

  test('Should_CountDownFromStepSentAt_WithDefault1h', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(1000)
    expect(w.lastStatus()).toBe('🕒 59:59 · 1h · 90% · r1k w100 n10')
  })

  test('Should_IgnoreSubagentSteps', async ($, on) => {
    const w = world(on)
    await start($)
    await step($, { agentId: 'agent-1' })
    await w.clock.advance(1000)
    expect(w.lastStatus()).toBe('🕒 chưa có request')
  })

  test('Should_ToastAtWarnThenCountdownMarks_ForBigPrompt', { timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on, { usages: [BIG] })
    await start($)
    await step($)
    await w.clock.set(START + 55 * MIN + 1000)
    await w.clock.advance(1000)
    expect(w.toasts).toEqual(['Prompt cache còn 05:00: gửi tin để giữ 151k token còn ấm'])
    await w.clock.set(START + 60 * MIN - 9_500)
    await w.clock.advance(1000)
    expect(w.toasts.at(-1)).toBe('Prompt cache còn 10 giây: gửi tin ngay để giữ cache')
    expect(w.toasts.length).toBe(2)
  })

  test('Should_NotToast_ForSmallPrompt', { timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.set(START + 55 * MIN + 1000)
    await w.clock.advance(1000)
    expect(w.toasts).toEqual([])
  })

  test('Should_ShowExpired_AfterTtl', { timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.set(START + 60 * MIN + 1000)
    await w.clock.advance(1000)
    expect(w.lastStatus()).toBe('🕒 cache hết hạn · 90% · r1k w100 n10')
  })

  test('Should_Resume_FromTranscript_With5mTtl', async ($, on) => {
    const sentAt = new Date(START - 2 * MIN).toISOString()
    const transcript = [
      '{"cut line',
      JSON.stringify({ type: 'user', timestamp: sentAt }),
      assistantRow(new Date(START - 2 * MIN + 5000).toISOString(), 'msg-1', '5m'),
    ].join('\n')
    const w = world(on, { transcript })
    await start($)
    expect(w.lastStatus()).toBe('🕒 03:00 · 5m')
  })

  test('Should_UseSubscriptionTtl_FromRateLimits_WhenNoTranscript', async ($, on) => {
    const w = world(on, { rateLimits: [{ kind: 'seven_day', percentUsed: 100 }] })
    await start($)
    await step($)
    expect(w.lastStatus()).toBe('🕒 05:00 · 5m · 90% · r1k w100 n10')
  })

  test('Should_FollowForce5mEnv', async ($, on) => {
    const w = world(on, { env: { FORCE_PROMPT_CACHING_5M: '1' }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] })
    await start($)
    await step($)
    expect(w.lastStatus()).toContain('· 5m ·')
  })

  test('Should_ShowCachingOff_WhenDisablePromptCaching', async ($, on) => {
    const w = world(on, { env: { DISABLE_PROMPT_CACHING: '1' } })
    await start($)
    await step($)
    expect(w.lastStatus()).toBe('🕒 caching đang tắt (DISABLE_PROMPT_CACHING)')
  })

  test('Should_ShowMissReason_AndToast_WhenPrefixChanged', async ($, on) => {
    const missed = { ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 152_000, input_tokens: 400 }
    const w = world(on, { usages: [BIG, missed] })
    await start($)
    await step($)
    await w.clock.advance(20_000)
    await step($)
    expect(w.lastStatus()).toBe('🕒 60:00 · 1h · 0% · r0 w152k n400 · ✖ miss: prefix prompt thay đổi (effort, tool, system prompt hoặc CLAUDE.md)')
    expect(w.toasts).toEqual(['Cache miss, ghi lại 152k token: prefix prompt thay đổi (effort, tool, system prompt hoặc CLAUDE.md)'])
  })

  test('Should_ShowMissReason_WhenModelChanged', async ($, on) => {
    const missed = { ...BIG, model: 'claude-sonnet-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 151_000 }
    const w = world(on, { usages: [BIG, missed] })
    await start($)
    await step($)
    await step($)
    expect(w.lastStatus()).toContain('✖ miss: đổi model (claude-opus-5-5 → claude-sonnet-5-5)')
  })

  test('Should_ShowNotCached_WhenRequestTouchedNoCache', async ($, on) => {
    const w = world(on, { usages: [{ ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 900 }] })
    await start($)
    await step($)
    expect(w.lastStatus()).toBe('🕒 60:00 · 1h · không cache (n900)')
  })

  test('Should_ResetEverything_OnClear', async ($, on) => {
    const w = world(on, { usages: [BIG] })
    await start($)
    await step($)
    expect(w.lastStatus()).toContain('99%')
    await ($ as any).session.end({ reason: 'clear', sessionId: 'session-1' })
    expect(w.lastStatus()).toBe('🕒 chưa có request')
  })

  test('Should_StopCountdown_AndToast_OnCompact', async ($, on) => {
    const w = world(on, { usages: [BIG] })
    await start($)
    await step($)
    await w.clock.advance(1000)
    await ($ as any).session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'old', toolUses: [], toolResults: [] }] })
    expect(w.toasts.at(-1)).toBe('Đã compact 240k token, bản tóm tắt 30k: tin tiếp theo bắt đầu từ bản tóm tắt')
    expect(w.lastStatus()).toBe('🕒 đã compact (240k → tóm tắt 30k)')
    const ui = await band($)
    expect(await texts(ui)).toContain('cache: compacted (240k → summary 30k): the next message starts from the summary')
    await ui.unmount()
  })

  test('Should_ShowRealPromptSize_OnFirstRequestAfterCompact', async ($, on) => {
    const after = { ...BIG, cache_read_input_tokens: 57_800, cache_creation_input_tokens: 27_300, input_tokens: 2 }
    const w = world(on, { usages: [BIG, after, after] })
    await start($)
    await step($)
    await w.clock.advance(1000)
    await ($ as any).session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [], toolResults: [] }] })
    await w.clock.advance(1000)
    await step($, { turnId: 't2' })
    expect(w.toasts.at(-1)).toBe('Sau compact: 240k → 85.1k token (đọc cache 57.8k, ghi mới 27.3k)')
    const ui = await band($)
    expect(await texts(ui)).toContain('1h · warm: compacted 240k → 85.1k, keep going')
    await ui.unmount()
    // Từ request thứ hai sau compact về như thường, không toast lại
    const count = w.toasts.length
    await step($, { turnId: 't3' })
    expect(w.toasts.length).toBe(count)
    const next = await band($)
    expect(await texts(next)).toContain('1h · warm: keep going')
    await next.unmount()
  })

  test('Should_IgnorePrecompute_AndSubagentCompaction', async ($, on) => {
    const w = world(on, { usages: [BIG] })
    await start($)
    await step($)
    await w.clock.advance(1000)
    await ($ as any).session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'old', toolUses: [], toolResults: [] }] })
    await ($ as any).session.compact({ trigger: 'auto', agentId: 'a1', messages: [{ role: 'user', text: 'old', toolUses: [], toolResults: [] }] })
    expect(w.toasts).toEqual([])
    expect(w.lastStatus()).toContain('99%')
  })

  test('Should_OverrideTtl_WithCommand_AndBackToAuto', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    const r = await ($ as any).command.run({ command: 'cache-ttl', args: '5m' })
    expect(r.text).toContain('TTL 5m (đặt bằng /cache-ttl)')
    expect(w.lastStatus()).toContain('· 5m ·')
    await ($ as any).command.run({ command: 'cache-ttl', args: 'auto' })
    expect(w.lastStatus()).toContain('· 1h ·')
  })

  test('Should_DrawFullColoredFooter_OnTerminal', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    const ui = await footer($, 'terminal')
    expect((await texts(ui)).slice(1)).toEqual(['● ', 'cache ', '█████░ ', '90% ', '⏱ 60:00', ' read 1k', ' wrote 100', ' new 10', ' 1h'])
    expect(await colorOf(ui, ' read 1k')).toBe('green')
    expect(await colorOf(ui, ' wrote 100')).toBe('#D97706')
    expect(await colorOf(ui, ' new 10')).toBe('cyan')
    expect(await colorOf(ui, '⏱ 60:00')).toBe('green')
    // Có footer thì status line được xóa để không hiện trùng
    expect(w.lastStatus()).toBeUndefined()
    await ui.unmount()
  })

  test('Should_NotDrawFooter_OnDesktop_WhenBandOn', async ($, on) => {
    const wd = world(on)
    await start($)
    await step($)
    const w = await footer($, 'desktop')
    // Dải phía trên đã có dòng đầy đủ: footer desktop để nguyên của Claude Code, status line cũng tắt
    expect(await colorOf(w, '60:00')).toBeUndefined()
    expect(await colorOf(w, ' 90%')).toBeUndefined()
    await w.unmount()
    expect(wd.lastStatus()).toBeUndefined()
  })

  test('Should_ShowTokensInDesktopFooter_WhenBandOff', { options: { band: false } }, async ($, on) => {
    world(on)
    await start($)
    await step($)
    const ui = await footer($, 'desktop')
    expect((await texts(ui)).slice(1)).toEqual(['● ', '60:00', ' 90%', ' r1k', ' w100', ' n10'])
    await ui.unmount()
  })

  test('Should_KeepClaudeModes_AndMarkMissRed_InFooter', { options: { band: false } }, async ($, on) => {
    const missed = { ...BIG, cache_read_input_tokens: 0, cache_creation_input_tokens: 151_000 }
    world(on, { usages: [BIG, missed] })
    await start($)
    await step($)
    await step($)
    const ui = await footer($, 'desktop', ['focus'])
    expect(await colorOf(ui, '✖ ')).toBe('red')
    expect(await colorOf(ui, ' ✖ miss')).toBe('red')
    expect(await colorOf(ui, ' · ')).toBe(null)
    await ui.unmount()
  })

  test('Should_DrawBand_LikePromptCacheControl_OnDesktopOnly', async ($, on) => {
    world(on)
    await start($)
    // Chưa có request thì không chiếm dải
    const empty = await band($)
    expect(await colorOf(empty, 'read 1k')).toBeUndefined()
    await empty.unmount()
    await step($)
    const desk = await band($)
    expect(await colorOf(desk, '●')).toBe('green')
    expect(await colorOf(desk, 'cache')).toBe('cyan')
    expect(await colorOf(desk, '█████████░')).toBe('green')
    expect(await colorOf(desk, 'read 1k')).toBe('green')
    expect(await colorOf(desk, 'wrote 100')).toBe('#D97706')
    expect(await colorOf(desk, 'new 10')).toBe('cyan')
    expect(await colorOf(desk, '⏱ 1:00:00')).toBe('green')
    expect(await texts(desk)).toContain('1h · warm: keep going')
    // read/wrote/new nằm chung một Text trong Box không co, nên luôn cùng một hàng
    expect((await desk.findAll({ type: 'Box' })).some((b: any) => b.props?.flexShrink === 0)).toBe(true)
    await desk.unmount()
    const term = await $.ui.mount({ plugin: 'promptCacheTtl', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await colorOf(term, 'read 1k')).toBeUndefined()
    await term.unmount()
  })

  test('Should_ShrinkBand_WhenNarrow', async ($, on) => {
    world(on, { usages: [BIG] })
    await start($)
    await step($)
    const ui = await band($, { ...BAND, bodyColumns: 70 })
    const all = await texts(ui)
    expect(all).toContain('██████')
    expect(all).not.toContain('██████████')
    // Hẹp vẫn hiện đủ read/wrote/new, không gộp
    expect(await colorOf(ui, 'read 150k')).toBe('green')
    expect(await colorOf(ui, 'wrote 1k')).toBe('#D97706')
    expect(await colorOf(ui, 'new 300')).toBe('cyan')
    expect(all).not.toContain('151k tok')
    await ui.unmount()
  })

  test('Should_SuggestCompact_WhenBigPromptExpired', { timeoutMs: 60_000 }, async ($, on) => {
    const w = world(on, { usages: [BIG] })
    await start($)
    await step($)
    await w.clock.set(START + 60 * MIN + 1000)
    await w.clock.advance(1000)
    const ui = await band($, { ...BAND, bodyColumns: 200 })
    expect(await texts(ui)).toContain('1h · expired: the next message rewrites 151k tokens. /compact first, or /clear if the task is done')
    await ui.unmount()
  })

  test('Should_KeepClockOnOneRow_AndScrollTail_WhenTooLong', async ($, on) => {
    const w = world(on, { usages: [BIG] })
    await start($)
    await step($)
    const narrow = { ...BAND, bodyColumns: 60 }
    const tailOf = async (ui: any) => (await texts(ui)).find(t => t.includes(' '))
    const first = await band($, narrow)
    // Đồng hồ nằm trong Box không co, không xuống hàng giữa ⏱ và số
    expect((await first.findAll({ type: 'Box' })).filter((b: any) => b.props?.flexShrink === 0).length).toBe(2)
    expect(await colorOf(first, '⏱ 1:00:00')).toBe('green')
    const before = await tailOf(first)
    expect([...(before ?? '')].length).toBe(10)
    await first.unmount()
    await w.clock.advance(5000)
    const later = await band($, narrow)
    expect(await tailOf(later)).not.toBe(before)
    await later.unmount()
  })

  test('Should_OpenPane_WithPerTurnTable', async ($, on) => {
    world(on, { usages: [BIG] })
    await start($)
    await step($, { turnId: 't1' })
    await step($, { turnId: 't1' })
    await step($, { turnId: 't2' })
    const r = await ($ as any).command.run({ command: 'cache-ttl', args: '' })
    expect(r.text).toContain('TTL 1h (mặc định)')
    const pane = await $.ui.mount({ plugin: 'promptCacheTtl', surface: 'terminal', component: 'Pane', requestId: 'cache-ttl', props: { bodyColumns: 100, bodyRows: 30 } })
    const all = await texts(pane)
    expect(all).toContain('⚡ PROMPT CACHE')
    expect(all).toContain('99% hit')
    // 2 lượt: t1 có 2 request, t2 có 1
    expect(all.filter((t: string) => t === '2').length).toBeGreaterThan(0)
    expect(all).toContain('300k')
    await pane.unmount()
    // Pane đang mở thì dải nhường chỗ
    const b = await band($)
    expect(await colorOf(b, 'cache')).toBeUndefined()
    await b.unmount()
  })
})
