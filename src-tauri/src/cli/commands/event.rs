use crate::cli::args::EventAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: EventAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        EventAction::Query { r#type, agent, limit } => {
            let _ = (r#type, agent, limit); // TODO
        }
        EventAction::Tail { r#type } => {
            let _ = r#type; // TODO
        }
    }
    Ok(())
}
