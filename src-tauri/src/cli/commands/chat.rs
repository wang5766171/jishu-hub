use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(
    _agent: String,
    _session: Option<String>,
    _project: String,
    _ctx: &ExecutionContext,
) -> Result<(), CliError> {
    // TODO: implement interactive chat
    Ok(())
}
