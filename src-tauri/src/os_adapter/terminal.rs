use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 强制为控制台子进程分配**新的独立控制台窗口**。debug 构建（tauri dev）
/// 本身是控制台程序、继承开发者终端——无此标志时子终端会附着到同一个
/// 控制台（表现为"覆盖"正在运行的 dev 会话，关窗即双杀）。
#[cfg(target_os = "windows")]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

pub fn open_in_terminal_raw(
    project_path: &str,
    terminal_command: &str,
    window_id: Option<&str>,
) -> Result<u32, Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        let mut wt_lookup = Command::new("cmd");
        let has_wt =
            crate::process_command::std_no_window(wt_lookup.args(["/C", "where wt >nul 2>nul"]))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

        if has_wt {
            // v0.7.4 修复：不带 -w 时 wt 遵循用户"在现有窗口打开"设置——新终端
            // 变成已有窗口的新标签（遮住正在运行的会话，关窗即双双退出）。
            // 始终携带窗口 ID：复用调用方指定的（同会话 resume 复用），否则
            // 生成唯一 ID 强制开新窗口。
            let wid = window_id
                .map(str::to_string)
                .unwrap_or_else(|| format!("jishu-hub-{}", uuid::Uuid::new_v4()));
            let mut cmd = Command::new("wt");
            cmd.args(["-w", &wid]);
            // 优先 PowerShell 7（pwsh），无则回退 cmd /K。
            let mut pwsh_lookup = Command::new("cmd");
            let has_pwsh = crate::process_command::std_no_window(
                pwsh_lookup.args(["/C", "where pwsh >nul 2>nul"]),
            )
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
            let child = if has_pwsh {
                cmd.args(["-d", project_path])
                    .args(["--", "pwsh", "-NoExit", "-Command", terminal_command])
                    .creation_flags(CREATE_NEW_CONSOLE)
                    .spawn()?
            } else {
                cmd.args(["-d", project_path])
                    .args(["--", "cmd", "/K", terminal_command])
                    .creation_flags(CREATE_NEW_CONSOLE)
                    .spawn()?
            };
            Ok(child.id())
        } else {
            let child = Command::new("cmd")
                .args(["/K", terminal_command])
                .current_dir(project_path)
                .creation_flags(CREATE_NEW_CONSOLE)
                .spawn()?;
            Ok(child.id())
        }
    }
    #[cfg(target_os = "macos")]
    {
        let child = Command::new("open")
            .args(["-a", "Terminal", project_path])
            .spawn()?;
        std::thread::sleep(std::time::Duration::from_millis(500));
        let safe_path = project_path.replace('\'', "'\\''");
        let escaped_cmd = terminal_command.replace('"', "\\\""); // Simple escaping for AppleScript
        Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "tell application \"Terminal\" to do script \"cd '{}' && {}\"",
                    safe_path, escaped_cmd
                ),
            ])
            .spawn()?;
        Ok(child.id())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let terminal = which_terminal()?;
        let safe_path = project_path.replace('\'', "'\\''");
        let child = Command::new(terminal)
            .args([
                "-e",
                "sh",
                "-c",
                &format!("cd '{}' && {}", safe_path, terminal_command),
            ])
            .spawn()?;
        Ok(child.id())
    }
}

pub fn run_in_terminal(
    command: &str,
    cwd: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        let mut wt_lookup = Command::new("cmd");
        let has_wt =
            crate::process_command::std_no_window(wt_lookup.args(["/C", "where wt >nul 2>nul"]))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

        if has_wt {
            let wrapped = format!("prompt $P$G& @echo %CD%^>{}& @echo.& {}", command, command);
            let mut cmd = Command::new("wt");
            if let Some(dir) = cwd {
                cmd.args(["-d", dir]);
            }
            cmd.args(["--", "cmd", "/K", &wrapped]).spawn()?;
        } else {
            let wrapped = format!("prompt $P$G& @echo %CD%^>{}& @echo.& {}", command, command);
            let mut cmd = Command::new("cmd");
            cmd.args(["/K", &wrapped]);
            if let Some(dir) = cwd {
                cmd.current_dir(dir);
            }
            cmd.spawn()?;
        }
        Ok(true)
    }
    #[cfg(target_os = "macos")]
    {
        let escaped = command.replace('\'', "'\\''");
        let shell_cmd = match cwd {
            Some(dir) => format!(
                "cd '{}' && echo '> {}'; echo; {}; exec bash",
                dir, escaped, command
            ),
            None => format!("echo '> {}'; echo; {}; exec bash", escaped, command),
        };
        Command::new("open").args(["-a", "Terminal"]).spawn()?;
        std::thread::sleep(std::time::Duration::from_millis(500));
        let safe_shell_cmd = shell_cmd.replace('"', "\\\"");
        Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "tell application \"Terminal\" to do script \"{}\"",
                    safe_shell_cmd
                ),
            ])
            .spawn()?;
        Ok(true)
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let terminal = which_terminal()?;
        let escaped = command.replace('\'', "'\\''");
        let shell_cmd = match cwd {
            Some(dir) => format!(
                "cd '{}' && echo '> {}'; echo; {}; exec sh",
                dir, escaped, command
            ),
            None => format!("echo '> {}'; echo; {}; exec sh", escaped, command),
        };
        Command::new(terminal)
            .args(["-e", "sh", "-c", &shell_cmd])
            .spawn()?;
        Ok(true)
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn which_terminal() -> Result<&'static str, Box<dyn std::error::Error>> {
    for term in &["gnome-terminal", "konsole", "xfce4-terminal", "xterm"] {
        if Command::new("which")
            .arg(term)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return Ok(term);
        }
    }
    Ok("xterm")
}
