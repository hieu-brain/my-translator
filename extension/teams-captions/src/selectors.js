/**
 * Selectors cho live captions của Teams web.
 *
 * Đã xác minh trực tiếp trên teams.cloud.microsoft (Edge WebView 149) trong một
 * cuộc họp thật: 23/23 row đều có đủ text + tên + MRI.
 *
 *   [data-tid="closed-caption-v2-window-wrapper"]     ← container để gắn observer
 *     └ .fui-ChatMessageCompact                       ← 1 dòng caption
 *         ├ .fui-ChatMessageCompact__avatar
 *         │   └ [data-person-mri="8:orgid:…"]         ← ID người nói (ổn định)
 *         ├ .fui-ChatMessageCompact__author           ← "檜山 治樹"
 *         └ .fui-ChatMessageCompact__body
 *             └ … > [data-tid="closed-caption-text"]  ← text thuần, không lẫn tên
 *
 * Nếu Teams đổi layout, đây là file duy nhất cần sửa.
 */
const SEL = {
  root: '[data-tid="closed-caption-v2-window-wrapper"]',
  row: '.fui-ChatMessageCompact',
  text: '[data-tid="closed-caption-text"]',
  author: '.fui-ChatMessageCompact__author',
  mri: '[data-person-mri]',
};

/** Đọc toàn bộ dòng caption đang có trong DOM. */
function snapshotCaptions(root) {
  const out = [];
  for (const row of root.querySelectorAll(SEL.row)) {
    const textEl = row.querySelector(SEL.text);
    if (!textEl) continue;
    const text = textEl.textContent.trim();
    if (!text) continue;
    out.push({
      mri: row.querySelector(SEL.mri)?.getAttribute('data-person-mri') || '',
      name: row.querySelector(SEL.author)?.textContent.trim() || '',
      text,
    });
  }
  return out;
}
