use crate::cli::args::SessionAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: SessionAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        SessionAction::List { project } => {
            let _ = project; // TODO
        }
        SessionAction::Show { session_id, project } => {
            let _ = (session_id, project); // TODO
        }
        SessionAction::Delete { session_id } => {
            let _ = session_id; // TODO
        }
    }
    Ok(())
}
