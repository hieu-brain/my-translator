/**
 * Project context for the meeting assistant.
 *
 * A reply suggestion is only useful if it knows what the project actually is —
 * "renew CMS thay vì migration" needs the repo's own docs and the open tickets
 * to answer concretely instead of generically. This module gathers that context
 * from three sources and renders it as one Markdown block for the prompt.
 *
 * Context is fetched once per meeting and cached: the files don't change
 * mid-meeting, and re-reading them on every summary would add latency to a call
 * that already runs every couple of minutes.
 */

const { invoke } = window.__TAURI__.core;

/** Cap the Backlog slice so a busy project can't crowd out the transcript. */
const MAX_BACKLOG_ISSUES = 25;

export class ContextProviders {
    constructor() {
        this._cache = new Map(); // profileId → rendered markdown
    }

    invalidate(profileId) {
        if (profileId) this._cache.delete(profileId);
        else this._cache.clear();
    }

    /**
     * Build the context block for a meeting profile.
     * Returns '' when no profile is selected — the assistant still works, it
     * just answers from the transcript alone.
     */
    async build(profile, settings) {
        if (!profile) return '';
        if (this._cache.has(profile.id)) return this._cache.get(profile.id);

        const parts = [];

        const project = await this._readProject(profile);
        if (project) parts.push(project);

        const notes = await this._readNotes(profile);
        if (notes) parts.push(notes);

        const backlog = await this._readBacklog(profile, settings);
        if (backlog) parts.push(backlog);

        const rendered = parts.join('\n\n');
        this._cache.set(profile.id, rendered);
        return rendered;
    }

    async _readProject(profile) {
        if (!profile.project_path) return '';
        try {
            const ctx = await invoke('read_project_context', {
                projectPath: profile.project_path,
            });
            if (!ctx.files.length) return '';

            const body = ctx.files
                .map((f) => {
                    const name = f.path.split('/').pop();
                    return `### ${name}\n${f.content}`;
                })
                .join('\n\n');
            return `## Tài liệu dự án (${ctx.root})\n\n${body}`;
        } catch (err) {
            console.warn('read_project_context failed:', err);
            return '';
        }
    }

    async _readNotes(profile) {
        const paths = profile.note_files || [];
        if (!paths.length) return '';
        try {
            const files = await invoke('read_note_files', { paths });
            if (!files.length) return '';
            const body = files
                .map((f) => `### ${f.path.split('/').pop()}\n${f.content}`)
                .join('\n\n');
            return `## Ghi chú đính kèm\n\n${body}`;
        } catch (err) {
            console.warn('read_note_files failed:', err);
            return '';
        }
    }

    async _readBacklog(profile, settings) {
        const key = profile.backlog_project_key?.trim();
        const space = settings?.backlog_space?.trim();
        const apiKey = settings?.backlog_api_key?.trim();
        if (!key || !space || !apiKey) return '';

        const host = space.replace(/^https?:\/\//, '').replace(/\/$/, '');
        try {
            // Resolve the project key to its numeric id — the issues endpoint
            // filters by id, not by key.
            const projRes = await fetch(
                `https://${host}/api/v2/projects/${encodeURIComponent(key)}?apiKey=${encodeURIComponent(apiKey)}`
            );
            if (!projRes.ok) throw new Error(`projects ${projRes.status}`);
            const project = await projRes.json();

            const params = new URLSearchParams({ apiKey, count: String(MAX_BACKLOG_ISSUES) });
            params.append('projectId[]', String(project.id));
            // 1 = open, 2 = in progress, 3 = resolved. Closed issues aren't
            // what anyone asks about in a status meeting.
            ['1', '2', '3'].forEach((s) => params.append('statusId[]', s));
            params.append('sort', 'updated');
            params.append('order', 'desc');

            const issuesRes = await fetch(`https://${host}/api/v2/issues?${params}`);
            if (!issuesRes.ok) throw new Error(`issues ${issuesRes.status}`);
            const issues = await issuesRes.json();
            if (!issues.length) return '';

            const rows = issues
                .map((i) => {
                    const assignee = i.assignee?.name || 'chưa gán';
                    const status = i.status?.name || '';
                    const due = i.dueDate ? ` · hạn ${i.dueDate.slice(0, 10)}` : '';
                    return `- [${i.issueKey}] ${i.summary} — ${status} · ${assignee}${due}`;
                })
                .join('\n');

            return `## Backlog — ${project.name} (${key})\n\n${rows}`;
        } catch (err) {
            console.warn('Backlog fetch failed:', err);
            return '';
        }
    }
}

export const contextProviders = new ContextProviders();
