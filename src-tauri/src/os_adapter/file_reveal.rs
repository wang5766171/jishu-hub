//! 文件管理器定位与关联应用打开（v0.8.0 需求4）。
//! 跨平台差异收敛在本模块（DEVELOP_READ §11）；命令包装层不做平台分支。
//! 失败一律返回结构化 Err，不 panic（§17.5 盲端容错）。

use std::path::PathBuf;

/// 剥 Windows canonicalize() 的 verbatim 前缀：`\\?\C:\a` → `C:\a`、
/// `\\?\UNC\s\share\a` → `\\s\share\a`。explorer /select 与多数 shell 语义
/// 不识别 verbatim 前缀（容忍度随 Windows 版本而异——公司 Win10 实测
/// 「点击打开文件夹无反应」的根因之一）； UNC 形态还原后 explorer 原生
/// 支持。与 pi_rpc_runtime plugin_preview_html 的同款剥离逻辑语义一致。
pub(crate) fn strip_verbatim_prefix(s: &str) -> String {
    s.strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| s.strip_prefix(r"\\?\").map(|rest| rest.to_string()))
        .unwrap_or_else(|| s.to_string())
}

/// 校验路径真实存在并规范化。注意：这里**不复用** image::validate_path——
/// 那是「内容读取」安全卫（拒 UNC/系统目录），对 shell 定位/打开无意义且
/// 会把公司网络盘项目（\\server\share\...）一刀切拒绝（用户实测：预览
/// 报不支持 + reveal 静默失败）。本模块只关心「文件在不在」。
fn validated_existing_path(path: &str) -> Result<String, String> {
    let raw = PathBuf::from(path);
    if !raw.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    let canonical = std::fs::canonicalize(&raw)
        .map_err(|e| format!("Path not accessible: {path} ({e})"))?;
    Ok(strip_verbatim_prefix(&canonical.to_string_lossy()))
}

/// spawn 后不阻塞调用方；Unix 下以守护线程回收子进程，避免僵尸。
fn spawn_detached(command: &mut std::process::Command, what: &str) -> Result<(), String> {
    // unix 分支的 wait() 需可变借用；Windows 分支仅 drop，cfg_attr 消 unused_mut。
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut child = command
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
    let display = validated_existing_path(path)?;
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
        let pb = PathBuf::from(&display);
        let dir = if pb.is_dir() {
            pb
        } else {
            pb.parent().map(|p| p.to_path_buf()).unwrap_or(pb)
        };
        let mut command = std::process::Command::new("xdg-open");
        command.arg(dir);
        spawn_detached(&mut command, "file manager")
    }
}

/// 用系统关联应用打开文件/目录本体。
pub fn open_with_default_app(path: &str) -> Result<(), String> {
    let canonical = validated_existing_path(path)?;
    let pb = PathBuf::from(&canonical);
    open::that_detached(&pb).map_err(|e| format!("Failed to open with default app: {e}"))
}
