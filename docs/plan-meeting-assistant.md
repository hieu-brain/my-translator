# Kế hoạch cải tiến My Translator — Meeting-first + AI trợ lý họp

> Chốt ngày 2026-08-05. Quyết định: lấy upstream v0.9.1 làm nền, lược bỏ tính năng thừa,
> xây tính năng AI trợ lý họp dùng Claude API.

## Bối cảnh

- Branch `hieu` đang dựa trên ~v0.6, upstream (`phuc-nt/my-translator` = `origin`) đã lên **v0.9.1, hơn 127 commits**.
- v0.9.1 đã có sẵn: Smart Scroll (không bị kéo xuống đáy khi đọc lại), Dual Panel (gốc | dịch),
  Two-way translation VI↔JA (thay cho bilingual mode tự làm), SessionStore autosave 15s
  (fix lỗi export thiếu nội dung), 4 engine STT, custom translation terms.
- Mục đích sử dụng: **transcript trực tiếp trong cuộc họp** (không phải xem video).

## Phase 0 — Backup & đổi nền (0.5 buổi)

1. Commit toàn bộ WIP trên `hieu` + tạo branch backup `backup/hieu-pre-v091`.
2. Tạo branch mới `hieu-v2` từ `origin/main` (v0.9.1).
3. `npm install` (upstream thêm plugin-process/plugin-updater), build, chạy thử:
   Soniox key + two-way VI↔JA + dual panel + autosave transcript.

## Phase 1 — Lược bỏ tính năng thừa (1 buổi)

Đã chốt bỏ (mỗi mục 1 commit riêng để dễ revert):

| Bỏ | Files chính |
|---|---|
| TTS toàn bộ + Read mode | `src/js/{edge,google,google-free,elevenlabs,microsoft,tiktok,local,web-speech}-tts.js`, `audio-player.js`, `reader.js`, `read-chunker.js`; Rust: `commands/{edge_tts,google_free_tts,microsoft_tts,tiktok_tts,local_tts}.rs`; UI nút TTS, ⌘T, settings TTS |
| OpenAI Realtime + Qwen engine | `openai-realtime-client.js`, `openai-audio-output-queue.js`, `qwen-realtime-client.js`, `qwen-langs.js`; Rust: `commands/{openai_realtime,qwen_realtime}.rs`; settings engine picker chỉ còn Soniox + Local |
| Windows support | `audio/wasapi.rs`, docs/build Windows, cfg windows trong lib.rs |
| Auto-updater | `updater.js`, `@tauri-apps/plugin-updater`, config updater trong tauri.conf.json |

Giữ lại: Soniox v5, Local MLX (offline dự phòng), two-way mode, dual panel, smart scroll,
SessionStore, custom translation terms, `http_client.rs` (sẽ dùng cho Phase 3).

Sau mỗi bước: `cd src-tauri && cargo check` + chạy app xác nhận.

## Phase 2 — Redesign UI cho meeting (1-2 buổi)

- Đã xuất layout hiện tại (v0.9.1) ra `design/current-layout.html` (standalone, CSS inline, dữ liệu mẫu VI/JA)
  + prompt thiết kế `design/ui-redesign-prompt.md` — dùng để yêu cầu Claude đề xuất & code lại UI.
- Sau khi chốt bản design: port HTML/CSS mới vào `src/index.html` + `src/styles/main.css`
  (design giữ nguyên id các element nên JS binding không đổi).
- Thêm khả năng **click chọn một câu/segment** trong transcript (highlight) — nền tảng cho Phase 3.
- Panel trợ lý (drawer thu gọn được) theo bản design mới.

## Phase 3 — AI trợ lý họp (Claude API) — phần phát triển mới chính

### 3a. Meeting setup UI (1-2 buổi)
- Trước khi Start: chọn "Meeting profile" — tên dự án, thư mục dự án (đọc CLAUDE.md/README/docs),
  Backlog project key, file notes đính kèm (md/txt). Lưu nhiều profile trong settings.
- Settings mới: Anthropic API key; Backlog space + API key.

### 3b. Rolling summary realtime (1-2 buổi)
- **Auto (mặc định, có toggle tắt)**: mỗi ~2 phút hoặc ~20 segments mới: gửi (summary cũ + segments mới)
  → cập nhật tóm tắt (chủ đề, quyết định, action items) hiển thị ở panel trợ lý.
  Chỉ gọi khi có segments mới (họp im lặng thì không gọi).
- **Nút "Tóm tắt ngay"**: chạy summary thủ công bất kỳ lúc nào — dùng khi tắt auto để tiết kiệm.
- Chi phí (nếu dùng API): Haiku 4.5 giá $1/$5 per 1M tokens → 1 giờ họp auto-summary ≈ **$0.10-0.15**.
  Gợi ý trả lời dùng Sonnet 5 ($3/$15, giá ưu đãi $2/$10 đến 31/08/2026) ≈ $0.02-0.05/lần.
  Tổng một buổi họp thường **< $0.50**. Nếu dùng backend gói Max (xem dưới) thì $0.

### Backend LLM: dùng gói Claude Max (mặc định) hoặc API key
Gói Max **không dùng được với Anthropic API key** (API tính tiền riêng theo token). Nhưng app có thể
gọi **Claude Code CLI headless** — `claude -p "<prompt>" --output-format json --model haiku` — CLI
xác thực bằng tài khoản Max đang đăng nhập → không tốn thêm tiền, chỉ tính vào usage limit của gói Max.
Thiết kế abstraction `llm-backend.js` với 2 provider:
1. **`claude-cli` (mặc định)**: Rust command spawn `claude -p` (stdin = prompt, parse JSON output).
   Yêu cầu máy đã cài Claude Code + đăng nhập Max. Độ trễ spawn ~2-4s — chấp nhận được cho summary
   định kỳ và gợi ý trả lời.
2. **`anthropic-api`**: gọi thẳng Messages API bằng API key (qua `http_client.rs`) — nhanh hơn,
   dùng khi cần latency thấp hoặc máy không có Claude Code. Model: `claude-haiku-4-5` (summary),
   `claude-sonnet-5` (gợi ý trả lời).
Settings cho phép chọn backend + nhập API key (optional).

### 3e. Lưu meeting notes theo dự án (0.5-1 buổi)
- **Có chọn dự án** trong meeting profile: lấy folder dự án làm gốc, tạo folder
  `<tên-folder-dự-án>-meeting-notes/` **đồng cấp** với folder dự án (tạo nếu chưa có), lưu note vào đó.
  Ví dụ: dự án `~/Projects/my-cms` → notes lưu ở `~/Projects/my-cms-meeting-notes/2026-08-05-<title>.md`.
- **Không chọn dự án**: lưu vào folder mặc định `~/Documents/meeting-notes/` (đường dẫn đổi được trong Settings).
- **Format file note** — đầu file là block tóm tắt thông tin cơ bản, sau đó mới đến transcript:
  ```markdown
  # <Tiêu đề cuộc họp>
  - Ngày giờ: 2026-08-05 14:00–15:00 (60 phút)
  - Dự án: my-cms
  - Ngôn ngữ: VI ⇄ JA · Engine: Soniox
  - Người nói: Speaker 1 (JA), Speaker 2 (VI)

  ## Tóm tắt
  <rolling summary cuối cùng: chủ đề chính, quyết định, action items>

  ## Transcript
  [14:00:12] [Speaker 1] ...
  ```
- SessionStore hiện có vẫn autosave `.md`/`.json` vào Application Support (backup an toàn khi crash);
  file meeting note theo dự án được ghi khi Stop session (kèm summary cuối).

### 3c. "Giúp tôi trả lời" (2 buổi)
- Chọn một câu trong transcript (hoặc nút "câu vừa rồi") → gửi: câu được hỏi + transcript gần nhất
  + rolling summary + project context → **Claude Sonnet 5** → 2-3 gợi ý trả lời (VI + bản JA để nói luôn).
- Ví dụ mục tiêu: sếp hỏi "đánh giá renew CMS thay vì migration?" → gợi ý dựa trên trạng thái thực tế
  của dự án lấy từ CLAUDE.md/backlog.

### 3d. Context providers (1-2 buổi)
- Rust command `read_project_context(path)`: đọc CLAUDE.md, README, docs/*.md (giới hạn kích thước).
- Backlog REST API qua `http_client.rs`: issues mở của project (summary, status, assignee).
- File notes: copy nội dung vào meeting profile.

## Phase 4 — Hoàn thiện (0.5-1 buổi)

- Export: xác nhận session .md/.json đầy đủ từ đầu đến cuối; thêm nút "Export kèm summary".
- Build .app production, dùng thử 1 cuộc họp thật, ghi nhận chỉnh sửa.

## Kiến trúc module mới (Phase 3)

```
src/js/meeting-assistant.js   — điều phối: rolling summary + suggest-answer
src/js/llm-backend.js         — abstraction 2 provider: claude-cli (Max) | anthropic-api (key)
src/js/context-providers.js   — CLAUDE.md / Backlog / notes
src-tauri/src/commands/project_context.rs — đọc file dự án + tạo/ghi folder meeting-notes
src-tauri/src/commands/claude_cli.rs      — spawn `claude -p` headless (backend gói Max)
```
