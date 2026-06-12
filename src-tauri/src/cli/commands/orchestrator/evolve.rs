use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(
    _plan: Option<&str>,
    _project: &str,
    _dry_run: bool,
    _ctx: &ExecutionContext,
) -> Result<(), CliError> {
    Err(CliError::Internal(
        "evolve is being rebuilt for the new task graph architecture (Phase D)".to_string(),
    ))
}
