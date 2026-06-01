use crate::cli::args::AgentBridgeAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: AgentBridgeAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        AgentBridgeAction::Start { agent, transport } => {
            let _ = (agent, transport); // TODO
        }
        AgentBridgeAction::List => { /* TODO */ }
        AgentBridgeAction::Stop { bridge_id } => {
            let _ = bridge_id; // TODO
        }
    }
    Ok(())
}
