use crate::cli::args::TaskAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: TaskAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        TaskAction::Add { plan, description } => {
            let _ = (plan, description); // TODO
        }
        TaskAction::Update { task_id, status } => {
            let _ = (task_id, status); // TODO
        }
        TaskAction::List { plan_id } => {
            let _ = plan_id; // TODO
        }
    }
    Ok(())
}
