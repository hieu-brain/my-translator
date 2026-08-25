/**
 * Mock Tauri APIs for browser-only UI testing (dev server on :3111).
 * Loaded before app.js. Dev-only: activates ONLY when the real Tauri runtime is
 * absent AND we are on the dev port — so it can never shadow window.__TAURI__ in
 * the packaged app (production origin is tauri://localhost, no :3111).
 */

if (!window.__TAURI__ && location.port === '3111') {
    console.warn('[tauri-mock] Browser dev mode — Tauri APIs are mocked');

    const mockSettings = {
        soniox_api_key: '',
        source_language: 'auto',
        target_language: 'vi',
        translation_type: 'two_way',
        language_a: 'ja',
        language_b: 'vi',
        language_hints_strict: false,
        endpoint_delay: 3000,
        audio_source: 'system',
        overlay_opacity: 0.9,
        font_size: 16,
        max_lines: 5,
        show_original: true,
        furigana_enabled: true,
        translation_mode: 'soniox',
        custom_context: null,

        llm_backend: 'claude-cli',
        anthropic_api_key: '',
        claude_cli_path: '',
        summary_model: 'claude-haiku-4-5',
        reply_model: 'claude-sonnet-5',
        auto_summary_enabled: true,
        auto_summary_interval_sec: 120,
        auto_summary_min_segments: 20,
        default_notes_dir: '',
        meeting_profiles: [
            {
                id: 'p-demo',
                name: 'my-cms',
                project_path: '/Users/dev/Projects/my-cms',
                backlog_project_key: 'MYCMS',
                note_files: [],
            },
        ],
        active_profile_id: 'p-demo',
        backlog_space: '',
        backlog_api_key: '',
    };

    const mockSessions = [
        {
            id: '2026-08-05-1400', title: 'Họp CMS renewal — khách hàng A',
            created_at: '2026-08-05T14:00', duration_sec: 2520, engine: 'soniox',
            source_lang: 'ja', target_lang: 'vi', segment_count: 184, chunk_count: 1,
            has_legacy_only: false,
        },
        {
            id: '2026-08-04-0930', title: 'Daily standup đội dev',
            created_at: '2026-08-04T09:30', duration_sec: 900, engine: 'soniox',
            source_lang: 'ja', target_lang: 'vi', segment_count: 61, chunk_count: 1,
            has_legacy_only: false,
        },
    ];

    const mockSummary = `CHỦ ĐỀ: Đánh giá công số renew CMS thay vì migration
QUYẾT ĐỊNH: Ưu tiên hướng renew, cần ước tính sơ bộ trước khi chốt
ACTIONS:
- Gửi ước tính sơ bộ · Minh · thứ Tư tuần sau
- Gửi danh sách chức năng hiện có · Tanaka`;

    const mockReplies = `VI: Được, tôi sẽ gửi ước tính sơ bộ trước thứ Tư tuần sau.
JA: はい、来週の水曜日までに概算をお送りします。

VI: Tuần sau hơi gấp — cho tôi thêm 2 ngày được không?
JA: 来週は少し厳しいので、あと2日いただけますか？`;

    window.__TAURI__ = {
        core: {
            invoke: async (cmd, args) => {
                console.log('[tauri-mock] invoke:', cmd, args);
                switch (cmd) {
                    case 'get_settings':
                        return mockSettings;
                    case 'save_settings':
                        Object.assign(mockSettings, args?.newSettings || {});
                        return null;
                    case 'get_platform_info':
                        return '{"os":"macos","arch":"aarch64","is_arm_hardware":true,"version":"0.9.1"}';
                    case 'check_claude_cli':
                        return '2.1.221 (Claude Code)';
                    case 'claude_cli_prompt': {
                        // Echo back plausible shapes so the panel rendering can be
                        // exercised without a real model call.
                        await new Promise((r) => setTimeout(r, 400));
                        const isReply = /CÂU CẦN TRẢ LỜI/.test(args?.prompt || '');
                        return { text: isReply ? mockReplies : mockSummary, duration_ms: 400 };
                    }
                    case 'read_project_context':
                        return {
                            root: args?.projectPath || '/Users/dev/Projects/my-cms',
                            files: [{ path: 'CLAUDE.md', content: '# my-cms\nLegacy CMS…', truncated: false }],
                            total_bytes: 32, skipped: [],
                        };
                    case 'read_note_files':
                        return [];
                    case 'meeting_notes_dir':
                        return args?.projectPath
                            ? `${args.projectPath.replace(/\/$/, '')}-meeting-notes`.replace(
                                /\/([^/]+)-meeting-notes$/, '/$1-meeting-notes')
                            : (args?.defaultNotesDir || '/Users/dev/Documents/meeting-notes');
                    case 'save_meeting_note':
                        return '/Users/dev/Projects/my-cms-meeting-notes/2026-08-05-hop-cms.md';
                    case 'open_path_in_finder':
                        return null;
                    case 'list_sessions':
                        return mockSessions;
                    case 'search_sessions':
                        return mockSessions.filter((s) =>
                            s.title.toLowerCase().includes((args?.query || '').toLowerCase()));
                    case 'read_session':
                        return { md: '# Session\n\n[14:00:12] Xin chào.', json: { title: 'Session demo' } };
                    case 'read_legacy_session':
                        return 'legacy transcript';
                    case 'export_session_srt':
                    case 'export_session_txt':
                        return 'demo export';
                    case 'delete_session':
                    case 'update_session_title':
                    case 'save_session':
                    case 'open_transcript_dir':
                    case 'start_capture':
                    case 'stop_capture':
                    case 'append_token_log':
                        return '/mock/token-logs/' + (args?.file || 'log.jsonl');
                    case 'start_caption_bridge':
                    case 'stop_caption_bridge':
                    case 'stop_local_pipeline':
                    case 'send_audio_to_pipeline':
                    case 'exit_app':
                        return null;
                    case 'check_mlx_setup':
                        return '{"ready":true}';
                    case 'list_transcripts':
                        return [];
                    default:
                        console.warn('[tauri-mock] unhandled command:', cmd);
                        return null;
                }
            },
            Channel: class {
                constructor() { this.onmessage = null; }
            },
        },
        dialog: {
            open: async () => '/Users/dev/Projects/my-cms',
        },
        opener: {
            openUrl: async (url) => window.open(url, '_blank'),
        },
        window: {
            LogicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } },
            LogicalSize: class { constructor(width, height) { this.width = width; this.height = height; } },
            getCurrentWindow: () => ({
                setAlwaysOnTop: async () => {},
                outerPosition: async () => ({ x: 100, y: 100 }),
                innerSize: async () => ({ width: 900, height: 640 }),
                scaleFactor: async () => 1,
                setPosition: async () => {},
                setSize: async () => {},
                startResizeDragging: async () => {},
                close: async () => { window.close(); },
                minimize: async () => {},
                onCloseRequested: async () => {},
                onResized: async () => {},
                listen: async () => {},
            }),
        },
    };
}
