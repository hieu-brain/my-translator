/**
 * WebSocket client đẩy caption sang app My Translator (chạy trong service worker).
 *
 * Mục đích: app gọi được `claude` CLI (gói Max, $0) để tổng hợp cuộn / gợi ý
 * trả lời / ghi meeting note. Extension không làm được vì Chrome không spawn
 * process. Phần dịch realtime vẫn ở lại extension.
 *
 * Phải mở WebSocket từ service worker chứ không phải content script: content
 * script bị ràng buộc bởi CSP của trang Teams và sẽ bị chặn.
 */

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

class AppBridge {
  constructor() {
    this.ws = null;
    this.cfg = { enabled: false, port: 8477, token: '' };
    this.attempt = 0;
    this.retryTimer = null;
    this.meeting = '';
    /** Câu chưa gửi được — gửi bù khi nối lại. Giới hạn để không phình vô hạn. */
    this.pending = [];
    this.onStatus = () => {};
  }

  configure(cfg) {
    const changed =
      cfg.enabled !== this.cfg.enabled ||
      cfg.port !== this.cfg.port ||
      cfg.token !== this.cfg.token;
    this.cfg = { ...this.cfg, ...cfg };
    if (!changed) return;
    this.#disconnect();
    if (this.cfg.enabled) this.#connect();
    else this.onStatus({ connected: false, reason: 'tắt' });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setMeeting(name) {
    if (!name || name === this.meeting) return;
    this.meeting = name;
    this.#send({ type: 'hello', meeting: name });
  }

  sendCaption(entry) {
    this.#send({
      type: 'caption',
      id: entry.id,
      at: entry.at,
      name: entry.name || '',
      mri: entry.mri || '',
      ja: entry.ja,
      vi: entry.vi ?? null,
    });
  }

  sendProvisional(line) {
    // Provisional đổi liên tục — bỏ qua nếu chưa nối, không cần gửi bù.
    if (!this.connected) return;
    this.ws.send(
      JSON.stringify({ type: 'provisional', name: line.name || '', text: line.text }),
    );
  }

  #send(msg) {
    if (this.connected) {
      try {
        this.ws.send(JSON.stringify(msg));
        return;
      } catch {
        /* rơi xuống hàng đợi bên dưới */
      }
    }
    if (!this.cfg.enabled) return;
    this.pending.push(msg);
    if (this.pending.length > 500) this.pending.shift();
  }

  #connect() {
    clearTimeout(this.retryTimer);
    if (!this.cfg.enabled || !this.cfg.token) return;

    const url = `ws://127.0.0.1:${this.cfg.port}/?token=${encodeURIComponent(this.cfg.token)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.#scheduleRetry(String(e?.message || e));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.onStatus({ connected: true });
      if (this.meeting) {
        ws.send(JSON.stringify({ type: 'hello', meeting: this.meeting }));
      }
      const backlog = this.pending;
      this.pending = [];
      for (const msg of backlog) {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          this.pending.push(msg);
        }
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.#scheduleRetry('mất kết nối');
    };

    // onerror luôn kèm theo onclose — chỉ ghi nhận, việc thử lại để onclose lo.
    ws.onerror = () => {};
  }

  #scheduleRetry(reason) {
    this.onStatus({ connected: false, reason });
    if (!this.cfg.enabled) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.#connect(), wait);
  }

  #disconnect() {
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.send(JSON.stringify({ type: 'bye' }));
      } catch {}
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

export { AppBridge };
