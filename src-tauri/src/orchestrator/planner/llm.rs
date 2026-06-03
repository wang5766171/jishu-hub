use super::{PlanContext, PlanError, Planner};
use crate::orchestrator::spec::{Step, StepKind, TaskSpec};

pub struct LlmPlanner;

impl LlmPlanner {
    pub fn new() -> Self {
        Self
    }
}

impl Planner for LlmPlanner {
    fn id(&self) -> &str {
        "llm"
    }

    fn plan(&self, spec: &TaskSpec, ctx: &PlanContext) -> Result<Vec<Step>, PlanError> {
        // Check if an active model is configured
        let store = crate::llm::config::ModelStore::load()
            .map_err(|e| PlanError::Other(format!("Cannot load model config: {e}")))?;

        if store.get_active().is_none() {
            return Err(PlanError::Other(
                "No active model configured. Use `jishu model use <id>` to set one.".to_string(),
            ));
        }

        // v0.6.0 stub: delegate to default planner behavior
        // Full LLM-driven planning with tool loop comes in v0.7
        let agent = spec
            .agent_hint
            .as_deref()
            .or(ctx.previous_active_agent.as_deref())
            .unwrap_or("claude-code")
            .to_string();

        let project = spec.project_path.clone().unwrap_or_else(|| ".".to_string());

        Ok(vec![Step {
            step_id: "sp_0".to_string(),
            kind: StepKind::Dispatch {
                agent,
                message: spec.message.clone(),
                project,
                session: None,
            },
            depends_on: vec![],
            timeout_ms: spec.deadline_ms,
        }])
    }
}
