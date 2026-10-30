export type Stamp = number | null
export type Ttl = '5m' | '1h'
// Một request main thread: read = cache phục vụ, write = ghi mới vào cache, fresh = gửi không qua cache
export type Sample = { turnId: string; index: number; model: string; sentAt: number; read: number; write: number; fresh: number }
// Lần compact gần nhất của main thread: cache entry cũ hơn mốc này đã không còn dùng.
// after = riêng bản tóm tắt (Claude Code báo); prompt = cả prompt của request đầu tiên sau compact
// (system prompt, tool, skill, memory, bản tóm tắt, file đính kèm lại), khớp panel Ngữ cảnh
export type Compacted = { at: number; trigger: string; before?: number; after?: number; prompt?: number }

declare module 'claude-code' {
  interface PluginState {
    'promptCacheTtl': {
      lastAt: Stamp
      ttl: Ttl | null
      observed: Ttl | null
      samples: Sample[]
      miss: string | null
      compacted: Compacted | null
    }
  }
}
