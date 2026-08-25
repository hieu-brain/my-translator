# My Translator — Meeting Edition · Project Guide for AI

## Project Overview
macOS overlay app for **live bilingual meetings** (VI ⇄ JA): audio capture → Soniox STT/translation → caption overlay, plus a Claude-powered meeting assistant (rolling summary + reply suggestions) and per-project meeting notes.

Fork of upstream `phuc-nt/my-translator` v0.9.1, with TTS, read mode, the OpenAI Realtime and Qwen engines, Windows support, and the auto-updater removed.

## Tech Stack
| Layer | Tech |
|-------|------|
| Frontend | Vanilla HTML/CSS/JS, ES modules (no framework, no CDN) |
| Backend | Rust + Tauri 2 |
| System audio | ScreenCaptureKit (macOS 13+) |
| Microphone | CPAL 0.15 |
| STT/Translation | Soniox API v4 (WebSocket) · Local MLX (offline, Apple Silicon) · Teams live captions (Chrome extension) |
| Meeting assistant | Claude — via the `claude` CLI (subscription) or the Anthropic API (key) |

## Commands
```bash
npm run tauri dev          # full app, hot-reload frontend
npm run dev:web            # UI only, :3111, Tauri APIs mocked (src/js/tauri-mock.js)
npm run tauri build        # production .app + .dmg
cd src-tauri && cargo check
```

## Project Structure
```
src/                          # Frontend
  index.html                  # Single page: overlay view + settings view
  styles/main.css             # Dark glass, M3 tonal roles (periwinkle/mint)
  js/
    app.js                    # Main controller — wires everything
    ui.js                     # TranscriptUI — caption blocks, selection, export
    soniox.js                 # Soniox WebSocket client
    session-store.js          # Session persistence (autosave every 15s)
    settings.js               # SettingsManager (IPC)
    ui-shell.js               # Activity tabs, auto-hide chrome, window modes
    meeting-assistant.js      # Rolling summary + reply suggestions
    llm-backend.js            # claude-cli | anthropic-api provider abstraction
    context-providers.js      # Project docs / Backlog / note files
    tauri-mock.js             # Browser-dev mocks (only on :3111)

src-tauri/src/
  lib.rs                      # Tauri builder + command registration
  settings.rs                 # Settings struct + MeetingProfile
  audio/{system_audio,microphone,resampler}.rs
  commands/
    audio.rs                  # start_capture / stop_capture
    settings.rs               # get_settings / save_settings
    transcript.rs             # legacy transcript files
    session_store.rs          # session .md/.json read/write/export
    local_pipeline.rs         # MLX offline engine
    claude_cli.rs             # `claude -p` headless (subscription backend)
    project_context.rs        # project docs + meeting-note writing
    http_client.rs            # shared reqwest client
```

## Tauri IPC Commands (JS → Rust)
```js
invoke('start_capture', { source: 'system'|'microphone'|'both', channel })
invoke('stop_capture')
invoke('get_settings')                        // → Settings JSON
invoke('save_settings', { newSettings })
invoke('save_session' | 'list_sessions' | 'read_session' | 'delete_session' | ...)
invoke('start_local_pipeline' | 'send_audio_to_pipeline' | 'stop_local_pipeline')
invoke('check_mlx_setup') / invoke('run_mlx_setup', { channel })
invoke('check_claude_cli', { cliPath })       // → version string
invoke('claude_cli_prompt', { cliPath, prompt, model, system, timeoutSec })
invoke('read_project_context', { projectPath })
invoke('read_note_files', { paths })
invoke('meeting_notes_dir', { projectPath, defaultNotesDir })
invoke('save_meeting_note', { projectPath, defaultNotesDir, datePrefix, title, content })
invoke('open_path_in_finder', { path })
invoke('start_caption_bridge', { port, token, channel }) / invoke('stop_caption_bridge')
invoke('append_token_log', { file, lines })      // debug: ghi luồng token Soniox ra .jsonl
```

## Data Flow
```
Audio HW → Rust capture (48kHz stereo) → resample 16kHz mono PCM s16le
         → IPC Channel (200ms batches) → JS → Soniox WebSocket
         → tokens: provisional / final / translation
         → TranscriptUI caption blocks → SessionStore (autosave)
         → on Stop: final summary + meeting note written to disk
```

## Key UI contracts
- `#transcript-content` is the scroller; `.transcript-flow` holds the blocks.
- One utterance = `.seg-block.spk-{a..d}[data-seg-id]`, containing an optional
  `.speaker-row`, then `.seg-translated` (target, large) and `.seg-original`
  (source, small/dim). `.single-view` on `#overlay-view` hides originals.
- Provisional text lives in `.seg-provisional-block` and is updated **in place**
  — recreating the node makes it flash on every partial token.
- Clicking a block selects it (`.selected`) and triggers reply suggestions.
- `body.furigana-on` reveals `<rt>` inside `<ruby>` in `.ja` text.
- `#ai-panel` is a bottom drawer under 780px and a right column above it (CSS
  grid only — no JS involved in that switch).

## Settings Storage
- Path: `~/Library/Application Support/com.personal.translator/settings.json`
- Struct: `src-tauri/src/settings.rs` → `Settings` (+ `MeetingProfile`)
- **Adding a setting**: add the field to the Rust struct *and* its `Default`
  impl, then to `DEFAULT_SETTINGS` in `src/js/settings.js`. Serde silently drops
  fields missing from the struct — that is how upstream's two-way settings
  failed to persist.

## Storage paths
| What | Where |
|---|---|
| Settings | `~/Library/Application Support/com.personal.translator/settings.json` |
| Sessions (autosave) | `~/Library/Application Support/com.personal.translator/sessions/` |
| Meeting notes (project) | `<project>-meeting-notes/` beside the project folder |
| Meeting notes (no project) | `~/Documents/meeting-notes/` or `default_notes_dir` |
| Token logs (debug Soniox) | `~/Library/Application Support/com.personal.translator/token-logs/` — giữ 20 phiên gần nhất |

## Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `⌘Enter` | Start/Stop capture |
| `⌘,` | Settings |
| `⌘1/2/3` | Audio source: system / mic / both |
| `⌘P` | Pin on top |
| `⌘D` | Compact (hide toolbar) |
| `⌘E` | Expand / shrink window |
| `⌘M` | Minimize |
| `Esc` | Back / close sheet |

## Caption bridge (Teams web)
`extension/teams-captions/` là Chrome extension đọc live captions từ DOM của
Teams web, dịch theo lô, và đẩy sang app qua WebSocket. Chọn engine
`teams-web` trong Settings để dùng — chế độ này **không đụng tới đường âm
thanh**, `start_capture` không được gọi.
- Extension lo phần dịch realtime (API, gom lô → rẻ). App lo phần tổng hợp /
  meeting note qua `claude` CLI (gói Max, $0).
- Bản dịch về sau vài giây và có thể lệch thứ tự → dùng
  `TranscriptUI.addKeyedOriginal()` / `setKeyedTranslation()` ghép theo khoá,
  **không** dùng `addTranslation()` (ghép theo vị trí, sẽ gán sai câu).
- Bảo mật: server chỉ bind 127.0.0.1, bắt buộc token khớp + `Origin` là
  `chrome-extension://`.

## Constraints & Gotchas
- **macOS only** — ScreenCaptureKit needs macOS 13+; Local MLX needs Apple Silicon.
- **Rust borrow checker**: always run `cargo check` after AI writes Rust code.
- **Tauri 2 API**: `window.__TAURI__.core.invoke`, not the v1 `window.__TAURI__.invoke`.
- **Audio pipeline**: JS does not process audio — it forwards raw PCM bytes.
- **Session reset**: the Soniox WebSocket auto-resets every 3 minutes (`soniox.js`).
- **`withGlobalTauri: true`** in tauri.conf.json enables `window.__TAURI__`.
- **No CDN**: the WebView runs offline; keep fonts/scripts local.
- **Assistant latency**: the CLI backend takes ~2-5s per call. Never put it in
  the audio path — it is for the periodic summary and on-demand suggestions.
- **Soniox pairing là GHÉP THEO VỊ TRÍ** (transcript và bản dịch là hai luồng
  token rời, không có id nối cặp). TranscriptUI tự-lành: câu gốc quá hạn
  `staleMs` (10s) bị bỏ khỏi màn hình, backlog chặn ở `maxPendingOriginals`
  (3). KHÔNG thêm hàng đợi ghép cặp song song ở nơi khác — lấy cặp từ giá trị
  trả về của `addTranslation()`. Test: `npm run dev:web` → `/dev-tests/pairing.html`.
- **Furigana** currently marks `.ja` text but has no tokenizer. `TranscriptUI`
  exposes `setFuriganaProvider(fn)`; wiring kuromoji.js (bundled offline) or a
  MeCab-backed Rust command is all that is missing.

## When Adding Features
1. **New Rust command**: add fn in `commands/`, register in `lib.rs` `.invoke_handler()`.
2. **New setting**: Rust struct + `Default`, then `settings.js` defaults, then the form in `app.js`.
3. **New UI element**: HTML in `index.html`, style in `main.css`, wire in `app.js`.
4. **New JS module**: import in `app.js`; keep modules single-responsibility.
5. **Mock it**: add the command to `tauri-mock.js` so `npm run dev:web` still works.
