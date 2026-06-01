use crate::cli::args::AcpAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: AcpAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        AcpAction::Start { cwd, model, log_file } => {
            crate::acp::run(cwd, model, log_file).map_err(CliError::Internal)
        }
        AcpAction::Stop { session_id } => {
            Err(CliError::Internal(format!(
                "ACP session stop not yet implemented: {session_id}"
            )))
        }
        AcpAction::List => {
            println!("No active ACP sessions.");
            Ok(())
        }
    }
}
