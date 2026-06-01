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
            // TODO: Connect to daemon and send daemon.shutdown
            println!("Daemon stop: connect to running daemon and send shutdown");
            Ok(())
        }
        DaemonAction::Status => {
            // TODO: Connect to daemon and query status
            println!("Daemon status: not yet connected");
            Ok(())
        }
        DaemonAction::Restart => {
            println!("Daemon restart: stop + start");
            Ok(())
        }
    }
}
