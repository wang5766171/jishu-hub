use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(rename = "agentId", default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(rename = "projectPath")]
    pub project_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Commands {
    pub commands: Vec<CustomCommand>,
}

fn commands_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(".jishu-hub");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("commands.json"))
}

fn read_json<T: for<'de> Deserialize<'de>>(
    path: &PathBuf,
) -> Result<T, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

fn write_json<T: Serialize>(path: &PathBuf, data: &T) -> Result<(), Box<dyn std::error::Error>> {
    let json = serde_json::to_string_pretty(data)?;
    std::fs::write(path, json)?;
    Ok(())
}

pub fn list_custom_commands() -> Result<Vec<CustomCommand>, Box<dyn std::error::Error>> {
    let path = commands_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data: Commands = read_json(&path)?;
    Ok(data.commands)
}

pub fn save_custom_command(cmd: CustomCommand) -> Result<(), Box<dyn std::error::Error>> {
    let path = commands_path()?;
    let mut data = if path.exists() {
        read_json::<Commands>(&path)?
    } else {
        Commands::default()
    };
    if let Some(idx) = data.commands.iter().position(|c| c.id == cmd.id) {
        data.commands[idx] = cmd;
    } else {
        data.commands.push(cmd);
    }
    write_json(&path, &data)
}

pub fn delete_custom_command(id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = commands_path()?;
    if !path.exists() {
        return Ok(());
    }
    let mut data: Commands = read_json(&path)?;
    data.commands.retain(|c| c.id != id);
    write_json(&path, &data)
}

pub fn open_agent_terminal(
    project_path: &str,
    command: &str,
    window_id: Option<&str>,
) -> Result<u32, Box<dyn std::error::Error>> {
    open_in_terminal_raw(project_path, command, window_id)
}

pub fn open_in_terminal_with_command(
    project_path: &str,
    command: &str,
) -> Result<u32, Box<dyn std::error::Error>> {
    open_in_terminal_raw(project_path, command, None)
}

fn open_in_terminal_raw(
    project_path: &str,
    terminal_command: &str,
    window_id: Option<&str>,
) -> Result<u32, Box<dyn std::error::Error>> {
    if cfg!(target_os = "windows") {
        let mut wt_lookup = std::process::Command::new("cmd");
        let has_wt =
            crate::process_command::std_no_window(wt_lookup.args(["/C", "where wt >nul 2>nul"]))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

        if has_wt {
            // Spawn wt directly — avoids nested quoting issues with cmd /C
            let mut cmd = std::process::Command::new("wt");
            // Named window per session so we can focus the correct one later
            if let Some(id) = window_id {
                cmd.args(["-w", id]);
            }
            let child = cmd
                .args(["-d", project_path])
                .args(["--", "cmd", "/K", terminal_command])
                .spawn()?;
            Ok(child.id())
        } else {
            // Use .current_dir() instead of cd /D to avoid quoting issues
            let child = std::process::Command::new("cmd")
                .args(["/K", terminal_command])
                .current_dir(project_path)
                .spawn()?;
            Ok(child.id())
        }
    } else if cfg!(target_os = "macos") {
        let child = std::process::Command::new("open")
            .args(["-a", "Terminal", project_path])
            .spawn()?;
        // Small delay then run the agent command via AppleScript
        std::thread::sleep(std::time::Duration::from_millis(500));
        std::process::Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "tell application \"Terminal\" to do script \"cd '{}' && {}\"",
                    project_path, terminal_command
                ),
            ])
            .spawn()?;
        Ok(child.id())
    } else {
        // Linux: try common terminal emulators
        let terminal = which_terminal()?;
        let child = std::process::Command::new(terminal)
            .args([
                "-e",
                "sh",
                "-c",
                &format!("cd '{}' && {}", project_path, terminal_command),
            ])
            .spawn()?;
        Ok(child.id())
    }
}

fn which_terminal() -> Result<&'static str, Box<dyn std::error::Error>> {
    for term in &["gnome-terminal", "konsole", "xfce4-terminal", "xterm"] {
        if std::process::Command::new("which")
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

/// Run a command silently in the background (no window) and wait for it to finish.
pub fn run_silent_command(
    command: &str,
    args: &[&str],
    cwd: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]);

        let args_joined = args
            .iter()
            .map(|a| {
                if a.contains(' ') {
                    format!("'{}'", a.replace("'", "''"))
                } else {
                    a.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");

        let pwsh_cmd = match cwd {
            Some(dir) => {
                // Use LiteralPath to support special characters like [ ] or Chinese
                format!(
                    "Set-Location -LiteralPath '{}'; & {} {}",
                    dir.replace("'", "''"),
                    command,
                    args_joined
                )
            }
            None => format!("& {} {}", command, args_joined),
        };

        c.arg(pwsh_cmd);
        crate::process_command::std_no_window(&mut c);
        let status = c.status()?;
        Ok(status.success())
    } else {
        let mut c = std::process::Command::new(command);
        c.args(args);
        if let Some(dir) = cwd {
            c.current_dir(dir);
        }
        let status = c.status()?;
        Ok(status.success())
    }
}

/// Run a command in a new terminal window. The terminal stays open after the command finishes.
pub fn run_in_terminal(
    command: &str,
    cwd: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    if cfg!(target_os = "windows") {
        let mut wt_lookup = std::process::Command::new("cmd");
        let has_wt =
            crate::process_command::std_no_window(wt_lookup.args(["/C", "where wt >nul 2>nul"]))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

        if has_wt {
            let wrapped = format!("prompt $P$G& @echo %CD%^>{}& @echo.& {}", command, command);
            let mut cmd = std::process::Command::new("wt");
            if let Some(dir) = cwd {
                cmd.args(["-d", dir]);
            }
            cmd.args(["--", "cmd", "/K", &wrapped]).spawn()?;
        } else {
            let wrapped = format!("prompt $P$G& @echo %CD%^>{}& @echo.& {}", command, command);
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/K", &wrapped]);
            if let Some(dir) = cwd {
                cmd.current_dir(dir);
            }
            cmd.spawn()?;
        }
    } else if cfg!(target_os = "macos") {
        let escaped = command.replace('\'', "'\\''");
        let shell_cmd = match cwd {
            Some(dir) => format!(
                "cd '{}' && echo '> {}'; echo; {}; exec bash",
                dir, escaped, command
            ),
            None => format!("echo '> {}'; echo; {}; exec bash", escaped, command),
        };
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .spawn()?;
        std::thread::sleep(std::time::Duration::from_millis(500));
        std::process::Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "tell application \"Terminal\" to do script \"{}\"",
                    shell_cmd
                ),
            ])
            .spawn()?;
    } else {
        let terminal = which_terminal()?;
        let escaped = command.replace('\'', "'\\''");
        let shell_cmd = match cwd {
            Some(dir) => format!(
                "cd '{}' && echo '> {}'; echo; {}; exec sh",
                dir, escaped, command
            ),
            None => format!("echo '> {}'; echo; {}; exec sh", escaped, command),
        };
        std::process::Command::new(terminal)
            .args(["-e", "sh", "-c", &shell_cmd])
            .spawn()?;
    }
    Ok(true)
}
