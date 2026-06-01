use crate::cli::args::DaemonAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: DaemonAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        DaemonAction::Start { detach } => {
            let _ = detach; // TODO
        }
        DaemonAction::Stop => { /* TODO */ }
        DaemonAction::Status => { /* TODO */ }
        DaemonAction::Restart => { /* TODO */ }
    }
    Ok(())
}
