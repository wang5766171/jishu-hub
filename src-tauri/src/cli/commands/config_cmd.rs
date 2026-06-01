use crate::cli::args::ConfigAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: ConfigAction, _ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ConfigAction::Show => { /* TODO */ }
        ConfigAction::Set { key, value } => {
            let _ = (key, value); // TODO
        }
        ConfigAction::Get { key } => {
            let _ = key; // TODO
        }
    }
    Ok(())
}
