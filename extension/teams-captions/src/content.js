/**
 * Nối observer ↔ store ↔ panel ↔ dịch theo lô.
 *
 * Panel KHÔNG tự bật lên: Teams còn dùng cho chat và gọi lẻ, tự hiện mỗi lần
 * load trang là phiền. Bấm icon extension trên thanh công cụ để bật/tắt.
 * Đóng panel = ngừng đọc caption luôn, không chạy ngầm.
 */

(async function main() {
  if (window.__tcbLoaded) return;
  window.__tcbLoaded = true;

  const cfg = await getConfig();

  const store = new TranscriptStore();
  await store.restore();

  const batcher = new TranslationBatcher((items) => flushBatch(items));
  batcher.configure(cfg);

  const panel = new CaptionPanel(
    store,
    {
      onClear: () => store.clear(),
      onToggleTranslate: (on) => {
        if (on) translateBacklog();
        else batcher.drop();
      },
      onOpenChange: (open) => (open ? watcher.start() : stopWatching()),
    },
    { translateOn: !!cfg.translateByDefault },
  );

  const geo = await chrome.storage.local.get('tcb_geometry').catch(() => null);
  panel.loadGeometry(geo?.tcb_geometry);
  panel.refresh();

  // Icon trên thanh công cụ bật/tắt panel.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toggle-panel') panel.toggle();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.batchSize || changes.maxWaitMs)) {
      getConfig().then((c) => batcher.configure(c));
    }
  });

  // Tên cuộc họp lấy từ title tab: "(24) Calendar | 制作部定例 | Microsoft Teams"
  const syncTitle = () => {
    const parts = document.title.split('|').map((s) => s.trim());
    const name = parts.length >= 3 ? parts[1] : '';
    if (name && name !== store.title) store.setTitle(name);
  };
  syncTitle();
  setInterval(syncTitle, 5000);

  // ---- cầu nối sang app My Translator ----

  function pushToApp(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, ...payload });
    } catch {
      /* service worker đang ngủ dậy — bridge tự gửi bù khi nối lại */
    }
  }

  let lastProvSentAt = 0;

  const stabilizer = new CaptionStabilizer({
    onFinal: (line) => {
      if (panel.isPaused()) return;
      const entry = store.add({ mri: line.mri, name: line.name, ja: line.text });
      // Gửi sang app kể cả khi không dịch — app vẫn lưu bản gốc tiếng Nhật và
      // meeting assistant vẫn tổng hợp được.
      pushToApp('bridge-caption', { entry, meeting: store.title });
      if (panel.isTranslateOn()) {
        batcher.push({ id: entry.id, name: entry.name, ja: entry.ja });
      }
    },
    onProvisional: (line) => {
      panel.setProvisional(line);
      // Provisional đổi ~2-3 lần/giây; hạn chế bớt để không đánh thức service
      // worker liên tục.
      const now = Date.now();
      if (line && now - lastProvSentAt > 300) {
        lastProvSentAt = now;
        pushToApp('bridge-provisional', { line });
      }
    },
  });

  const watcher = new CaptionWatcher(stabilizer, {
    onStateChange: (s) => panel.setState(s),
  });

  function stopWatching() {
    watcher.stop();
    batcher.drop();
    panel.setProvisional(null);
  }

  if (cfg.autoOpen) panel.show();

  // ---- dịch ----

  async function getConfig() {
    try {
      return (await chrome.runtime.sendMessage({ type: 'get-config' })) || {};
    } catch {
      return {};
    }
  }

  async function flushBatch(items) {
    if (!items.length) return;
    // Ngữ cảnh lấy từ câu ngay trước câu đầu tiên của lô.
    const context = store.contextBefore(items[0].id, 4).map((e) => ({
      name: e.name,
      ja: e.ja,
      vi: e.vi,
    }));

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'translate-batch',
        items,
        context,
      });
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }
    if (!res) return; // service worker chết giữa chừng

    if (!res.ok) {
      for (const it of items) store.setError(it.id, res.error);
      return;
    }

    const byId = new Map(res.items.map((x) => [x.i, x.vi]));
    for (const it of items) {
      const vi = byId.get(it.id);
      if (!vi) {
        store.setError(it.id, 'Model bỏ sót câu này');
        continue;
      }
      store.setTranslation(it.id, vi);
      // Gửi lại cùng id — app upsert bản dịch vào câu đã có.
      const entry = store.entries.find((e) => e.id === it.id);
      if (entry) pushToApp('bridge-caption', { entry, meeting: store.title });
    }
  }

  /** Đưa lại những câu còn trống vào hàng đợi (bật lại nút VI, hoặc thử lại lỗi). */
  function translateBacklog() {
    for (const e of store.entries) {
      if (!e.vi) batcher.push({ id: e.id, name: e.name, ja: e.ja });
    }
  }

  window.addEventListener('beforeunload', () => {
    stabilizer.flush();
    batcher.flush();
  });
})();
