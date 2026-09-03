//! 文件管理器定位与关联应用打开（v0.8.0 需求4）。
//! 跨平台差异收敛在本模块（DEVELOP_READ §11）；命令包装层不做平台分支。
//! 失败一律返回结构化 Err，不 panic（§17.5 盲端容错）。

use std::path::PathBuf;

/// 校验路径合法（与 read_text_file 同一防线）且真实存在，返回规范化路径。
fn validated_existing_path(path: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(path);
    crate::image::validate_path(&raw)?;
    let canonical =
        std::fs::canonicalize(&raw).map_err(|e| format!("Path not accessible: {path} ({e})"))?;
    if !canonical.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    Ok(canonical)
}

/// spawn 后不阻塞调用方；Unix 下以守护线程回收子进程，避免僵尸。
fn spawn_detached(command: &mut std::process::Command, what: &str) -> Result<(), String> {
    let child = command
        .spawn()
        .map_err(|e| format!("Failed to launch {what}: {e}"))?;
    #[cfg(unix)]
    {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    #[cfg(not(unix))]
    {
        drop(child);
    }
    Ok(())
}

/// 在系统文件管理器中定位该文件（Windows 选中文件；macOS Finder 选中；
/// Linux 无统一选中协议，回退打开父目录）。
pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    let canonical = validated_existing_path(path)?;
    let display = canonical.display().to_string();
    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(format!("/select,{display}"));
        spawn_detached(&mut command, "File Explorer")
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        command.args(["-R", &display]);
        spawn_detached(&mut command, "Finder")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if canonical.is_dir() {
            canonical
        } else {
            canonical
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or(canonical)
        };
        let mut command = std::process::Command::new("xdg-open");
        command.arg(dir);
        spawn_detached(&mut command, "file manager")
    }
}

/// 用系统关联应用打开文件/目录本体。
pub fn open_with_default_app(path: &str) -> Result<(), String> {
    let canonical = validated_existing_path(path)?;
    open::that_detached(&canonical).map_err(|e| format!("Failed to open with default app: {e}"))
}
