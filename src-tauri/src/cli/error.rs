/// All errors that can surface from the CLI layer.
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("invalid argument: {0}")]
    InvalidArg(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("agent unhealthy: {0}")]
    AgentUnhealthy(String),

    #[error("{0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Serde(#[from] serde_json::Error),

    #[error("daemon error: {0}")]
    Daemon(String),

    #[error("aborted")]
    Aborted,

    #[error("orchestrator error: {0}")]
    Orchestrator(String),

    #[error("permission denied: {0}")]
    Permission(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl CliError {
    /// Exit code convention:
    ///   1   - general / internal
    ///   2   - invalid argument
    ///   3   - not found
    ///   4   - agent unhealthy
    ///   5   - daemon / permission / orchestrator
    ///   130 - SIGINT (aborted)
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::InvalidArg(_) => 2,
            Self::NotFound(_) => 3,
            Self::AgentUnhealthy(_) => 4,
            Self::Daemon(_) | Self::Permission(_) | Self::Orchestrator(_) => 5,
            Self::Aborted => 130,
            Self::Io(_) | Self::Serde(_) | Self::Internal(_) => 1,
        }
    }
}
