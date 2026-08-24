/**
 * Nhận caption từ Chrome extension (Teams web) qua WebSocket server trong Rust.
 *
 * Vì sao có: Teams tự nhận dạng tiếng Nhật rất tốt và phân biệt được người nói,
 * nhưng bản dịch realtime của nó kém. Extension đọc caption từ DOM và dịch,
 * rồi đẩy sang đây để app dùng lại meeting assistant + meeting note qua gói Max.
 *
 * Đây là nguồn thay thế cho Soniox/MLX — không đụng gì tới đường âm thanh.
 */

const { invoke, Channel } = window.__TAURI__.core;

class CaptionBridge {
  constructor() {
    /** @type {(evt: object) => void} */
    this.onCaption = () => {};
    this.onProvisional = () => {};
    this.onStatusChange = () => {};
    this.onError = () => {};
    this.connected = false;
    this.meeting = '';
    /** id câu → đã hiện chưa; để phân biệt câu mới với cập nhật bản dịch. */
    this._seen = new Set();
  }

  async start({ port, token }) {
    if (!token) throw new Error('Chưa có token caption bridge — mở Cài đặt');

    this._seen.clear();
    const channel = new Channel();
    channel.onmessage = (evt) => this._handle(evt);

    await invoke('start_caption_bridge', { port, token, channel });
    this.onStatusChange('connecting');
  }

  async stop() {
    try {
      await invoke('stop_caption_bridge');
    } catch (err) {
      console.error('stop_caption_bridge:', err);
    }
    this.connected = false;
    this._seen.clear();
    this.onStatusChange('disconnected');
  }

  _handle(evt) {
    switch (evt?.type) {
      case 'listening':
        this.onStatusChange('connecting');
        break;
      case 'connected':
        this.connected = true;
        this.meeting = evt.meeting || '';
        this.onStatusChange('connected');
        break;
      case 'disconnected':
        this.connected = false;
        this.onStatusChange('connecting'); // server vẫn nghe, chờ extension nối lại
        break;
      case 'caption': {
        // Extension gửi câu hai lần: lúc chốt (vi = null) và lúc dịch xong
        // (cùng id, có vi). Lần đầu là câu mới, lần sau là cập nhật.
        const isNew = !this._seen.has(evt.id);
        this._seen.add(evt.id);
        this.onCaption({
          id: evt.id,
          at: evt.at,
          name: evt.name,
          mri: evt.mri,
          ja: evt.ja,
          vi: evt.vi ?? null,
          isNew,
        });
        break;
      }
      case 'provisional':
        this.onProvisional(evt.text, evt.name);
        break;
      case 'error':
        this.onError(evt.message);
        break;
    }
  }
}

export const captionBridge = new CaptionBridge();
