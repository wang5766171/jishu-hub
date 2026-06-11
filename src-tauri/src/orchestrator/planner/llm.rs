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
                "No active model configured. Please configure one in the jishu-hub settings page.".to_string(),
            ));
        }

        // v0.6: delegate to default planner behavior with role_id-based dispatch.
        // Full LLM-driven planning with tool loop comes in v0.7.
        // LLM planner uses roles from spec; if no roles, use previous_active_agent.
        let role_id = spec
            .roles
            .first()
            .map(|r| r.role_id.clone())
            .or_else(|| ctx.previous_active_agent.clone())
            .unwrap_or_else(|| "claude-code".into());

        let project = spec.project_path.clone().unwrap_or_else(|| ".".to_string());

        Ok(vec![Step {
            step_id: "sp_0".to_string(),
            kind: StepKind::Dispatch {
                role_id,
                prompt: spec.message.clone(),
                project,
                session: None,
            },
            depends_on: vec![],
            timeout_ms: spec.deadline_ms,
        }])
    }
}
