use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(
    _fix: bool,
    _format: &str,
    _only: Option<&str>,
    _ctx: &ExecutionContext,
) -> Result<(), CliError> {
    // TODO: implement diagnostics
    Ok(())
}
