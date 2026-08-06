pub mod microphone;
pub mod resampler;
pub mod system_audio;

pub use system_audio::SystemAudioCapture;

/// Target audio format for Soniox: PCM s16le, 16kHz, mono
pub const TARGET_SAMPLE_RATE: u32 = 16000;
pub const TARGET_CHANNELS: u16 = 1;
