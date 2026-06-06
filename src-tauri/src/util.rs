use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Returns the current time in milliseconds since Unix epoch.
/// Shared utility to avoid duplicating this in every module.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Atomically write content to a file by writing to a unique temp file
/// then renaming. Prevents corruption on crash/power-loss.
/// Uses PID + nanos for uniqueness to avoid concurrent-write collisions.
pub fn atomic_write(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let tmp = unique_tmp_path(path);
    std::fs::write(&tmp, content)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn unique_tmp_path(path: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(format!(".{}-{}.tmp", std::process::id(), nanos));
    path.with_file_name(name)
}
