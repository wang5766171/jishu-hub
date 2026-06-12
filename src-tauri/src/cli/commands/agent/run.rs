use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(
    _prompt: &str,
    _agent: Option<&str>,
    _project: &str,
    _ctx: &ExecutionContext,
) -> Result<(), CliError> {
    Err(CliError::Internal(
        "direct run is being rebuilt for the new task graph architecture (Phase B)".to_string(),
    ))
}
