use crate::agent::AgentRegistry;
use crate::orchestrator::spec::{Step, TaskSpec};
use std::sync::Arc;

pub mod default;
pub mod evolve;
pub mod llm;
pub mod routing;

pub use default::DefaultPlanner;
pub use evolve::EvolvePlanner;
pub use llm::LlmPlanner;
pub use routing::RoutingPlanner;

#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error("agent not found: {0}")]
    AgentNotFound(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("{0}")]
    Other(String),
}

pub struct PlanContext {
    pub registry: Arc<AgentRegistry>,
    pub previous_active_agent: Option<String>,
}

pub trait Planner: Send + Sync {
    fn id(&self) -> &str;
    fn plan(&self, spec: &TaskSpec, ctx: &PlanContext) -> Result<Vec<Step>, PlanError>;
}

pub fn create_planner(policy: &str) -> Box<dyn Planner> {
    match policy {
        "routing" => Box::new(RoutingPlanner),
        "evolve" | "evolve-stub" => Box::new(EvolvePlanner),
        "llm" => Box::new(LlmPlanner),
        _ => Box::new(DefaultPlanner),
    }
}
