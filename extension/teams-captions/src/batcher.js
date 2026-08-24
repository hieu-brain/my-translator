/**
 * Gom nhiều câu thành một request dịch.
 *
 * Đây là đòn bẩy chi phí lớn nhất: dịch từng câu nghĩa là system prompt (~250
 * token) bị gửi lại ~900 lần mỗi giờ họp. Gom 6 câu một lần giảm số request 6
 * lần và chia đều system prompt — chi phí giảm khoảng một bậc độ lớn.
 *
 * Đánh đổi: bản dịch trễ thêm vài giây. Giảm maxWaitMs / batchSize nếu cần bám sát.
 */
class TranslationBatcher {
  /**
   * @param {(items: {id:number,name:string,ja:string}[]) => Promise<void>} flushFn
   * @param {{batchSize?:number, maxWaitMs?:number}} [opts]
   */
  constructor(flushFn, { batchSize = 6, maxWaitMs = 8000 } = {}) {
    this.flushFn = flushFn;
    this.batchSize = batchSize;
    this.maxWaitMs = maxWaitMs;
    this.queue = [];
    this.timer = null;
  }

  configure({ batchSize, maxWaitMs }) {
    if (batchSize) this.batchSize = batchSize;
    if (maxWaitMs) this.maxWaitMs = maxWaitMs;
  }

  push(item) {
    this.queue.push(item);
    if (this.queue.length >= this.batchSize) {
      this.flush();
      return;
    }
    // Đồng hồ chạy từ câu ĐẦU TIÊN trong lô, không reset theo từng câu mới —
    // nếu không, lúc họp nói liên tục thì lô sẽ không bao giờ được gửi đi.
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.maxWaitMs);
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    this.flushFn(batch);
  }

  /** Bỏ những câu đang chờ (khi người dùng tắt dịch). */
  drop() {
    clearTimeout(this.timer);
    this.timer = null;
    const dropped = this.queue;
    this.queue = [];
    return dropped;
  }

  get pending() {
    return this.queue.length;
  }
}
