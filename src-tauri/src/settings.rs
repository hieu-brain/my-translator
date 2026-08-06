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

/// Custom context for Soniox — provides domain-specific hints
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    pub domain: Option<String>,
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
        }
    }
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
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
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
