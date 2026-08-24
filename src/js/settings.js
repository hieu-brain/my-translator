/**
 * Settings Manager — handles loading/saving settings via Tauri IPC
 */

const { invoke } = window.__TAURI__.core;

// Default settings shape
const DEFAULT_SETTINGS = {
  soniox_api_key: '',
  source_language: 'auto',
  target_language: 'vi',
  translation_type: 'one_way',
  language_a: 'ja',
  language_b: 'vi',
  language_hints_strict: false,
  endpoint_delay: 3000,
  audio_source: 'system',
  overlay_opacity: 0.85,
  font_size: 16,
  max_lines: 5,
  show_original: true,
  furigana_enabled: false,
  translation_mode: 'soniox',
  custom_context: null,

  // Meeting assistant
  llm_backend: 'claude-cli',
  anthropic_api_key: '',
  claude_cli_path: '',
  summary_model: 'claude-haiku-4-5',
  reply_model: 'claude-sonnet-5',
  auto_summary_enabled: true,
  auto_summary_interval_sec: 120,
  auto_summary_min_segments: 20,
  default_notes_dir: '',
  meeting_profiles: [],
  active_profile_id: '',
  backlog_space: '',
  backlog_api_key: '',

  // Caption bridge (Chrome extension đọc live captions của Teams web)
  caption_bridge_port: 8477,
  caption_bridge_token: '',
};

class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._listeners = [];
  }

  /**
   * Load settings from Rust backend
   */
  async load() {
    try {
      const settings = await invoke('get_settings');
      this.settings = { ...DEFAULT_SETTINGS, ...settings };
    } catch (err) {
      console.error('Failed to load settings:', err);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this._notify();
    return this.settings;
  }

  /**
   * Save settings to Rust backend
   */
  async save(newSettings) {
    try {
      const merged = { ...this.settings, ...newSettings };
      await invoke('save_settings', { newSettings: merged });
      this.settings = merged;
      this._notify();
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      throw err;
    }
  }

  /**
   * Get current settings (cached)
   */
  get() {
    return { ...this.settings };
  }

  /**
   * Subscribe to settings changes
   */
  onChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  _notify() {
    const settings = this.get();
    this._listeners.forEach(cb => cb(settings));
  }
}

// Singleton
export const settingsManager = new SettingsManager();
