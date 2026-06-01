pub mod bus;
pub mod planner;
pub mod proposal;
pub mod result;
pub mod spec;
pub mod trace;

pub use bus::EventBus;
pub use proposal::EvolutionProposal;
pub use result::{RunResult, RunStatus, StepOutcome, UsageSummary};
pub use spec::{Step, StepKind, TaskKind, TaskSpec};
pub use trace::TraceRecorder;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn task_spec_roundtrip() {
        let spec = TaskSpec {
            task_id: "ts_1234_abcd".into(),
            kind: TaskKind::Run,
            message: "Fix the bug".into(),
            project_path: Some("/tmp/proj".into()),
            agent_hint: None,
            policy: "default".into(),
            depth: 0,
            parent_task_id: None,
            created_at: 1700000000,
            deadline_ms: None,
            labels: HashMap::new(),
        };
        let json = serde_json::to_string(&spec).unwrap();
        let de: TaskSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(spec.task_id, de.task_id);
    }

    #[test]
    fn step_kind_tagged_union() {
        let step = Step {
            step_id: "sp_0".into(),
            kind: StepKind::Dispatch {
                agent: "claude-code".into(),
                message: "hello".into(),
                project: "/tmp".into(),
                session: None,
            },
            depends_on: vec![],
            timeout_ms: None,
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"type\":\"dispatch\""));
        let de: Step = serde_json::from_str(&json).unwrap();
        assert_eq!(step.step_id, de.step_id);
    }

    #[test]
    fn evolution_proposal_roundtrip() {
        let p = EvolutionProposal {
            proposal_id: "ep_1234".into(),
            created_at: 1700000000,
            source_task_id: "ts_1234".into(),
            target: "Fix auth".into(),
            kind: proposal::ProposalKind::CodeEdit,
            diff: None,
            rationale: "Security fix".into(),
            risk: proposal::RiskLevel::Low,
            status: proposal::ProposalStatus::Draft,
        };
        let json = serde_json::to_string(&p).unwrap();
        let de: EvolutionProposal = serde_json::from_str(&json).unwrap();
        assert_eq!(p.proposal_id, de.proposal_id);
    }
}
