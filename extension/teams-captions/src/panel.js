/**
 * Panel nổi hiển thị caption + bản dịch.
 *
 * Dựng trong Shadow DOM để CSS Fluent UI của Teams không đụng tới, và ngược lại
 * React của Teams không thể remount/xoá node của chúng ta (lý do không chèn
 * inline vào khung caption gốc — xem ghi chú trong stabilizer.js).
 */

const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Hiragino Sans", sans-serif; }

.wrap {
  position: fixed; z-index: 2147483000;
  display: flex; flex-direction: column;
  background: rgba(20,20,24,.94);
  color: #e8e8ec;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.5);
  backdrop-filter: blur(12px);
  overflow: hidden;
  font-size: 14px;
}
.wrap.compact { box-shadow: 0 6px 20px rgba(0,0,0,.4); }

header {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px;
  background: rgba(255,255,255,.05);
  border-bottom: 1px solid rgba(255,255,255,.08);
  cursor: move; user-select: none;
  flex: 0 0 auto;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex: 0 0 auto; }
.dot.live { background: #34d399; box-shadow: 0 0 8px #34d399; }
.title { font-size: 12px; font-weight: 600; letter-spacing: .02em; opacity: .85; margin-right: auto; white-space: nowrap; }
.count { font-size: 11px; opacity: .5; font-variant-numeric: tabular-nums; }

button {
  all: unset;
  padding: 3px 7px; border-radius: 6px; cursor: pointer;
  font-size: 11px; line-height: 1.5; color: #cfcfd6;
  border: 1px solid transparent;
}
button:hover { background: rgba(255,255,255,.1); color: #fff; }
button.on { background: rgba(129,140,248,.22); color: #c7d2fe; border-color: rgba(129,140,248,.4); }

.menu-wrap { position: relative; }
.menu {
  position: absolute; right: 0; top: 100%; margin-top: 4px;
  background: #26262e; border: 1px solid rgba(255,255,255,.14);
  border-radius: 8px; padding: 4px; min-width: 150px;
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  display: none; flex-direction: column; gap: 2px;
}
.menu.open { display: flex; }
.menu button { display: block; padding: 6px 10px; font-size: 12px; }

.body { flex: 1 1 auto; overflow-y: auto; padding: 8px 10px; scroll-behavior: smooth; }
.body::-webkit-scrollbar { width: 8px; }
.body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 4px; }

.hint { opacity: .45; font-size: 12px; padding: 14px 4px; text-align: center; line-height: 1.6; }

.line { padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
.line:last-child { border-bottom: none; }
.meta { display: flex; gap: 6px; align-items: baseline; font-size: 11px; opacity: .55; margin-bottom: 3px; }
.who { font-weight: 600; opacity: .9; }
.ja { font-size: 13px; line-height: 1.55; opacity: .68; }
.vi { font-size: 15px; line-height: 1.5; color: #a5f3d0; margin-top: 3px; }
.vi.pending { opacity: .35; color: #cfcfd6; font-style: italic; }
.vi.err { color: #fca5a5; font-size: 12px; }

.prov { padding: 7px 0; opacity: .55; font-style: italic; }
.prov .ja { opacity: .8; }

.compact .body { padding: 6px 10px; }
.compact .meta { display: none; }
.compact .ja { font-size: 12px; }
.compact .vi { font-size: 14px; }
.compact .line { border-bottom: none; padding: 4px 0; }

.resize {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, rgba(255,255,255,.25) 50%);
}
.pill {
  position: fixed; z-index: 2147483000;
  display: flex; align-items: center; gap: 7px;
  padding: 8px 13px; border-radius: 999px;
  background: rgba(20,20,24,.94); color: #e8e8ec;
  border: 1px solid rgba(255,255,255,.14);
  box-shadow: 0 8px 24px rgba(0,0,0,.45);
  cursor: pointer; font-size: 12px; font-weight: 600;
  backdrop-filter: blur(12px);
}
.hidden { display: none !important; }
`;

class CaptionPanel {
  /**
   * @param {TranscriptStore} store
   * @param {{onClear:Function, onToggleTranslate:Function}} handlers
   */
  constructor(store, handlers = {}, opts = {}) {
    this.store = store;
    this.handlers = handlers;
    this.compact = false;
    this.paused = false;
    // Mặc định KHÔNG dịch: Teams không chỉ dùng để họp, và bật dịch là bắt đầu
    // tốn tiền. Người dùng bật nút VI khi thật sự cần.
    this.translateOn = !!opts.translateOn;
    this.open = false;
    this.provisional = null;
    this.stuckToBottom = true;

    this.host = document.createElement('div');
    this.host.id = 'teams-captions-bridge';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(this.host);

    this.#render();
    this.store.onChange(() => this.refresh());
  }

  #render() {
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <header>
        <span class="dot"></span>
        <span class="title">Captions</span>
        <span class="count"></span>
        <button data-act="translate" title="Bật/tắt dịch">VI</button>
        <button data-act="compact" title="Thu gọn còn 3 dòng cuối">▤</button>
        <button data-act="pause" title="Tạm dừng ghi">❙❙</button>
        <span class="menu-wrap">
          <button data-act="menu" title="Xuất transcript">⤓</button>
          <span class="menu">
            <button data-act="export-txt">Lưu .txt</button>
            <button data-act="export-md">Lưu .md</button>
            <button data-act="export-json">Lưu .json</button>
            <button data-act="copy">Copy vào clipboard</button>
            <button data-act="clear">Xoá transcript</button>
            <button data-act="options">Cài đặt…</button>
          </span>
        </span>
        <button data-act="min" title="Thu nhỏ (vẫn ghi)">—</button>
        <button data-act="close" title="Đóng và ngừng ghi">✕</button>
      </header>
      <div class="body"><div class="hint">Đang chờ live captions của Teams…<br>Bật <b>More → Language and speech → Turn on live captions</b>.</div></div>
      <div class="resize"></div>
    `;

    wrap.classList.add('hidden'); // mặc định không tự bật lên
    const pill = document.createElement('div');
    pill.className = 'pill hidden';
    pill.innerHTML = `<span class="dot"></span><span>Captions</span>`;

    this.shadow.append(style, wrap, pill);
    this.wrap = wrap;
    this.pill = pill;
    this.bodyEl = wrap.querySelector('.body');
    this.countEl = wrap.querySelector('.count');
    this.dotEl = wrap.querySelector('.dot');
    this.menuEl = wrap.querySelector('.menu');

    this.#applyGeometry();
    this.#wireEvents();
    if (this.translateOn) wrap.querySelector('[data-act="translate"]').classList.add('on');
  }

  /** Mở panel và bắt đầu ghi. */
  show() {
    if (this.open) return;
    this.open = true;
    this.wrap.classList.remove('hidden');
    this.pill.classList.add('hidden');
    this.handlers.onOpenChange?.(true);
    this.refresh();
  }

  /** Đóng hẳn: ẩn panel VÀ ngừng ghi. Khác với "—" (thu nhỏ, vẫn ghi). */
  hide() {
    if (!this.open) return;
    this.open = false;
    this.wrap.classList.add('hidden');
    this.pill.classList.add('hidden');
    this.handlers.onOpenChange?.(false);
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  #wireEvents() {
    this.wrap.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act !== 'menu') this.menuEl.classList.remove('open');
      this.#onAction(act, e.target);
    });

    this.pill.addEventListener('click', () => {
      this.pill.classList.add('hidden');
      this.wrap.classList.remove('hidden');
    });

    this.bodyEl.addEventListener('scroll', () => {
      const gap =
        this.bodyEl.scrollHeight - this.bodyEl.scrollTop - this.bodyEl.clientHeight;
      this.stuckToBottom = gap < 40;
    });

    this.#makeDraggable(this.wrap.querySelector('header'));
    this.#makeResizable(this.wrap.querySelector('.resize'));
  }

  #onAction(act, el) {
    switch (act) {
      case 'menu':
        this.menuEl.classList.toggle('open');
        break;
      case 'translate':
        this.translateOn = !this.translateOn;
        el.classList.toggle('on', this.translateOn);
        this.handlers.onToggleTranslate?.(this.translateOn);
        break;
      case 'compact':
        this.compact = !this.compact;
        el.classList.toggle('on', this.compact);
        this.wrap.classList.toggle('compact', this.compact);
        this.#applyGeometry();
        this.refresh();
        break;
      case 'pause':
        this.paused = !this.paused;
        el.classList.toggle('on', this.paused);
        break;
      case 'min':
        this.wrap.classList.add('hidden');
        this.pill.classList.remove('hidden');
        break;
      case 'close':
        this.hide();
        break;
      case 'export-txt':
      case 'export-md':
      case 'export-json': {
        const kind = act.split('-')[1];
        const count = this.store.entries.length;
        if (!count) return this.#flash('Chưa có gì để xuất');
        if (Exporter.download(this.store, kind)) {
          // Đã lưu ra file thì dọn luôn, để cuộc họp sau bắt đầu từ trang trắng.
          // Chỉ dọn khi tải về THÀNH CÔNG — thất bại mà xoá là mất dữ liệu.
          this.handlers.onClear?.();
          this.#flash(`Đã lưu ${count} câu và dọn transcript`);
        } else {
          Exporter.copyToClipboard(this.store, kind).then(
            () => this.#flash('Tải về bị chặn — đã copy vào clipboard, chưa dọn'),
            () => this.#flash('Không xuất được'),
          );
        }
        break;
      }
      case 'copy':
        Exporter.copyToClipboard(this.store).then(
          () => this.#flash('Đã copy transcript'),
          () => this.#flash('Không copy được'),
        );
        break;
      case 'clear':
        if (confirm('Xoá toàn bộ transcript của phiên này?')) {
          this.handlers.onClear?.();
        }
        break;
      case 'options':
        chrome.runtime.sendMessage({ type: 'open-options' });
        break;
    }
  }

  setState(state) {
    const live = state === 'live';
    this.dotEl.classList.toggle('live', live);
    this.pill.querySelector('.dot').classList.toggle('live', live);
  }

  setProvisional(line) {
    this.provisional = this.paused ? null : line;
    this.refresh();
  }

  isPaused() {
    return this.paused;
  }

  isTranslateOn() {
    return this.translateOn;
  }

  refresh() {
    const all = this.store.entries;
    const shown = this.compact ? all.slice(-3) : all;
    this.countEl.textContent = all.length ? `${all.length} câu` : '';

    if (!all.length && !this.provisional) {
      if (!this.bodyEl.querySelector('.hint')) {
        this.bodyEl.innerHTML =
          '<div class="hint">Đang chờ live captions của Teams…<br>Bật <b>More → Language and speech → Turn on live captions</b>.</div>';
      }
      return;
    }

    const frag = document.createDocumentFragment();
    for (const e of shown) frag.appendChild(this.#lineNode(e));
    if (this.provisional) frag.appendChild(this.#provNode(this.provisional));

    this.bodyEl.replaceChildren(frag);
    if (this.stuckToBottom) this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  #lineNode(e) {
    const div = document.createElement('div');
    div.className = 'line';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = e.name || '???';
    const at = document.createElement('span');
    at.textContent = new Date(e.at).toLocaleTimeString();
    meta.append(who, at);

    const ja = document.createElement('div');
    ja.className = 'ja';
    ja.textContent = e.ja;

    div.append(meta, ja);

    if (e.err) {
      const err = document.createElement('div');
      err.className = 'vi err';
      err.textContent = `⚠ ${e.err}`;
      div.appendChild(err);
    } else if (e.vi) {
      const vi = document.createElement('div');
      vi.className = 'vi';
      vi.textContent = e.vi;
      div.appendChild(vi);
    } else if (this.translateOn) {
      const vi = document.createElement('div');
      vi.className = 'vi pending';
      vi.textContent = 'đang dịch…';
      div.appendChild(vi);
    }
    return div;
  }

  #provNode(line) {
    const div = document.createElement('div');
    div.className = 'prov';
    const ja = document.createElement('div');
    ja.className = 'ja';
    ja.textContent = `${line.name ? line.name + ': ' : ''}${line.text}`;
    div.appendChild(ja);
    return div;
  }

  #flash(msg) {
    const old = this.wrap.querySelector('.title').textContent;
    this.wrap.querySelector('.title').textContent = msg;
    setTimeout(() => {
      this.wrap.querySelector('.title').textContent = old;
    }, 2200);
  }

  // ---- vị trí / kích thước, nhớ lại giữa các lần mở ----

  #applyGeometry() {
    const g = this.geometry || (this.geometry = { right: 24, bottom: 96, w: 420, h: 460 });
    const s = this.wrap.style;
    s.right = `${g.right}px`;
    s.bottom = `${g.bottom}px`;
    s.width = `${g.w}px`;
    s.height = this.compact ? 'auto' : `${g.h}px`;
    s.maxHeight = this.compact ? '190px' : '';
    this.pill.style.right = `${g.right}px`;
    this.pill.style.bottom = `${g.bottom}px`;
  }

  loadGeometry(g) {
    if (g) this.geometry = { ...this.geometry, ...g };
    this.#applyGeometry();
  }

  #saveGeometry() {
    chrome.storage.local.set({ tcb_geometry: this.geometry }).catch(() => {});
  }

  #makeDraggable(handle) {
    let sx, sy, sr, sb;
    const move = (e) => {
      this.geometry.right = Math.max(0, sr - (e.clientX - sx));
      this.geometry.bottom = Math.max(0, sb - (e.clientY - sy));
      this.#applyGeometry();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.#saveGeometry();
    };
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      sx = e.clientX;
      sy = e.clientY;
      sr = this.geometry.right;
      sb = this.geometry.bottom;
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }

  #makeResizable(grip) {
    let sx, sy, sw, sh, sr, sb;
    // Panel neo theo right/bottom. Kéo góc dưới-phải phải đồng thời đổi cả
    // right/bottom lẫn w/h, nếu không góc trên-trái sẽ trôi theo.
    const move = (e) => {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const g = this.geometry;
      g.w = Math.max(260, sw + dx);
      g.h = Math.max(160, sh + dy);
      g.right = Math.max(0, sr - (g.w - sw));
      g.bottom = Math.max(0, sb - (g.h - sh));
      this.#applyGeometry();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.#saveGeometry();
    };
    grip.addEventListener('mousedown', (e) => {
      sx = e.clientX;
      sy = e.clientY;
      sw = this.geometry.w;
      sh = this.geometry.h;
      sr = this.geometry.right;
      sb = this.geometry.bottom;
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
      e.stopPropagation();
    });
  }
}
