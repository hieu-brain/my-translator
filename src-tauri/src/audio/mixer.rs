//! Mixes two 16 kHz mono s16le streams (system audio + microphone) into one.
//!
//! The old `"both"` path forwarded whole chunks from each source into a single
//! channel, so Soniox received system and mic audio *interleaved in time*:
//! 200 ms of the meeting, then 200 ms of the mic, then the meeting again. Each
//! second of wall-clock produced two seconds of audio, every utterance was
//! chopped into pieces separated by the other source, and recognition of the
//! user's own voice was effectively lost.
//!
//! This mixer sums samples instead, so one second of wall-clock stays one
//! second of audio with both voices in it. The two sources tick on different
//! clocks (ScreenCaptureKit vs CoreAudio), so they are buffered and paired by
//! length: whatever both have is mixed and emitted; if one source stalls (no
//! app playing audio, or a muted mic that stops delivering) the other is
//! flushed alone once it is more than `MAX_LAG_SAMPLES` ahead, which bounds the
//! extra latency instead of waiting forever.

use std::collections::VecDeque;

/// 300 ms at 16 kHz: how far one source may run ahead while the other is
/// silent before its samples are emitted alone.
pub const MAX_LAG_SAMPLES: usize = 16_000 * 300 / 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    System,
    Microphone,
}

#[derive(Default)]
pub struct Mixer {
    system: VecDeque<i16>,
    mic: VecDeque<i16>,
}

impl Mixer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append raw s16le bytes from one source. A trailing odd byte is dropped.
    pub fn push(&mut self, source: Source, bytes: &[u8]) {
        let buf = match source {
            Source::System => &mut self.system,
            Source::Microphone => &mut self.mic,
        };
        buf.extend(
            bytes
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]])),
        );
    }

    /// Emit what can be emitted now, as s16le bytes. Returns `None` when both
    /// buffers are short and neither has stalled long enough to flush.
    pub fn drain(&mut self, max_lag: usize) -> Option<Vec<u8>> {
        let paired = self.system.len().min(self.mic.len());
        let mut out: Vec<i16> = Vec::with_capacity(paired.max(max_lag));

        for _ in 0..paired {
            let a = self.system.pop_front().unwrap_or(0);
            let b = self.mic.pop_front().unwrap_or(0);
            out.push(mix_sample(a, b));
        }

        // One source stalled: pass the other through once it is far enough
        // ahead that waiting would only add latency.
        if self.mic.is_empty() && self.system.len() > max_lag {
            out.extend(self.system.drain(..));
        } else if self.system.is_empty() && self.mic.len() > max_lag {
            out.extend(self.mic.drain(..));
        }

        if out.is_empty() {
            return None;
        }
        Some(to_bytes(&out))
    }

    /// Flush everything, mixing what overlaps and appending the remainder.
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        self.drain(0)
    }
}

/// Sum with saturation. Plain addition would wrap and turn loud passages into
/// clicks; saturating keeps them merely clipped.
#[inline]
pub fn mix_sample(a: i16, b: i16) -> i16 {
    a.saturating_add(b)
}

fn to_bytes(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(samples: &[i16]) -> Vec<u8> {
        to_bytes(samples)
    }

    fn samples(bytes: &[u8]) -> Vec<i16> {
        bytes
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect()
    }

    #[test]
    fn equal_lengths_are_summed_not_concatenated() {
        let mut m = Mixer::new();
        m.push(Source::System, &bytes(&[100, 200, 300]));
        m.push(Source::Microphone, &bytes(&[1, 2, 3]));
        let out = samples(&m.drain(MAX_LAG_SAMPLES).unwrap());
        assert_eq!(out, vec![101, 202, 303]);
        assert!(m.drain(MAX_LAG_SAMPLES).is_none(), "nothing left over");
    }

    #[test]
    fn one_second_in_stays_one_second_out() {
        // The old interleaving path would have produced 2 s here.
        let mut m = Mixer::new();
        let one_sec: Vec<i16> = (0..16_000).map(|i| (i % 100) as i16).collect();
        m.push(Source::System, &bytes(&one_sec));
        m.push(Source::Microphone, &bytes(&one_sec));
        let out = m.drain(MAX_LAG_SAMPLES).unwrap();
        assert_eq!(out.len() / 2, 16_000);
    }

    #[test]
    fn surplus_waits_until_lag_exceeded() {
        let mut m = Mixer::new();
        m.push(Source::System, &bytes(&[5; 10]));
        m.push(Source::Microphone, &bytes(&[1; 4]));
        let out = samples(&m.drain(100).unwrap());
        assert_eq!(out, vec![6; 4], "only the overlap is emitted");
        assert!(m.drain(100).is_none(), "6 surplus samples < lag 100: hold");
        // Mic stays silent and system keeps coming → flush system alone.
        m.push(Source::System, &bytes(&[7; 200]));
        let out = samples(&m.drain(100).unwrap());
        assert_eq!(out.len(), 206);
        assert_eq!(&out[..6], &[5; 6]);
        assert_eq!(&out[6..], &[7; 200]);
    }

    #[test]
    fn mic_alone_also_passes_through_after_lag() {
        let mut m = Mixer::new();
        m.push(Source::Microphone, &bytes(&[9; 150]));
        assert!(m.drain(200).is_none());
        m.push(Source::Microphone, &bytes(&[9; 100]));
        assert_eq!(samples(&m.drain(200).unwrap()), vec![9; 250]);
    }

    #[test]
    fn loud_sum_saturates_instead_of_wrapping() {
        assert_eq!(mix_sample(30_000, 10_000), i16::MAX);
        assert_eq!(mix_sample(-30_000, -10_000), i16::MIN);
        assert_eq!(mix_sample(-5, 5), 0);
    }

    #[test]
    fn flush_mixes_overlap_and_appends_rest() {
        let mut m = Mixer::new();
        m.push(Source::System, &bytes(&[1, 1, 1]));
        m.push(Source::Microphone, &bytes(&[2]));
        assert_eq!(samples(&m.flush().unwrap()), vec![3, 1, 1]);
        assert!(m.flush().is_none());
    }

    #[test]
    fn odd_trailing_byte_is_ignored() {
        let mut m = Mixer::new();
        m.push(Source::System, &[1, 0, 2]);
        m.push(Source::Microphone, &[0, 0]);
        assert_eq!(samples(&m.flush().unwrap()), vec![1]);
    }
}
