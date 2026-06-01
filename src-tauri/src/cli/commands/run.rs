use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(
    _prompt: &str,
    _agent: Option<&str>,
    _project: &str,
    _ctx: &ExecutionContext,
) -> Result<(), CliError> {
    // TODO: implement non-interactive prompt execution
    Ok(())
}
