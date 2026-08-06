/**
 * LLM backend abstraction for the meeting assistant.
 *
 * Two providers, chosen in Settings → Trợ lý AI:
 *
 *   claude-cli    Shells out to the locally installed Claude Code CLI, which is
 *                 already authenticated with the user's Max/Pro subscription.
 *                 No per-token billing — calls draw on the plan's allowance.
 *                 Costs ~2-5s per call in process spawn and model time.
 *
 *   anthropic-api Calls the Messages API directly with an API key. Faster
 *                 (~1-2s) but billed per token against a separate API account.
 *
 * Both return plain text. Callers own the prompt and any parsing.
 */

const { invoke } = window.__TAURI__.core;

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export class LlmBackend {
    constructor() {
        this.backend = 'claude-cli';
        this.apiKey = '';
        this.cliPath = '';
    }

    configure({ llm_backend, anthropic_api_key, claude_cli_path } = {}) {
        if (llm_backend !== undefined) this.backend = llm_backend || 'claude-cli';
        if (anthropic_api_key !== undefined) this.apiKey = anthropic_api_key || '';
        if (claude_cli_path !== undefined) this.cliPath = claude_cli_path || '';
    }

    /** True when the selected backend has everything it needs to run. */
    isConfigured() {
        if (this.backend === 'anthropic-api') return !!this.apiKey;
        return true; // CLI path is resolved lazily by the Rust side
    }

    describe() {
        return this.backend === 'anthropic-api'
            ? 'Anthropic API'
            : 'Claude CLI (gói Max/Pro)';
    }

    /**
     * Run one prompt and return the model's text.
     *
     * @param {string} prompt   The user-turn content.
     * @param {object} opts
     * @param {string} opts.model      Model id.
     * @param {string} [opts.system]   System prompt.
     * @param {number} [opts.maxTokens]
     * @param {number} [opts.timeoutSec]
     */
    async complete(prompt, { model, system, maxTokens = 2000, timeoutSec = 120 } = {}) {
        if (!model) throw new Error('Thiếu model cho lệnh gọi LLM');

        if (this.backend === 'anthropic-api') {
            return this._completeViaApi(prompt, { model, system, maxTokens, timeoutSec });
        }
        return this._completeViaCli(prompt, { model, system, timeoutSec });
    }

    async _completeViaCli(prompt, { model, system, timeoutSec }) {
        const res = await invoke('claude_cli_prompt', {
            cliPath: this.cliPath,
            prompt,
            model,
            system: system || null,
            timeoutSec,
        });
        return { text: res.text, durationMs: res.duration_ms, backend: 'claude-cli' };
    }

    async _completeViaApi(prompt, { model, system, maxTokens, timeoutSec }) {
        if (!this.apiKey) {
            throw new Error('Chưa nhập Anthropic API key trong Cài đặt → Trợ lý AI');
        }

        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

        try {
            const body = {
                model,
                max_tokens: maxTokens,
                messages: [{ role: 'user', content: prompt }],
            };
            if (system) body.system = system;

            const res = await fetch(API_URL, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': API_VERSION,
                    // The WebView enforces CORS; Anthropic gates browser-origin
                    // calls behind this opt-in header.
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 300)}`);
            }

            const json = await res.json();
            if (json.stop_reason === 'refusal') {
                throw new Error('Model từ chối yêu cầu này.');
            }
            const text = (json.content || [])
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('')
                .trim();

            return { text, durationMs: Date.now() - started, backend: 'anthropic-api' };
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`Anthropic API quá thời gian chờ (${timeoutSec}s)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Probe the CLI so the user finds problems in Settings, not mid-meeting. */
    async checkCli() {
        return invoke('check_claude_cli', { cliPath: this.cliPath });
    }
}

export const llmBackend = new LlmBackend();
