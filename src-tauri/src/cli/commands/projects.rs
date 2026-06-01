use crate::cli::args::ProjectAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: ProjectAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ProjectAction::List => { /* TODO */ }
        ProjectAction::Add { path } => {
            let _ = path; // TODO
        }
        ProjectAction::Remove { project } => {
            let _ = project; // TODO
        }
        ProjectAction::Info { project } => {
            let _ = project; // TODO
        }
    }
    Ok(())
}
