//! LLM backend that runs through the locally installed Claude Code CLI.
//!
//! Why: a Claude Max/Pro subscription cannot authenticate the Anthropic HTTP
//! API (that bills per token against a separate API account), but the `claude`
//! CLI is already signed in with the subscription. Shelling out to
//! `claude -p <prompt> --output-format json` therefore gives the app LLM access
//! at no extra cost — it draws on the plan's usage allowance instead.
//!
//! Trade-off: process spawn + model round-trip is ~2-5s, which is fine for the
//! periodic meeting summary and on-demand reply suggestions, but too slow for
//! anything in the audio path. The `anthropic-api` backend (see
//! `src/js/llm-backend.js`) is the low-latency alternative.

use serde::Serialize;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Result of one CLI invocation.
#[derive(Debug, Serialize)]
pub struct ClaudeCliResult {
    pub text: String,
    /// Wall-clock duration of the call, for the UI to surface slow backends.
    pub duration_ms: u64,
}

/// Where the `claude` binary usually lives. The app is launched from Finder, so
/// it inherits a minimal PATH that has none of these — probe them explicitly
/// before giving up.
const COMMON_CLI_PATHS: &[&str] = &[
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
];

/// Resolve the CLI path: explicit override → PATH → common install locations.
fn resolve_cli(explicit: &str) -> Result<String, String> {
    if !explicit.trim().is_empty() {
        return Ok(explicit.trim().to_string());
    }

    // `which` runs under the user's login shell so it sees the real PATH
    // (nvm/asdf/homebrew shims included), unlike this process's environment.
    if let Ok(out) = Command::new("/bin/sh")
        .args(["-lc", "command -v claude"])
        .output()
    {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }

    for candidate in COMMON_CLI_PATHS {
        if std::path::Path::new(candidate).exists() {
            return Ok(candidate.to_string());
        }
    }

    Err("Không tìm thấy Claude Code CLI. Cài đặt rồi đăng nhập bằng tài khoản Max, \
         hoặc chỉ định đường dẫn trong Cài đặt → Trợ lý AI."
        .to_string())
}

/// Report whether the CLI is available, and its version if so. Used by the
/// settings screen so the user finds out before a meeting, not during one.
#[tauri::command]
pub fn check_claude_cli(cli_path: String) -> Result<String, String> {
    let bin = resolve_cli(&cli_path)?;
    let out = Command::new(&bin)
        .arg("--version")
        .output()
        .map_err(|e| format!("Không chạy được {}: {}", bin, e))?;

    if !out.status.success() {
        return Err(format!(
            "{} --version thất bại: {}",
            bin,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Run a one-shot prompt through the CLI and return the assistant's text.
///
/// The prompt goes in on stdin rather than argv: meeting transcripts routinely
/// exceed the ~256KB argv limit on macOS, and stdin also keeps the transcript
/// out of the process table.
#[tauri::command]
pub async fn claude_cli_prompt(
    cli_path: String,
    prompt: String,
    model: String,
    system: Option<String>,
    timeout_sec: Option<u64>,
) -> Result<ClaudeCliResult, String> {
    let bin = resolve_cli(&cli_path)?;
    let timeout = Duration::from_secs(timeout_sec.unwrap_or(120));

    // Blocking process I/O must not run on the async runtime's worker thread.
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();

        let mut cmd = Command::new(&bin);
        cmd.arg("-p")
            .arg("--output-format")
            .arg("json")
            .arg("--model")
            .arg(&model);
        if let Some(sys) = system.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--append-system-prompt").arg(sys);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Không khởi chạy được {}: {}", bin, e))?;

        child
            .stdin
            .take()
            .ok_or("Không mở được stdin của Claude CLI")?
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("Không ghi được prompt: {}", e))?;

        // Poll for completion so a wedged CLI can't hang the meeting forever.
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        return Err(format!(
                            "Claude CLI quá thời gian chờ ({}s)",
                            timeout.as_secs()
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(120));
                }
                Err(e) => return Err(format!("Lỗi chờ Claude CLI: {}", e)),
            }
        }

        let out = child
            .wait_with_output()
            .map_err(|e| format!("Lỗi đọc kết quả Claude CLI: {}", e))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "Claude CLI lỗi: {}",
                if stderr.trim().is_empty() {
                    "không có thông báo".to_string()
                } else {
                    stderr.trim().to_string()
                }
            ));
        }

        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let text = extract_result_text(&stdout)?;

        Ok(ClaudeCliResult {
            text,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| format!("Tác vụ Claude CLI bị hủy: {}", e))?
}

/// Pull the assistant text out of `--output-format json`. The CLI wraps the
/// answer in `{"type":"result","result":"..."}`; fall back to the raw stdout so
/// a CLI version with a different envelope degrades to something usable rather
/// than erroring.
fn extract_result_text(stdout: &str) -> Result<String, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("Claude CLI không trả về nội dung".to_string());
    }

    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(err) = v.get("is_error").and_then(|e| e.as_bool()) {
            if err {
                let msg = v
                    .get("result")
                    .and_then(|r| r.as_str())
                    .unwrap_or("lỗi không xác định");
                return Err(format!("Claude CLI báo lỗi: {}", msg));
            }
        }
        if let Some(result) = v.get("result").and_then(|r| r.as_str()) {
            return Ok(result.to_string());
        }
    }

    Ok(trimmed.to_string())
}
