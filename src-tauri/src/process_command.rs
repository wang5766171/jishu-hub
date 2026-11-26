#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
pub fn windows_no_window_creation_flags() -> u32 {
    CREATE_NO_WINDOW
}

pub fn std_no_window(command: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_no_window_creation_flags());
    }
    command
}

/// std 版 PATH 补全（与 tokio 版同源路径集）——安装/更新命令链
/// （shell::run_install_command）用 StdCommand，此前完全没补 PATH。
pub fn extend_path_for_child_std(
    command: &mut std::process::Command,
) -> &mut std::process::Command {
    let extra = collect_user_paths();
    if extra.is_empty() {
        return command;
    }
    let current_path = std::env::var_os("PATH").unwrap_or_default();
    let mut parts: Vec<std::path::PathBuf> = std::env::split_paths(&current_path).collect();
    for dir in extra {
        let path_dir = std::path::PathBuf::from(&dir);
        if !parts.contains(&path_dir) {
            parts.push(path_dir);
        }
    }
    let joined = std::env::join_paths(parts).unwrap_or(current_path);
    command.env("PATH", joined);
    command
}

pub fn tokio_no_window(command: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(windows_no_window_creation_flags());
    }
    command
}

/// v0.7.0：补充子进程的 PATH，确保 dev/release 环境都能找到用户级安装的 CLI
/// （如 codex/claude/claude-agent-acp 等 npm 全局包和 ~/.local/bin）。
///
/// 背景：Tauri dev 模式（npm run tauri dev）的 PATH 继承自 Node/Vite 启动链，
/// 可能缺少用户级 PATH 目录；release 从 Explorer 启动时也可能缺少某些路径。
/// 此函数在子进程的环境变量里补充常见的用户级 bin 目录。
pub fn extend_path_for_child_tokio(
    command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    let extra = collect_user_paths();
    if extra.is_empty() {
        return command;
    }
    let current_path = std::env::var_os("PATH").unwrap_or_default();
    let mut parts: Vec<std::path::PathBuf> = std::env::split_paths(&current_path).collect();
    for dir in extra {
        let path_dir = std::path::PathBuf::from(&dir);
        if !parts.contains(&path_dir) {
            parts.push(path_dir);
        }
    }
    let joined = std::env::join_paths(parts).unwrap_or(current_path);
    command.env("PATH", joined);
    command
}

/// 安装类子进程的期限：`pi install`、预检与回滚的 `npm install` / `npm uninstall`、
/// 安装器的 powershell / sh（见 [`run_bounded_command`]）。
///
/// v0.9.8 评审修复轮 R3：此前这几条子进程没有期限。网络不通、git 源要凭据时
/// 子进程无限期挂住，前端那边「在途安装不落定就关不掉弹层」，用户被困在模
/// 态里只能重启应用。「在途」必须有上界。
///
/// 取 10 分钟，与运行时更新的安装链同口径：一件 npm 包正常 10 秒到 1 分钟装
/// 完；冷缓存、依赖多、网络慢时会到几分钟——10 分钟覆盖正常耗时的上限并留
/// 足余量，再久基本只剩「挂住」这一种解释（引擎自检探针那条是 60 秒：它只
/// 起一次引擎，不下载）。
pub const INSTALL_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// 跑一条子进程并等它结束，输出照 `Command::output()` 的形状交回。到期没结
/// 束：结束它的**整棵进程树**（npm 会再拉起 git、生命周期脚本），报一条中文
/// 错误——「在途」到此为止。
///
/// 等待放进独立任务：到期时由这里显式结束进程树、再回收输出。直接给
/// `cmd.output()` 套超时的话，future 被丢下的那一刻进程句柄也跟着没了，既
/// 拿不到进程号、也管不到它的子进程。标准输入接空：安装源要凭据时得到的是
/// 「没有输入」，而不是无人应答的无限等待。
///
/// - `what`：这件事的人话说法，进报错（「安装 xxx」）。
/// - `spawn_error`：程序起不来时的报错（调用方各自的说法）。
/// - `limit`：期限。
pub async fn run_bounded_command(
    mut cmd: tokio::process::Command,
    what: &str,
    spawn_error: impl FnOnce(String) -> String,
    limit: std::time::Duration,
) -> Result<std::process::Output, String> {
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| spawn_error(e.to_string()))?;
    let pid = child.id();
    let waiter = tokio::spawn(async move { child.wait_with_output().await });
    match tokio::time::timeout(limit, waiter).await {
        Ok(joined) => joined
            .map_err(|e| format!("{what}的等待异常结束：{e}"))?
            .map_err(|e| format!("{what}没有正常结束：{e}")),
        Err(_) => {
            if let Some(pid) = pid {
                if let Err(e) = crate::process_control::terminate_process_tree(pid) {
                    log::warn!("[install] 结束超时的进程树失败（{what}，pid {pid}）: {e}");
                }
            }
            Err(format!(
                "{what}超过 {} 秒仍未结束，已强制结束——多半是网络不通，或安装源在等待输入凭据。请检查网络或凭据后重试。",
                limit.as_secs()
            ))
        }
    }
}

/// 收集用户级 PATH 目录（返回 &str 引用，避免在 hot path 重复分配）。
fn collect_user_paths() -> Vec<String> {
    let mut dirs = Vec::new();

    // npm 全局 bin 目录（Windows: %APPDATA%\npm，Unix: ~/.npm-global/bin 等）
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            dirs.push(format!("{}\\npm", appdata));
        }
        // claude CLI 常装在 ~/.local/bin
        if let Ok(home) = std::env::var("USERPROFILE") {
            dirs.push(format!("{}\\.local\\bin", home));
        }
        // v0.9.7 收版反馈（2026-11-13）：winget 是用户级 Store 别名
        // （%LOCALAPPDATA%\Microsoft\WindowsApps）——hub 子进程 PATH 缺该
        // 目录时 winget「无法识别」（在线更新策略链第一跳）。choco bin
        // 一并补（策略链第二跳）。
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(format!("{}\\Microsoft\\WindowsApps", local));
        }
        dirs.push("C:\\ProgramData\\chocolatey\\bin".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(format!("{}/.local/bin", home));
            dirs.push(format!("{}/.npm-global/bin", home));
            dirs.push(format!("{}/.bun/bin", home));
            dirs.push(format!("{}/.cargo/bin", home));
        }
    }

    dirs.retain(|d| std::path::Path::new(d).exists());
    dirs
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_silent_processes_use_create_no_window() {
        assert_eq!(super::windows_no_window_creation_flags(), 0x08000000);
    }
}
