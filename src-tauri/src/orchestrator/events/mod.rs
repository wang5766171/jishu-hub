use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Schema version for event payloads.
pub const EVENT_SCHEMA_VERSION: &str = "1.0.0";

/// Append-only task event. The authority source for all run state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskEvent {
    pub event_id: String,
    pub run_id: String,
    /// Monotonically increasing within a single run.
    pub run_seq: u64,
    pub event_type: TaskEventType,
    pub schema_version: String,
    pub occurred_at: i64,
    pub actor: String,
    #[serde(default)]
    pub causation_id: Option<String>,
    #[serde(default)]
    pub correlation_id: Option<String>,
    pub payload: serde_json::Value,
}

/// Core event types per design doc section 10.3.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TaskEventType {
    RunStarted,
    NodeReady,
    LeaseGranted,
    AttemptStarted,
    AttemptProgressed,
    ArtifactProduced,
    ApprovalRequested,
    ApprovalResolved,
    AttemptFailed,
    RecoveryChosen,
    RetryScheduled,
    RepairGraphAttached,
    LoopStarted,
    IterationStarted,
    ProgressEvaluated,
    LoopSleeping,
    LoopCompleted,
    RevisionAppliedToRun,
    RevisionCreated,
    NodeResolved,
    RunCompleted,
    // Additional control events
    RunPaused,
    RunResumed,
    RunCancelled,
    RunFailed,
    NodeBlocked,
    NodeSkipped,
    NodeCancelled,
    NodeSuperseded,
    BudgetExceeded,
    LeaseExpired,
}

/// Payload definitions for each event type.
/// These are typed for internal Rust use; externally stored as JSON Value.
pub mod payloads {
    use super::*;
    use crate::orchestrator::domain::run::{
        AgentAssignment, AttemptError, AttemptUsage, BudgetState, NodeRunStatus, RunStatus,
    };

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct RunStartedPayload {
        pub run_id: String,
        pub graph_id: String,
        pub revision_id: String,
        pub initial_status: RunStatus,
        pub budget_state: BudgetState,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct NodeReadyPayload {
        pub node_run_id: String,
        pub node_id: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct LeaseGrantedPayload {
        pub lease_id: String,
        pub node_run_id: String,
        pub attempt_id: String,
        pub resources: Vec<String>,
        pub expires_at: i64,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct AttemptStartedPayload {
        pub attempt_id: String,
        pub node_run_id: String,
        pub attempt_number: u32,
        pub agent_assignment: Option<AgentAssignment>,
        pub transport: Option<String>,
        pub idempotency_key: Option<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct AttemptProgressedPayload {
        pub attempt_id: String,
        pub node_run_id: String,
        pub message: String,
        pub usage_delta: AttemptUsage,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ArtifactProducedPayload {
        pub artifact_id: String,
        pub attempt_id: String,
        pub name: String,
        pub artifact_type: String,
        pub hash: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ApprovalRequestedPayload {
        pub approval_id: String,
        pub node_run_id: String,
        pub description: String,
        pub risk_level: String,
        pub scope: Vec<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ApprovalResolvedPayload {
        pub approval_id: String,
        pub node_run_id: String,
        pub approved: bool,
        pub resolver: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct AttemptFailedPayload {
        pub attempt_id: String,
        pub node_run_id: String,
        pub error: AttemptError,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct RecoveryChosenPayload {
        pub node_run_id: String,
        pub strategy: String,
        pub reason: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct RetryScheduledPayload {
        pub node_run_id: String,
        pub next_attempt_number: u32,
        pub wake_at: i64,
        pub backoff_ms: u64,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct RepairGraphAttachedPayload {
        pub node_run_id: String,
        pub repair_revision_id: String,
        pub depth: u32,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct LoopStartedPayload {
        pub loop_node_id: String,
        pub run_id: String,
        pub max_iterations: Option<u32>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct IterationStartedPayload {
        pub loop_node_id: String,
        pub iteration: u32,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ProgressEvaluatedPayload {
        pub loop_node_id: String,
        pub iteration: u32,
        pub result: EvaluatorResult,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case", tag = "outcome")]
    pub enum EvaluatorResult {
        Continue,
        Wait { wake_at: i64 },
        Complete { result: serde_json::Value },
        Pause { reason: String },
        Fail { error: String },
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct LoopSleepingPayload {
        pub loop_node_id: String,
        pub wake_at: i64,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct LoopCompletedPayload {
        pub loop_node_id: String,
        pub total_iterations: u32,
        pub final_result: serde_json::Value,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct RevisionAppliedToRunPayload {
        pub run_id: String,
        pub old_revision_id: String,
        pub new_revision_id: String,
        pub frozen_node_ids: Vec<String>,
        pub superseded_node_ids: Vec<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct RevisionCreatedPayload {
        pub revision_id: String,
        pub run_id: String,
        pub graph_id: String,
        /// What produced this revision (e.g. "run_revision_apply").
        pub source: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct NodeResolvedPayload {
        pub node_run_id: String,
        pub node_id: String,
        pub final_status: NodeRunStatus,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct RunCompletedPayload {
        pub run_id: String,
        pub final_status: RunStatus,
        pub total_usage: AttemptUsage,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct NodeStatusChangedPayload {
        pub node_run_id: String,
        pub node_id: String,
        pub old_status: NodeRunStatus,
        pub new_status: NodeRunStatus,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct BudgetExceededPayload {
        pub run_id: String,
        pub budget_type: String,
        pub used: f64,
        pub limit: f64,
    }
}

/// Helper to build a TaskEvent with defaults.
pub fn build_event(
    event_id: impl Into<String>,
    run_id: impl Into<String>,
    run_seq: u64,
    event_type: TaskEventType,
    actor: impl Into<String>,
    occurred_at: i64,
    payload: serde_json::Value,
) -> TaskEvent {
    TaskEvent {
        event_id: event_id.into(),
        run_id: run_id.into(),
        run_seq,
        event_type,
        schema_version: EVENT_SCHEMA_VERSION.into(),
        occurred_at,
        actor: actor.into(),
        causation_id: None,
        correlation_id: None,
        payload,
    }
}

/// A batch of events to be appended atomically.
#[derive(Debug, Clone)]
pub struct EventBatch {
    pub run_id: String,
    pub events: Vec<TaskEvent>,
}

impl EventBatch {
    pub fn new(run_id: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            events: vec![],
        }
    }

    pub fn add(&mut self, event: TaskEvent) {
        self.events.push(event);
    }
}

/// Projection that can be rebuilt from events.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RunProjection {
    pub run_id: String,
    pub graph_id: String,
    pub revision_id: String,
    pub status: crate::orchestrator::domain::run::RunStatus,
    pub run_seq: u64,
    pub budget_state: crate::orchestrator::domain::run::BudgetState,
    pub node_runs: HashMap<String, NodeRunProjection>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

/// Projection of a single node run, derived from events.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodeRunProjection {
    pub node_run_id: String,
    pub node_id: String,
    pub status: crate::orchestrator::domain::run::NodeRunStatus,
    pub attempt_count: u32,
    pub current_attempt_id: Option<String>,
    pub wake_at: Option<i64>,
    pub error: Option<String>,
    pub usage: crate::orchestrator::domain::run::AttemptUsage,
    pub loop_iteration: Option<u32>,
}

/// Rebuild a RunProjection from a sequence of events.
pub fn rebuild_projection(
    run_id: &str,
    events: &[TaskEvent],
) -> Result<RunProjection, ProjectionError> {
    let mut proj = RunProjection {
        run_id: run_id.into(),
        ..Default::default()
    };

    let mut expected_seq = 1;
    for event in events {
        if event.run_id != run_id {
            continue;
        }
        if event.run_seq != expected_seq {
            return Err(ProjectionError::Sequence {
                expected: expected_seq,
                actual: event.run_seq,
            });
        }
        expected_seq += 1;
        proj.run_seq = event.run_seq;
        apply_event_to_projection(&mut proj, event)?;
    }

    Ok(proj)
}

/// Apply a contiguous delta of events to an existing projection.
/// Checks that the first event's run_seq == starting_seq and each subsequent is +1.
pub fn apply_events_to_projection(
    proj: &mut RunProjection,
    events: &[TaskEvent],
    starting_seq: u64,
) -> Result<(), ProjectionError> {
    let mut expected = starting_seq;
    for event in events {
        if event.run_seq != expected {
            return Err(ProjectionError::Sequence {
                expected,
                actual: event.run_seq,
            });
        }
        expected += 1;
        proj.run_seq = event.run_seq;
        apply_event_to_projection(proj, event)?;
    }
    Ok(())
}

fn apply_event_to_projection(
    proj: &mut RunProjection,
    event: &TaskEvent,
) -> Result<(), ProjectionError> {
    use TaskEventType::*;

    match event.event_type {
        RunStarted => {
            let payload: payloads::RunStartedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            proj.graph_id = payload.graph_id;
            proj.revision_id = payload.revision_id;
            proj.status = payload.initial_status;
            proj.budget_state = payload.budget_state;
            proj.started_at = Some(event.occurred_at);
        }
        NodeReady | NodeBlocked => {
            let payload: payloads::NodeReadyPayload = serde_json::from_value(event.payload.clone())
                .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            let nr = proj
                .node_runs
                .entry(payload.node_run_id.clone())
                .or_insert_with(|| NodeRunProjection {
                    node_run_id: payload.node_run_id.clone(),
                    node_id: payload.node_id.clone(),
                    ..Default::default()
                });
            nr.status = if event.event_type == NodeReady {
                crate::orchestrator::domain::run::NodeRunStatus::Ready
            } else {
                crate::orchestrator::domain::run::NodeRunStatus::Blocked
            };
        }
        LeaseGranted => {
            let payload: payloads::LeaseGrantedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            let nr = proj
                .node_runs
                .get_mut(&payload.node_run_id)
                .ok_or_else(|| ProjectionError::MissingNodeRun(payload.node_run_id.clone()))?;
            nr.status = crate::orchestrator::domain::run::NodeRunStatus::Leased;
            nr.current_attempt_id = Some(payload.attempt_id);
        }
        AttemptStarted => {
            let payload: payloads::AttemptStartedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            let nr = proj
                .node_runs
                .get_mut(&payload.node_run_id)
                .ok_or_else(|| ProjectionError::MissingNodeRun(payload.node_run_id.clone()))?;
            nr.status = crate::orchestrator::domain::run::NodeRunStatus::Running;
            nr.attempt_count = payload.attempt_number + 1;
            nr.current_attempt_id = Some(payload.attempt_id);
        }
        AttemptProgressed => {
            let payload: payloads::AttemptProgressedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            if let Some(nr) = proj.node_runs.get_mut(&payload.node_run_id) {
                nr.usage.input_tokens += payload.usage_delta.input_tokens;
                nr.usage.output_tokens += payload.usage_delta.output_tokens;
                nr.usage.cost_usd += payload.usage_delta.cost_usd;
            }
            proj.budget_state.consume(
                payload
                    .usage_delta
                    .input_tokens
                    .saturating_add(payload.usage_delta.output_tokens),
                payload.usage_delta.cost_usd,
            );
        }
        AttemptFailed => {
            let payload: payloads::AttemptFailedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            if let Some(nr) = proj.node_runs.get_mut(&payload.node_run_id) {
                nr.error = Some(payload.error.message.clone());
                nr.status = crate::orchestrator::domain::run::NodeRunStatus::Failed;
            }
        }
        RetryScheduled => {
            let payload: payloads::RetryScheduledPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            if let Some(nr) = proj.node_runs.get_mut(&payload.node_run_id) {
                nr.status = crate::orchestrator::domain::run::NodeRunStatus::RetryWait;
                nr.wake_at = Some(payload.wake_at);
            }
        }
        ApprovalRequested => {
            let payload: payloads::ApprovalRequestedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            if let Some(nr) = proj.node_runs.get_mut(&payload.node_run_id) {
                nr.status = crate::orchestrator::domain::run::NodeRunStatus::AwaitingApproval;
            }
        }
        LoopStarted => {
            let payload: payloads::LoopStartedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            if let Some(node_run) = proj
                .node_runs
                .values_mut()
                .find(|node_run| node_run.node_id == payload.loop_node_id)
            {
                node_run.status = crate::orchestrator::domain::run::NodeRunStatus::Running;
                node_run.loop_iteration = Some(0);
            }
        }
        IterationStarted => {
            let payload: payloads::IterationStartedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            if let Some(node_run) = proj
                .node_runs
                .values_mut()
                .find(|node_run| node_run.node_id == payload.loop_node_id)
            {
                node_run.status = crate::orchestrator::domain::run::NodeRunStatus::Running;
                node_run.loop_iteration = Some(payload.iteration);
                node_run.wake_at = None;
            }
        }
        LoopSleeping => {
            let payload: payloads::LoopSleepingPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            if let Some(node_run) = proj
                .node_runs
                .values_mut()
                .find(|node_run| node_run.node_id == payload.loop_node_id)
            {
                node_run.status = crate::orchestrator::domain::run::NodeRunStatus::RetryWait;
                node_run.wake_at = Some(payload.wake_at);
            }
        }
        NodeResolved => {
            let payload: payloads::NodeResolvedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            if let Some(nr) = proj.node_runs.get_mut(&payload.node_run_id) {
                nr.status = payload.final_status;
                nr.current_attempt_id = None;
            }
        }
        NodeSkipped | NodeCancelled | NodeSuperseded => {
            let payload: payloads::NodeStatusChangedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            if let Some(nr) = proj.node_runs.get_mut(&payload.node_run_id) {
                nr.status = payload.new_status;
            }
        }
        RevisionAppliedToRun => {
            let payload: payloads::RevisionAppliedToRunPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            proj.revision_id = payload.new_revision_id;
        }
        // NOTE: `RevisionCreated` is currently emitted ONLY from `apply_run_revision`
        // (run-scope — a running graph's active revision hot-swap), so overwriting the
        // projection's `revision_id` here is correct. If a future caller emits it for a
        // draft-scope revision (e.g. `apply_commands`), this handler must NOT overwrite
        // `revision_id` for draft events — add a `scope`/`source` guard at that point.
        RevisionCreated => {
            let payload: payloads::RevisionCreatedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            proj.revision_id = payload.revision_id;
        }
        RunCompleted => {
            let payload: payloads::RunCompletedPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            proj.status = payload.final_status;
            proj.finished_at = Some(event.occurred_at);
        }
        RunPaused => {
            proj.status = crate::orchestrator::domain::run::RunStatus::Paused;
        }
        RunResumed => {
            proj.status = crate::orchestrator::domain::run::RunStatus::Running;
        }
        RunCancelled => {
            proj.status = crate::orchestrator::domain::run::RunStatus::Cancelled;
            proj.finished_at = Some(event.occurred_at);
        }
        RunFailed => {
            proj.status = crate::orchestrator::domain::run::RunStatus::Failed;
            proj.finished_at = Some(event.occurred_at);
        }
        BudgetExceeded => {
            let payload: payloads::BudgetExceededPayload =
                serde_json::from_value(event.payload.clone())
                    .map_err(|e| ProjectionError::PayloadDecode(e.to_string()))?;
            // Mark budget as exhausted.
            if payload.budget_type == "token" {
                proj.budget_state.token_used = payload.limit as u64;
            } else if payload.budget_type == "cost" {
                proj.budget_state.cost_used_usd = payload.limit;
            }
        }
        // Events that don't affect the main projection.
        ArtifactProduced | ApprovalResolved | RecoveryChosen | RepairGraphAttached
        | ProgressEvaluated | LoopCompleted | LeaseExpired => {
            // These are tracked in specialized projections (artifact index, approval queue, etc.)
        }
    }

    Ok(())
}

/// Error during projection rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionError {
    PayloadDecode(String),
    MissingNodeRun(String),
    Sequence { expected: u64, actual: u64 },
}

impl std::fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PayloadDecode(msg) => write!(f, "projection payload decode error: {msg}"),
            Self::MissingNodeRun(node_run_id) => {
                write!(f, "projection references unknown node run {node_run_id}")
            }
            Self::Sequence { expected, actual } => {
                write!(
                    f,
                    "projection expected run sequence {expected}, got {actual}"
                )
            }
        }
    }
}

impl std::error::Error for ProjectionError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::domain::run::{BudgetState, RunStatus};

    #[test]
    fn rebuild_projection_from_events() {
        let run_id = "run_1";
        let events = vec![
            build_event(
                "evt_1",
                run_id,
                1,
                TaskEventType::RunStarted,
                "system",
                1000,
                serde_json::to_value(&payloads::RunStartedPayload {
                    run_id: run_id.into(),
                    graph_id: "graph_1".into(),
                    revision_id: "rev_1".into(),
                    initial_status: RunStatus::Running,
                    budget_state: BudgetState::default(),
                })
                .unwrap(),
            ),
            build_event(
                "evt_2",
                run_id,
                2,
                TaskEventType::NodeReady,
                "scheduler",
                1100,
                serde_json::to_value(&payloads::NodeReadyPayload {
                    node_run_id: "nr_1".into(),
                    node_id: "node_a".into(),
                })
                .unwrap(),
            ),
            build_event(
                "evt_3",
                run_id,
                3,
                TaskEventType::RunCompleted,
                "system",
                2000,
                serde_json::to_value(&payloads::RunCompletedPayload {
                    run_id: run_id.into(),
                    final_status: RunStatus::Completed,
                    total_usage: Default::default(),
                })
                .unwrap(),
            ),
        ];

        let proj = rebuild_projection(run_id, &events).unwrap();
        assert_eq!(proj.graph_id, "graph_1");
        assert_eq!(proj.revision_id, "rev_1");
        assert_eq!(proj.status, RunStatus::Completed);
        assert_eq!(proj.run_seq, 3);
        assert_eq!(proj.node_runs.len(), 1);
        assert_eq!(
            proj.node_runs["nr_1"].status,
            crate::orchestrator::domain::run::NodeRunStatus::Ready
        );
    }

    #[test]
    fn event_batch_collects() {
        let mut batch = EventBatch::new("run_1");
        batch.add(build_event(
            "e1",
            "run_1",
            1,
            TaskEventType::RunStarted,
            "system",
            1000,
            serde_json::Value::Null,
        ));
        batch.add(build_event(
            "e2",
            "run_1",
            2,
            TaskEventType::NodeReady,
            "scheduler",
            1100,
            serde_json::Value::Null,
        ));
        assert_eq!(batch.events.len(), 2);
    }

    #[test]
    fn projection_idempotent_on_replay() {
        let run_id = "run_1";
        let events = vec![build_event(
            "evt_1",
            run_id,
            1,
            TaskEventType::RunStarted,
            "system",
            1000,
            serde_json::to_value(&payloads::RunStartedPayload {
                run_id: run_id.into(),
                graph_id: "graph_1".into(),
                revision_id: "rev_1".into(),
                initial_status: RunStatus::Running,
                budget_state: BudgetState::default(),
            })
            .unwrap(),
        )];

        let proj1 = rebuild_projection(run_id, &events).unwrap();
        let proj2 = rebuild_projection(run_id, &events).unwrap();
        assert_eq!(proj1.status, proj2.status);
        assert_eq!(proj1.run_seq, proj2.run_seq);
    }

    #[test]
    fn projection_rejects_sequence_gaps() {
        let event = build_event(
            "evt_2",
            "run_1",
            2,
            TaskEventType::RunPaused,
            "user",
            1000,
            serde_json::Value::Null,
        );
        assert!(matches!(
            rebuild_projection("run_1", &[event]),
            Err(ProjectionError::Sequence {
                expected: 1,
                actual: 2
            })
        ));
    }

    #[test]
    fn attempt_usage_updates_node_and_run_budget_projection() {
        let events = vec![
            build_event(
                "e1",
                "run1",
                1,
                TaskEventType::RunStarted,
                "test",
                1,
                serde_json::to_value(payloads::RunStartedPayload {
                    run_id: "run1".into(),
                    graph_id: "graph1".into(),
                    revision_id: "rev1".into(),
                    initial_status: RunStatus::Running,
                    budget_state: BudgetState {
                        token_limit: Some(100),
                        cost_limit_usd: Some(1.0),
                        ..Default::default()
                    },
                })
                .unwrap(),
            ),
            build_event(
                "e2",
                "run1",
                2,
                TaskEventType::NodeReady,
                "test",
                2,
                serde_json::to_value(payloads::NodeReadyPayload {
                    node_run_id: "nr1".into(),
                    node_id: "node1".into(),
                })
                .unwrap(),
            ),
            build_event(
                "e3",
                "run1",
                3,
                TaskEventType::AttemptProgressed,
                "agent",
                3,
                serde_json::to_value(payloads::AttemptProgressedPayload {
                    attempt_id: "attempt1".into(),
                    node_run_id: "nr1".into(),
                    message: String::new(),
                    usage_delta: crate::orchestrator::domain::run::AttemptUsage {
                        input_tokens: 10,
                        output_tokens: 20,
                        cost_usd: 0.25,
                    },
                })
                .unwrap(),
            ),
        ];

        let projection = rebuild_projection("run1", &events).unwrap();
        assert_eq!(projection.budget_state.token_used, 30);
        assert_eq!(projection.budget_state.cost_used_usd, 0.25);
        assert_eq!(projection.node_runs["nr1"].usage.output_tokens, 20);
    }
}
