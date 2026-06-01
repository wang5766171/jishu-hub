use crate::cli::args::PlanAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: PlanAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        PlanAction::Create { name, description } => {
            let _ = (name, description); // TODO
        }
        PlanAction::List => { /* TODO */ }
        PlanAction::Show { plan_id } => {
            let _ = plan_id; // TODO
        }
        PlanAction::Delete { plan_id } => {
            let _ = plan_id; // TODO
        }
    }
    Ok(())
}
