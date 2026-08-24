const FIELDS = {
  engine: 'anthropic',
  apiKey: '',
  model: 'claude-haiku-4-5',
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  sourceLang: 'Tiếng Nhật',
  targetLang: 'Tiếng Việt',
  glossary: '',
  batchSize: 6,
  maxWaitMs: 8000,
  bridgeEnabled: false,
  bridgePort: 8477,
  bridgeToken: '',
  autoOpen: false,
  translateByDefault: false,
};

const NUMERIC = new Set(['batchSize', 'maxWaitMs', 'bridgePort']);
const BOOLEAN = new Set(['bridgeEnabled', 'autoOpen', 'translateByDefault']);

/**
 * Giá $/triệu token (input, output) — chỉ để ước lượng hiển thị, không dùng để
 * tính tiền thật. Gemini free tier tính là 0.
 */
const PRICES = {
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5': [3, 15],
  'claude-opus-5': [5, 25],
};

function el(id) {
  return document.getElementById(id);
}

function syncPanes() {
  const engine = el('engine').value;
  el('pane-anthropic').classList.toggle('hidden', engine !== 'anthropic');
  el('pane-gemini').classList.toggle('hidden', engine !== 'gemini');
  updateCost();
}

/** Ước lượng thô cho 1 giờ họp nói liên tục (~900 câu). */
function updateCost() {
  const engine = el('engine').value;
  const batch = Math.max(1, Number(el('batchSize').value) || 6);
  const LINES = 900;
  const calls = Math.ceil(LINES / batch);

  if (engine === 'gemini') {
    const rpm = calls / 60;
    el('cost').textContent =
      `Ước lượng 1 giờ họp: ~${calls} request (~${rpm.toFixed(1)}/phút). ` +
      (rpm > 15
        ? '⚠ Vượt free tier 15 request/phút — tăng số câu mỗi lô.'
        : 'Nằm trong free tier.');
    return;
  }

  const [pin, pout] = PRICES[el('model').value] || PRICES['claude-haiku-4-5'];
  // system ~250 token + ngữ cảnh ~120 + nội dung ~45/câu; output ~35/câu
  const inTok = calls * (250 + 120) + LINES * 45;
  const outTok = LINES * 35;
  const usd = (inTok / 1e6) * pin + (outTok / 1e6) * pout;
  el('cost').textContent =
    `Ước lượng 1 giờ họp: ~${calls} request, khoảng $${usd.toFixed(2)} ` +
    `(~${Math.round(usd * 26000).toLocaleString('vi-VN')}₫). Con số tham khảo, không phải hoá đơn.`;
}

async function showBridgeStatus() {
  try {
    const cfg = await chrome.runtime.sendMessage({ type: 'get-config' });
    const s = cfg?.bridgeStatus;
    el('bridgeStatus').textContent = !cfg?.bridgeEnabled
      ? 'Cầu nối đang tắt.'
      : s?.connected
        ? '✓ Đã nối với app.'
        : `Chưa nối được (${s?.reason || 'đang thử lại'}) — app đã mở và bật caption bridge chưa?`;
  } catch {
    el('bridgeStatus').textContent = '';
  }
}

async function load() {
  const cfg = await chrome.storage.local.get(FIELDS);
  for (const key of Object.keys(FIELDS)) {
    const node = el(key);
    if (!node) continue;
    if (BOOLEAN.has(key)) node.checked = !!(cfg[key] ?? FIELDS[key]);
    else node.value = cfg[key] ?? FIELDS[key];
  }
  syncPanes();
  showBridgeStatus();
}

async function save() {
  const out = {};
  for (const key of Object.keys(FIELDS)) {
    const node = el(key);
    if (!node) continue;
    if (BOOLEAN.has(key)) out[key] = node.checked;
    else if (NUMERIC.has(key)) out[key] = Number(node.value) || FIELDS[key];
    else out[key] = node.value.trim();
  }
  await chrome.storage.local.set(out);
  setTimeout(showBridgeStatus, 1200);

  const status = el('status');
  status.textContent = 'Đã lưu. Reload tab Teams để áp dụng.';
  status.classList.add('show');
  setTimeout(() => status.classList.remove('show'), 2500);
}

el('save').addEventListener('click', save);
el('engine').addEventListener('change', syncPanes);
el('model').addEventListener('change', updateCost);
el('batchSize').addEventListener('input', updateCost);
load();
