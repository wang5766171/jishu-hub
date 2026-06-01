use crate::cli::args::AgentAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: AgentAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        AgentAction::List => { /* TODO */ }
        AgentAction::Health { agent } => {
            let _ = agent; // TODO
        }
        AgentAction::Probe { agent } => {
            let _ = agent; // TODO
        }
    }
    Ok(())
}
