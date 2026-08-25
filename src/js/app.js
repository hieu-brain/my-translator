/**
 * App — main controller for My Translator, Meeting Edition.
 *
 * Wires the transcript UI, the Soniox / Local MLX engines, session persistence,
 * and the meeting assistant. Two engines only: Soniox (cloud, the default) and
 * Local MLX (offline fallback on Apple Silicon).
 */

import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { captionBridge } from './caption-bridge.js';
import { tokenLogger } from './token-log.js';
import { sonioxClient } from './soniox.js';
import { sessionStore } from './session-store.js';
import { MeetingAssistant } from './meeting-assistant.js';
import { llmBackend } from './llm-backend.js';
import { contextProviders } from './context-providers.js';
import {
    initShell,
    setActivity,
    getActivity,
    setLiveBadge,
    startAutoHideWatch,
    stopAutoHideWatch,
    toggleManualCompact,
    isAutoHideEnabled,
    setAutoHideEnabled,
    bindMenu,
    initWindowModes,
    toggleWindowMode,
} from './ui-shell.js';

const { invoke } = window.__TAURI__.core;

const LANG_NAMES = {
    auto: 'Tự phát hiện', ja: 'Japanese', vi: 'Vietnamese', en: 'English',
    zh: 'Chinese', ko: 'Korean', th: 'Thai', fr: 'French', de: 'German',
    es: 'Spanish', pt: 'Portuguese', ru: 'Russian', id: 'Indonesian',
};

class App {
    constructor() {
        this.appWindow = window.__TAURI__.window.getCurrentWindow();
        this.transcriptUI = new TranscriptUI(document.getElementById('transcript-content'));
        this.assistant = new MeetingAssistant(this.transcriptUI);

        this.isRunning = false;
        this.isPinned = true;
        this.isCompact = false;
        this.currentSource = 'system';
        this.translationMode = 'soniox';
        this.isAppleSilicon = false;

        this.sessionStartTime = null;
        this.sessionSourceLang = 'auto';
        this.sessionTargetLang = 'vi';
        this.sessionMode = 'one_way';
        this.localPipelineReady = false;

        this._teamsSegments = new Map();
        this._currentViewedSession = null;
    }

    // ─── Bootstrap ─────────────────────────────────────────

    async init() {
        initShell();
        await initWindowModes(this.appWindow);

        await settingsManager.load();
        const settings = settingsManager.get();

        await this._checkPlatformSupport();

        this._applySettings(settings);
        this._populateSettingsForm(settings);
        this._bindEvents();
        this._bindKeyboardShortcuts();
        this._bindEngineCallbacks();
        this._bindAssistant();

        sessionStore.init({
            engine: settings.translation_mode || 'soniox',
            sourceLang: settings.source_language || 'auto',
            targetLang: settings.target_language || 'vi',
        });

        await this._restoreWindowPosition();
        await this._bindCloseHooks();

        this.transcriptUI.showPlaceholder();
        this._updateStatus('disconnected');
        this._updateStartButton();

        document.getElementById('about-version').textContent = 'v0.9.1 · meeting';
    }

    async _checkPlatformSupport() {
        try {
            const info = JSON.parse(await invoke('get_platform_info'));
            this.isAppleSilicon = info.os === 'macos' && info.is_arm_hardware;
        } catch {
            this.isAppleSilicon = false;
        }
        if (!this.isAppleSilicon) {
            const opt = document.querySelector('#select-translation-mode option[value="local"]');
            if (opt) {
                opt.disabled = true;
                opt.textContent = 'Local MLX (chỉ Apple Silicon)';
            }
        }
    }

    // ─── Event wiring ──────────────────────────────────────

    _bindEvents() {
        // Window chrome
        document.getElementById('btn-close').addEventListener('click', () => this.appWindow.close());
        document.getElementById('btn-minimize')?.addEventListener('click', () => this.appWindow.minimize());
        document.getElementById('btn-pin').addEventListener('click', () => this._togglePin());
        document.getElementById('btn-settings').addEventListener('click', () => this._showView('settings'));
        document.getElementById('btn-back').addEventListener('click', () => this._closeSettings());
        document.getElementById('btn-save-settings').addEventListener('click', () => this._saveSettingsFromForm());
        document.getElementById('btn-save-settings-top').addEventListener('click', () => this._saveSettingsFromForm());

        // Transport
        document.getElementById('btn-start').addEventListener('click', () => this._toggleCapture());
        document.getElementById('btn-pause').addEventListener('click', () => this.pause());
        document.getElementById('select-audio-source').addEventListener('change', (e) => {
            this._setSource(e.target.value);
        });

        // Transcript controls
        document.getElementById('btn-font-up').addEventListener('click', () => this._adjustFontSize(2));
        document.getElementById('btn-font-down').addEventListener('click', () => this._adjustFontSize(-2));
        document.getElementById('btn-view-mode').addEventListener('click', () => this._toggleViewMode());
        document.getElementById('btn-furigana').addEventListener('click', () => this._toggleFurigana());

        bindMenu('btn-more', 'more-menu');
        document.getElementById('btn-copy').addEventListener('click', () => this._copyTranscript());
        document.getElementById('btn-clear').addEventListener('click', () => {
            this.transcriptUI.clear();
            this.assistant.reset();
        });
        document.getElementById('btn-compact').addEventListener('click', () => this._toggleCompact());
        document.getElementById('btn-auto-hide').addEventListener('click', () => {
            const on = !isAutoHideEnabled();
            setAutoHideEnabled(on);
            this._showToast(on ? 'Tự ẩn thanh công cụ: BẬT' : 'Tự ẩn thanh công cụ: TẮT');
        });
        document.getElementById('btn-shortcuts').addEventListener('click', () => {
            document.getElementById('shortcut-sheet').style.display = 'flex';
        });
        document.getElementById('shortcut-sheet').addEventListener('click', (e) => {
            if (e.target.id === 'shortcut-sheet') e.currentTarget.style.display = 'none';
        });

        // Settings navigation
        document.querySelectorAll('.settings-card').forEach((card) => {
            card.addEventListener('click', () => this._showSettingsScreen(card.dataset.screen));
        });
        document.querySelectorAll('.settings-back-row').forEach((btn) => {
            btn.addEventListener('click', () => this._showSettingsScreen(btn.dataset.screen));
        });

        this._bindSettingsForm();

        // Library
        document.addEventListener('activity-changed', ({ detail }) => {
            if (detail.activity === 'library') this._showSessions();
        });
        document.getElementById('input-session-search').addEventListener('input', (e) => {
            clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => this._showSessions(e.target.value), 220);
        });
        document.getElementById('btn-open-transcripts').addEventListener('click', () => {
            invoke('open_transcript_dir').catch((err) => this._showToast(String(err), 'error'));
        });
        document.getElementById('btn-session-back-to-list').addEventListener('click', () => this._showSessions());
        document.getElementById('btn-session-export-srt').addEventListener('click', () => this._exportCurrentSession('srt'));
        document.getElementById('btn-session-export-txt').addEventListener('click', () => this._exportCurrentSession('txt'));
        document.getElementById('btn-session-copy').addEventListener('click', () => {
            const text = document.getElementById('session-viewer-content').textContent;
            navigator.clipboard.writeText(text);
            this._showToast('Đã copy nội dung session');
        });
        document.getElementById('btn-session-edit-title').addEventListener('click', () => this._renameViewedSession());

        // Resize handle (frameless window has no native grip on this edge)
        this._bindResizeHandle();

        document.getElementById('link-issues')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener?.openUrl('https://github.com/phuc-nt/my-translator/issues');
        });
        document.getElementById('link-soniox')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener?.openUrl('https://console.soniox.com');
        });
    }

    _bindSettingsForm() {
        const bindRange = (id, valueId, fmt) => {
            const el = document.getElementById(id);
            const out = document.getElementById(valueId);
            if (!el || !out) return;
            el.addEventListener('input', () => { out.textContent = fmt(el.value); });
        };
        bindRange('range-opacity', 'opacity-value', (v) => `${v}%`);
        bindRange('range-font-size', 'font-size-value', (v) => `${v}px`);
        bindRange('range-max-lines', 'max-lines-value', (v) => v);
        bindRange('range-endpoint-delay', 'endpoint-delay-value', (v) => `${(v / 1000).toFixed(1)}s`);
        bindRange('range-summary-interval', 'summary-interval-value', (v) => `${v}s`);
        bindRange('range-summary-min-segments', 'summary-min-segments-value', (v) => `${v} câu`);

        document.getElementById('range-font-size').addEventListener('input', (e) => {
            this.transcriptUI.configure({ fontSize: parseInt(e.target.value, 10) });
            document.getElementById('font-size-display').textContent = e.target.value;
        });
        document.getElementById('range-opacity').addEventListener('input', (e) => {
            document.documentElement.style.setProperty('--overlay-opacity', e.target.value / 100);
        });

        document.getElementById('select-translation-mode').addEventListener('change', (e) => {
            this._updateModeUI(e.target.value);
        });
        document.getElementById('select-translation-type').addEventListener('change', (e) => {
            this._updateTranslationTypeUI(e.target.value);
        });
        document.getElementById('select-llm-backend').addEventListener('change', (e) => {
            this._updateLlmBackendUI(e.target.value);
        });

        const toggleReveal = (btnId, inputId) => {
            document.getElementById(btnId)?.addEventListener('click', () => {
                const input = document.getElementById(inputId);
                input.type = input.type === 'password' ? 'text' : 'password';
            });
        };
        toggleReveal('btn-toggle-key', 'input-api-key');
        toggleReveal('btn-toggle-anthropic-key', 'input-anthropic-key');
        toggleReveal('btn-toggle-backlog-key', 'input-backlog-key');
        toggleReveal('btn-toggle-bridge-token', 'input-bridge-token');
        document.getElementById('btn-copy-bridge-token')?.addEventListener('click', async () => {
            const token = document.getElementById('input-bridge-token').value.trim();
            if (!token) return;
            try {
                await navigator.clipboard.writeText(token);
                this._showToast('Đã copy token — dán vào Cài đặt của extension');
            } catch {
                this._showToast('Không copy được, chọn thủ công', 'error');
            }
        });

        document.getElementById('btn-test-soniox').addEventListener('click', () => this._testSoniox());
        document.getElementById('btn-test-claude-cli').addEventListener('click', () => this._testClaudeCli());

        document.getElementById('btn-add-term').addEventListener('click', () => this._addTermRow());
        document.getElementById('btn-add-general').addEventListener('click', () => this._addGeneralRow());
        document.getElementById('btn-add-profile').addEventListener('click', () => this._addProfileRow());

        document.getElementById('select-meeting-profile').addEventListener('change', () => this._refreshNotesDirHint());
        document.getElementById('input-default-notes-dir').addEventListener('input', () => this._refreshNotesDirHint());
        document.getElementById('btn-pick-notes-dir').addEventListener('click', () => this._pickNotesDir());
    }

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

            if (e.key === 'Escape') {
                const sheet = document.getElementById('shortcut-sheet');
                if (sheet.style.display === 'flex') { sheet.style.display = 'none'; return; }
                if (document.getElementById('settings-view').classList.contains('active')) {
                    this._closeSettings();
                }
                return;
            }
            if (!e.metaKey && !e.ctrlKey) return;

            switch (e.key) {
                case 'Enter':
                    e.preventDefault();
                    this._toggleCapture();
                    break;
                case ',':
                    e.preventDefault();
                    this._showView('settings');
                    break;
                case '1': case '2': case '3':
                    if (inField) return;
                    e.preventDefault();
                    this._setSource(['system', 'microphone', 'both'][Number(e.key) - 1]);
                    break;
                case 'p': case 'P':
                    if (inField) return;
                    e.preventDefault();
                    this._togglePin();
                    break;
                case 'd': case 'D':
                    if (inField) return;
                    e.preventDefault();
                    this._toggleCompact();
                    break;
                case 'm': case 'M':
                    if (inField) return;
                    e.preventDefault();
                    this.appWindow.minimize();
                    break;
                case 'e': case 'E':
                    if (inField) return;
                    e.preventDefault();
                    toggleWindowMode();
                    break;
            }
        });
    }

    _bindEngineCallbacks() {
        sonioxClient.onOriginal = (text, speaker, language) => {
            this.transcriptUI.addOriginal(text, speaker, language);
        };
        sonioxClient.onTranslation = (text) => {
            // TranscriptUI là nguồn ghép cặp duy nhất (kèm cơ chế tự-lành).
            // Hàng đợi song song trước đây không có xử lý quá hạn — một câu
            // mồ côi làm mọi cặp src/tgt sau đó trong meeting note lệch
            // vĩnh viễn.
            const seg = this.transcriptUI.addTranslation(text);
            sessionStore.addSegment(seg?.original || '', text);
        };
        sonioxClient.onDebugEvent = (evt) => tokenLogger.log(evt);
        sonioxClient.onProvisional = (text, speaker, language) => {
            if (text) this.transcriptUI.setProvisional(text, speaker, language);
            else this.transcriptUI.clearProvisional();
        };
        sonioxClient.onStatusChange = (status) => this._updateStatus(status);
        sonioxClient.onError = (error) => this._showToast(String(error), 'error');
        sonioxClient.onConfidence = (c) => this.transcriptUI.setConfidence(c);

        // ── caption bridge (Teams web qua Chrome extension) ──
        captionBridge.onCaption = (c) => {
            const key = String(c.id);
            if (c.isNew) {
                if (c.mri && c.name) this.transcriptUI.setSpeakerName(c.mri, c.name);
                this.transcriptUI.clearProvisional();
                this.transcriptUI.removeStatusMessage();
                this.transcriptUI.addKeyedOriginal(key, c.ja, c.mri || null, 'ja');
                // Ghi vào session NGAY, không chờ bản dịch: bản dịch về sau vài
                // giây vì gom lô, và có thể không bao giờ về nếu tắt dịch ở
                // extension. Chờ nó nghĩa là meeting assistant không thấy gì.
                this._teamsSegments.set(key, sessionStore.addSegment(c.ja, c.vi || ''));
            }
            if (c.vi) {
                this.transcriptUI.setKeyedTranslation(key, c.vi);
                const seg = this._teamsSegments.get(key);
                if (seg) seg.tgt = c.vi;
            }
        };
        captionBridge.onProvisional = (text, name) => {
            if (text) this.transcriptUI.setProvisional(text, null, 'ja');
            else this.transcriptUI.clearProvisional();
        };
        captionBridge.onStatusChange = (status) => this._updateStatus(status);
        captionBridge.onError = (message) => this._showToast(String(message), 'error');
    }

    // ─── Meeting assistant ─────────────────────────────────

    _bindAssistant() {
        const panel = document.getElementById('ai-panel');
        document.getElementById('btn-ai-toggle').addEventListener('click', () => {
            panel.classList.toggle('open');
        });
        document.getElementById('btn-ai-summarize').addEventListener('click', () => {
            this.assistant.summarize({ auto: false });
        });

        this.assistant.onSummary = (summary) => this._renderSummary(summary);
        this.assistant.onReplies = (payload) => this._renderReplies(payload);
        this.assistant.onStatus = (message, kind) => this._renderAssistantStatus(message, kind);

        // Selecting a sentence is the request for reply suggestions.
        this.transcriptUI.onSelect = (segment) => {
            if (!segment) {
                this._renderReplies(null);
                return;
            }
            panel.classList.add('open');
            this.assistant.suggestReplies(segment);
        };

        // Copy buttons are added dynamically — delegate.
        document.getElementById('ai-replies').addEventListener('click', (e) => {
            const btn = e.target.closest('.ai-reply-copy');
            if (!btn) return;
            const reply = btn.closest('.ai-reply');
            const text = btn.dataset.lang === 'ja'
                ? reply.querySelector('.ai-reply-ja')?.textContent
                : reply.querySelector('.ai-reply-vi')?.textContent;
            if (text) {
                navigator.clipboard.writeText(text.trim());
                this._showToast('Đã copy câu trả lời');
            }
        });
    }

    _renderSummary(summary) {
        const el = document.getElementById('ai-summary');
        const badge = document.getElementById('ai-badge');
        if (!summary) {
            el.innerHTML = '<div class="ai-hint-empty">Chưa có tóm tắt. Bắt đầu ghi hoặc nhấn "Tóm tắt ngay".</div>';
            badge.style.display = 'none';
            return;
        }

        // The summary comes back in the fixed CHỦ ĐỀ / QUYẾT ĐỊNH / ACTIONS
        // shape the prompt asks for; render each part as its own labelled row.
        const rows = [];
        const section = (label, re) => {
            const m = summary.match(re);
            return m ? m[1].trim() : '';
        };
        const topic = section('CHỦ ĐỀ', /CHỦ ĐỀ\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:QUYẾT ĐỊNH|ACTIONS)\s*[:：]|$)/i);
        const decision = section('QUYẾT ĐỊNH', /QUYẾT ĐỊNH\s*[:：]\s*([\s\S]*?)(?=\n\s*ACTIONS\s*[:：]|$)/i);
        const actionsRaw = section('ACTIONS', /ACTIONS\s*[:：]\s*([\s\S]*)$/i);

        if (topic) rows.push(this._summaryRow('CHỦ ĐỀ', topic));
        if (decision) rows.push(this._summaryRow('QUYẾT ĐỊNH', decision));

        const actions = actionsRaw
            .split('\n')
            .map((l) => l.replace(/^[-•*]\s*/, '').trim())
            .filter(Boolean);
        if (actions.length) {
            const items = actions
                .map((a) => `<div class="ai-action"><span class="ai-check" style="border:1.5px solid var(--secondary)"></span><span class="ai-row-text">${this._esc(a)}</span></div>`)
                .join('');
            rows.push(`<div class="ai-row"><span class="ai-row-label">ACTIONS</span><div>${items}</div></div>`);
        }

        el.innerHTML = rows.length
            ? rows.join('')
            : `<div class="ai-row"><span class="ai-row-text">${this._esc(summary)}</span></div>`;

        const n = this.assistant.actionItemCount;
        badge.textContent = n ? `${n} action item${n === 1 ? '' : 's'}` : '';
        badge.style.display = n ? '' : 'none';
    }

    _summaryRow(label, text) {
        return `<div class="ai-row"><span class="ai-row-label">${label}</span><span class="ai-row-text">${this._esc(text)}</span></div>`;
    }

    _renderReplies(payload) {
        const el = document.getElementById('ai-replies');
        const empty = document.getElementById('ai-replies-empty');

        if (!payload) {
            el.innerHTML = '';
            empty.style.display = '';
            return;
        }
        empty.style.display = 'none';

        let html = '<span class="ai-section-label">Gợi ý trả lời — câu đã chọn</span>';
        html += `<div class="ai-selected-quote">${this._esc(payload.quote || '')}</div>`;

        if (payload.loading) {
            el.classList.add('busy');
            html += '<div class="ai-hint-empty">Đang soạn gợi ý…</div>';
            el.innerHTML = html;
            return;
        }
        el.classList.remove('busy');

        if (payload.error) {
            html += `<div class="ai-error">${this._esc(payload.error)}</div>`;
        }
        for (const r of payload.replies || []) {
            html += '<div class="ai-reply">';
            if (r.vi) html += `<div class="ai-reply-vi">${this._esc(r.vi)}</div>`;
            if (r.ja) html += `<div class="ai-reply-ja">${this._esc(r.ja)}</div>`;
            html += `<button class="ai-reply-copy" data-lang="${r.ja ? 'ja' : 'vi'}" title="Copy ${r.ja ? 'tiếng Nhật' : 'tiếng Việt'}" type="button"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
            html += '</div>';
        }
        el.innerHTML = html;
    }

    _renderAssistantStatus(message, kind) {
        const label = document.getElementById('ai-summary-label');
        if (!label) return;
        label.classList.remove('busy', 'failed');

        if (kind === 'busy') {
            label.classList.add('busy');
            label.textContent = message || 'Đang tóm tắt…';
        } else if (kind === 'error') {
            label.classList.add('failed');
            label.textContent = 'Tóm tắt lỗi';
            this._showToast(message, 'error');
        } else if (kind === 'info') {
            this._showToast(message);
            label.textContent = this._summaryLabel();
        } else {
            label.textContent = this._summaryLabel();
        }
    }

    _summaryLabel() {
        const at = this.assistant.summaryUpdatedAt;
        if (!at) return 'Tóm tắt';
        const secs = Math.round((Date.now() - at) / 1000);
        if (secs < 60) return `Tóm tắt · ${secs}s trước`;
        return `Tóm tắt · ${Math.round(secs / 60)} phút trước`;
    }

    // ─── Capture lifecycle ─────────────────────────────────

    _toggleCapture() {
        if (this.isRunning) this.stopSession();
        else this.start();
    }

    async start() {
        const settings = settingsManager.get();
        this.translationMode = settings.translation_mode || 'soniox';

        if (this.translationMode === 'local' && !this.isAppleSilicon) {
            this._showToast('Local MLX chỉ chạy trên macOS Apple Silicon.', 'error');
            this._showView('settings');
            return;
        }
        if (this.translationMode === 'soniox' && !settings.soniox_api_key) {
            this._showToast('Cần Soniox API key. Thêm trong Cài đặt.', 'error');
            this._showView('settings');
            return;
        }
        if (this.translationMode === 'teams-web' && !settings.caption_bridge_token) {
            this._showToast('Chưa có token caption bridge. Mở Cài đặt.', 'error');
            this._showView('settings');
            return;
        }

        this.isRunning = true;
        this._updateStartButton();

        if (!this.sessionStartTime) {
            this.sessionStartTime = new Date();
            this.sessionMode = settings.translation_type || 'one_way';
            if (this.sessionMode === 'two_way') {
                this.sessionSourceLang = settings.language_a || 'ja';
                this.sessionTargetLang = settings.language_b || 'vi';
            } else {
                this.sessionSourceLang = settings.source_language || 'auto';
                this.sessionTargetLang = settings.target_language || 'vi';
            }
        }

        sessionStore.beginChunk({
            engine: this.translationMode,
            sourceLang: this.sessionSourceLang,
            targetLang: this.sessionTargetLang,
        });

        this.assistant.configure(settings);
        this.assistant.start();
        this._updateProfileChip();

        if (!this.transcriptUI.hasContent()) this.transcriptUI.showListening();
        else this.transcriptUI.clearProvisional();

        if (this.translationMode === 'local') await this._startLocalMode(settings);
        else if (this.translationMode === 'teams-web') await this._startTeamsBridge(settings);
        else await this._startSonioxMode(settings);
    }

    /**
     * Nguồn caption là Chrome extension đọc live captions của Teams web, không
     * phải micro. Không gọi start_capture — đường âm thanh hoàn toàn không dùng.
     */
    async _startTeamsBridge(settings) {
        this._updateStatus('connecting');
        try {
            await captionBridge.start({
                port: settings.caption_bridge_port || 8477,
                token: settings.caption_bridge_token,
            });
            this.transcriptUI.showStatusMessage(
                'Đang chờ extension nối vào… (mở Teams web và bật live captions)'
            );
        } catch (err) {
            console.error('start_caption_bridge failed:', err);
            this._showToast(`Caption bridge: ${err}`, 'error');
            await this.pause();
        }
    }

    async _startSonioxMode(settings) {
        this._updateStatus('connecting');
        // Ghi nguyên luồng token ra .jsonl — khi có lỗi ghép cặp giữa họp
        // thật, file này cho phép phát lại đúng dữ liệu đã gây lỗi.
        tokenLogger.start('soniox');
        sonioxClient.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: settings.source_language,
            targetLanguage: settings.target_language,
            customContext: settings.custom_context,
            translationType: settings.translation_type || 'one_way',
            languageA: settings.language_a,
            languageB: settings.language_b,
            languageHintsStrict: settings.language_hints_strict || false,
            endpointDelay: settings.endpoint_delay || 3000,
        });

        try {
            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcm) => {
                sonioxClient.sendAudio(new Uint8Array(pcm).buffer);
            };
            await invoke('start_capture', { source: this.currentSource, channel });
        } catch (err) {
            console.error('start_capture failed:', err);
            this._showToast(`Lỗi âm thanh: ${err}`, 'error');
            await this.pause();
        }
    }

    async _startLocalMode(settings) {
        this._updateStatus('connecting');

        // Prompt for the audio permission before spending minutes on model
        // download — a permission denial after a 5GB fetch is a bad trade.
        try {
            await invoke('start_capture', {
                source: this.currentSource,
                channel: new window.__TAURI__.core.Channel(),
            });
            await invoke('stop_capture');
        } catch (err) {
            this._showToast(`Cần quyền truy cập âm thanh: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
            return;
        }

        try {
            const status = JSON.parse(await invoke('check_mlx_setup'));
            if (!status.ready) {
                this.transcriptUI.showStatusMessage('Đang tải model MLX (chỉ một lần)…');
                await this._runMlxSetup();
            }
        } catch (err) {
            console.warn('MLX check failed, continuing:', err);
        }

        try {
            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (msg) => {
                let data;
                try { data = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch { return; }
                try { this._handleLocalPipelineResult(data); } catch (e) { console.error(e); }
            };
            const langMap = { auto: 'auto', ja: 'Japanese', en: 'English', zh: 'Chinese', ko: 'Korean', vi: 'Vietnamese' };
            await invoke('start_local_pipeline', {
                sourceLang: langMap[settings.source_language] || 'Japanese',
                targetLang: settings.target_language || 'vi',
                channel,
            });
        } catch (err) {
            this._showToast(`Lỗi pipeline: ${err}`, 'error');
            await this.pause();
            return;
        }

        try {
            const audioChannel = new window.__TAURI__.core.Channel();
            audioChannel.onmessage = async (pcm) => {
                try {
                    await invoke('send_audio_to_pipeline', { data: Array.from(new Uint8Array(pcm)) });
                } catch { /* pipeline may still be warming up */ }
            };
            await invoke('start_capture', { source: this.currentSource, channel: audioChannel });
        } catch (err) {
            this._showToast(`Âm thanh: ${err}`, 'error');
        }
    }

    _handleLocalPipelineResult(data) {
        switch (data.type) {
            case 'ready':
                this.localPipelineReady = true;
                this._updateStatus('connected');
                this.transcriptUI.removeStatusMessage();
                this.transcriptUI.showListening();
                break;
            case 'result':
                if (data.original) this.transcriptUI.addOriginal(data.original);
                if (data.translated) this.transcriptUI.addTranslation(data.translated);
                sessionStore.addSegment(data.original || '', data.translated || '');
                break;
            case 'status': {
                const msg = data.message || 'Đang tải…';
                const statusText = document.getElementById('status-text');
                if (statusText) statusText.textContent = msg.replace(/^\[pipeline\]\s*/, '');
                if (!msg.startsWith('[pipeline]')) this.transcriptUI.showStatusMessage(msg);
                break;
            }
            case 'done':
                this._updateStatus('disconnected');
                break;
        }
    }

    /** Stop capture, persist the chunk, keep the session file open. */
    async pause() {
        this.isRunning = false;
        this._updateStartButton();
        this.assistant.stop();

        if (this.translationMode !== 'teams-web') {
            try { await invoke('stop_capture'); } catch (err) { console.error(err); }
        }

        if (this.translationMode === 'teams-web') {
            await captionBridge.stop();
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
        } else if (this.translationMode === 'local') {
            try { await invoke('stop_local_pipeline'); } catch (err) { console.error(err); }
            this.localPipelineReady = false;
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
        } else {
            sonioxClient.disconnect();
        }

        this.transcriptUI.clearProvisional();
        tokenLogger.stop();

        // Câu chưa kịp có bản dịch: lấy bản gốc làm bản dịch để meeting note và
        // export không có ô trống.
        for (const seg of this._teamsSegments.values()) if (!seg.tgt) seg.tgt = seg.src;
        this._teamsSegments.clear();

        sessionStore.endChunk();
        const result = await sessionStore.persist();
        if (result === 'failed') {
            this._showToast('Lưu thất bại — session vẫn còn trong bộ nhớ', 'error');
        }
    }

    /**
     * Stop: pause, write the meeting note (summary + full transcript), finalize
     * the session file, and reset identity so the next Start opens a new one.
     */
    async stopSession() {
        if (this.isRunning) await this.pause();

        if (sessionStore.isEmpty() && !this.transcriptUI.hasContent()) {
            this._showToast('Chưa có nội dung để lưu');
            return;
        }

        // One last summary so the note opens with an up-to-date picture rather
        // than one that stops a couple of minutes before the meeting ended.
        try { await this.assistant.summarize({ auto: true }); } catch { /* note still saves */ }

        await this._saveMeetingNote();

        const result = await sessionStore.endSession();
        if (result === 'failed') {
            this._showToast('Lưu thất bại — session vẫn còn trong bộ nhớ', 'error');
            return;
        }

        this.sessionStartTime = null;
        const settings = settingsManager.get();
        sessionStore.init({
            engine: settings.translation_mode || 'soniox',
            sourceLang: settings.source_language || 'auto',
            targetLang: settings.target_language || 'vi',
        });
    }

    // ─── Meeting note ──────────────────────────────────────

    async _saveMeetingNote() {
        if (!this.transcriptUI.hasContent()) return;

        const settings = settingsManager.get();
        const profile = this.assistant.profile;
        const started = this.sessionStartTime || new Date();
        const durationMs = Date.now() - started.getTime();

        const title = this._meetingTitle(profile, started);
        const content = this.transcriptUI.getFullSessionText({
            title,
            startedAt: started.getTime(),
            duration: this._formatDuration(durationMs),
            project: profile?.name || '',
            languagePair: `${this._langName(this.sessionSourceLang)} → ${this._langName(this.sessionTargetLang)}`,
            mode: this.translationMode,
            summary: this.assistant.summary,
        });
        if (!content) return;

        try {
            const path = await invoke('save_meeting_note', {
                projectPath: profile?.project_path || '',
                defaultNotesDir: settings.default_notes_dir || '',
                datePrefix: started.toISOString().slice(0, 10),
                title,
                content,
            });
            this._lastNotePath = path;
            this._showToast(`Đã lưu ghi chú: ${path.split('/').pop()}`, 'success', () => {
                invoke('open_path_in_finder', { path }).catch(() => {});
            });
        } catch (err) {
            console.error('save_meeting_note failed:', err);
            this._showToast(`Không lưu được ghi chú: ${err}`, 'error');
        }
    }

    _meetingTitle(profile, started) {
        // Prefer the summary's own topic line — it describes the meeting far
        // better than a timestamp does.
        const m = this.assistant.summary?.match(/CHỦ ĐỀ\s*[:：]\s*(.+)/i);
        if (m) return m[1].trim().slice(0, 70);
        if (profile?.name) return `${profile.name} — ${started.toTimeString().slice(0, 5)}`;
        return `Cuộc họp ${started.toTimeString().slice(0, 5)}`;
    }

    // ─── Settings ──────────────────────────────────────────

    _applySettings(s) {
        this.currentSource = s.audio_source || 'system';
        document.getElementById('select-audio-source').value = this.currentSource;

        this.transcriptUI.configure({
            fontSize: s.font_size || 16,
            maxLines: s.max_lines || 5,
            viewMode: s.show_original === false ? 'single' : 'dual',
            furigana: !!s.furigana_enabled,
        });
        document.getElementById('font-size-display').textContent = s.font_size || 16;
        document.getElementById('btn-view-mode').classList.toggle('active', s.show_original !== false);
        document.getElementById('btn-furigana').classList.toggle('active', !!s.furigana_enabled);
        document.documentElement.style.setProperty('--overlay-opacity', s.overlay_opacity ?? 0.9);

        const type = s.translation_type || 'one_way';
        if (type === 'two_way') {
            this.transcriptUI.setTwoWayLanguages(s.language_a || 'ja', s.language_b || 'vi');
            this.transcriptUI.setLanguagePair(s.language_a || 'ja', s.language_b || 'vi');
        } else {
            this.transcriptUI.setTwoWayLanguages(null, null);
            this.transcriptUI.setLanguagePair(s.source_language, s.target_language);
        }
        this._updateLiveLang(s);
        this._updateSettingsCards(s);

        llmBackend.configure(s);
        this.assistant.configure(s);
        this._updateProfileChip();
    }

    _updateLiveLang(s) {
        const el = document.getElementById('live-lang');
        if (!el) return;
        if ((s.translation_type || 'one_way') === 'two_way') {
            el.innerHTML = `${(s.language_a || 'ja').toUpperCase()} <b>⇄</b> ${(s.language_b || 'vi').toUpperCase()}`;
        } else {
            const src = (s.source_language || 'auto').toUpperCase();
            el.innerHTML = `${src === 'AUTO' ? 'AUTO' : src} <b>→</b> ${(s.target_language || 'vi').toUpperCase()}`;
        }
    }

    _updateSettingsCards(s) {
        const pair = (s.translation_type || 'one_way') === 'two_way'
            ? `${(s.language_a || 'ja').toUpperCase()} ⇄ ${(s.language_b || 'vi').toUpperCase()}`
            : `${(s.source_language || 'auto').toUpperCase()} → ${(s.target_language || 'vi').toUpperCase()}`;
        document.getElementById('card-translation-sub').textContent =
            `${{ local: 'Local MLX', 'teams-web': 'Teams captions' }[s.translation_mode] || 'Soniox'} · ${pair}`;
        document.getElementById('card-display-sub').textContent =
            `Cỡ chữ ${s.font_size || 16}px · ${s.furigana_enabled ? 'furigana bật' : 'furigana tắt'}`;

        const backend = s.llm_backend === 'anthropic-api' ? 'Anthropic API' : 'Claude CLI (gói Max)';
        const profile = (s.meeting_profiles || []).find((p) => p.id === s.active_profile_id);
        document.getElementById('card-assistant-sub').textContent =
            `${backend}${profile ? ` · ${profile.name}` : ' · không gắn dự án'}`;
    }

    _populateSettingsForm(s) {
        document.getElementById('input-api-key').value = s.soniox_api_key || '';
        document.getElementById('select-translation-mode').value = s.translation_mode || 'soniox';
        document.getElementById('input-bridge-port').value = s.caption_bridge_port || 8477;
        document.getElementById('input-bridge-token').value = s.caption_bridge_token || '';
        document.getElementById('select-translation-type').value = s.translation_type || 'one_way';
        document.getElementById('select-source-lang').value = s.source_language || 'auto';
        document.getElementById('select-target-lang').value = s.target_language || 'vi';
        document.getElementById('select-lang-a').value = s.language_a || 'ja';
        document.getElementById('select-lang-b').value = s.language_b || 'vi';
        document.getElementById('check-strict-lang').checked = !!s.language_hints_strict;

        const delay = s.endpoint_delay || 3000;
        document.getElementById('range-endpoint-delay').value = delay;
        document.getElementById('endpoint-delay-value').textContent = `${(delay / 1000).toFixed(1)}s`;

        const src = document.querySelector(`input[name="audio-source"][value="${s.audio_source || 'system'}"]`);
        if (src) src.checked = true;

        const opacity = Math.round((s.overlay_opacity ?? 0.9) * 100);
        document.getElementById('range-opacity').value = opacity;
        document.getElementById('opacity-value').textContent = `${opacity}%`;
        document.getElementById('range-font-size').value = s.font_size || 16;
        document.getElementById('font-size-value').textContent = `${s.font_size || 16}px`;
        document.getElementById('range-max-lines').value = s.max_lines || 5;
        document.getElementById('max-lines-value').textContent = s.max_lines || 5;
        document.getElementById('check-show-original').checked = s.show_original !== false;
        document.getElementById('check-furigana').checked = !!s.furigana_enabled;

        // Assistant
        document.getElementById('select-llm-backend').value = s.llm_backend || 'claude-cli';
        document.getElementById('input-claude-cli-path').value = s.claude_cli_path || '';
        document.getElementById('input-anthropic-key').value = s.anthropic_api_key || '';
        document.getElementById('select-summary-model').value = s.summary_model || 'claude-haiku-4-5';
        document.getElementById('select-reply-model').value = s.reply_model || 'claude-sonnet-5';
        document.getElementById('check-auto-summary').checked = s.auto_summary_enabled !== false;
        const iv = s.auto_summary_interval_sec || 120;
        document.getElementById('range-summary-interval').value = iv;
        document.getElementById('summary-interval-value').textContent = `${iv}s`;
        const minSeg = s.auto_summary_min_segments || 20;
        document.getElementById('range-summary-min-segments').value = minSeg;
        document.getElementById('summary-min-segments-value').textContent = `${minSeg} câu`;
        document.getElementById('input-default-notes-dir').value = s.default_notes_dir || '';
        document.getElementById('input-backlog-space').value = s.backlog_space || '';
        document.getElementById('input-backlog-key').value = s.backlog_api_key || '';

        this._renderProfiles(s.meeting_profiles || [], s.active_profile_id || '');
        this._renderContextRows(s.custom_context);

        this._updateModeUI(s.translation_mode || 'soniox');
        this._updateTranslationTypeUI(s.translation_type || 'one_way');
        this._updateLlmBackendUI(s.llm_backend || 'claude-cli');
        this._refreshKeyStatus(s);
        this._refreshNotesDirHint();
    }

    _renderContextRows(ctx) {
        document.getElementById('context-general-list').innerHTML = '';
        document.getElementById('translation-terms-list').innerHTML = '';
        if (!ctx) return;

        for (const [k, v] of Object.entries(ctx.general || {})) this._addGeneralRow(k, v);
        for (const t of ctx.translation_terms || []) this._addTermRow(t.source, t.target);
        if (ctx.terms?.length) {
            document.getElementById('input-context-terms').value = ctx.terms.join('\n');
        }
        if (ctx.text) document.getElementById('input-context-text').value = ctx.text;
    }

    async _saveSettingsFromForm() {
        const settings = {
            soniox_api_key: document.getElementById('input-api-key').value.trim(),
            translation_mode: document.getElementById('select-translation-mode').value,
            caption_bridge_port: parseInt(document.getElementById('input-bridge-port').value, 10) || 8477,
            caption_bridge_token: document.getElementById('input-bridge-token').value.trim(),
            translation_type: document.getElementById('select-translation-type').value,
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
            language_a: document.getElementById('select-lang-a').value,
            language_b: document.getElementById('select-lang-b').value,
            language_hints_strict: document.getElementById('check-strict-lang').checked,
            endpoint_delay: parseInt(document.getElementById('range-endpoint-delay').value, 10),
            audio_source: document.querySelector('input[name="audio-source"]:checked')?.value || 'system',
            overlay_opacity: parseInt(document.getElementById('range-opacity').value, 10) / 100,
            font_size: parseInt(document.getElementById('range-font-size').value, 10),
            max_lines: parseInt(document.getElementById('range-max-lines').value, 10),
            show_original: document.getElementById('check-show-original').checked,
            furigana_enabled: document.getElementById('check-furigana').checked,
            custom_context: this._collectContext(),

            llm_backend: document.getElementById('select-llm-backend').value,
            claude_cli_path: document.getElementById('input-claude-cli-path').value.trim(),
            anthropic_api_key: document.getElementById('input-anthropic-key').value.trim(),
            summary_model: document.getElementById('select-summary-model').value,
            reply_model: document.getElementById('select-reply-model').value,
            auto_summary_enabled: document.getElementById('check-auto-summary').checked,
            auto_summary_interval_sec: parseInt(document.getElementById('range-summary-interval').value, 10),
            auto_summary_min_segments: parseInt(document.getElementById('range-summary-min-segments').value, 10),
            default_notes_dir: document.getElementById('input-default-notes-dir').value.trim(),
            meeting_profiles: this._collectProfiles(),
            active_profile_id: document.getElementById('select-meeting-profile').value,
            backlog_space: document.getElementById('input-backlog-space').value.trim(),
            backlog_api_key: document.getElementById('input-backlog-key').value.trim(),
        };

        try {
            await settingsManager.save(settings);
            // Project docs and Backlog issues are cached per meeting; a settings
            // change may well be the user fixing exactly that context.
            contextProviders.invalidate();
            this._applySettings(settingsManager.get());
            this._showToast('Đã lưu cài đặt');
            this._closeSettings();
        } catch (err) {
            this._showToast(`Lưu cài đặt thất bại: ${err}`, 'error');
        }
    }

    _collectContext() {
        const general = {};
        document.querySelectorAll('#context-general-list .general-row').forEach((row) => {
            const k = row.querySelector('.general-key')?.value.trim();
            const v = row.querySelector('.general-value')?.value.trim();
            if (k && v) general[k] = v;
        });
        const termsRaw = document.getElementById('input-context-terms').value.trim();
        const terms = termsRaw ? termsRaw.split('\n').map((t) => t.trim()).filter(Boolean) : [];
        const text = document.getElementById('input-context-text').value.trim();

        const translation_terms = [];
        document.querySelectorAll('#translation-terms-list .term-row').forEach((row) => {
            const source = row.querySelector('.term-source')?.value.trim();
            const target = row.querySelector('.term-target')?.value.trim();
            if (source && target) translation_terms.push({ source, target });
        });

        if (!Object.keys(general).length && !terms.length && !text && !translation_terms.length) {
            return null;
        }
        return { general, terms, text, translation_terms };
    }

    _collectProfiles() {
        const out = [];
        document.querySelectorAll('#meeting-profiles-list .profile-row').forEach((row) => {
            const name = row.querySelector('.profile-name').value.trim();
            const project_path = row.querySelector('.profile-path').value.trim();
            const backlog_project_key = row.querySelector('.profile-backlog').value.trim();
            if (!name && !project_path) return;
            out.push({
                id: row.dataset.id,
                name: name || project_path.split('/').pop() || 'Dự án',
                project_path,
                backlog_project_key,
                note_files: JSON.parse(row.dataset.noteFiles || '[]'),
            });
        });
        return out;
    }

    _renderProfiles(profiles, activeId) {
        const list = document.getElementById('meeting-profiles-list');
        list.innerHTML = '';
        for (const p of profiles) this._addProfileRow(p);
        this._refreshProfileSelect(activeId);
    }

    _addProfileRow(profile = null) {
        const list = document.getElementById('meeting-profiles-list');
        const row = document.createElement('div');
        row.className = 'profile-row';
        row.dataset.id = profile?.id || `p-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        row.dataset.noteFiles = JSON.stringify(profile?.note_files || []);
        row.innerHTML = `
            <input class="profile-name" placeholder="Tên dự án" value="${this._escAttr(profile?.name || '')}" />
            <input class="profile-path" placeholder="/đường/dẫn/tới/dự-án" value="${this._escAttr(profile?.project_path || '')}" />
            <input class="profile-backlog" placeholder="KEY" style="flex:0 0 70px" value="${this._escAttr(profile?.backlog_project_key || '')}" />
            <button type="button" class="btn-icon-sm profile-pick" title="Chọn thư mục">…</button>
            <button type="button" class="btn-icon-sm profile-remove" title="Xóa">×</button>`;

        row.querySelector('.profile-pick').addEventListener('click', async () => {
            const dir = await this._pickDirectory('Chọn thư mục dự án');
            if (dir) {
                row.querySelector('.profile-path').value = dir;
                if (!row.querySelector('.profile-name').value.trim()) {
                    row.querySelector('.profile-name').value = dir.split('/').pop();
                }
                this._refreshProfileSelect();
                this._refreshNotesDirHint();
            }
        });
        row.querySelector('.profile-remove').addEventListener('click', () => {
            row.remove();
            this._refreshProfileSelect();
            this._refreshNotesDirHint();
        });
        row.querySelector('.profile-name').addEventListener('input', () => this._refreshProfileSelect());

        list.appendChild(row);
        this._refreshProfileSelect();
    }

    _refreshProfileSelect(activeId) {
        const select = document.getElementById('select-meeting-profile');
        const keep = activeId !== undefined ? activeId : select.value;
        const profiles = this._collectProfiles();
        select.innerHTML = '<option value="">— Không gắn dự án —</option>';
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            select.appendChild(opt);
        }
        select.value = profiles.some((p) => p.id === keep) ? keep : '';
        this._refreshNotesDirHint();
    }

    async _refreshNotesDirHint() {
        const hint = document.getElementById('hint-notes-dir');
        if (!hint) return;
        const id = document.getElementById('select-meeting-profile').value;
        const profile = this._collectProfiles().find((p) => p.id === id);
        const defaultDir = document.getElementById('input-default-notes-dir').value.trim();
        try {
            const dir = await invoke('meeting_notes_dir', {
                projectPath: profile?.project_path || '',
                defaultNotesDir: defaultDir,
            });
            hint.textContent = `Ghi chú sẽ lưu vào: ${dir}`;
        } catch {
            hint.textContent = 'Ghi chú sẽ lưu vào: —';
        }
    }

    async _pickDirectory(title) {
        try {
            const result = await window.__TAURI__.dialog.open({ directory: true, multiple: false, title });
            return typeof result === 'string' ? result : null;
        } catch (err) {
            this._showToast(`Không mở được hộp thoại: ${err}`, 'error');
            return null;
        }
    }

    async _pickNotesDir() {
        const dir = await this._pickDirectory('Chọn thư mục ghi chú mặc định');
        if (dir) {
            document.getElementById('input-default-notes-dir').value = dir;
            this._refreshNotesDirHint();
        }
    }

    _updateProfileChip() {
        const chip = document.getElementById('ai-profile-chip');
        if (!chip) return;
        const name = this.assistant.profileName;
        chip.textContent = name || 'Không gắn dự án';
        chip.classList.toggle('empty', !name);
    }

    _addTermRow(source = '', target = '') {
        const list = document.getElementById('translation-terms-list');
        const row = document.createElement('div');
        row.className = 'term-row';
        row.innerHTML = `
            <input class="term-source" placeholder="nguồn" value="${this._escAttr(source)}" />
            <span class="term-arrow">→</span>
            <input class="term-target" placeholder="đích" value="${this._escAttr(target)}" />
            <button type="button" class="btn-icon-sm term-remove">×</button>`;
        row.querySelector('.term-remove').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _addGeneralRow(key = '', value = '') {
        const list = document.getElementById('context-general-list');
        const row = document.createElement('div');
        row.className = 'general-row';
        row.innerHTML = `
            <input class="general-key" placeholder="key" value="${this._escAttr(key)}" />
            <input class="general-value" placeholder="value" value="${this._escAttr(value)}" />
            <button type="button" class="btn-icon-sm general-remove">×</button>`;
        row.querySelector('.general-remove').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _updateModeUI(mode) {
        document.getElementById('hint-mode-soniox').style.display = mode === 'soniox' ? '' : 'none';
        document.getElementById('hint-mode-local').style.display = mode === 'local' ? '' : 'none';
        document.getElementById('hint-mode-teams').style.display = mode === 'teams-web' ? '' : 'none';
        document.getElementById('section-api-key').style.display = mode === 'soniox' ? '' : 'none';
        document.getElementById('section-soniox-context').style.display = mode === 'soniox' ? '' : 'none';
        document.getElementById('section-endpoint-delay').style.display = mode === 'soniox' ? '' : 'none';
        document.getElementById('section-caption-bridge').style.display = mode === 'teams-web' ? '' : 'none';
    }

    _updateTranslationTypeUI(type) {
        const twoWay = type === 'two_way';
        document.getElementById('section-oneway-langs').style.display = twoWay ? 'none' : '';
        document.getElementById('section-twoway-langs').style.display = twoWay ? '' : 'none';
        document.getElementById('hint-twoway').style.display = twoWay ? '' : 'none';
    }

    _updateLlmBackendUI(backend) {
        const api = backend === 'anthropic-api';
        document.getElementById('section-claude-cli').style.display = api ? 'none' : '';
        document.getElementById('section-anthropic-key').style.display = api ? '' : 'none';
        document.getElementById('hint-llm-cli').style.display = api ? 'none' : '';
        document.getElementById('hint-llm-api').style.display = api ? '' : 'none';
    }

    _refreshKeyStatus(s) {
        const set = (id, ok) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = ok ? '✓' : '';
            el.className = `key-status${ok ? ' ok' : ''}`;
        };
        set('key-status-soniox', !!s.soniox_api_key);
        set('key-status-anthropic', !!s.anthropic_api_key);
    }

    async _testSoniox() {
        const key = document.getElementById('input-api-key').value.trim();
        if (!key) { this._showToast('Nhập API key trước', 'error'); return; }
        try {
            const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 6000);
                ws.onopen = () => {
                    clearTimeout(timer);
                    ws.send(JSON.stringify({ api_key: key, model: 'stt-rt-v3', audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1 }));
                    setTimeout(() => { ws.close(); resolve(); }, 400);
                };
                ws.onerror = () => { clearTimeout(timer); reject(new Error('không kết nối được')); };
            });
            this._showToast('Soniox: kết nối OK');
        } catch (err) {
            this._showToast(`Soniox: ${err.message}`, 'error');
        }
    }

    async _testClaudeCli() {
        const status = document.getElementById('key-status-claude-cli');
        status.textContent = '…';
        llmBackend.configure({ claude_cli_path: document.getElementById('input-claude-cli-path').value.trim() });
        try {
            const version = await llmBackend.checkCli();
            status.textContent = '✓';
            status.className = 'key-status ok';
            this._showToast(`Claude CLI: ${version}`);
        } catch (err) {
            status.textContent = '✕';
            status.className = 'key-status';
            this._showToast(String(err), 'error');
        }
    }

    // ─── Views ─────────────────────────────────────────────

    _showView(view) {
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        document.getElementById(view === 'settings' ? 'settings-view' : 'overlay-view').classList.add('active');
        if (view === 'settings') this._showSettingsScreen('settings-home');
    }

    _closeSettings() {
        this._showView('overlay');
    }

    _showSettingsScreen(id) {
        document.querySelectorAll('.settings-tab-content').forEach((c) => {
            c.classList.toggle('active', c.id === id);
        });
        document.querySelector('.settings-body')?.scrollTo(0, 0);
    }

    // ─── Transcript controls ───────────────────────────────

    _setSource(source) {
        this.currentSource = source;
        document.getElementById('select-audio-source').value = source;
        settingsManager.save({ audio_source: source }).catch(() => {});
        if (this.isRunning) {
            this._showToast('Đổi nguồn âm thanh sẽ áp dụng ở lần bắt đầu tiếp theo');
        }
    }

    _toggleViewMode() {
        const dual = this.transcriptUI.viewMode === 'dual';
        this.transcriptUI.configure({ viewMode: dual ? 'single' : 'dual' });
        document.getElementById('btn-view-mode').classList.toggle('active', !dual);
        document.getElementById('check-show-original').checked = !dual;
        settingsManager.save({ show_original: !dual }).catch(() => {});
    }

    _toggleFurigana() {
        const on = !document.body.classList.contains('furigana-on');
        this.transcriptUI.configure({ furigana: on });
        document.getElementById('btn-furigana').classList.toggle('active', on);
        document.getElementById('check-furigana').checked = on;
        settingsManager.save({ furigana_enabled: on }).catch(() => {});
    }

    _adjustFontSize(delta) {
        const size = Math.max(12, Math.min(140, (this.transcriptUI.fontSize || 16) + delta));
        this.transcriptUI.configure({ fontSize: size });
        document.getElementById('font-size-display').textContent = size;
        document.getElementById('range-font-size').value = size;
        document.getElementById('font-size-value').textContent = `${size}px`;
        settingsManager.save({ font_size: size }).catch(() => {});
    }

    _copyTranscript() {
        const text = this.transcriptUI.getPlainText();
        if (!text) { this._showToast('Chưa có nội dung'); return; }
        navigator.clipboard.writeText(text);
        this._showToast('Đã copy transcript');
    }

    _toggleCompact() {
        this.isCompact = toggleManualCompact();
    }

    async _togglePin() {
        this.isPinned = !this.isPinned;
        await this.appWindow.setAlwaysOnTop(this.isPinned);
        document.getElementById('btn-pin').classList.toggle('active', this.isPinned);
        this._showToast(this.isPinned ? 'Đã ghim luôn nổi' : 'Bỏ ghim');
    }

    _updateStartButton() {
        const play = document.getElementById('icon-play');
        const stop = document.getElementById('icon-stop');
        const label = document.getElementById('btn-start-label');
        const btn = document.getElementById('btn-start');
        play.style.display = this.isRunning ? 'none' : '';
        stop.style.display = this.isRunning ? '' : 'none';
        label.textContent = this.isRunning ? 'Dừng' : 'Bắt đầu';
        btn.classList.toggle('recording', this.isRunning);
        document.getElementById('btn-pause').disabled = !this.isRunning;
    }

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');
        dot.className = 'status-dot';

        switch (status) {
            case 'connecting':
                dot.classList.add('connecting');
                text.textContent = 'Đang kết nối…';
                break;
            case 'connected':
                dot.classList.add('connected');
                text.textContent = 'Đang nghe';
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'Lỗi';
                break;
            default:
                dot.classList.add('disconnected');
                text.textContent = 'Sẵn sàng';
        }

        setLiveBadge(this.isRunning);
        if (this.isRunning) startAutoHideWatch();
        else stopAutoHideWatch();
    }

    // ─── Library ───────────────────────────────────────────

    async _showSessions(query) {
        const listEl = document.getElementById('sessions-list');
        document.getElementById('sessions-list-panel').style.display = '';
        document.getElementById('session-viewer').style.display = 'none';
        listEl.innerHTML = '<div class="sessions-loading">Đang tải…</div>';

        try {
            const useSearch = query && query.trim();
            const sessions = await invoke(useSearch ? 'search_sessions' : 'list_sessions',
                useSearch ? { query: query.trim() } : {});

            if (!sessions.length) {
                listEl.innerHTML = '<div class="sessions-empty">Chưa có session nào.</div>';
                return;
            }
            listEl.innerHTML = sessions.map((s) => this._renderSessionItem(s)).join('');

            listEl.querySelectorAll('.session-item').forEach((item) => {
                item.addEventListener('click', (e) => {
                    if (e.target.closest('.session-delete-btn')) return;
                    this._openSession(item.dataset.id, item.dataset.legacy === '1');
                });
            });
            listEl.querySelectorAll('.session-delete-btn').forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const id = btn.dataset.id;
                    // Deleting the live session would just be undone by the next
                    // autosave, so block it rather than fail confusingly.
                    if (id === sessionStore.id) {
                        this._showToast('Không xóa được session đang chạy — hãy Dừng trước', 'error');
                        return;
                    }
                    if (!confirm('Xóa vĩnh viễn session này?')) return;
                    try {
                        await invoke('delete_session', { id });
                        await this._showSessions();
                    } catch (err) {
                        this._showToast(`Xóa thất bại: ${err}`, 'error');
                    }
                });
            });
        } catch (err) {
            listEl.innerHTML = `<div class="sessions-empty">Lỗi: ${this._esc(String(err))}</div>`;
        }
    }

    _renderSessionItem(s) {
        const title = this._esc(s.title || 'Session chưa đặt tên');
        const created = this._esc((s.created_at || '').slice(0, 16).replace('T', ' '));
        const duration = this._formatSeconds(s.duration_sec || 0);
        const engine = s.has_legacy_only ? 'legacy' : (s.engine || '—');
        const pair = s.source_lang && s.target_lang
            ? `<span class="session-badge">${this._esc(s.source_lang.toUpperCase())}→${this._esc(s.target_lang.toUpperCase())}</span>`
            : '';
        return `<button class="session-item" type="button" data-id="${this._escAttr(s.id)}" data-legacy="${s.has_legacy_only ? '1' : '0'}">
            <span class="session-item-row1">
                <span class="session-item-title">${title}</span>
                ${pair}
                <span class="session-delete-btn" title="Xóa" data-id="${this._escAttr(s.id)}">×</span>
            </span>
            <span class="session-item-row2">
                <span class="session-meta-dim">${created}${duration ? ` · ${duration}` : ''}</span>
                <span class="session-badge badge-engine">${this._esc(engine)}</span>
            </span>
        </button>`;
    }

    async _openSession(id, isLegacy = false) {
        document.getElementById('sessions-list-panel').style.display = 'none';
        document.getElementById('session-viewer').style.display = '';
        const title = document.getElementById('session-viewer-title');
        const content = document.getElementById('session-viewer-content');
        title.textContent = id;
        content.textContent = 'Đang tải…';
        this._currentViewedSession = { id, isLegacy };

        try {
            if (isLegacy) {
                content.textContent = await invoke('read_legacy_session', { id });
            } else {
                const result = await invoke('read_session', { id });
                content.textContent = result.md;
                title.textContent = result.json.title || id;
            }
        } catch (err) {
            content.textContent = `Lỗi tải session: ${err}`;
        }
    }

    async _renameViewedSession() {
        const cur = this._currentViewedSession;
        if (!cur || cur.isLegacy) return;
        const title = prompt('Tên mới cho session:', document.getElementById('session-viewer-title').textContent);
        if (!title) return;
        try {
            await invoke('update_session_title', { id: cur.id, title });
            document.getElementById('session-viewer-title').textContent = title;
        } catch (err) {
            this._showToast(`Đổi tên thất bại: ${err}`, 'error');
        }
    }

    async _exportCurrentSession(format) {
        const cur = this._currentViewedSession;
        if (!cur || cur.isLegacy) {
            this._showToast('Không xuất được session legacy', 'error');
            return;
        }
        try {
            const text = await invoke(format === 'srt' ? 'export_session_srt' : 'export_session_txt', { id: cur.id });
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${cur.id}.${format}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            this._showToast(`Đã xuất .${format}`);
        } catch (err) {
            this._showToast(`Xuất thất bại: ${err}`, 'error');
        }
    }

    // ─── MLX setup modal ───────────────────────────────────

    _runMlxSetup() {
        const modal = document.getElementById('setup-modal');
        const fill = document.getElementById('setup-progress-fill');
        const pct = document.getElementById('setup-progress-pct');
        const statusText = document.getElementById('setup-status-text');
        const cancelBtn = document.getElementById('btn-cancel-setup');
        const steps = ['check', 'venv', 'packages', 'models'];
        const weights = { check: 5, venv: 10, packages: 35, models: 50 };

        const markStep = (name, icon, active) => {
            const el = document.getElementById(`step-${name}`);
            if (!el) return;
            el.querySelector('.step-icon').textContent = icon;
            el.classList.toggle('active', active);
            el.classList.toggle('done', icon === '✅');
        };
        const setProgress = (p) => {
            const v = Math.min(100, p);
            fill.style.width = `${v}%`;
            pct.textContent = `${Math.round(v)}%`;
        };

        modal.style.display = 'flex';

        return new Promise((resolve, reject) => {
            const channel = new window.__TAURI__.core.Channel();
            const onCancel = () => { modal.style.display = 'none'; reject(new Error('Đã hủy cài đặt')); };
            cancelBtn.addEventListener('click', onCancel, { once: true });

            channel.onmessage = (msg) => {
                let data;
                try { data = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch { return; }

                if (data.type === 'progress') {
                    statusText.textContent = data.message || 'Đang xử lý…';
                    if (data.step) {
                        const idx = steps.indexOf(data.step);
                        steps.forEach((s, i) => {
                            if (i < idx) markStep(s, '✅', false);
                            else if (i === idx) markStep(s, data.done ? '✅' : '🔄', !data.done);
                        });
                        let p = 0;
                        steps.forEach((s, i) => {
                            if (i < idx) p += weights[s];
                            else if (i === idx) p += ((data.progress || 0) / 100) * weights[s];
                        });
                        setProgress(p);
                    }
                } else if (data.type === 'complete') {
                    setProgress(100);
                    steps.forEach((s) => markStep(s, '✅', false));
                    statusText.textContent = data.message || 'Hoàn tất';
                    setTimeout(() => { modal.style.display = 'none'; resolve(); }, 800);
                } else if (data.type === 'error') {
                    statusText.textContent = data.message || 'Cài đặt thất bại';
                    cancelBtn.textContent = 'Đóng';
                    cancelBtn.removeEventListener('click', onCancel);
                    cancelBtn.addEventListener('click', () => {
                        modal.style.display = 'none';
                        reject(new Error(data.message));
                    }, { once: true });
                }
            };

            invoke('run_mlx_setup', { channel }).catch((err) => {
                modal.style.display = 'none';
                reject(err);
            });
        });
    }

    // ─── Window ────────────────────────────────────────────

    _bindResizeHandle() {
        const handle = document.getElementById('resize-handle');
        if (!handle) return;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.appWindow.startResizeDragging?.('SouthEast').catch(() => {});
        });
    }

    async _saveWindowPosition() {
        try {
            const factor = await this.appWindow.scaleFactor();
            const pos = await this.appWindow.outerPosition();
            const size = await this.appWindow.innerSize();
            localStorage.setItem('window_state', JSON.stringify({
                x: Math.round(pos.x / factor),
                y: Math.round(pos.y / factor),
                width: Math.round(size.width / factor),
                height: Math.round(size.height / factor),
            }));
        } catch (err) {
            console.error('save window position failed:', err);
        }
    }

    async _restoreWindowPosition() {
        try {
            const saved = localStorage.getItem('window_state');
            if (!saved) return;
            const state = JSON.parse(saved);
            const { LogicalPosition, LogicalSize } = window.__TAURI__.window;

            // A monitor that went away can leave the saved position off-screen,
            // which would open the window somewhere the user can't reach it.
            if (state.x < -100 || state.y < -100 || state.x > 5000 || state.y > 3000) {
                localStorage.removeItem('window_state');
                return;
            }
            if (state.width >= 300 && state.height >= 100) {
                await this.appWindow.setSize(new LogicalSize(state.width, state.height));
            }
            await this.appWindow.setPosition(new LogicalPosition(state.x, state.y));
        } catch (err) {
            localStorage.removeItem('window_state');
        }
    }

    async _bindCloseHooks() {
        await this.appWindow.onCloseRequested(async (event) => {
            if (this._closing) return;
            this._closing = true;
            event.preventDefault();
            await this._flushOnExit();
            await invoke('exit_app').catch(() => {});
        });

        await this.appWindow.listen('app-exit-requested', async () => {
            if (this._closing) return;
            this._closing = true;
            await this._flushOnExit();
            await invoke('exit_app').catch(() => {});
        });
    }

    async _flushOnExit() {
        await this._saveWindowPosition().catch(() => {});
        try { await this._saveMeetingNote(); } catch (e) { console.error('exit note failed:', e); }
        try { await sessionStore.endSession(); } catch (e) { console.error('exit endSession failed:', e); }
        try { await this.pause(); } catch (e) { console.error('exit pause failed:', e); }
    }

    // ─── Helpers ───────────────────────────────────────────

    _langName(code) {
        return LANG_NAMES[code] || (code || '').toUpperCase();
    }

    _formatDuration(ms) {
        const total = Math.round(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        if (h) return `${h}h${m ? ` ${m}m` : ''}`;
        return `${m || 1} phút`;
    }

    _formatSeconds(sec) {
        if (!sec) return '';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        if (h) return `${h}h ${m}m`;
        if (m) return `${m} phút`;
        return `${sec}s`;
    }

    _showToast(message, type = 'success', onClick = null) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        if (onClick) {
            toast.style.cursor = 'pointer';
            toast.addEventListener('click', onClick);
        }
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, onClick ? 6000 : 3000);
    }

    _esc(str) {
        const div = document.createElement('div');
        div.textContent = str ?? '';
        return div.innerHTML;
    }

    _escAttr(str) {
        return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }
}

const app = new App();
app.init().catch((err) => {
    console.error('App init failed:', err);
});
window.app = app;
