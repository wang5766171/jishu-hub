use crate::cli::args::DaemonAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: DaemonAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        DaemonAction::Start { detach } => {
            if detach {
                // Spawn self as background process
                let exe = std::env::current_exe().map_err(CliError::Io)?;
                let mut cmd = std::process::Command::new(&exe);
                cmd.arg("daemon").arg("start");
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x00000008); // DETACHED_PROCESS
                }
                let child = cmd.spawn().map_err(CliError::Io)?;
                println!("Daemon started with PID: {}", child.id());
                return Ok(());
            }
            // Foreground: run daemon
            crate::orchestrator::daemon::run_daemon().map_err(|e| CliError::Daemon(e))
        }
        DaemonAction::Stop => {
            eprintln!("daemon stop: not yet implemented (v0.7)");
            Err(CliError::Internal(
                "daemon stop is not yet implemented".to_string(),
            ))
        }
        DaemonAction::Status => {
            eprintln!("daemon status: not yet implemented (v0.7)");
            Err(CliError::Internal(
                "daemon status is not yet implemented".to_string(),
            ))
        }
        DaemonAction::Restart => {
            eprintln!("daemon restart: not yet implemented (v0.7)");
            Err(CliError::Internal(
                "daemon restart is not yet implemented".to_string(),
            ))
        }
    }
}
