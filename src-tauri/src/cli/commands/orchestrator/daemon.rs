use crate::cli::args::DaemonAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: DaemonAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        DaemonAction::Start { detach: _ } => Err(CliError::Internal(
            "daemon is being rebuilt for the new task graph architecture (Phase B)".to_string(),
        )),
        DaemonAction::Stop => {
            eprintln!("daemon stop: not yet implemented");
            Err(CliError::Internal(
                "daemon stop is not yet implemented".to_string(),
            ))
        }
        DaemonAction::Status => {
            println!("daemon: not running (being rebuilt)");
            Ok(())
        }
        DaemonAction::Restart => Err(CliError::Internal(
            "daemon is being rebuilt for the new task graph architecture (Phase B)".to_string(),
        )),
    }
}
