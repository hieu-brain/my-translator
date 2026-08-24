/**
 * Service worker: dịch một LÔ câu qua engine đã chọn.
 *
 * Phải gọi từ đây chứ không phải content script — fetch trong content script bị
 * ràng buộc bởi CSP của trang Teams và sẽ bị chặn. Service worker thì không.
 */
import { Engines, RetryableError } from './src/engines.js';
import { AppBridge } from './src/bridge.js';

const DEFAULTS = {
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
  // Panel không tự bật lên: Teams còn dùng cho chat và gọi lẻ.
  autoOpen: false,
  translateByDefault: false,
};

// ── cầu nối sang app My Translator ───────────────────────────────────
const bridge = new AppBridge();
let bridgeStatus = { connected: false, reason: 'chưa bật' };
bridge.onStatus = (s) => {
  bridgeStatus = s;
};

async function syncBridge() {
  const cfg = await getConfig();
  bridge.configure({
    enabled: !!cfg.bridgeEnabled,
    port: Number(cfg.bridgePort) || 8477,
    token: cfg.bridgeToken || '',
  });
}
syncBridge();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.bridgeEnabled || changes.bridgePort || changes.bridgeToken) syncBridge();
});

async function getConfig() {
  // storage.local chứ không phải storage.sync: API key không nên được đồng bộ
  // lên tài khoản Google.
  const got = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...got };
}

function missingKey(cfg) {
  if (cfg.engine === 'gemini' && !cfg.geminiKey) {
    return 'Chưa nhập Google API key — mở Cài đặt';
  }
  if (cfg.engine === 'anthropic' && !cfg.apiKey) {
    return 'Chưa nhập Anthropic API key — mở Cài đặt';
  }
  return null;
}

async function translateBatch(cfg, payload, attempt = 0) {
  const engine = Engines[cfg.engine] || Engines.anthropic;
  try {
    return await engine.translate(cfg, payload);
  } catch (err) {
    if (err instanceof RetryableError && attempt < 2) {
      const wait = err.retryAfterMs || 900 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 6000)));
      return translateBatch(cfg, payload, attempt + 1);
    }
    throw err;
  }
}

/**
 * Chỉ chạy MỘT lô tại một thời điểm. Các lô đã được gom sẵn ở content script,
 * chạy song song chỉ làm rối thứ tự và dễ đụng rate limit của free tier Gemini
 * (15 request/phút).
 */
let chain = Promise.resolve();

function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (msg?.type === 'get-config') {
    getConfig().then((cfg) => sendResponse({ ...cfg, bridgeStatus }));
    return true;
  }

  // Caption đi sang app: gửi ngay lúc chốt câu (vi = null) để app hiện tiếng
  // Nhật realtime, rồi gửi lại cùng id sau khi dịch xong — app upsert theo id.
  if (msg?.type === 'bridge-caption') {
    bridge.setMeeting(msg.meeting);
    bridge.sendCaption(msg.entry);
    return false;
  }

  if (msg?.type === 'bridge-provisional') {
    bridge.sendProvisional(msg.line);
    return false;
  }

  if (msg?.type === 'translate-batch') {
    serialize(async () => {
      const cfg = await getConfig();
      const err = missingKey(cfg);
      if (err) {
        sendResponse({ ok: false, error: err });
        return;
      }
      try {
        const items = await translateBatch(cfg, {
          items: msg.items,
          context: msg.context,
        });
        sendResponse({ ok: true, items });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    });
    return true; // giữ kênh mở cho sendResponse bất đồng bộ
  }

  return false;
});

const TEAMS_HOST = /^https:\/\/teams\.(cloud\.microsoft|microsoft\.com)\//;

chrome.action.onClicked.addListener(async (tab) => {
  // Trên tab Teams: bật/tắt panel. Ngoài Teams: mở Cài đặt (không có gì để bật).
  if (tab?.id && TEAMS_HOST.test(tab.url || '')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' });
      return;
    } catch {
      // Content script chưa inject (tab mở trước khi cài extension) — reload
      // rồi bảo người dùng bấm lại còn rõ ràng hơn là im lặng không làm gì.
      chrome.tabs.reload(tab.id);
      return;
    }
  }
  chrome.runtime.openOptionsPage();
});
