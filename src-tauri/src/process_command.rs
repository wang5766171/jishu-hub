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
