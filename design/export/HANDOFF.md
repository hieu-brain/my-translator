# My Translator — Meeting Edition · Handoff / Prompt mô tả

File giao: `export/my-translator-redesign.html` (1 file duy nhất, CSS inline, không framework, không CDN — chạy offline trong WebView Tauri).
Icon app: `AppIcon.iconset/` (10 PNG, 16→1024px) + `icons/icon_1024.png`.

---

## 1. Prompt mô tả (dán cho Claude Code / dev khi cần tiếp tục)

> Đây là UI mới của app macOS overlay "My Translator" (Tauri 2, vanilla HTML/CSS/JS, always-on-top, dịch song ngữ realtime Nhật ⇄ Việt cho BrSE trong cuộc họp).
>
> **Ngôn ngữ thiết kế:** dark glass (nền `rgba(19,18,23,.92)` + `backdrop-filter: blur(28px)`), hệ màu theo Material 3 tonal roles: primary periwinkle `#a5a8ff` (on-primary `#22267a`), secondary mint `#7fd6c2`, tertiary amber `#ffd18a`, error `#ff5449`, on-surface `#e7e4ec`. Không dùng shadow, không gradient trên surface. Bo góc 7/10/14px. Font: system stack (`-apple-system`, có `Hiragino Sans` cho tiếng Nhật).
>
> **Transcript (trung tâm):** caption block một cột. Mỗi block = hàng speaker (avatar tròn chữ cái + tên có thể click sửa + pill ngôn ngữ nguồn → pill ngôn ngữ đích + timestamp) rồi **bản dịch (ngôn ngữ đích) chữ lớn, sáng, weight 500**, dưới là **bản gốc nhỏ hơn (0.74em), mờ (opacity .4)**. Hàng speaker chỉ hiện khi đổi người nói. Speaker A = periwinkle, Speaker B = mint. Click một block → highlight nền `rgba(165,168,255,.1)` và panel AI hiện gợi ý trả lời cho câu đó.
>
> **Ngôn ngữ đích:** luôn là dòng lớn. Hai chiều: khi Speaker nói JA thì dòng lớn là VI; khi nói VI thì dòng lớn là JA. Một chiều: dòng lớn luôn là ngôn ngữ đích đã cấu hình.
>
> **Furigana:** nút `ふ` trong thanh công cụ bật/tắt class `furigana-on` trên `<body>` → hiện `<rt>` trong `<ruby>` của mọi text tiếng Nhật (`.ja`), line-height nới lên 1.9. Ngoài ra mỗi token có nghĩa được bọc `<span class="tk" data-gloss="…">` — click hiện popover chữ Hán + cách đọc + nghĩa tiếng Việt (hoạt động cả khi tắt furigana).
>
> **Panel trợ lý AI (`#ai-panel`, mới):** adaptive — cửa sổ hẹp thì là drawer thu gọn ở dưới; ≥780px thì thành cột phải 300px (CSS grid, không cần JS). Nội dung: tóm tắt realtime (CHỦ ĐỀ / QUYẾT ĐỊNH / ACTIONS), nút "Tóm tắt ngay", khu "Gợi ý trả lời" hiện 2 phương án VI + JA có nút copy.
>
> **Responsive:** `@media (max-height: 330px)` → mini caption mode: ẩn header và panel AI, chỉ giữ 3 block cuối, ẩn hàng speaker và bản gốc, chữ to hơn 5px, nút Dừng + chấm trạng thái nổi góc trên phải.
>
> **Ràng buộc:** giữ nguyên toàn bộ `id` cũ mà JS app đang bind, giữ `data-tauri-drag-region`, không thêm CDN. Đã bỏ hoàn toàn TTS/Read.

---

## 2. Những gì đã thay đổi so với layout cũ

| Trước | Sau |
|---|---|
| Dual-view 2 cột cuộn độc lập, dễ lệch dòng | Caption block 1 cột, gốc + dịch luôn dính nhau |
| Speaker label cam mờ, không phân biệt người | Avatar chữ cái + màu riêng từng speaker, tên sửa được inline |
| Badge cờ 🇯🇵/🇻🇳 | Pill chữ JA / VI, pill đích tô màu primary |
| Không có trợ lý AI | `#ai-panel` adaptive (drawer / cột phải) |
| Không có furigana | Nút `ふ` + popover từ vựng |
| Toolbar 3 hàng (drag + status + action) | Header gọn + 1 hàng action duy nhất, engine đưa vào menu ⋯ |
| Tab Live / Đọc / Thư viện | Live / Thư viện (bỏ Đọc + TTS) |
| Emoji trong UI | Icon line-art SVG (stroke 1.7–2) |

## 3. ID được giữ nguyên (JS app bind theo)

`overlay-view`, `drag-region`, `btn-settings`, `settings-badge`, `btn-window-mode`, `btn-pin`, `btn-minimize`, `btn-close`, `live-tab-badge`, `live-lang`, `transcript-container`, `transcript-content`, `select-audio-source`, `btn-start`, `icon-play`, `icon-stop`, `btn-start-label`, `btn-pause`, `status-indicator`, `status-text`, `btn-more`, `more-menu`, `btn-copy`, `btn-clear`, `btn-compact`, `btn-auto-hide`, `btn-shortcuts`, `btn-font-up`, `btn-font-down`, `font-size-display`, `btn-view-mode`, `engine-pill`, `engine-picker`, `library-panel`, `sessions-list-panel`, `input-session-search`, `btn-open-transcripts`, `sessions-list`, `session-viewer`, `btn-session-back-to-list`, `session-viewer-title`, `btn-session-edit-title`, `btn-session-export-srt`, `btn-session-export-txt`, `btn-session-copy`, `session-viewer-content`, `resize-handle`, `settings-view`, `settings-drag`, `btn-back`, `btn-save-settings-top`, `settings-home`, `card-translation`, `card-translation-sub`, `card-display`, `card-display-sub`, `card-about`, `card-about-sub`, `tab-translation`, `tab-display`, `tab-about`, `select-translation-mode`, `hint-mode-*`, `openai-cost-warning`, `section-api-key`, `input-api-key`, `btn-toggle-key`, `btn-test-soniox`, `key-status-*`, `link-soniox`, `section-openai-key`, `input-openai-key`, `btn-toggle-openai-key`, `btn-test-openai`, `section-qwen-key`, `input-qwen-key`, `btn-toggle-qwen-key`, `section-languages`, `select-translation-type`, `section-oneway-langs`, `select-source-lang`, `select-target-lang`, `section-twoway-langs`, `select-lang-a`, `select-lang-b`, `hint-twoway`, `section-strict-lang`, `check-strict-lang`, `section-endpoint-delay`, `range-endpoint-delay`, `endpoint-delay-value`, `audio-source-group`, `section-soniox-context`, `btn-add-general`, `context-general-list`, `input-context-terms`, `input-context-text`, `btn-add-term`, `translation-terms-list`, `range-opacity`, `opacity-value`, `range-font-size`, `font-size-value`, `range-max-lines`, `max-lines-value`, `check-show-original`, `about-version`, `section-update`, `update-status`, `update-status-text`, `btn-check-update`, `update-actions`, `btn-do-update`, `update-btn-text`, `update-progress`, `update-progress-fill`, `update-progress-pct`, `link-github`, `link-issues`, `btn-save-settings`, `shortcut-sheet`, `setup-modal`, `setup-progress-fill`, `setup-progress-pct`, `step-check`, `step-venv`, `step-packages`, `step-models`, `setup-status-text`, `btn-cancel-setup`.

**ID mới (phần trợ lý AI + furigana — được phép thêm):** `ai-panel`, `btn-ai-toggle`, `ai-badge`, `btn-ai-summarize`, `ai-summary`, `ai-replies`, `ai-replies-empty`, `btn-furigana`, `check-furigana`.

**ID đã bỏ (TTS/Read đã loại khỏi app):** `read-panel`, `read-input`, `read-output`, `btn-read-*`, `read-voice-quick`, `read-progress*`, `read-hint`, `btn-tts`, `icon-tts-*`, `card-tts`, `tab-tts`, `select-tts-*`, `tts-*-settings`, `select-edge-voice`, `range-*-speed`, `select-google-voice`, `input-elevenlabs-key`, `input-google-tts-key`, `select-local-lang`, `local-voice-list`, `input-local-models-dir`, `btn-local-*`, `input-tiktok-*`, `select-tiktok-voice`, `select-microsoft-*`, `select-google-free-*`, `input-google-free-key`, `btn-toggle-google-*`, `btn-toggle-elevenlabs-key`, `sessions-view`, `btn-tts`. Nhớ xóa/guard các listener tương ứng trong JS app.

## 4. Cần làm phía app (JS)

1. **Render transcript** theo cấu trúc block mới:
   ```html
   <div class="seg-block spk-a" data-seg-id="…">
     <div class="speaker-row">…</div>       <!-- chỉ khi đổi speaker -->
     <span class="seg-translated">…</span>   <!-- ngôn ngữ đích -->
     <span class="seg-original ja">…</span>  <!-- thêm class "ja" nếu là tiếng Nhật -->
   </div>
   ```
   Class speaker: `spk-a` / `spk-b` (map theo speaker id, xoay vòng nếu >2 người).
2. **Furigana**: cần một bước tách token + reading (kuromoji.js bundle offline, hoặc MeCab phía Rust). Với mỗi token có kanji, bọc `<ruby>漢字<rt>かんじ</rt></ruby>`; token có nghĩa từ điển thì bọc thêm `<span class="tk" data-gloss="nghĩa">…<span class="tk-popover">…</span></span>`.
3. **Provisional**: dùng `.seg-provisional-block` — thay nội dung tại chỗ (không remove/append lại) để tránh nhấp nháy.
4. **Panel AI**: `#btn-ai-summarize` gọi API tóm tắt; khi user click `.seg-block`, gửi câu đó lên LLM lấy 2–3 gợi ý trả lời, render vào `#ai-replies`; không có lựa chọn thì hiện `#ai-replies-empty`.
5. **Font size**: set biến CSS `--transcript-font-size` trên `:root` (đã hỗ trợ tới 44px+, mini mode tự +5px).
6. Xóa block `<script>` demo ở cuối file trước khi tích hợp — nó chỉ để xem thử mockup.

## 5. Icon

- Nguồn vector: `AppIcon.dc.html` (SVG 1024×1024, có thể sửa và chụp lại).
- Đã xuất: `AppIcon.iconset/icon_{16,32,128,256,512}x…png` (bản `@2x` đang lưu tên `-2x`).
- Tạo `.icns`:
  ```bash
  cd AppIcon.iconset && for f in *-2x.png; do mv "$f" "${f/-2x/@2x}"; done && cd ..
  iconutil -c icns AppIcon.iconset -o AppIcon.icns
  ```
- Đặt vào `src-tauri/icons/` và khai báo trong `tauri.conf.json`.
