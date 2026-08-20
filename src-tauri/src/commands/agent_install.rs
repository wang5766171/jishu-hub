use super::env_check::runtime_registry;

/// Whitelist for `install_agent_command`. The frontend only ever sends the
/// agents' built-in `install_hint` / `native_install_command` strings (and the
/// runtime install/update commands), all of which are fixed
/// `npm/winget/choco install <pkg>` or `winget upgrade <pkg>` patterns. Restricting to these patterns
/// closes the "execute arbitrary PowerShell" hole (K-HIGH-3 / original H1)
/// without affecting any current install flow.
fn is_allowed_install_command(cmd: &str) -> bool {
    fn safe_pkg(s: &str) -> bool {
        let s = s.trim();
        !s.is_empty()
            && !s.contains(char::is_whitespace)
            && s.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-' | '+')
            })
    }
    if cmd == "jishu-hub-internal-install" {
        return true;
    }
    if runtime_registry()
        .iter()
        .any(|runtime| runtime.install_command == Some(cmd) || runtime.update_command == Some(cmd))
    {
        return true;
    }
    for prefix in [
        "npm install -g ",
        "winget install ",
        "winget upgrade ",
        "choco install ",
    ] {
        if let Some(rest) = cmd.strip_prefix(prefix) {
            return safe_pkg(rest);
        }
    }
    false
}

/// 该（已过白名单的）安装命令是否需要管理员权限。前端据此在触发
/// UAC 前弹应用内说明并征得用户同意（v0.7.4：升权原因先告知用户）。
#[tauri::command]
pub(crate) fn install_command_needs_elevation(command: String) -> Result<bool, String> {
    if !is_allowed_install_command(&command) {
        return Err(format!("Install command not allowed: {}", command));
    }
    Ok(crate::os_adapter::shell::command_requires_elevation(
        &command,
    ))
}

#[tauri::command]
pub(crate) async fn install_agent_command(
    app: tauri::AppHandle,
    command: String,
) -> Result<String, String> {
    if !is_allowed_install_command(&command) {
        return Err(format!("Install command not allowed: {}", command));
    }
    if command == "jishu-hub-internal-install" {
        return install_internal_jishu_agent(app).await;
    }
    let output = crate::os_adapter::shell::run_install_command(&command, None).await?;
    // v0.7.6 需求1：npm 全局安装成功后确保全局命令目录在用户 PATH——
    // Node 装到自定义路径的机器可能缺失该条目（Hub 显示已安装但命令行
    // 无法识别）。返回值带 [PATH_ADDED] 标记供前端弹提示；补全失败静默
    // 降级，不阻断安装结果。
    if command.starts_with("npm install -g") {
        if let Some(dir) = crate::os_adapter::path_env::ensure_npm_global_bin_on_user_path().await {
            return Ok(format!("{output}\n[PATH_ADDED]{dir}"));
        }
    }
    Ok(output)
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        // Bundled npm workspaces contain directory junctions on Windows.
        // `DirEntry::file_type()` reports those as links, so follow the link
        // before deciding whether to recurse instead of passing a directory to
        // `fs::copy`, which fails with access denied (os error 5).
        if std::fs::metadata(&src_path)?.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|error| {
                std::io::Error::new(
                    error.kind(),
                    format!(
                        "failed to copy {} to {}: {error}",
                        src_path.display(),
                        dst_path.display()
                    ),
                )
            })?;
        }
    }
    Ok(())
}

fn backup_managed_pi_runtime(target: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let backup = target.join(format!(".runtime-backup-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&backup).map_err(|error| error.to_string())?;
    for name in ["packages", "node_modules"] {
        let current = target.join(name);
        if current.exists() {
            std::fs::rename(&current, backup.join(name))
                .map_err(|error| format!("Failed to back up {}: {error}", current.display()))?;
        }
    }
    Ok(backup)
}

fn restore_managed_pi_runtime(
    target: &std::path::Path,
    backup: &std::path::Path,
) -> Result<(), String> {
    for name in ["packages", "node_modules"] {
        let current = target.join(name);
        if current.exists() {
            std::fs::remove_dir_all(&current).map_err(|error| error.to_string())?;
        }
        let previous = backup.join(name);
        if previous.exists() {
            std::fs::rename(&previous, &current).map_err(|error| error.to_string())?;
        }
    }
    let _ = std::fs::remove_dir_all(backup);
    Ok(())
}

async fn install_internal_jishu_agent(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let res_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;
    let mut source = res_dir.join("third_party").join("pi-bundle");
    if !source.exists() {
        source = res_dir.join("_up_").join("third_party").join("pi-bundle");
    }
    install_pi_bundle_from(&source)
}

/// 核心：把 pi-bundle 源目录安装到 ~/.jishu-agent（备份+覆盖+回滚）。
/// v0.7.2 需求 5：GUI（install_internal_jishu_agent）与 CLI（run_install_agent_cli，
/// 由 NSIS 安装器在 POSTINSTALL 调用）共用此内核，确保安装/更新 hub 时 agent 一致地
/// 落到用户目录。需求 4 已移除 lite 的 npm 在线回退，pi-bundle 不存在即报错。
fn install_pi_bundle_from(source: &std::path::Path) -> Result<String, String> {
    let target = crate::agent::jishu_self::pi_agent_dir().ok_or("Failed to get target dir")?;
    if !source.exists() {
        return Err(format!(
            "bundled pi-bundle not found at {}",
            source.display()
        ));
    }
    if let Err(e) = std::fs::create_dir_all(&target) {
        return Err(format!("Failed to create target directory: {}", e));
    }
    let backup = backup_managed_pi_runtime(std::path::Path::new(&target))?;
    if let Err(e) = copy_dir_recursive(source, std::path::Path::new(&target)) {
        let _ = restore_managed_pi_runtime(std::path::Path::new(&target), &backup);
        return Err(format!("Failed to copy bundled pi agent files: {}", e));
    }
    let _ = std::fs::remove_dir_all(&backup);
    register_jishu_cli_shim(std::path::Path::new(&target));
    Ok("Bundled Jishu Agent runtime installed.".to_string())
}

/// 在 hub 安装目录创建 `jishu` CLI shim，指向 ~/.jishu-agent 的 pi cli.js。
/// hub 安装目录由 NSIS 加入 PATH（installer.nsh -AddToPath），故 `jishu` 命令行可用，
/// 替代 lite 版的 npm bin 全局注册。Windows 用 jishu.cmd，macOS/Linux 用无扩展脚本 +x。
fn register_jishu_cli_shim(agent_dir: &std::path::Path) {
    let cli_js = agent_dir
        .join("packages")
        .join("coding-agent")
        .join("dist")
        .join("cli.js");
    if !cli_js.exists() {
        return;
    }
    let exe_dir = match std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
    {
        Some(d) => d,
        None => return,
    };
    let cli_display = cli_js.display();
    #[cfg(target_os = "windows")]
    {
        let shim = exe_dir.join("jishu.cmd");
        let content =
            format!("@echo off\r\nset PI_SKIP_VERSION_CHECK=1\r\nnode \"{cli_display}\" %*\r\n");
        let _ = std::fs::write(&shim, content);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shim = exe_dir.join("jishu");
        let content = format!("#!/bin/sh\nexec node \"{cli_display}\" \"$@\"\n");
        if std::fs::write(&shim, content).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&shim) {
                    let mut perm = meta.permissions();
                    perm.set_mode(0o755);
                    let _ = std::fs::set_permissions(&shim, perm);
                }
            }
        }
    }
}

/// CLI 模式入口（v0.7.2 需求 5）：`Jishu Hub --install-agent`，由 NSIS 安装器在
/// POSTINSTALL 阶段调用，把内嵌 pi-bundle 装到 ~/.jishu-agent。用 current_exe 推导
/// 源路径，安装后返回退出码，不启动 GUI（windows_subsystem=windows 下不弹窗）。
pub fn run_install_agent_cli() -> i32 {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[install-agent] current_exe failed: {e}");
            return 1;
        }
    };
    let exe_dir = exe.parent().unwrap_or(std::path::Path::new("."));
    let mut source = exe_dir.join("third_party").join("pi-bundle");
    if !source.exists() {
        source = exe_dir.join("_up_").join("third_party").join("pi-bundle");
    }
    match install_pi_bundle_from(&source) {
        Ok(_) => 0,
        Err(e) => {
            eprintln!("[install-agent] FAILED: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn allows_git_winget_update_command() {
        assert!(super::is_allowed_install_command(
            "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements"
        ));
        assert!(super::is_allowed_install_command(
            "winget upgrade --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements"
        ));
        assert!(!super::is_allowed_install_command(
            "winget upgrade Git.Git; whoami"
        ));
    }

    #[test]
    fn pi_runtime_backup_preserves_user_data_and_can_restore_managed_directories() {
        let root = std::env::temp_dir().join(format!(
            "jishu-runtime-backup-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("packages")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        std::fs::write(root.join("packages/old.txt"), "old package").unwrap();
        std::fs::write(root.join("node_modules/old.txt"), "old dependency").unwrap();
        std::fs::write(root.join("settings.json"), "{}").unwrap();
        std::fs::write(root.join("sessions/keep.jsonl"), "session").unwrap();

        let backup = super::backup_managed_pi_runtime(&root).unwrap();
        assert!(!root.join("packages").exists());
        assert!(!root.join("node_modules").exists());
        assert!(root.join("settings.json").exists());
        assert!(root.join("sessions/keep.jsonl").exists());

        std::fs::create_dir_all(root.join("packages")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("packages/new.txt"), "new package").unwrap();
        super::restore_managed_pi_runtime(&root, &backup).unwrap();

        assert!(root.join("packages/old.txt").exists());
        assert!(root.join("node_modules/old.txt").exists());
        assert!(!root.join("packages/new.txt").exists());
        assert!(root.join("settings.json").exists());
        assert!(root.join("sessions/keep.jsonl").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
