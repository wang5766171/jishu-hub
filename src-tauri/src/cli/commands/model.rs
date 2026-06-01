use crate::cli::args::ModelAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: ModelAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ModelAction::List => { /* TODO */ }
        ModelAction::Add {
            id,
            provider,
            base_url,
            api_key,
        } => {
            let _ = (id, provider, base_url, api_key); // TODO
        }
        ModelAction::Remove { id } => {
            let _ = id; // TODO
        }
        ModelAction::Test { id } => {
            let _ = id; // TODO
        }
    }
    Ok(())
}
