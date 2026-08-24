/**
 * Lưu transcript của phiên hiện tại.
 *
 * Giữ trong bộ nhớ + ghi xuống chrome.storage.local (throttle 2s) để reload
 * trang giữa cuộc họp không mất dữ liệu — quan trọng vì phần export là mục đích
 * chính của extension.
 */
const STORE_KEY = 'tcb_session';

class TranscriptStore {
  constructor() {
    /** @type {{id:number, at:string, mri:string, name:string, ja:string, vi:string|null, err:string|null}[]} */
    this.entries = [];
    this.startedAt = new Date().toISOString();
    this.title = '';
    this.nextId = 1;
    this.listeners = new Set();
    this.saveTimer = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify() {
    for (const fn of this.listeners) fn(this);
    this.#scheduleSave();
  }

  add({ mri, name, ja }) {
    const entry = {
      id: this.nextId++,
      at: new Date().toISOString(),
      mri,
      name,
      ja,
      vi: null,
      err: null,
    };
    this.entries.push(entry);
    this.#notify();
    return entry;
  }

  setTranslation(id, vi) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.vi = vi;
    e.err = null;
    this.#notify();
  }

  setError(id, err) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.err = err;
    this.#notify();
  }

  /** Câu gần nhất, để làm ngữ cảnh cho bản dịch. */
  contextBefore(id, n = 6) {
    const i = this.entries.findIndex((x) => x.id === id);
    const end = i === -1 ? this.entries.length : i;
    return this.entries.slice(Math.max(0, end - n), end);
  }

  clear() {
    this.entries = [];
    this.startedAt = new Date().toISOString();
    this.nextId = 1;
    this.#notify();
  }

  setTitle(t) {
    this.title = t;
    this.#notify();
  }

  #scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      chrome.storage.local
        .set({
          [STORE_KEY]: {
            startedAt: this.startedAt,
            title: this.title,
            nextId: this.nextId,
            entries: this.entries,
          },
        })
        .catch(() => {});
    }, 2000);
  }

  async restore() {
    try {
      const got = await chrome.storage.local.get(STORE_KEY);
      const s = got?.[STORE_KEY];
      if (!s?.entries?.length) return false;
      this.startedAt = s.startedAt || this.startedAt;
      this.title = s.title || '';
      this.entries = s.entries;
      this.nextId = s.nextId || this.entries.length + 1;
      this.#notify();
      return true;
    } catch {
      return false;
    }
  }
}
