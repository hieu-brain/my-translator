/**
 * Ghi nguyên luồng token Soniox ra file .jsonl (append-only) để phát lại
 * offline. Mục đích: khi lỗi ghép cặp xảy ra giữa một cuộc họp thật, mọi lần
 * sửa sau đó đều kiểm chứng được trên đúng dữ liệu đã gây lỗi — không phải
 * chờ (và hy vọng) cuộc họp tiếp theo tái hiện.
 *
 * File nằm ở ~/Library/Application Support/com.personal.translator/token-logs/
 * — Rust giữ 20 phiên gần nhất, tự dọn phần cũ. Ghi lỗi thì chỉ warn: đây là
 * công cụ chẩn đoán, không được làm phiền phiên dịch thật.
 */

const { invoke } = window.__TAURI__.core;

const FLUSH_EVERY = 25;   // dòng
const FLUSH_MS = 2000;

export class TokenLogger {
    constructor() {
        this.file = null;     // null = không ghi
        this.t0 = 0;
        this.buf = [];
        this.timer = null;
        this.path = null;     // đường dẫn đầy đủ — Rust trả về sau lần ghi đầu
    }

    start(label = 'soniox') {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        this.file =
            `${label}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
            `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jsonl`;
        this.t0 = Date.now();
        this.buf = [];
        this.log({ kind: 'session_start', at: d.toISOString() });
    }

    /**
     * Ghi một sự kiện {kind, ...}. Trường `raw` (chuỗi JSON từ WS) được nhúng
     * đã-parse thành `msg` cho dễ phân tích bằng jq; parse hỏng thì giữ raw.
     */
    log(evt) {
        if (!this.file) return;
        const line = { t: Date.now() - this.t0, ...evt };
        if (typeof line.raw === 'string') {
            try {
                line.msg = JSON.parse(line.raw);
                delete line.raw;
            } catch { /* giữ raw nguyên trạng */ }
        }
        this.buf.push(JSON.stringify(line));
        if (this.buf.length >= FLUSH_EVERY) this._flush();
        else if (!this.timer) this.timer = setTimeout(() => this._flush(), FLUSH_MS);
    }

    async stop() {
        if (!this.file) return;
        this.log({ kind: 'session_end' });
        const done = this._flush();
        this.file = null;
        await done;
    }

    async _flush() {
        clearTimeout(this.timer);
        this.timer = null;
        if (!this.buf.length) return;
        const lines = this.buf;
        this.buf = [];
        const file = this.file;
        if (!file) return;
        try {
            this.path = await invoke('append_token_log', { file, lines });
        } catch (err) {
            console.warn('[token-log] ghi thất bại:', err);
        }
    }
}

export const tokenLogger = new TokenLogger();
