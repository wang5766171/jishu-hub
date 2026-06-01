use super::{PlanContext, PlanError, Planner};
use crate::orchestrator::spec::{Step, StepKind, TaskSpec};

pub struct DefaultPlanner;

impl Planner for DefaultPlanner {
    fn id(&self) -> &str {
        "default"
    }

    fn plan(&self, spec: &TaskSpec, ctx: &PlanContext) -> Result<Vec<Step>, PlanError> {
        let agent = spec
            .agent_hint
            .as_deref()
            .or(ctx.previous_active_agent.as_deref())
            .unwrap_or("claude-code")
            .to_string();

        let project = spec
            .project_path
            .clone()
            .unwrap_or_else(|| ".".to_string());

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
