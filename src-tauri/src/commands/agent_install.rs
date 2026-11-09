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

// ── v0.9.7 需求1 T4：agent 运行时状态/初始化 IPC（引导页门控与版本横幅消费）──

/// 状态查询（无副作用）：`{state: ready|init_running|mismatch, recorded, expected}`。
/// `init-running` 表示启动钩子（或一键更新）正在跑。
#[tauri::command]
pub(crate) fn agent_runtime_status() -> Result<serde_json::Value, String> {
    let mut value = serde_json::to_value(crate::agent_runtime_init::current_state())
        .map_err(|e| e.to_string())?;
    if let serde_json::Value::Object(map) = &mut value {
        map.insert(
            "expected".to_string(),
            serde_json::json!(crate::agent::jishu_self::PI_AGENT_VERSION),
        );
    }
    Ok(value)
}

/// 手动触发/失败重试（幂等；内部 ensure_agent_runtime——启动钩子在跑时返回
/// init-running 语义而非并发重入）。进度走 `agent-runtime-progress` 事件。
#[tauri::command]
pub(crate) async fn agent_runtime_init(app: tauri::AppHandle) -> Result<String, String> {
    let state = crate::agent_runtime_init::ensure_agent_runtime(&app).await?;
    match state {
        crate::agent_runtime_init::AgentRuntimeState::Ready => Ok("ready".to_string()),
        crate::agent_runtime_init::AgentRuntimeState::InitRunning { .. } => {
            Ok("init-running".to_string())
        }
        crate::agent_runtime_init::AgentRuntimeState::Mismatch { .. } => {
            // 安装序列刚完成（记录已写入）；下一次 status 查询即 ready。
            Ok("installed".to_string())
        }
    }
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

/// v0.9.7 需求8 修复A：修复 zip 链路写坏的 npm workspace 链接（存量自愈）。
///
/// 坏形态 = `node_modules/<scope>/<pkg>`（或顶层 `<pkg>`）是一个**普通文件**，
/// 内容为指向 `packages/<X>` 的相对路径文本——pack-pi 早期 zip 把 workspace
/// junction 存成 symlink 条目，`extract_zip_to_temp` 不识别 symlink 把「目标
/// 路径文本」当文件内容写出、`copy_dir_recursive` 原样搬运所致。subagent 的
/// `dist/core` 散模块 import 这些包即 `Cannot find package`。修复 = 删坏文件，
/// 从 `packages/<X>` 实体拷贝回该位置。幂等：修过的位置是目录，判定自然不中。
/// 返回修复的条目数。
pub(crate) fn heal_workspace_links(agent_dir: &std::path::Path) -> Result<usize, String> {
    let node_modules = agent_dir.join("node_modules");
    if !node_modules.is_dir() {
        return Ok(0);
    }
    // 顶层与 @scope/ 两层（npm workspace 链接只出现在这两层；.bin 的
    // cmd-shim 是真文件，不在 healing 范围）。
    let mut scan_dirs: Vec<std::path::PathBuf> = vec![node_modules.clone()];
    for entry in std::fs::read_dir(&node_modules).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir() && entry.file_name().to_string_lossy().starts_with('@') {
            scan_dirs.push(p);
        }
    }
    let mut fixed = 0usize;
    for dir in scan_dirs {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let link_path = entry.path();
            let Some(target) = broken_link_target(&link_path, agent_dir) else {
                continue;
            };
            std::fs::remove_file(&link_path)
                .map_err(|e| format!("remove broken link {}: {e}", link_path.display()))?;
            copy_dir_recursive(&target, &link_path).map_err(|e| {
                format!(
                    "heal {} from {}: {e}",
                    link_path.display(),
                    target.display()
                )
            })?;
            fixed += 1;
            log::info!(
                "[agent-install] healed workspace link {} ← {}",
                link_path.display(),
                target.display()
            );
        }
    }
    Ok(fixed)
}

/// 判定「坏链接文件」并解出实体目标目录：内容是 <100 字节、无换行、以 `..`
/// 开头的相对路径（Windows zip 存反斜杠 / macOS 存正斜杠，统一按 `/` 解析），
/// 且按该文件所在目录解析后落在 agent_dir 内的现存目录（防穿越——workspace
/// 链接只指向自家 packages/）。真包不可能是百字节内的纯相对路径文本，四条件
/// 防误伤。
fn broken_link_target(
    link_path: &std::path::Path,
    agent_dir: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let meta = std::fs::metadata(link_path).ok()?;
    if !meta.is_file() || meta.len() >= 100 {
        return None;
    }
    let content = std::fs::read_to_string(link_path).ok()?;
    let content = content.trim();
    if content.contains('\n') || content.contains('\r') || !content.starts_with("..") {
        return None;
    }
    let base = link_path.parent()?;
    let target = base.join(content.replace('\\', "/"));
    let canonical_target = target.canonicalize().ok()?;
    let canonical_base = agent_dir.canonicalize().ok()?;
    if !canonical_target.starts_with(&canonical_base) || !canonical_target.is_dir() {
        return None;
    }
    Some(canonical_target)
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
    // v0.9.7 需求1 T3（P0-2 附带修复）：手动安装改走 zip 解压入口，与启动钩子
    // 共用 extract——原硬编码散目录（res/third_party/pi-bundle）在 resources
    // 单 zip 化后必然报「bundled pi-bundle not found」。
    let temp_bundle = crate::agent_runtime_init::extract_bundled_runtime_for_manual_install(&app)?;
    let output = install_pi_bundle_from(&temp_bundle);
    let _ = std::fs::remove_dir_all(&temp_bundle);
    let output = output?;
    // v0.9.5 需求11（pi 1.1.0）：MCP 接入改为 pi 原生 mcp.json 条目自愈
    //（幂等；失败不阻断——启动自愈与环境检测页手动安装兜底）。adapter
    // 扩展已退役，残留清理一并在 ensure 内完成。
    // 需求5：4 个 pi 扩展包同款确保 + 运行时配置 + packages 对齐。
    let mut summary =
        match crate::agent::jishu_self::JishuSelfAgent::ensure_native_mcp_entry().await {
            Ok(msg) => format!("{output}\n{msg}"),
            Err(e) => format!("{output}\nMCP native entry ensure skipped: {e}"),
        };
    match crate::agent::jishu_self::JishuSelfAgent::ensure_pi_extensions_installed().await {
        Ok(installed) if !installed.is_empty() => {
            crate::task_plan::ensure_subagents_runtime_config();
            crate::agent::plugin::sync_pi_packages_with_plugins();
            summary = format!("{summary}\npi extensions installed: {:?}", installed);
        }
        Ok(_) => {}
        Err(e) => summary = format!("{summary}\npi extensions install skipped: {e}"),
    }
    // v0.9.7 需求1：手动安装成功即写版本记录（状态命令立刻 Ready）。
    if let Some(record) = crate::agent_runtime_init::runtime_record_path() {
        if let Err(e) = std::fs::write(
            &record,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": crate::agent::jishu_self::PI_AGENT_VERSION
            }))
            .unwrap_or_default(),
        ) {
            summary = format!("{summary}\nwrite runtime record failed: {e}");
        }
    }
    Ok(summary)
}

/// 核心：把 pi-bundle 源目录（散目录形态——zip 已先行解压到临时目录）安装到
/// ~/.jishu-agent（备份+覆盖+回滚）。
/// v0.7.2 需求 5 起 GUI 与 CLI 共用此内核；v0.9.7 需求1 起三方共用（启动钩子
/// ensure_agent_runtime / 环境检测页手动安装 / --install-agent CLI），保证安装
/// /更新 hub 时 agent 一致地落到用户目录。
pub(crate) fn install_pi_bundle_from(source: &std::path::Path) -> Result<String, String> {
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
    // v0.85.0 起产物为 dist/bundle/cli.js（上游 bundle 布局），旧安装为 dist/cli.js。
    let dist = agent_dir.join("packages").join("coding-agent").join("dist");
    let cli_js = [dist.join("bundle").join("cli.js"), dist.join("cli.js")]
        .into_iter()
        .find(|p| p.exists());
    let Some(cli_js) = cli_js else {
        return;
    };
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

/// CLI 模式入口（v0.7.2 需求 5）：`Jishu Hub --install-agent`。v0.9.7 需求1 T2 起
/// NSIS POSTINSTALL 已删除，本入口保留为手动/边缘兜底；源改为 exe 旁的
/// pi-runtime.zip（与启动钩子同一资源形态），解压→安装→确保→写记录。
pub fn run_install_agent_cli() -> i32 {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[install-agent] current_exe failed: {e}");
            return 1;
        }
    };
    let exe_dir = exe.parent().unwrap_or(std::path::Path::new("."));
    let zip_candidates = [
        exe_dir.join("third_party").join("pi-runtime.zip"),
        exe_dir
            .join("_up_")
            .join("third_party")
            .join("pi-runtime.zip"),
    ];
    let Some(zip_path) = zip_candidates.into_iter().find(|p| p.exists()) else {
        eprintln!("[install-agent] FAILED: pi-runtime.zip not found next to exe");
        return 1;
    };
    let temp_bundle = match crate::agent_runtime_init::extract_zip_to_temp(&zip_path) {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[install-agent] FAILED: {e}");
            return 1;
        }
    };
    let result = install_pi_bundle_from(&temp_bundle);
    let _ = std::fs::remove_dir_all(&temp_bundle);
    match result {
        Ok(_) => {
            // v0.9.5 需求11：确保 pi 原生 mcp.json 条目（幂等；失败仅告警——
            // 首启后台与环境检测页手动安装兜底）。
            match tauri::async_runtime::block_on(
                crate::agent::jishu_self::JishuSelfAgent::ensure_native_mcp_entry(),
            ) {
                Ok(_) => {}
                Err(e) => eprintln!("[install-agent] MCP native entry ensure skipped: {e}"),
            }
            // v0.9.5 需求5：4 个 pi 扩展包同款确保（失败仅告警）。
            match tauri::async_runtime::block_on(
                crate::agent::jishu_self::JishuSelfAgent::ensure_pi_extensions_installed(),
            ) {
                Ok(installed) if !installed.is_empty() => {
                    eprintln!("[install-agent] pi extensions installed: {:?}", installed);
                    crate::task_plan::ensure_subagents_runtime_config();
                    crate::agent::plugin::sync_pi_packages_with_plugins();
                }
                Ok(_) => {}
                Err(e) => eprintln!("[install-agent] pi extensions install skipped: {e}"),
            }
            // v0.9.7 需求1：写版本记录（与 GUI 链路一致）。
            // 需求8 修复A：写记录前 heal 一次（老 zip 兜底），healed 落盘。
            if let Some(record) = crate::agent_runtime_init::runtime_record_path() {
                let healed = record
                    .parent()
                    .and_then(|dir| heal_workspace_links(dir).ok())
                    .is_some();
                let _ = std::fs::write(
                    &record,
                    serde_json::to_string_pretty(&serde_json::json!({
                        "version": crate::agent::jishu_self::PI_AGENT_VERSION,
                        "healed": healed,
                    }))
                    .unwrap_or_default(),
                );
            }
            0
        }
        Err(e) => {
            eprintln!("[install-agent] FAILED: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 需求8 修复A：坏链接文件（内容=指向 packages/<X> 的相对路径文本）被
    // heal 成实体目录；反例（长内容/非路径/目标不存在/真目录）不动；幂等。
    #[test]
    fn heal_workspace_links_fixes_broken_link_files() {
        let root =
            std::env::temp_dir().join(format!("jishu-heal-links-test-{}", uuid::Uuid::new_v4()));
        let scope = root.join("node_modules/@earendil-works");
        std::fs::create_dir_all(&scope).unwrap();
        std::fs::create_dir_all(root.join("packages/ai/dist")).unwrap();
        std::fs::write(root.join("packages/ai/package.json"), r#"{"name":"pi-ai"}"#).unwrap();
        std::fs::write(root.join("packages/ai/dist/retry.js"), "export const R=1;").unwrap();
        // 坏件：Windows zip 形态（反斜杠、无换行）。
        std::fs::write(scope.join("pi-ai"), "..\\..\\packages\\ai").unwrap();
        // 坏件：macOS zip 形态（正斜杠）。
        std::fs::write(scope.join("pi-tui"), "../../packages/ai").unwrap();

        let fixed = heal_workspace_links(&root).unwrap();
        assert_eq!(fixed, 2);
        for pkg in ["pi-ai", "pi-tui"] {
            let p = scope.join(pkg);
            assert!(
                p.join("package.json").is_file(),
                "{pkg} 应已 heal 成实体目录"
            );
        }
        // 幂等：再跑一遍无新修复。
        assert_eq!(heal_workspace_links(&root).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn heal_workspace_links_leaves_non_targets_alone() {
        let root =
            std::env::temp_dir().join(format!("jishu-heal-links-neg-{}", uuid::Uuid::new_v4()));
        let scope = root.join("node_modules/@scope");
        std::fs::create_dir_all(&scope).unwrap();
        // 长内容（真包的形态不可能是这个，但保护性反例）。
        std::fs::write(scope.join("long"), vec![b'.'; 120]).unwrap();
        // 相对路径但目标不存在。
        std::fs::write(scope.join("ghost"), "../../packages/ghost").unwrap();
        // 非路径文本。
        std::fs::write(scope.join("text"), "hello world not a path").unwrap();
        // 尝试穿越出 agent_dir。
        std::fs::write(scope.join("escape"), "../../../../../windows").unwrap();
        // 真目录（真包）。
        std::fs::create_dir_all(scope.join("real-pkg")).unwrap();
        std::fs::write(scope.join("real-pkg/package.json"), "{}").unwrap();

        assert_eq!(heal_workspace_links(&root).unwrap(), 0);
        assert!(scope.join("long").is_file());
        assert!(scope.join("ghost").is_file());
        assert!(scope.join("text").is_file());
        assert!(scope.join("escape").is_file());
        assert!(scope.join("real-pkg/package.json").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

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
