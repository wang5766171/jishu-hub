use tokio::process::Command as TokioCommand;
use std::process::Command as StdCommand;

/// Build a platform-aware command. On Windows, .cmd/.bat scripts (npm, npx, etc.)
/// must be invoked via `cmd /C <command>` since `Command::new("npm")` won't resolve
/// npm.cmd. On Unix, invoke the binary directly.
pub fn shell_command(program: &str, args: Vec<String>) -> TokioCommand {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = TokioCommand::new("cmd");
        let mut full_args = vec!["/C".to_string(), program.to_string()];
        full_args.extend(args);
        cmd.args(&full_args);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = TokioCommand::new(program);
        cmd.args(&args);
        cmd
    }
}

/// Run an arbitrary install or multi-line command with standard error capturing.
/// Windows: uses `powershell -NoProfile -Command`
/// Unix: uses `sh -c`
pub async fn run_install_command(command: &str, current_dir: Option<&std::path::Path>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let mut installer = StdCommand::new("powershell");
        installer.args(["-NoProfile", "-Command", command]);
        if let Some(dir) = current_dir {
            installer.current_dir(dir);
        }
        let output = crate::process_command::std_no_window(&mut installer)
            .output()
            .map_err(|e| format!("Failed to spawn powershell: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut installer = StdCommand::new("sh");
        installer.args(["-c", command]);
        if let Some(dir) = current_dir {
            installer.current_dir(dir);
        }
        
        let output = crate::process_command::std_no_window(&mut installer)
            .output()
            .map_err(|e| format!("Failed to spawn sh: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
}
