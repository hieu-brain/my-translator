/**
 * Biến chuỗi mutation thô của Teams thành các câu đã "chốt".
 *
 * Cơ chế Teams (đo thực tế, 111 mutation / 15s):
 *   1. Câu đang nói được sửa TẠI CHỖ qua characterData, cách nhau 150–400ms.
 *   2. Câu mới xuất hiện dưới dạng addedNode, text đã đầy đủ ngay lúc thêm.
 *   3. Node bị REMOVE KHÔNG có nghĩa là câu đã xong — virtual list unmount/remount
 *      row liên tục (đã thấy add rồi del cùng một câu chỉ sau 1.2s). Vì vậy:
 *        - không dùng "node bị xoá" làm tín hiệu chốt câu
 *        - không dùng node identity (WeakMap) làm khoá — phải khử trùng lặp theo
 *          nội dung, nếu không sẽ vừa mất câu vừa lặp câu.
 *
 * Quy tắc chốt:
 *   - Dòng CUỐI = provisional. Chốt khi text đứng yên quietMs.
 *   - Các dòng TRƯỚC = chốt ngay, nhưng chỉ khi đã thấy y hệt ở snapshot trước
 *     (ổn định 1 tick) → tránh bắt nhầm lúc Teams đang sửa dở.
 *   - Khử trùng lặp bằng key `mri|text` trong cửa sổ dedupeWindow câu gần nhất,
 *     để sống sót qua remount.
 */
class CaptionStabilizer {
  /**
   * @param {object} o
   * @param {(line: {mri:string,name:string,text:string}) => void} o.onFinal
   * @param {(line: object|null) => void} o.onProvisional  null = xoá provisional
   * @param {number} [o.quietMs]        text đứng yên bao lâu thì coi là chốt
   * @param {number} [o.dedupeWindow]   số key gần nhất giữ lại để khử lặp
   */
  constructor({ onFinal, onProvisional, quietMs = 1200, dedupeWindow = 30 }) {
    this.onFinal = onFinal;
    this.onProvisional = onProvisional;
    this.quietMs = quietMs;
    this.dedupeWindow = dedupeWindow;

    this.prev = [];          // snapshot của tick trước
    this.emitted = [];       // hàng đợi key đã phát (FIFO, tối đa dedupeWindow)
    this.emittedSet = new Set();
    this.pendingKey = null;  // key của dòng cuối đang chờ đứng yên
    this.pendingLine = null;
    this.timer = null;
  }

  static key(line) {
    return `${line.mri}|${line.text}`;
  }

  /** Gọi mỗi lần DOM caption thay đổi. */
  tick(rows) {
    if (!rows.length) return;

    // 1. Chốt mọi dòng trừ dòng cuối, với điều kiện ổn định 1 tick.
    for (let i = 0; i < rows.length - 1; i++) {
      const line = rows[i];
      const stable = this.prev.some(
        (p) => p.mri === line.mri && p.text === line.text,
      );
      if (stable) this.#emit(line);
    }

    // 2. Dòng cuối là provisional. Text đổi → reset đồng hồ.
    const last = rows[rows.length - 1];
    const k = CaptionStabilizer.key(last);
    if (k !== this.pendingKey) {
      this.pendingKey = k;
      this.pendingLine = last;
      this.onProvisional(last);
    }

    this.prev = rows;
    this.#armQuietTimer();
  }

  /** Gọi khi caption bị tắt / rời cuộc họp — chốt nốt câu đang treo. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.pendingLine) this.#emit(this.pendingLine);
    this.#clearPending();
  }

  #armQuietTimer() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.pendingLine) this.#emit(this.pendingLine);
      this.#clearPending();
    }, this.quietMs);
  }

  #clearPending() {
    this.pendingKey = null;
    this.pendingLine = null;
    this.onProvisional(null);
  }

  #emit(line) {
    const k = CaptionStabilizer.key(line);
    if (this.emittedSet.has(k)) return;

    this.emittedSet.add(k);
    this.emitted.push(k);
    if (this.emitted.length > this.dedupeWindow) {
      this.emittedSet.delete(this.emitted.shift());
    }

    // Câu này vừa chốt → không còn là provisional nữa.
    if (k === this.pendingKey) {
      this.pendingKey = null;
      this.pendingLine = null;
      this.onProvisional(null);
    }

    this.onFinal(line);
  }
}

/**
 * Gắn MutationObserver vào khung caption và bơm snapshot vào stabilizer.
 * Tự bám lại nếu Teams dựng lại khung caption (bật/tắt captions, đổi cuộc họp).
 */
class CaptionWatcher {
  constructor(stabilizer, { onStateChange } = {}) {
    this.stabilizer = stabilizer;
    this.onStateChange = onStateChange || (() => {});
    this.root = null;
    this.observer = null;
    this.pollId = null;
  }

  start() {
    if (this.pollId) return;
    this.#check();
    this.pollId = setInterval(() => this.#check(), 1000);
  }

  stop() {
    clearInterval(this.pollId);
    this.pollId = null;
    this.#detach();
  }

  #check() {
    const root = document.querySelector(SEL.root);
    if (root === this.root) return;

    this.#detach();
    if (!root) {
      this.onStateChange('idle');
      return;
    }

    this.root = root;
    this.observer = new MutationObserver(() => {
      this.stabilizer.tick(snapshotCaptions(root));
    });
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.onStateChange('live');
    this.stabilizer.tick(snapshotCaptions(root)); // bắt luôn lịch sử đang có
  }

  #detach() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.root) {
      this.root = null;
      this.stabilizer.flush();
    }
  }
}
