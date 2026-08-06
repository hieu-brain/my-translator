# My Translator — Meeting Edition

A macOS overlay that transcribes and translates **live meetings** between Vietnamese and Japanese, and gives you an AI meeting assistant on the side: a rolling summary you can glance at, and reply suggestions grounded in your actual project when someone puts you on the spot.

Personal fork of [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator) (v0.9.1), rebuilt around live meetings rather than watching video.

---

## What it does

```
System audio / Mic ──► 16kHz PCM ──► Soniox (cloud) ──┐
                                  └─► Local MLX (offline) ─┴─► Caption overlay
                                                             │
                                          ┌──────────────────┴──────────────────┐
                                          │  Meeting assistant (Claude)         │
                                          │  · rolling summary every ~2 min     │
                                          │  · reply suggestions (VI + JA)      │
                                          │  · meeting note saved per project   │
                                          └─────────────────────────────────────┘
```

| Feature | Detail |
|---|---|
| **Engines** | ☁️ Soniox (~2s, ~$0.12/hr, 70+ languages) · 🖥️ Local MLX (offline, free, Apple Silicon) |
| **Two-way translation** | Speak VI → shows JA, speak JA → shows VI, automatically |
| **Transcript** | Caption blocks: translation large, original underneath, per-speaker colours and editable names |
| **Smart scroll** | Scroll up to re-read without being yanked back to the bottom |
| **Furigana** | Toggle ruby readings over Japanese kanji (`ふ` button) |
| **Meeting assistant** | Rolling summary (topic / decisions / action items) + reply suggestions in Vietnamese *and* Japanese |
| **Project context** | Assistant reads the project's `CLAUDE.md` / `README` / `docs`, its open Backlog issues, and any notes you attach |
| **Meeting notes** | Saved as Markdown with a summary header, next to the project folder |
| **Platform** | macOS 13+ only |

---

## The meeting assistant

### Backend: your Claude plan, or an API key

A Claude Max/Pro subscription cannot authenticate the Anthropic HTTP API — but the `claude` CLI on your machine is already signed in with it. The app shells out to that CLI, so assistant calls **cost nothing extra**; they draw on your plan's usage instead. Each call takes ~2-5s, which is fine for a summary that runs every couple of minutes.

Prefer per-token billing and lower latency? Switch to the **Anthropic API** backend in Settings and paste an API key. Rough cost at that point: Haiku 4.5 for summaries is ~$0.10-0.15 per meeting-hour, Sonnet 5 reply suggestions ~$0.02-0.05 each — under $0.50 for a typical meeting.

### Rolling summary

Every ~2 minutes (configurable) the assistant sends *only the new sentences* plus the previous summary, so cost stays flat as the meeting grows. If nobody has spoken, it skips the call entirely. There's a **Tóm tắt ngay** button for on-demand runs, and auto-summary can be turned off completely.

### Reply suggestions

Click any sentence in the transcript. The assistant reads it together with the project context, the running summary, and the last ~15 exchanges, then proposes 2-3 replies — each as a Vietnamese line you can think in and a polite Japanese line you can say out loud.

### Meeting profiles

Bind a meeting to a project: point at the project folder, optionally give a Backlog project key, and attach note files. That's what turns "I think that's fine but it'll take time" into an answer that references the actual codebase and the actual open tickets.

---

## Meeting notes

When you press Stop, the app writes a Markdown note:

- **With a project selected** → `<project>-meeting-notes/` *beside* the project folder (e.g. `~/Projects/my-cms` → `~/Projects/my-cms-meeting-notes/2026-08-05-….md`). Beside, not inside, so notes never show up in `git status`.
- **Without a project** → `~/Documents/meeting-notes/` (configurable).

Each note opens with the essentials, then the summary, then the full transcript:

```markdown
# Đánh giá công số renew CMS thay vì migration

- Ngày giờ: 2026-08-05 14:00 · 42 phút
- Dự án: my-cms
- Ngôn ngữ: Japanese → Vietnamese · Engine: soniox
- Người nói: Tanaka (#1), Minh (#2)
- Số câu: 184

## Tóm tắt
CHỦ ĐỀ: …
QUYẾT ĐỊNH: …
ACTIONS:
- Gửi ước tính sơ bộ · Minh · thứ Tư tuần sau

## Transcript
**Tanaka**
[14:00:12] Hôm nay tôi muốn trao đổi về việc làm mới lại CMS.
> 今日はCMSリニューアルの件について相談したいと思います。
```

Sessions are also autosaved every 15s to Application Support, so a crash costs at most one autosave interval.

---

## Setup

1. **Soniox key** — Settings → Engine dịch. Get one at [console.soniox.com](https://console.soniox.com).
2. **Assistant backend** — Settings → Trợ lý AI. Leave it on *Claude Code CLI* if you have Claude Code installed and logged in (press **Test** to confirm), or switch to the API and paste a key.
3. **Meeting profile** — add your project folder so the assistant has real context.
4. **Two-way mode** — Settings → Engine dịch → Kiểu dịch: *Hai chiều*, languages JA ⇄ VI. For video calls set Audio source to **Cả hai** (system + mic).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘↩` | Start / stop |
| `⌘1` / `⌘2` / `⌘3` | Audio source: system / mic / both |
| `⌘,` | Settings |
| `⌘P` | Pin on top |
| `⌘D` | Compact — hide the toolbar |
| `⌘E` | Expand / shrink the window |
| `⌘M` | Minimize |
| `Esc` | Back to the main view |

## Build from source

```bash
npm install
npm run tauri build
```

Requires Rust (stable), Node 18+, macOS 13+.

```bash
npm run tauri dev
```

For UI-only work without the Rust backend, `npm run dev:web` serves `src/` on `:3111` with the Tauri APIs mocked.

## Privacy

The app talks directly to the APIs you configure — there is no server in between. Audio goes to Soniox (or nowhere at all in Local MLX mode); meeting text goes to Claude only when the assistant runs. Keys and transcripts stay on your machine.

## License

MIT — as the upstream project.
