# promptCacheTtl

Mod cho Claude Code / Claude desktop: theo dõi prompt cache của hội thoại — còn bao lâu thì hết hạn, mỗi request đọc / ghi / gửi mới bao nhiêu token, vì sao cache miss, và nên làm gì (đi tiếp, `/compact` hay `/clear`).

## Hiện ở đâu

- **Dải phía trên ô prompt (desktop)**, bố cục theo plugin `prompt-cache-control` nhưng `read / wrote / new` luôn cùng một hàng:

  ```
  ● cache ██████████ 99% read 294k wrote 3.2k new 2 ⏱ 59:40 1h · warm: keep going
  ```

  Hẹp dưới 90 cột thì thanh còn 6 ô, `read / wrote / new` vẫn hiện đủ; thiếu chỗ thì cắt phần lời khuyên cuối dòng. Nhường chỗ khi có survey hoặc khi bảng `/cache-ttl` đang mở.
- **Footer dưới ô prompt**, cạnh model/effort: terminal hiện bản đầy đủ. Desktop đã có dải phía trên nên để nguyên footer của Claude Code; tắt tuỳ chọn `band` thì footer desktop hiện bản gọn `● 59:40 99% r294k w3.2k n2` (ô này khoá ~20 ký tự).
- **Status line** dạng text khi surface không vẽ footer (VS Code, `claude -p`) hoặc tắt tuỳ chọn `footer`.

Màu: `●` xanh khi cache còn ấm, `▲` vàng khi sắp hết, `✖` đỏ khi hết hạn hoặc miss. Đồng hồ xanh → vàng (dưới 40% TTL) → đỏ (từ ngưỡng cảnh báo). `read` xanh lá, `wrote` cam đậm `#D97706` (dễ đọc trên cả nền sáng lẫn tối), `new` xanh ngọc.

## Tính năng

- **Đếm từ lúc gửi từng request** của main thread (`turn.step`); request của subagent bị bỏ qua vì subagent cache prefix riêng.
- **TTL 5m / 1h**, theo thứ tự ưu tiên:
  1. `/cache-ttl 5m|1h` hoặc tuỳ chọn `ttl`
  2. đọc từ `usage.cache_creation` trong transcript (chính xác nhất)
  3. suy từ nhịp request: hit sau hơn 5 phút chứng minh 1h; miss 5–60 phút sau với prompt không co là 5m
  4. như Claude Code chọn: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, setting `promptCacheTtl`, `ENABLE_PROMPT_CACHING_1H`, rồi theo tài khoản (subscription 1h, usage credits 5m — đọc từ rate limit)
- **Sau reload/resume** lấy lại mốc request cuối từ transcript.
- **Cache miss**: nhận ra request lẽ ra đọc cache mà phải ghi mới, nêu lý do (đổi model, cache đã hết hạn, prefix prompt thay đổi) và toast. Prompt co lại do `/compact` / `/clear` không tính là miss.
- **Hết hạn với prompt lớn** (từ `compactAtTokens`) gợi ý `/compact` hoặc `/clear` trước khi ghi lại cả prefix.
- **Toast** ở ngưỡng cảnh báo (mặc định 5 phút với TTL 1h, 1 phút với 5m) rồi 10, 3, 2, 1 giây cuối, chỉ với prompt từ `toastMinTokens`; toast khi cache miss và khi compact.
- **`/clear`** đếm lại từ đầu cho hội thoại mới.
- **`/compact`** (kể cả khi Claude Code tự compact lúc để yên): báo kích thước trước compact và bản tóm tắt (`240k → tóm tắt 30k`), ngừng đếm cache cũ cho tới request kế tiếp; request đầu tiên sau compact báo prompt thật (`240k → 85k`, gồm cả system prompt, tool, file đính kèm lại — khớp panel Ngữ cảnh).
- **`DISABLE_PROMPT_CACHING*`**: báo caching đang tắt thay vì đếm.

Phần đếm ngược tới lúc Claude Code tự compact khi để yên (của `prompt-cache-control`) không port: nó dựa vào cờ rollout ẩn trong `~/.claude.json`.

## Lệnh

- `/cache-ttl` — mở bảng: đồng hồ và thanh thời gian còn lại, thanh read/wrote/new của request cuối, bảng token theo từng lượt
- `/cache-ttl 5m` / `/cache-ttl 1h` — cố định TTL (mọi session); `/cache-ttl auto` — về tự động
- `/cache-ttl stop` — đóng bảng

## Tuỳ chọn

Đặt trong `~/.claude/settings.json` dưới `pluginConfigs`, hoặc `/plugin configure promptCacheTtl@claude-cache-ttl` trong terminal:

```
ttl              "auto" | "5m" | "1h"   (auto)
warnSeconds      số giây cảnh báo trước khi hết hạn; 0 = tự động (0)
compactAtTokens  ngưỡng gợi ý /compact khi hết hạn (100000)
toastMinTokens   ngưỡng token để toast (20000)
band             dải phía trên ô prompt (true)
footer           footer dưới ô prompt (true)
toast            toast (true)
```

**Hạn chế:** vẫn là ước tính phía client — server có thể drop cache sớm hơn. Transcript đọc bằng `$.fs.read` (giới hạn 4 MiB); lớn hơn thì đọc đuôi bằng `tail`, máy không có `tail` (Windows thuần) thì TTL lấy theo bước 3–4 ở trên.

Phần lớn logic phát hiện miss, suy TTL, toast nhiều mốc, bảng theo lượt và bố cục dải port từ plugin `prompt-cache-control` (MIT, claude-code-templates).

## Test

```bash
claude plugin validate .
claude plugin test .
```

## Cài đặt

Terminal (shell):

```bash
claude plugin install promptCacheTtl --marketplace http://192.168.5.251/huypd/claude-cache-ttl.git
```

Trong một phiên Claude Code ở terminal:

```
/plugin install promptCacheTtl --marketplace http://192.168.5.251/huypd/claude-cache-ttl.git
```

Claude desktop (Code tab): bấm **+** cạnh ô prompt → **Plugins** → **Add marketplace**, dán `http://192.168.5.251/huypd/claude-cache-ttl.git` → **Add plugin** → chọn `promptCacheTtl`.

Yêu cầu: máy phải clone được repo này (có quyền đọc và git credential cho `192.168.5.251`).

## Cập nhật

```bash
claude plugin update promptCacheTtl
```

rồi gõ `/reload-plugins` trong phiên đang mở.

## Gỡ

```bash
claude plugin uninstall promptCacheTtl
```
