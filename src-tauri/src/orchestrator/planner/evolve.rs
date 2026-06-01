use super::{PlanContext, PlanError, Planner};
use crate::orchestrator::spec::{Step, StepKind, TaskSpec};

pub struct EvolvePlanner;

impl Planner for EvolvePlanner {
    fn id(&self) -> &str {
        "evolve-stub"
    }

    fn plan(&self, spec: &TaskSpec, _ctx: &PlanContext) -> Result<Vec<Step>, PlanError> {
        Ok(vec![Step {
            step_id: "sp_0".to_string(),
            kind: StepKind::Reflect {
                question: spec.message.clone(),
            },
            depends_on: vec![],
            timeout_ms: spec.deadline_ms,
        }])
    }
}
