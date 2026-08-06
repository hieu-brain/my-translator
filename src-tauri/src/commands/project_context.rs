//! Project context for the meeting assistant, plus meeting-note output.
//!
//! Two jobs:
//!   1. Read a project folder's own documentation (CLAUDE.md, README, docs/*.md)
//!      so reply suggestions are grounded in what the project actually is.
//!   2. Write the meeting note where the user expects to find it: a
//!      `<project>-meeting-notes/` folder next to the project when a profile is
//!      selected, or a single default folder when it is not.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Cap on a single file. Big enough for a real CLAUDE.md, small enough that one
/// stray file can't crowd the transcript out of the model's context.
const MAX_FILE_BYTES: usize = 24_000;
/// Cap across every file in one context read.
const MAX_TOTAL_BYTES: usize = 80_000;

#[derive(Debug, Serialize)]
pub struct ContextFile {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct ProjectContext {
    pub root: String,
    pub files: Vec<ContextFile>,
    /// Total bytes returned, so the caller can show what it is spending.
    pub total_bytes: usize,
    /// Files found but skipped because the budget ran out.
    pub skipped: Vec<String>,
}

/// Documentation worth reading, most important first — the byte budget is spent
/// in this order so CLAUDE.md always survives.
const PREFERRED_FILES: &[&str] = &[
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "README.markdown",
    "docs/README.md",
    "docs/architecture.md",
    "docs/overview.md",
];

fn read_capped(path: &Path) -> Option<ContextFile> {
    let raw = fs::read_to_string(path).ok()?;
    let truncated = raw.len() > MAX_FILE_BYTES;
    let content = if truncated {
        // Cut on a char boundary — a mid-UTF-8 slice would panic.
        let mut end = MAX_FILE_BYTES;
        while end > 0 && !raw.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n…(đã cắt bớt)", &raw[..end])
    } else {
        raw
    };
    Some(ContextFile {
        path: path.to_string_lossy().to_string(),
        content,
        truncated,
    })
}

/// Read a project folder's documentation within a fixed byte budget.
#[tauri::command]
pub fn read_project_context(project_path: String) -> Result<ProjectContext, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("Không tìm thấy thư mục dự án: {}", project_path));
    }

    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut total = 0usize;

    for rel in PREFERRED_FILES {
        let p = root.join(rel);
        if !p.is_file() {
            continue;
        }
        match read_capped(&p) {
            Some(f) if total + f.content.len() <= MAX_TOTAL_BYTES => {
                total += f.content.len();
                files.push(f);
            }
            Some(_) => skipped.push(rel.to_string()),
            None => {}
        }
    }

    // Sweep docs/ for anything the preferred list missed, newest names first so
    // the result is stable across runs.
    let docs = root.join("docs");
    if docs.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(&docs)
            .map_err(|e| format!("Không đọc được docs/: {}", e))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
            .collect();
        entries.sort();

        for p in entries {
            let path_str = p.to_string_lossy().to_string();
            if files.iter().any(|f| f.path == path_str) {
                continue;
            }
            match read_capped(&p) {
                Some(f) if total + f.content.len() <= MAX_TOTAL_BYTES => {
                    total += f.content.len();
                    files.push(f);
                }
                Some(_) => skipped.push(path_str),
                None => {}
            }
        }
    }

    Ok(ProjectContext {
        root: root.to_string_lossy().to_string(),
        files,
        total_bytes: total,
        skipped,
    })
}

/// Read arbitrary note files the user attached to a meeting profile.
#[tauri::command]
pub fn read_note_files(paths: Vec<String>) -> Result<Vec<ContextFile>, String> {
    let mut out = Vec::new();
    let mut total = 0usize;
    for p in paths {
        let path = PathBuf::from(&p);
        if !path.is_file() {
            continue;
        }
        if let Some(f) = read_capped(&path) {
            if total + f.content.len() > MAX_TOTAL_BYTES {
                break;
            }
            total += f.content.len();
            out.push(f);
        }
    }
    Ok(out)
}

/// Where a meeting note for this profile should be written.
///
/// With a project: a sibling of the project folder named
/// `<project-folder>-meeting-notes`. Keeping notes *beside* the repo rather
/// than inside it means they never show up in `git status` or get swept up by a
/// clean checkout.
///
/// Without a project: `default_notes_dir`, or `~/Documents/meeting-notes`.
fn resolve_notes_dir(project_path: &str, default_notes_dir: &str) -> Result<PathBuf, String> {
    if !project_path.trim().is_empty() {
        let project = PathBuf::from(project_path);
        let name = project
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Đường dẫn dự án không hợp lệ")?;
        let parent = project
            .parent()
            .ok_or("Không xác định được thư mục cha của dự án")?;
        return Ok(parent.join(format!("{}-meeting-notes", name)));
    }

    if !default_notes_dir.trim().is_empty() {
        return Ok(PathBuf::from(default_notes_dir.trim()));
    }

    let home = dirs::home_dir().ok_or("Không xác định được thư mục home")?;
    Ok(home.join("Documents").join("meeting-notes"))
}

/// Resolve the notes folder without writing anything — lets the settings screen
/// show the user exactly where notes will land.
#[tauri::command]
pub fn meeting_notes_dir(project_path: String, default_notes_dir: String) -> Result<String, String> {
    Ok(resolve_notes_dir(&project_path, &default_notes_dir)?
        .to_string_lossy()
        .to_string())
}

/// Strip characters that are illegal or awkward in a filename.
fn slugify(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "meeting".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// Write a meeting note, creating the folder if needed. Returns the full path.
///
/// `content` is the finished Markdown (summary header + transcript) built on the
/// JS side, so the note format lives in one place.
#[tauri::command]
pub fn save_meeting_note(
    project_path: String,
    default_notes_dir: String,
    date_prefix: String,
    title: String,
    content: String,
) -> Result<String, String> {
    let dir = resolve_notes_dir(&project_path, &default_notes_dir)?;
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Không tạo được thư mục ghi chú {}: {}",
            dir.to_string_lossy(),
            e
        )
    })?;

    let base = format!("{}-{}", date_prefix, slugify(&title));
    let mut path = dir.join(format!("{}.md", base));
    // Two meetings can legitimately share a title on the same day; don't
    // overwrite the earlier note.
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{}-{}.md", base, n));
        n += 1;
    }

    fs::write(&path, content)
        .map_err(|e| format!("Không ghi được ghi chú {}: {}", path.to_string_lossy(), e))?;

    Ok(path.to_string_lossy().to_string())
}

/// Reveal a saved note in Finder.
#[tauri::command]
pub fn open_path_in_finder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Không tìm thấy: {}", path));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("Không mở được Finder: {}", e))?;
    }
    Ok(())
}
