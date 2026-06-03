pub mod default;
pub use default::DefaultDispatcher;

use crate::agent::AgentRegistry;
use crate::agent::NormalizedEvent;
use crate::orchestrator::result::StepOutcome;
use crate::orchestrator::spec::{Step, TaskSpec};
use crate::orchestrator::trace::TraceRecorder;
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum DispatchError {
    #[error("agent not found: {0}")]
    AgentNotFound(String),
    #[error("role not found: {0}")]
    RoleNotFound(String),
    #[error("no agent assigned for role: {0}")]
    NoAgentForRole(String),
    #[error("path traversal denied: {0}")]
    PathTraversal(String),
    #[error("unsupported step kind: {0}")]
    Unsupported(String),
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

pub struct DispatchContext<'a> {
    pub registry: Arc<AgentRegistry>,
    pub run_id: &'a str,
    pub spec: &'a TaskSpec,
    pub trace: &'a TraceRecorder,
    pub emitter: &'a mut dyn FnMut(&NormalizedEvent),
}

pub trait Dispatcher: Send + Sync {
    fn id(&self) -> &str;
    fn execute(&self, step: &Step, ctx: &mut DispatchContext)
        -> Result<StepOutcome, DispatchError>;
}
