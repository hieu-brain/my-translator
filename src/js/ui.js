/**
 * TranscriptUI — caption-block transcript for bilingual meetings.
 *
 * Each utterance renders as one block: an optional speaker row (avatar, editable
 * name, source → target language pills, timestamp), the translation in the
 * target language as the large primary line, and the original underneath,
 * smaller and dimmed. Original and translation therefore stay physically
 * together — the two-column layout this replaces let them drift apart as the
 * columns scrolled at different rates.
 *
 * A block is clickable: selecting one is how the user asks the meeting
 * assistant for reply suggestions to that specific sentence.
 *
 * `segments` is the render window (trimmed to keep the DOM small); `sessionLog`
 * is the complete meeting and is never trimmed — export reads from it, which is
 * why exports no longer lose the beginning of a long meeting.
 */

const SPEAKER_CLASSES = ['spk-a', 'spk-b', 'spk-c', 'spk-d'];

export class TranscriptUI {
    constructor(container) {
        this.container = container;
        this.contentEl = null;
        this.placeholderEl = container.querySelector('.transcript-placeholder');
        this.maxChars = 1200;
        this.fontSize = 16;
        /** 'dual' shows the original line, 'single' hides it. */
        this.viewMode = 'dual';

        // Tự-lành cho ghép cặp theo vị trí (khôi phục từ v0.9.0 — bản
        // Meeting Edition đánh mất cả hai khi viết lại file này):
        // câu gốc không có bản dịch sau staleMs bị BỎ khỏi màn hình, và hàng
        // chờ bị chặn trần. sessionLog không bị đụng — export vẫn đủ câu.
        this.staleMs = 10000;
        this.maxPendingOriginals = 3;

        this.segments = [];
        this.sessionLog = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;

        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;

        /** Display names keyed by speaker id, e.g. {1: 'Tanaka'}. */
        this.speakerNames = {};
        /** Stable spk-* class per speaker id, assigned first-seen-first. */
        this._speakerClasses = {};
        this._nextSpeakerClass = 0;

        this.selectedSegId = null;
        this._segCounter = 0;
        /** Set by the app: called with the selected segment (or null). */
        this.onSelect = null;
        /** Set by the app: called with (speakerId, newName). */
        this.onSpeakerRename = null;

        this._bindDelegatedEvents();
    }

    // ─── Configuration ─────────────────────────────────────

    configure({ maxLines, fontSize, fontColor, viewMode, furigana } = {}) {
        if (maxLines !== undefined) this.maxChars = maxLines * 160;
        if (fontSize !== undefined) {
            this.fontSize = fontSize;
            document.documentElement.style.setProperty('--transcript-font-size', `${fontSize}px`);
        }
        if (fontColor !== undefined) {
            document.documentElement.style.setProperty('--transcript-font-color', fontColor);
        }
        if (viewMode !== undefined) {
            this.viewMode = viewMode;
            const overlay = document.getElementById('overlay-view');
            if (overlay) overlay.classList.toggle('single-view', viewMode !== 'dual');
        }
        if (furigana !== undefined) {
            document.body.classList.toggle('furigana-on', !!furigana);
        }
    }

    /** Language pair for the header pills, e.g. {a: 'ja', b: 'vi'}. */
    setLanguagePair(sourceLang, targetLang) {
        this.sourceLang = sourceLang || null;
        this.targetLang = targetLang || null;
    }

    setSpeakerName(speakerId, name) {
        if (!speakerId) return;
        this.speakerNames[speakerId] = name;
        this._render();
    }

    // ─── Content ───────────────────────────────────────────

    /** Add a finalized source-language utterance, awaiting its translation. */
    addOriginal(text, speaker = null, language = null) {
        if (!text || !text.trim()) return;

        const seg = {
            id: `seg-${++this._segCounter}`,
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            language: language || null,
            confidence: this.lastConfidence,
            createdAt: Date.now(),
        };
        this.segments.push(seg);
        this.sessionLog.push({ ...seg });

        if (speaker) this.currentSpeaker = speaker;
        if (language) this.currentLanguage = language;
        this._cleanupStaleOriginals();
        this._render();
    }

    /**
     * Like `addOriginal`, but tagged with a caller-supplied key so the
     * translation can be attached later by key instead of by position.
     *
     * Nguồn caption ngoài (extension Teams) dịch theo lô, bản dịch về sau vài
     * giây và có thể lệch thứ tự — ghép theo vị trí như Soniox sẽ gán nhầm câu.
     */
    addKeyedOriginal(key, text, speaker = null, language = null) {
        if (!text || !text.trim()) return;
        if (this.segments.some((s) => s.extKey === key)) return; // gửi lại, bỏ qua

        const seg = {
            id: `seg-${++this._segCounter}`,
            extKey: key,
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            language: language || null,
            confidence: null,
            createdAt: Date.now(),
        };
        this.segments.push(seg);
        this.sessionLog.push({ ...seg });

        if (speaker) this.currentSpeaker = speaker;
        if (language) this.currentLanguage = language;
        this._cleanupStaleOriginals();
        this._render();
    }

    /** Attach a translation to the segment carrying `key`. */
    setKeyedTranslation(key, text) {
        if (!text || !text.trim()) return;
        for (const list of [this.segments, this.sessionLog]) {
            const seg = list.find((s) => s.extKey === key);
            if (seg) {
                seg.translation = text;
                seg.status = 'translated';
            }
        }
        this._render();
    }

    /**
     * Attach a translation to the oldest untranslated segment. Soniox emits the
     * translation as a separate token stream, so the pairing is positional.
     */
    addTranslation(text) {
        if (!text || !text.trim()) return null;

        // extKey segments pair by key (setKeyedTranslation) — positional
        // pairing must never consume them.
        const pending = this.segments.find(
            (s) => !s.extKey && s.status === 'original'
        );
        if (pending) {
            pending.translation = text;
            pending.status = 'translated';
            const logged = this.sessionLog.find(
                (s) => s.id === pending.id
            );
            if (logged) {
                logged.translation = text;
                logged.status = 'translated';
            }
            this._render();
            // Trả về cặp vừa ghép: app dùng nó để ghi sessionStore, nên log
            // và màn hình luôn thống nhất một nguồn ghép duy nhất.
            return pending;
        }

        // Translation with no pending source (engine restarted mid-stream):
        // keep it rather than dropping the user's content on the floor.
        const seg = {
            id: `seg-${++this._segCounter}`,
            original: null,
            translation: text,
            status: 'translated',
            speaker: this.currentSpeaker,
            language: this.currentLanguage,
            confidence: this.lastConfidence,
            createdAt: Date.now(),
        };
        this.segments.push(seg);
        this.sessionLog.push({ ...seg });
        this._render();
        return seg;
    }

    setProvisional(text, speaker = null, language = null) {
        this.provisionalText = text || '';
        this.provisionalSpeaker = speaker || this.currentSpeaker;
        this.provisionalLanguage = language || this.currentLanguage;
        this._renderProvisional();
    }

    clearProvisional() {
        if (!this.provisionalText) return;
        this.provisionalText = '';
        this._renderProvisional();
    }

    setConfidence(confidence) {
        this.lastConfidence = confidence;
    }

    clear() {
        this.segments = [];
        this.sessionLog = [];
        this.provisionalText = '';
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.selectedSegId = null;
        this._segCounter = 0;
        this._ensureContent();
        this.contentEl.innerHTML = '';
        this._removeStatus();
        this.showPlaceholder();
        if (this.onSelect) this.onSelect(null);
    }

    hasContent() {
        return this.sessionLog.length > 0;
    }

    // ─── Placeholder / status ──────────────────────────────

    showPlaceholder() {
        this.container.classList.add('empty');
    }

    hidePlaceholder() {
        this.container.classList.remove('empty');
    }

    showListening() {
        this.hidePlaceholder();
        this._ensureContent();
        if (this.container.querySelector('.listening-indicator')) return;
        const el = document.createElement('div');
        el.className = 'listening-indicator';
        el.innerHTML = '<span class="prov-dots"><span>●</span><span>●</span><span>●</span></span>';
        this.container.appendChild(el);
    }

    removeListening() {
        const el = this.container.querySelector('.listening-indicator');
        if (el) el.remove();
    }

    showStatusMessage(message) {
        this.hidePlaceholder();
        let el = this.container.querySelector('.pipeline-status');
        if (!el) {
            el = document.createElement('div');
            el.className = 'pipeline-status';
            this.container.appendChild(el);
        }
        el.textContent = message;
    }

    removeStatusMessage() {
        this._removeStatus();
    }

    _removeStatus() {
        const el = this.container.querySelector('.pipeline-status');
        if (el) el.remove();
        this.removeListening();
    }

    // ─── Selection ─────────────────────────────────────────

    getSelectedSegment() {
        if (!this.selectedSegId) return null;
        return this.sessionLog.find((s) => s.id === this.selectedSegId) || null;
    }

    /** The most recent finished utterance — what "trả lời câu vừa rồi" means. */
    getLastSegment() {
        for (let i = this.sessionLog.length - 1; i >= 0; i--) {
            if (this.sessionLog[i].translation || this.sessionLog[i].original) {
                return this.sessionLog[i];
            }
        }
        return null;
    }

    selectSegment(segId) {
        this.selectedSegId = segId || null;
        this.contentEl?.querySelectorAll('.seg-block').forEach((el) => {
            el.classList.toggle('selected', el.dataset.segId === this.selectedSegId);
        });
        if (this.onSelect) this.onSelect(this.getSelectedSegment());
    }

    _bindDelegatedEvents() {
        this.container.addEventListener('click', (e) => {
            // Renaming a speaker must not also select the block underneath.
            const label = e.target.closest('.speaker-label');
            if (label && label.dataset.speaker) {
                e.stopPropagation();
                this._startRename(label);
                return;
            }

            const tk = e.target.closest('.tk[data-gloss]');
            if (tk) {
                e.stopPropagation();
                const wasOpen = tk.classList.contains('pop-open');
                this.container.querySelectorAll('.tk.pop-open')
                    .forEach((el) => el.classList.remove('pop-open'));
                tk.classList.toggle('pop-open', !wasOpen);
                return;
            }

            const block = e.target.closest('.seg-block');
            if (!block || block.classList.contains('seg-provisional-block')) return;
            const id = block.dataset.segId;
            this.selectSegment(this.selectedSegId === id ? null : id);
        });
    }

    _startRename(label) {
        const speakerId = label.dataset.speaker;
        const input = document.createElement('input');
        input.className = 'speaker-name-input';
        input.value = this.speakerNames[speakerId] || `Speaker ${speakerId}`;
        label.replaceWith(input);
        input.focus();
        input.select();

        const commit = () => {
            const name = input.value.trim();
            if (name) {
                this.speakerNames[speakerId] = name;
                if (this.onSpeakerRename) this.onSpeakerRename(speakerId, name);
            }
            this._render();
        };
        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') {
                input.value = '';
                this._render();
            }
        });
    }

    // ─── Rendering ─────────────────────────────────────────

    _ensureContent() {
        if (!this.contentEl || !this.contentEl.isConnected) {
            this.contentEl = this.container.querySelector('.transcript-flow');
            if (!this.contentEl) {
                this.contentEl = document.createElement('div');
                this.contentEl.className = 'transcript-flow';
                this.container.insertBefore(this.contentEl, this.container.firstChild);
            }
        }
        return this.contentEl;
    }

    _render() {
        this._ensureContent();
        this._trimSegments();
        if (this.segments.length) this.hidePlaceholder();

        const atBottom = this._isNearBottom();
        let html = '';
        let lastSpeaker = null;

        for (const seg of this.segments) {
            // Câu có extKey đến từ nguồn ngoài (extension Teams): bản dịch về
            // sau vài giây vì gom lô, và có thể không bao giờ về nếu người dùng
            // tắt dịch. Giữ lại "một nhịp" ở đây nghĩa là không hiện gì cả —
            // vẽ luôn bản gốc, bản dịch tới thì thay.
            if (!seg.extKey && seg.status === 'original' && !seg.translation) {
                // Source captured, translation still in flight — showing the raw
                // source as the big line then swapping it for the translation
                // reads as flicker, so hold the block back one beat.
                continue;
            }
            const showSpeakerRow = seg.speaker && seg.speaker !== lastSpeaker;
            if (seg.speaker) lastSpeaker = seg.speaker;
            html += this._renderBlock(seg, showSpeakerRow);
        }

        this.contentEl.innerHTML = html;
        this._renderProvisional();
        if (atBottom) this._scrollToBottom();
    }

    _renderBlock(seg, showSpeakerRow) {
        const spkClass = this._speakerClass(seg.speaker);
        const selected = seg.id === this.selectedSegId ? ' selected' : '';
        const lowConf =
            seg.confidence !== null && seg.confidence !== undefined && seg.confidence < 0.7
                ? ' low-confidence'
                : '';

        let html = `<div class="seg-block ${spkClass}${selected}" data-seg-id="${seg.id}">`;
        if (showSpeakerRow) html += this._renderSpeakerRow(seg);

        const targetLang = this._targetLangFor(seg);
        const translated = seg.translation || seg.original || '';
        const tgtJa = targetLang === 'ja' ? ' ja' : '';
        html += `<span class="seg-translated${tgtJa}${lowConf}">${this._decorate(translated, targetLang)}</span>`;

        if (seg.original && seg.translation) {
            const srcJa = seg.language === 'ja' ? ' ja' : '';
            html += `<span class="seg-original${srcJa}">${this._decorate(seg.original, seg.language)}</span>`;
        }
        html += '</div>';
        return html;
    }

    _renderSpeakerRow(seg) {
        const id = seg.speaker;
        const name = this.speakerNames[id] || `Speaker ${id}`;
        const initial = this._esc(name.trim().charAt(0).toUpperCase() || '?');
        const src = (seg.language || this.sourceLang || '').toUpperCase();
        const tgt = (this._targetLangFor(seg) || '').toUpperCase();
        const time = new Date(seg.createdAt || Date.now()).toTimeString().slice(0, 5);

        let row = '<div class="speaker-row">';
        row += `<span class="speaker-avatar">${initial}</span>`;
        row += `<button class="speaker-label" type="button" data-speaker="${this._escAttr(id)}" title="Click để đổi tên">${this._esc(name)}</button>`;
        if (src) row += `<span class="lang-badge">${this._esc(src)}</span>`;
        if (src && tgt && src !== tgt) {
            row += '<svg class="lang-arrow" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
            row += `<span class="lang-badge target">${this._esc(tgt)}</span>`;
        }
        row += `<span class="seg-time">${time}</span>`;
        row += '</div>';
        return row;
    }

    _renderProvisional() {
        this._ensureContent();
        const existing = this.contentEl.querySelector('.seg-provisional-block');

        if (!this.provisionalText) {
            if (existing) existing.remove();
            return;
        }
        this.hidePlaceholder();

        const lang = this.provisionalLanguage;
        const ja = lang === 'ja' ? ' ja' : '';
        const inner =
            `<span class="seg-provisional${ja}">${this._esc(this.provisionalText)}` +
            '<span class="prov-dots"><span>●</span><span>●</span><span>●</span></span></span>';

        if (existing) {
            // Replace in place: removing and re-appending the node makes the
            // caret-like dots restart and the block visibly flash on every
            // partial-token update, which arrive several times per second.
            const body = existing.querySelector('.seg-provisional');
            if (body) {
                body.className = `seg-provisional${ja}`;
                body.innerHTML =
                    `${this._esc(this.provisionalText)}<span class="prov-dots"><span>●</span><span>●</span><span>●</span></span>`;
                return;
            }
            existing.innerHTML = inner;
            return;
        }

        const atBottom = this._isNearBottom();
        const block = document.createElement('div');
        block.className = `seg-block seg-provisional-block ${this._speakerClass(this.provisionalSpeaker)}`;
        let html = '';
        if (this.provisionalSpeaker) {
            const name = this.speakerNames[this.provisionalSpeaker] || `Speaker ${this.provisionalSpeaker}`;
            html += '<div class="speaker-row">';
            html += `<span class="speaker-avatar">${this._esc(name.charAt(0).toUpperCase())}</span>`;
            html += `<span class="speaker-label" style="cursor:default">${this._esc(name)}</span>`;
            html += '<span class="lang-badge prov-badge">ĐANG NGHE</span>';
            html += '</div>';
        }
        block.innerHTML = html + inner;
        this.contentEl.appendChild(block);
        if (atBottom) this._scrollToBottom();
    }

    /**
     * Wrap Japanese text for the furigana/vocabulary layer.
     *
     * A real reading requires morphological analysis (kuromoji/MeCab), which is
     * not bundled yet. Until it is, text is escaped and returned as-is — the
     * `.ja` class and the CSS are already in place, so adding a tokenizer later
     * is a matter of filling in `furiganaProvider` and nothing else.
     */
    _decorate(text, lang) {
        const escaped = this._esc(text);
        if (lang !== 'ja' || !this.furiganaProvider) return escaped;
        try {
            return this.furiganaProvider(text) || escaped;
        } catch {
            return escaped;
        }
    }

    /** Install a tokenizer that returns ruby-annotated HTML for Japanese text. */
    setFuriganaProvider(fn) {
        this.furiganaProvider = fn;
        this._render();
    }

    _targetLangFor(seg) {
        // Two-way mode: the target is whichever configured language the speaker
        // is *not* speaking.
        if (this.langA && this.langB && seg.language) {
            if (seg.language === this.langA) return this.langB;
            if (seg.language === this.langB) return this.langA;
        }
        return this.targetLang || null;
    }

    setTwoWayLanguages(langA, langB) {
        this.langA = langA || null;
        this.langB = langB || null;
    }

    _speakerClass(speakerId) {
        if (!speakerId) return SPEAKER_CLASSES[0];
        if (!this._speakerClasses[speakerId]) {
            this._speakerClasses[speakerId] =
                SPEAKER_CLASSES[this._nextSpeakerClass % SPEAKER_CLASSES.length];
            this._nextSpeakerClass++;
        }
        return this._speakerClasses[speakerId];
    }

    _trimSegments() {
        let total = this.segments.reduce(
            (n, s) => n + (s.translation?.length || 0) + (s.original?.length || 0),
            0
        );
        while (total > this.maxChars && this.segments.length > 1) {
            const dropped = this.segments.shift();
            total -= (dropped.translation?.length || 0) + (dropped.original?.length || 0);
        }
    }

    /**
     * Drop source segments that never received a translation. Without this a
     * single dropped translation token stalls the positional pairing in
     * `addTranslation` and every later translation lands on the wrong sentence.
     */
    _cleanupStaleOriginals() {
        // BỎ câu quá hạn khỏi màn hình chứ không "thăng cấp" bản gốc thành
        // bản dịch — thăng cấp là nguồn của lỗi "ngập ngừng": cục tiếng Nhật
        // hiện muộn 15s giữa luồng tiếng Việt. sessionLog giữ nguyên để
        // export vẫn đủ câu. Câu extKey ghép theo khoá, bản dịch đến muộn là
        // bình thường — miễn trừ.
        const now = Date.now();
        const isPending = (s) => !s.extKey && s.status === 'original';

        this.segments = this.segments.filter(
            (s) => !(isPending(s) && now - s.createdAt > this.staleMs)
        );

        // Trần hàng chờ: nếu bản dịch ngừng về (token 'none', rơi mạng),
        // backlog không được phình — quá trần thì bỏ câu cũ nhất.
        const pending = this.segments.filter(isPending);
        while (pending.length > this.maxPendingOriginals) {
            const oldest = pending.shift();
            const idx = this.segments.indexOf(oldest);
            if (idx !== -1) this.segments.splice(idx, 1);
        }
    }

    // ─── Scroll ────────────────────────────────────────────

    _scroller() {
        // #transcript-content is the scroller; its parent is overflow:hidden.
        return this.container;
    }

    _isNearBottom() {
        const el = this._scroller();
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }

    _scrollToBottom() {
        const el = this._scroller();
        if (el) el.scrollTop = el.scrollHeight;
    }

    // ─── Export ────────────────────────────────────────────

    getPlainText() {
        return this.sessionLog
            .map((s) => {
                const parts = [];
                if (s.speaker) parts.push(`[${this.speakerNames[s.speaker] || `Speaker ${s.speaker}`}]`);
                if (s.translation) parts.push(s.translation);
                if (s.original && s.original !== s.translation) parts.push(`(${s.original})`);
                return parts.join(' ');
            })
            .join('\n');
    }

    /**
     * Full-session Markdown. `metadata.summary` is the assistant's final rolling
     * summary — it goes above the transcript so the note opens with what the
     * meeting decided rather than with minute one of the raw captions.
     */
    getFullSessionText(metadata = {}) {
        if (this.sessionLog.length === 0) return null;

        const lines = [];
        const now = new Date();
        const title = metadata.title || 'Cuộc họp';

        lines.push(`# ${title}`);
        lines.push('');
        const started = metadata.startedAt ? new Date(metadata.startedAt) : now;
        const when = `${started.toISOString().slice(0, 10)} ${started.toTimeString().slice(0, 5)}`;
        lines.push(`- Ngày giờ: ${when}${metadata.duration ? ` · ${metadata.duration}` : ''}`);
        if (metadata.project) lines.push(`- Dự án: ${metadata.project}`);
        const pair = metadata.languagePair
            || [metadata.sourceLang, metadata.targetLang].filter(Boolean).join(' → ');
        if (pair) lines.push(`- Ngôn ngữ: ${pair}${metadata.mode ? ` · Engine: ${metadata.mode}` : ''}`);
        const speakers = Object.entries(this.speakerNames)
            .map(([id, name]) => `${name} (#${id})`)
            .join(', ');
        if (speakers) lines.push(`- Người nói: ${speakers}`);
        lines.push(`- Số câu: ${this.sessionLog.length}`);
        lines.push('');

        if (metadata.summary) {
            lines.push('## Tóm tắt');
            lines.push('');
            lines.push(metadata.summary.trim());
            lines.push('');
        }

        lines.push('## Transcript');
        lines.push('');
        let lastSpeaker = null;
        for (const seg of this.sessionLog) {
            if (seg.speaker && seg.speaker !== lastSpeaker) {
                lines.push('');
                lines.push(`**${this.speakerNames[seg.speaker] || `Speaker ${seg.speaker}`}**`);
                lastSpeaker = seg.speaker;
            }
            const time = new Date(seg.createdAt).toTimeString().slice(0, 8);
            if (seg.translation) lines.push(`[${time}] ${seg.translation}`);
            if (seg.original && seg.original !== seg.translation) lines.push(`> ${seg.original}`);
        }

        return lines.join('\n').trim();
    }

    /** Compact transcript for the LLM: no timestamps, speaker-prefixed. */
    getTranscriptForLLM({ sinceIndex = 0, max = 400 } = {}) {
        return this.sessionLog
            .slice(sinceIndex, sinceIndex + max)
            .map((s) => {
                const who = s.speaker
                    ? this.speakerNames[s.speaker] || `Speaker ${s.speaker}`
                    : 'Ai đó';
                const text = s.translation || s.original || '';
                const orig = s.original && s.original !== s.translation ? ` // ${s.original}` : '';
                return `${who}: ${text}${orig}`;
            })
            .join('\n');
    }

    get segmentCount() {
        return this.sessionLog.length;
    }

    // ─── Escaping ──────────────────────────────────────────

    _esc(str) {
        const div = document.createElement('div');
        div.textContent = str ?? '';
        return div.innerHTML;
    }

    _escAttr(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
    }
}
