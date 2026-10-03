/**
 * Meeting assistant — rolling summary + reply suggestions.
 *
 * Two jobs, deliberately split across two models:
 *
 *   Rolling summary  Runs on a timer while recording, feeding the previous
 *                    summary plus only the new segments to a cheap model. It is
 *                    incremental so cost stays flat as the meeting grows, and
 *                    it skips entirely when nothing new was said — a quiet
 *                    meeting costs nothing.
 *
 *   Reply suggestion On demand, when the user picks a sentence. Uses a stronger
 *                    model and the full context (project docs, Backlog, running
 *                    summary, recent transcript) because this is the output the
 *                    user reads out loud.
 *
 * The summary is also what lands at the top of the saved meeting note.
 */

import { llmBackend } from './llm-backend.js';
import { contextProviders } from './context-providers.js';

const SUMMARY_SYSTEM = `Bạn là trợ lý ghi chép cuộc họp song ngữ Nhật–Việt cho một BrSE.
Nhiệm vụ: duy trì một bản tóm tắt NGẮN GỌN, luôn cập nhật, của cuộc họp đang diễn ra.

Trả về đúng định dạng sau, không thêm lời dẫn:
CHỦ ĐỀ: <một câu>
QUYẾT ĐỊNH: <một hoặc hai câu; ghi "chưa có" nếu chưa chốt gì>
ACTIONS:
- <việc cần làm> · <người phụ trách> · <hạn nếu có>
(nếu chưa có action nào thì ghi "- chưa có")

Viết bằng tiếng Việt. Chỉ ghi những gì thực sự được nói, không suy diễn.`;

const REPLY_SYSTEM = `Bạn là trợ lý cho một BrSE người Việt đang họp với khách hàng Nhật.
Người dùng vừa được hỏi một câu. Hãy đề xuất 2-3 phương án trả lời phù hợp,
dựa trên NGỮ CẢNH DỰ ÁN và diễn biến cuộc họp — trả lời cụ thể, không chung chung.

Mỗi phương án gồm hai dòng, theo đúng định dạng:
VI: <câu trả lời tiếng Việt, tự nhiên, đúng mức độ cam kết>
JA: <bản tiếng Nhật lịch sự, dùng được ngay trong họp (敬語)>

Ngăn cách các phương án bằng một dòng trống. Không thêm lời dẫn hay giải thích.
Nếu ngữ cảnh không đủ để cam kết chắc chắn, hãy đề xuất câu trả lời thận trọng
(xin thêm thời gian, xác nhận lại) thay vì bịa số liệu.`;

export class MeetingAssistant {
    constructor(transcriptUI) {
        this.ui = transcriptUI;
        this.settings = {};
        this.profile = null;

        this.summary = '';
        this.summaryUpdatedAt = null;
        this.projectContext = '';

        /** Index into sessionLog marking what the last summary already covered. */
        this._summarizedUpto = 0;
        this._timer = null;
        this._summaryInFlight = false;
        this._replyInFlight = false;

        /** Set by the app to render state changes. */
        this.onSummary = null;
        this.onReplies = null;
        this.onStatus = null;
    }

    configure(settings) {
        this.settings = settings || {};
        llmBackend.configure(this.settings);
        this.profile =
            (this.settings.meeting_profiles || []).find(
                (p) => p.id === this.settings.active_profile_id
            ) || null;
    }

    get profileName() {
        return this.profile?.name || '';
    }

    /** Load project context once, before the meeting gets busy. */
    async prepare() {
        try {
            this.projectContext = await contextProviders.build(this.profile, this.settings);
        } catch (err) {
            console.warn('Context build failed:', err);
            this.projectContext = '';
        }
    }

    // ─── Session lifecycle ─────────────────────────────────

    start() {
        this.reset();
        this.prepare();
        this._scheduleAuto();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    reset() {
        this.stop();
        // Lời gọi tóm tắt đang bay thuộc về phiên cũ: khi về sẽ bị bỏ.
        this._generation = (this._generation || 0) + 1;
        this.summary = '';
        this.summaryUpdatedAt = null;
        this._summarizedUpto = 0;
        if (this.onSummary) this.onSummary('', null);
        if (this.onReplies) this.onReplies(null);
    }

    _scheduleAuto() {
        this.stop();
        if (!this.settings.auto_summary_enabled) return;

        const intervalMs = Math.max(30, this.settings.auto_summary_interval_sec || 120) * 1000;
        this._timer = setInterval(() => {
            const newCount = this.ui.segmentCount - this._summarizedUpto;
            const minSegments = this.settings.auto_summary_min_segments || 20;
            // A meeting with long silences shouldn't burn calls (or plan usage)
            // producing the same summary over and over.
            if (newCount >= minSegments) this.summarize({ auto: true });
        }, intervalMs);
    }

    // ─── Rolling summary ───────────────────────────────────

    /**
     * Update the rolling summary. `auto` calls are silent about "nothing new";
     * a manual press should always say something back.
     */
    async summarize({ auto = false } = {}) {
        if (this._summaryInFlight) return this.summary;

        const total = this.ui.segmentCount;
        const newCount = total - this._summarizedUpto;
        if (newCount <= 0) {
            if (!auto && this.onStatus) this.onStatus('Chưa có nội dung mới để tóm tắt.', 'info');
            return this.summary;
        }
        if (!llmBackend.isConfigured()) {
            if (this.onStatus) {
                this.onStatus('Chưa cấu hình backend LLM (Cài đặt → Trợ lý AI).', 'error');
            }
            return this.summary;
        }

        this._summaryInFlight = true;
        const generation = this._generation || 0;
        if (this.onStatus) this.onStatus('Đang tóm tắt…', 'busy');

        try {
            const chunk = this.ui.getTranscriptForLLM({
                sinceIndex: this._summarizedUpto,
                max: 400,
            });

            const prompt = [
                this.summary
                    ? `TÓM TẮT HIỆN TẠI:\n${this.summary}`
                    : 'TÓM TẮT HIỆN TẠI: (chưa có — đây là phần đầu cuộc họp)',
                '',
                `NỘI DUNG MỚI (${newCount} câu):`,
                chunk,
                '',
                'Hãy cập nhật bản tóm tắt để bao gồm cả nội dung mới.',
            ].join('\n');

            const res = await llmBackend.complete(prompt, {
                model: this.settings.summary_model || 'claude-haiku-4-5',
                system: SUMMARY_SYSTEM,
                maxTokens: 1200,
                timeoutSec: 90,
            });

            if ((this._generation || 0) !== generation) {
                // reset() đã chạy (phiên đã kết thúc hoặc bị bỏ) — kết quả này
                // thuộc transcript cũ, dán lên phiên mới là sai.
                if (this.onStatus) this.onStatus(null, 'ok');
                return this.summary;
            }
            this.summary = res.text.trim();
            this.summaryUpdatedAt = Date.now();
            // Only advance after a successful call — a failed summary must not
            // silently skip the segments it never read.
            this._summarizedUpto = total;

            if (this.onSummary) this.onSummary(this.summary, this.summaryUpdatedAt);
            if (this.onStatus) this.onStatus(null, 'ok');
            return this.summary;
        } catch (err) {
            console.error('Summary failed:', err);
            if (this.onStatus) this.onStatus(String(err.message || err), 'error');
            return this.summary;
        } finally {
            this._summaryInFlight = false;
        }
    }

    // ─── Reply suggestions ─────────────────────────────────

    /**
     * Suggest replies to one utterance.
     * @param {object} segment  A sessionLog entry (from click or "câu vừa rồi").
     */
    async suggestReplies(segment) {
        if (!segment) return null;
        if (this._replyInFlight) return null;
        if (!llmBackend.isConfigured()) {
            if (this.onStatus) {
                this.onStatus('Chưa cấu hình backend LLM (Cài đặt → Trợ lý AI).', 'error');
            }
            return null;
        }

        this._replyInFlight = true;
        if (this.onReplies) this.onReplies({ loading: true, quote: this._quote(segment) });

        try {
            const idx = this.ui.sessionLog.indexOf(segment);
            const from = Math.max(0, (idx === -1 ? this.ui.segmentCount : idx) - 15);
            const recent = this.ui.getTranscriptForLLM({ sinceIndex: from, max: 30 });

            const prompt = [
                this.projectContext ? `# NGỮ CẢNH DỰ ÁN\n\n${this.projectContext}\n` : '',
                this.summary ? `# TÓM TẮT CUỘC HỌP ĐẾN LÚC NÀY\n\n${this.summary}\n` : '',
                `# DIỄN BIẾN GẦN ĐÂY\n\n${recent}\n`,
                `# CÂU CẦN TRẢ LỜI\n\n${this._quote(segment)}`,
            ]
                .filter(Boolean)
                .join('\n');

            const res = await llmBackend.complete(prompt, {
                model: this.settings.reply_model || 'claude-sonnet-5',
                system: REPLY_SYSTEM,
                maxTokens: 1500,
                timeoutSec: 120,
            });

            const replies = this._parseReplies(res.text);
            const payload = { quote: this._quote(segment), replies, loading: false };
            if (this.onReplies) this.onReplies(payload);
            return payload;
        } catch (err) {
            console.error('Reply suggestion failed:', err);
            if (this.onReplies) {
                this.onReplies({
                    quote: this._quote(segment),
                    replies: [],
                    loading: false,
                    error: String(err.message || err),
                });
            }
            return null;
        } finally {
            this._replyInFlight = false;
        }
    }

    _quote(segment) {
        return (segment.translation || segment.original || '').trim();
    }

    /**
     * Parse the VI:/JA: pairs. Tolerant by design — a malformed line becomes a
     * VI-only suggestion rather than throwing away the whole response.
     */
    _parseReplies(text) {
        const replies = [];
        let current = null;

        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (!line) continue;

            const vi = line.match(/^VI\s*[:：]\s*(.+)$/i);
            const ja = line.match(/^JA\s*[:：]\s*(.+)$/i);

            if (vi) {
                if (current) replies.push(current);
                current = { vi: vi[1].trim(), ja: '' };
            } else if (ja && current) {
                current.ja = ja[1].trim();
                replies.push(current);
                current = null;
            } else if (ja && !current) {
                replies.push({ vi: '', ja: ja[1].trim() });
            }
        }
        if (current) replies.push(current);

        if (!replies.length && text.trim()) {
            replies.push({ vi: text.trim(), ja: '' });
        }
        return replies.slice(0, 3);
    }

    /** Count of action-item lines, for the panel header badge. */
    get actionItemCount() {
        if (!this.summary) return 0;
        const section = this.summary.split(/ACTIONS\s*[:：]/i)[1];
        if (!section) return 0;
        return section
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('-') && !/chưa có/i.test(l)).length;
    }
}
