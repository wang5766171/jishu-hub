use crate::cli::args::AcpAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: AcpAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        AcpAction::Start { cwd, model, log_file } => {
            let _ = (cwd, model, log_file); // TODO
        }
        AcpAction::Stop { session_id } => {
            let _ = session_id; // TODO
        }
        AcpAction::List => { /* TODO */ }
    }
    Ok(())
}
