use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Translation term: source → target mapping for Soniox
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationTerm {
    pub source: String,
    pub target: String,
}

/// Custom context for Soniox — provides domain-specific hints.
///
/// Every field the settings form collects must exist here: serde silently
/// drops unknown fields on save, so a missing field means the user types a
/// value, sees it in the form once, and it never reaches Soniox. That is
/// exactly what happened to `terms`, `general` and `text` before they were
/// added — transcription terms never persisted.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    /// Legacy single domain string (older settings files). The form writes
    /// `general` instead; soniox.js falls back to this when `general` is empty.
    pub domain: Option<String>,
    /// Free-form key → value hints (domain, topic, speakers…). Stored as a map
    /// because that is what the form produces; soniox.js converts to the
    /// `[{key, value}]` list the API wants.
    pub general: std::collections::BTreeMap<String, String>,
    /// Transcription terms: words Soniox should expect (names, project jargon).
    pub terms: Vec<String>,
    /// Longer unstructured background text.
    pub text: String,
    pub translation_terms: Vec<TranslationTerm>,
}

/// A meeting profile binds a meeting to a project so the assistant can pull
/// real context (repo docs, Backlog issues, attached notes) and knows where to
/// write the meeting note when the session ends.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct MeetingProfile {
    pub id: String,
    pub name: String,
    /// Absolute path to the project folder (reads CLAUDE.md / README / docs).
    pub project_path: String,
    /// Backlog project key, e.g. "MYCMS". Empty = no Backlog lookup.
    pub backlog_project_key: String,
    /// Extra note files (.md/.txt) attached as context.
    pub note_files: Vec<String>,
}

/// App settings — persisted to JSON
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Soniox API key
    pub soniox_api_key: String,
    /// Source language: "auto" or ISO 639-1 code
    pub source_language: String,
    /// Target language: ISO 639-1 code
    pub target_language: String,
    /// Translation direction: "one_way" | "two_way"
    pub translation_type: String,
    /// Two-way mode: language A (e.g. "ja")
    pub language_a: String,
    /// Two-way mode: language B (e.g. "vi")
    pub language_b: String,
    /// Restrict Soniox to the configured languages instead of auto-detecting
    pub language_hints_strict: bool,
    /// Soniox endpoint delay in ms — how long to wait before finalizing a segment
    pub endpoint_delay: u32,
    /// Audio source: "system" | "microphone" | "both"
    pub audio_source: String,
    /// Overlay opacity: 0.0 - 1.0
    pub overlay_opacity: f64,
    /// Font size in px
    pub font_size: u32,
    /// Max transcript lines to display
    pub max_lines: u32,
    /// Whether to show original text alongside translation
    pub show_original: bool,
    /// Show furigana above Japanese kanji in the transcript
    pub furigana_enabled: bool,
    /// Translation mode: "soniox" | "local"
    pub translation_mode: String,
    /// Optional custom context for better transcription
    pub custom_context: Option<CustomContext>,

    // ── Meeting assistant ──────────────────────────────────────────
    /// LLM backend: "claude-cli" (uses the signed-in Claude Max/Pro plan via
    /// the Claude Code CLI, no per-token billing) or "anthropic-api" (API key).
    pub llm_backend: String,
    /// Anthropic API key — only used when llm_backend = "anthropic-api".
    pub anthropic_api_key: String,
    /// Path to the `claude` executable. Empty = resolve from PATH.
    pub claude_cli_path: String,
    /// Model for the rolling summary (cheap, runs often).
    pub summary_model: String,
    /// Model for reply suggestions (higher quality, runs on demand).
    pub reply_model: String,
    /// Run the rolling summary automatically while recording.
    pub auto_summary_enabled: bool,
    /// Minimum seconds between automatic summaries.
    pub auto_summary_interval_sec: u32,
    /// Minimum new segments before an automatic summary is worth running.
    pub auto_summary_min_segments: u32,
    /// Fallback folder for meeting notes when no project is selected.
    /// Empty = ~/Documents/meeting-notes
    pub default_notes_dir: String,
    /// Saved meeting profiles.
    pub meeting_profiles: Vec<MeetingProfile>,
    /// Id of the profile used for the next session. Empty = no project.
    pub active_profile_id: String,
    /// Backlog space, e.g. "myspace.backlog.com"
    pub backlog_space: String,
    /// Backlog API key
    pub backlog_api_key: String,

    // ── Caption bridge (Chrome extension → app) ────────────────────
    /// Cổng WebSocket local mà extension kết nối vào.
    pub caption_bridge_port: u16,
    /// Token dùng chung với extension. Sinh tự động lần đầu.
    pub caption_bridge_token: String,

    // ── Chạy nền / phát hiện cuộc gọi ──────────────────────────────
    /// Mở app khi đăng nhập (LaunchAgent qua tauri-plugin-autostart), khởi
    /// động ẩn và chỉ hiện khi phát hiện cuộc gọi.
    pub launch_at_login: bool,
    /// Hỏi "Bắt đầu ghi?" khi app khác bắt đầu dùng micro.
    pub call_detection: bool,
    /// Ghim luôn nổi. Mặc định tắt — app chạy nền từ lúc đăng nhập mà luôn
    /// nổi trên mọi cửa sổ thì phiền; ⌘P bật lại và được nhớ.
    pub pin_on_top: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            soniox_api_key: String::new(),
            source_language: "auto".to_string(),
            target_language: "vi".to_string(),
            translation_type: "one_way".to_string(),
            language_a: "ja".to_string(),
            language_b: "vi".to_string(),
            language_hints_strict: false,
            endpoint_delay: 3000,
            audio_source: "system".to_string(),
            overlay_opacity: 0.85,
            font_size: 16,
            max_lines: 5,
            show_original: true,
            furigana_enabled: false,
            translation_mode: "soniox".to_string(),
            custom_context: None,

            llm_backend: "claude-cli".to_string(),
            anthropic_api_key: String::new(),
            claude_cli_path: String::new(),
            summary_model: "claude-haiku-4-5".to_string(),
            reply_model: "claude-sonnet-5".to_string(),
            auto_summary_enabled: true,
            auto_summary_interval_sec: 120,
            auto_summary_min_segments: 20,
            default_notes_dir: String::new(),
            meeting_profiles: Vec::new(),
            active_profile_id: String::new(),
            backlog_space: String::new(),
            backlog_api_key: String::new(),

            caption_bridge_port: 8477,
            // Để rỗng ở đây: `load()` mới sinh token rồi ghi xuống đĩa. Nếu sinh
            // trong Default thì mỗi lần khởi động app lại ra token khác (serde
            // dùng Default để bù field thiếu), và extension sẽ mất kết nối.
            caption_bridge_token: String::new(),
            launch_at_login: false,
            call_detection: true,
            pin_on_top: false,
        }
    }
}

/// Token ngẫu nhiên 32 hex cho caption bridge. Bất kỳ trang web nào cũng
/// connect được vào 127.0.0.1, nên đây là lớp chặn tối thiểu.
fn random_token() -> String {
    use rand::Rng;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    hex::encode(bytes)
}

/// Get the settings file path
/// ~/Library/Application Support/com.personal.translator/settings.json
fn settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.personal.translator");
    path.push("settings.json");
    path
}

impl Settings {
    /// Load settings from disk, or return defaults
    pub fn load() -> Self {
        let path = settings_path();
        let mut settings = if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        };

        // Sinh token caption bridge một lần duy nhất và ghi xuống đĩa, để token
        // giữ nguyên qua các lần khởi động.
        if settings.caption_bridge_token.is_empty() {
            settings.caption_bridge_token = random_token();
            let _ = settings.save();
        }

        settings
    }

    /// Save settings to disk
    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json =
            serde_json::to_string_pretty(self).map_err(|e| format!("Failed to serialize: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

        Ok(())
    }

    /// The profile selected for the next/current session, if any.
    pub fn active_profile(&self) -> Option<&MeetingProfile> {
        if self.active_profile_id.is_empty() {
            return None;
        }
        self.meeting_profiles
            .iter()
            .find(|p| p.id == self.active_profile_id)
    }
}

/// Thread-safe settings state managed by Tauri
pub struct SettingsState(pub Mutex<Settings>);

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the serde-drops-unknown-fields trap: every field the settings
    /// form writes into `custom_context` must survive a save/load round trip,
    /// otherwise it silently never reaches Soniox.
    #[test]
    fn custom_context_round_trips_every_form_field() {
        let json = r#"{
            "general": {"domain": "NOD weekly", "speakers": "坂田, 松井"},
            "terms": ["ヒエウ", "ランシステム"],
            "text": "background",
            "translation_terms": [{"source": "ヒエウ", "target": "Hieu"}]
        }"#;
        let ctx: CustomContext = serde_json::from_str(json).unwrap();
        let back: CustomContext =
            serde_json::from_str(&serde_json::to_string(&ctx).unwrap()).unwrap();
        assert_eq!(back.general.get("domain").map(String::as_str), Some("NOD weekly"));
        assert_eq!(back.general.len(), 2);
        assert_eq!(back.terms, vec!["ヒエウ", "ランシステム"]);
        assert_eq!(back.text, "background");
        assert_eq!(back.translation_terms.len(), 1);
    }

    #[test]
    fn legacy_custom_context_without_new_fields_still_loads() {
        let ctx: CustomContext =
            serde_json::from_str(r#"{"domain": "old", "translation_terms": []}"#).unwrap();
        assert_eq!(ctx.domain.as_deref(), Some("old"));
        assert!(ctx.terms.is_empty() && ctx.general.is_empty() && ctx.text.is_empty());
    }
}
