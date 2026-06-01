use std::path::PathBuf;

/// Resolves user-supplied identifiers (project paths, agent IDs) to concrete
/// values. Initially just passes through; will grow validation logic later.
pub struct Resolver;

impl Resolver {
    pub fn new() -> Self {
        Self
    }

    /// Resolve a project path from a user-supplied string.
    /// If `input` is `.`, resolves to the current working directory.
    pub fn resolve_project_path(&self, input: &str) -> Result<PathBuf, crate::cli::error::CliError> {
        let path = PathBuf::from(input);
        let resolved = if input == "." {
            std::env::current_dir()?
        } else {
            path
        };
        Ok(resolved)
    }

    /// Resolve an agent identifier. Currently a pass-through.
    pub fn resolve_agent_id(&self, input: &str) -> Result<String, crate::cli::error::CliError> {
        Ok(input.to_string())
    }
}
