use std::path::Path;
use std::process::Command as StdCommand;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

#[derive(Debug, Clone)]
pub struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

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

pub async fn run_shell_command(
    command: &str,
    current_dir: Option<&Path>,
    timeout_ms: Option<u64>,
) -> Result<ShellOutput, String> {
    #[cfg(target_os = "windows")]
    let mut process = {
        let mut process = TokioCommand::new("cmd");
        process.arg("/C").arg(command);
        process
    };

    #[cfg(not(target_os = "windows"))]
    let mut process = {
        let mut process = TokioCommand::new("sh");
        process.arg("-c").arg(command);
        process
    };

    if let Some(current_dir) = current_dir {
        process.current_dir(current_dir);
    }
    process.kill_on_drop(true);
    crate::process_command::tokio_no_window(&mut process);

    let execution = process.output();
    let output = if let Some(timeout_ms) = timeout_ms {
        timeout(Duration::from_millis(timeout_ms), execution)
            .await
            .map_err(|_| format!("command timed out after {timeout_ms} ms"))?
            .map_err(|error| format!("failed to run command: {error}"))?
    } else {
        execution
            .await
            .map_err(|error| format!("failed to run command: {error}"))?
    };

    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code(),
    })
}

/// Run an arbitrary install or multi-line command with standard error capturing.
/// Windows: uses `powershell -NoProfile -Command`
/// Unix: uses `sh -c`
pub async fn run_install_command(
    command: &str,
    current_dir: Option<&std::path::Path>,
) -> Result<String, String> {
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
            // npm/winget often write failure detail to stdout rather than
            // stderr; prefer stderr but fall back to stdout, and always
            // include the exit code so the error is never empty.
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            Err(format!(
                "command failed (exit {:?}): {}",
                output.status.code(),
                detail
            ))
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
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            Err(format!(
                "command failed (exit {:?}): {}",
                output.status.code(),
                detail
            ))
        }
    }
}
