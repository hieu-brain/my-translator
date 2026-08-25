//! Ghi luồng token Soniox ra .jsonl (append-only) để phát lại offline khi
//! chẩn đoán lỗi ghép cặp bản dịch. Frontend gom ~25 dòng mỗi lần gọi nên
//! tần suất IPC thấp; mở-ghi-đóng từng lần là đủ, không cần giữ handle.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Số phiên gần nhất được giữ lại — mỗi phiên một file, ~1-5 MB/giờ họp.
const KEEP_FILES: usize = 20;

fn log_dir() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("com.personal.translator");
    p.push("token-logs");
    p
}

#[tauri::command]
pub fn append_token_log(file: String, lines: Vec<String>) -> Result<String, String> {
    // Tên file do frontend sinh — chặn mọi ký tự có thể thành đường dẫn.
    let valid = !file.is_empty()
        && file.len() < 128
        && file.ends_with(".jsonl")
        && !file.contains("..")
        && file
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid {
        return Err(format!("Tên file log không hợp lệ: {file}"));
    }

    let dir = log_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Không tạo được thư mục log: {e}"))?;
    let path = dir.join(&file);
    let is_new = !path.exists();

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Không mở được {}: {e}", path.display()))?;
    for line in &lines {
        writeln!(f, "{line}").map_err(|e| format!("Ghi log thất bại: {e}"))?;
    }

    // File mới = phiên mới: dọn các phiên cũ nhất vượt quá hạn mức.
    if is_new {
        prune(&dir);
    }

    Ok(path.to_string_lossy().into_owned())
}

/// Tên file mở đầu bằng timestamp nên sort theo tên = sort theo thời gian.
fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    if files.len() <= KEEP_FILES {
        return;
    }
    files.sort();
    for old in &files[..files.len() - KEEP_FILES] {
        let _ = fs::remove_file(old);
    }
}
