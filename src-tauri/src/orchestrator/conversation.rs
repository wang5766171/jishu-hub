use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::agent::normalized::InteractionOption;
use crate::orchestrator::domain::graph::{GraphSnapshot, NodeKind, TaskGraph};
use crate::orchestrator::domain::run::{GraphRun, NodeRun, NodeRunStatus, RunStatus};
use crate::orchestrator::events::{TaskEvent, TaskEventType};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskConversationPhase {
    Created,
    Planning,
    ProposalReview,
    Executing,
    Verifying,
    Reworking,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskConversationEntryKind {
    UserMessage,
    AssistantMessage,
    PhaseChanged,
    PlanningProgress,
    InteractionRequested,
    InteractionResolved,
    NodeProgress,
    NodeCompleted,
    ApprovalRequested,
    ApprovalResolved,
    ArtifactPublished,
    RevisionChanged,
    Warning,
    Error,
    Completion,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskConversationEntry {
    pub entry_id: String,
    pub graph_id: String,
    pub run_id: String,
    pub sequence: u64,
    pub occurred_at: i64,
    pub phase: TaskConversationPhase,
    pub node_id: Option<String>,
    pub node_run_id: Option<String>,
    pub actor: String,
    pub kind: TaskConversationEntryKind,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskConversationSummary {
    pub graph_id: String,
    pub title: String,
    pub original_goal: String,
    pub project_root: String,
    pub owner_agent_id: String,
    pub run_id: Option<String>,
    pub phase: TaskConversationPhase,
    pub current_node_id: Option<String>,
    pub current_node_title: Option<String>,
    pub completed_nodes: usize,
    pub total_nodes: usize,
    pub active_revision_id: Option<String>,
    pub run_status: Option<RunStatus>,
    pub pending_interaction_count: usize,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskConversationDetail {
    pub summary: TaskConversationSummary,
    pub entries: Vec<TaskConversationEntry>,
    pub pending_interactions: Vec<TaskInteractionRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskInteractionSubmission {
    pub selected_option_ids: Vec<String>,
    pub custom_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskInteractionRequest {
    pub request_id: String,
    pub graph_id: String,
    pub run_id: Option<String>,
    pub node_id: Option<String>,
    pub node_run_id: Option<String>,
    pub session_id: Option<String>,
    pub prompt: String,
    pub options: Vec<InteractionOption>,
    pub allow_multiple: bool,
    pub allow_custom_text: bool,
    pub required: bool,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub consumed_at: Option<i64>,
    pub submission: Option<TaskInteractionSubmission>,
}

impl TaskInteractionRequest {
    pub fn is_pending(&self) -> bool {
        self.resolved_at.is_none()
    }
}

pub fn original_goal_entry(graph: &TaskGraph) -> TaskConversationEntry {
    TaskConversationEntry {
        entry_id: format!("goal-{}", graph.graph_id),
        graph_id: graph.graph_id.clone(),
        run_id: String::new(),
        sequence: 0,
        occurred_at: graph.created_at,
        phase: TaskConversationPhase::Created,
        node_id: None,
        node_run_id: None,
        actor: "user".into(),
        kind: TaskConversationEntryKind::UserMessage,
        payload: serde_json::json!({ "text": graph.goal }),
    }
}

pub fn build_task_conversation_summary(
    graph: &TaskGraph,
    run: Option<&GraphRun>,
    node_runs: &[NodeRun],
    snapshot: Option<&GraphSnapshot>,
    pending_interaction_count: usize,
) -> TaskConversationSummary {
    let phase = run
        .map(|value| phase_for_run_status(&value.status))
        .unwrap_or(TaskConversationPhase::Created);
    let current_node = node_runs
        .iter()
        .filter(|node_run| node_run.status.is_active())
        .min_by_key(|node_run| {
            (
                active_node_priority(&node_run.status),
                node_run.started_at.unwrap_or(i64::MAX),
                node_run.node_id.as_str(),
            )
        });
    let current_node_id = current_node.map(|node_run| node_run.node_id.clone());
    let current_node_title = current_node_id.as_ref().and_then(|node_id| {
        snapshot
            .and_then(|value| value.node_by_id(node_id))
            .map(|node| node.title.clone())
    });
    let completed_node_ids = node_runs
        .iter()
        .filter(|node_run| {
            matches!(
                node_run.status,
                NodeRunStatus::Succeeded | NodeRunStatus::Skipped
            )
        })
        .map(|node_run| node_run.node_id.as_str())
        .collect::<HashSet<_>>();
    let total_nodes = snapshot
        .map(|value| {
            value
                .nodes
                .iter()
                .filter(|node| !matches!(node.node_kind, NodeKind::Goal | NodeKind::Group))
                .count()
        })
        .unwrap_or_default();
    let updated_at = run
        .map(|value| value.finished_at.unwrap_or(value.started_at))
        .unwrap_or(graph.updated_at)
        .max(graph.updated_at);

    TaskConversationSummary {
        graph_id: graph.graph_id.clone(),
        title: graph.title.clone(),
        original_goal: graph.goal.clone(),
        project_root: graph.project_root.to_string_lossy().to_string(),
        owner_agent_id: "jishu-self".into(),
        run_id: run.map(|value| value.run_id.clone()),
        phase,
        current_node_id,
        current_node_title,
        completed_nodes: completed_node_ids.len(),
        total_nodes,
        active_revision_id: run
            .map(|value| value.active_revision_id.clone())
            .or_else(|| graph.current_draft_revision.clone()),
        run_status: run.map(|value| value.status.clone()),
        pending_interaction_count,
        updated_at,
    }
}

fn phase_for_run_status(status: &RunStatus) -> TaskConversationPhase {
    match status {
        RunStatus::Draft | RunStatus::Validating => TaskConversationPhase::Planning,
        RunStatus::Ready => TaskConversationPhase::ProposalReview,
        RunStatus::Running | RunStatus::Paused => TaskConversationPhase::Executing,
        RunStatus::AwaitingHuman => TaskConversationPhase::Verifying,
        RunStatus::Completed => TaskConversationPhase::Completed,
        RunStatus::Failed => TaskConversationPhase::Failed,
        RunStatus::Cancelled => TaskConversationPhase::Cancelled,
    }
}

fn active_node_priority(status: &NodeRunStatus) -> u8 {
    match status {
        NodeRunStatus::Running => 0,
        NodeRunStatus::AwaitingApproval => 1,
        NodeRunStatus::Repairing => 2,
        NodeRunStatus::Leased => 3,
        NodeRunStatus::Ready => 4,
        NodeRunStatus::RetryWait => 5,
        NodeRunStatus::Blocked => 6,
        NodeRunStatus::Succeeded
        | NodeRunStatus::Failed
        | NodeRunStatus::Skipped
        | NodeRunStatus::Cancelled
        | NodeRunStatus::Superseded => 7,
    }
}

pub fn project_public_entries(graph_id: &str, events: &[TaskEvent]) -> Vec<TaskConversationEntry> {
    let mut phase = TaskConversationPhase::Created;
    let mut entries = Vec::new();

    for event in events {
        let projection = match event.event_type {
            TaskEventType::RunStarted => {
                phase = TaskConversationPhase::Executing;
                Some((
                    TaskConversationEntryKind::PhaseChanged,
                    None,
                    None,
                    select_fields(&event.payload, &["revision_id"]),
                ))
            }
            TaskEventType::NodeReady | TaskEventType::AttemptStarted => Some((
                TaskConversationEntryKind::NodeProgress,
                string_field(&event.payload, "node_id"),
                string_field(&event.payload, "node_run_id"),
                select_fields(
                    &event.payload,
                    &["node_id", "node_run_id", "attempt_id", "attempt_number"],
                ),
            )),
            TaskEventType::ApprovalRequested => Some((
                TaskConversationEntryKind::ApprovalRequested,
                None,
                string_field(&event.payload, "node_run_id"),
                select_fields(
                    &event.payload,
                    &[
                        "approval_id",
                        "node_run_id",
                        "description",
                        "risk_level",
                        "scope",
                    ],
                ),
            )),
            TaskEventType::ApprovalResolved => Some((
                TaskConversationEntryKind::ApprovalResolved,
                None,
                string_field(&event.payload, "node_run_id"),
                select_fields(
                    &event.payload,
                    &["approval_id", "node_run_id", "approved", "resolver"],
                ),
            )),
            TaskEventType::ArtifactProduced => Some((
                TaskConversationEntryKind::ArtifactPublished,
                None,
                None,
                select_fields(
                    &event.payload,
                    &["artifact_id", "name", "artifact_type", "hash"],
                ),
            )),
            TaskEventType::RevisionCreated | TaskEventType::RevisionAppliedToRun => Some((
                TaskConversationEntryKind::RevisionChanged,
                None,
                None,
                select_fields(
                    &event.payload,
                    &["revision_id", "candidate_revision_id", "source"],
                ),
            )),
            TaskEventType::NodeResolved => Some((
                TaskConversationEntryKind::NodeCompleted,
                string_field(&event.payload, "node_id"),
                string_field(&event.payload, "node_run_id"),
                select_fields(&event.payload, &["node_id", "node_run_id", "final_status"]),
            )),
            TaskEventType::AttemptFailed => Some((
                TaskConversationEntryKind::Error,
                None,
                string_field(&event.payload, "node_run_id"),
                sanitized_attempt_error(&event.payload),
            )),
            TaskEventType::RetryScheduled => Some((
                TaskConversationEntryKind::Warning,
                None,
                string_field(&event.payload, "node_run_id"),
                select_fields(
                    &event.payload,
                    &[
                        "node_run_id",
                        "next_attempt_number",
                        "wake_at",
                        "backoff_ms",
                    ],
                ),
            )),
            TaskEventType::RecoveryChosen => Some((
                TaskConversationEntryKind::Warning,
                None,
                string_field(&event.payload, "node_run_id"),
                select_fields(&event.payload, &["node_run_id", "strategy"]),
            )),
            TaskEventType::RunCompleted => {
                phase = TaskConversationPhase::Completed;
                Some((
                    TaskConversationEntryKind::Completion,
                    None,
                    None,
                    select_fields(&event.payload, &["final_status"]),
                ))
            }
            TaskEventType::RunFailed | TaskEventType::BudgetExceeded => {
                phase = TaskConversationPhase::Failed;
                Some((
                    TaskConversationEntryKind::Error,
                    None,
                    None,
                    serde_json::json!({ "status": "failed" }),
                ))
            }
            TaskEventType::RunCancelled => {
                phase = TaskConversationPhase::Cancelled;
                Some((
                    TaskConversationEntryKind::Completion,
                    None,
                    None,
                    serde_json::json!({ "status": "cancelled" }),
                ))
            }
            TaskEventType::RunPaused => Some((
                TaskConversationEntryKind::PhaseChanged,
                None,
                None,
                serde_json::json!({ "status": "paused" }),
            )),
            TaskEventType::RunResumed => Some((
                TaskConversationEntryKind::PhaseChanged,
                None,
                None,
                serde_json::json!({ "status": "running" }),
            )),
            TaskEventType::NodeBlocked
            | TaskEventType::NodeSkipped
            | TaskEventType::NodeCancelled
            | TaskEventType::NodeSuperseded => Some((
                TaskConversationEntryKind::NodeProgress,
                string_field(&event.payload, "node_id"),
                string_field(&event.payload, "node_run_id"),
                select_fields(
                    &event.payload,
                    &["node_id", "node_run_id", "new_status", "final_status"],
                ),
            )),
            TaskEventType::AttemptProgressed
                if event
                    .payload
                    .get("public")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                    && event
                        .payload
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|message| !message.trim().is_empty()) =>
            {
                let kind = if event.actor == "user" {
                    TaskConversationEntryKind::UserMessage
                } else {
                    TaskConversationEntryKind::AssistantMessage
                };
                Some((
                    kind,
                    string_field(&event.payload, "node_id"),
                    string_field(&event.payload, "node_run_id"),
                    serde_json::json!({
                        "text": event.payload.get("message").cloned().unwrap_or_default()
                    }),
                ))
            }
            TaskEventType::AttemptProgressed => None,
            TaskEventType::LeaseGranted
            | TaskEventType::LeaseExpired
            | TaskEventType::RepairGraphAttached
            | TaskEventType::LoopStarted
            | TaskEventType::IterationStarted
            | TaskEventType::ProgressEvaluated
            | TaskEventType::LoopSleeping
            | TaskEventType::LoopCompleted => None,
        };

        if let Some((kind, node_id, node_run_id, payload)) = projection {
            entries.push(TaskConversationEntry {
                entry_id: event.event_id.clone(),
                graph_id: graph_id.to_string(),
                run_id: event.run_id.clone(),
                sequence: event.run_seq,
                occurred_at: event.occurred_at,
                phase: phase.clone(),
                node_id,
                node_run_id,
                actor: event.actor.clone(),
                kind,
                payload,
            });
        }
    }

    entries
}

fn string_field(payload: &serde_json::Value, field: &str) -> Option<String> {
    payload
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn select_fields(payload: &serde_json::Value, fields: &[&str]) -> serde_json::Value {
    let mut selected = serde_json::Map::new();
    for field in fields {
        if let Some(value) = payload.get(*field) {
            selected.insert((*field).to_string(), value.clone());
        }
    }
    serde_json::Value::Object(selected)
}

fn sanitized_attempt_error(payload: &serde_json::Value) -> serde_json::Value {
    let mut selected = serde_json::Map::new();
    if let Some(value) = payload.get("attempt_id") {
        selected.insert("attempt_id".into(), value.clone());
    }
    if let Some(value) = payload.get("node_run_id") {
        selected.insert("node_run_id".into(), value.clone());
    }
    if let Some(error) = payload.get("error") {
        if let Some(value) = error.get("category") {
            selected.insert("category".into(), value.clone());
        }
        if let Some(value) = error.get("retryable") {
            selected.insert("retryable".into(), value.clone());
        }
    }
    serde_json::Value::Object(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::domain::graph::{GraphNode, GraphSnapshot, NodeKind, TaskGraph};
    use crate::orchestrator::domain::run::{
        BudgetState, GraphRun, NodeRun, NodeRunStatus, RunPlanningSnapshot, RunStatus,
    };
    use crate::orchestrator::events::{TaskEvent, TaskEventType, EVENT_SCHEMA_VERSION};
    use std::path::PathBuf;

    fn event(run_seq: u64, event_type: TaskEventType, payload: serde_json::Value) -> TaskEvent {
        TaskEvent {
            event_id: format!("event-{run_seq}"),
            run_id: "run-1".into(),
            run_seq,
            event_type,
            schema_version: EVENT_SCHEMA_VERSION.into(),
            occurred_at: run_seq as i64,
            actor: "orchestrator".into(),
            causation_id: None,
            correlation_id: None,
            payload,
        }
    }

    #[test]
    fn public_projection_excludes_raw_progress_and_internal_contracts() {
        let events = vec![
            event(
                1,
                TaskEventType::RunStarted,
                serde_json::json!({
                    "run_id": "run-1",
                    "graph_id": "graph-1",
                    "revision_id": "revision-1"
                }),
            ),
            event(
                2,
                TaskEventType::AttemptProgressed,
                serde_json::json!({
                    "attempt_id": "attempt-1",
                    "node_run_id": "node-run-1",
                    "message": "INTERNAL CONTRACT write_files: false; return checkpoint JSON"
                }),
            ),
            event(
                3,
                TaskEventType::ApprovalRequested,
                serde_json::json!({
                    "approval_id": "approval-1",
                    "node_run_id": "node-run-1",
                    "description": "允许执行数据库迁移",
                    "risk_level": "high",
                    "scope": ["database"]
                }),
            ),
            event(
                4,
                TaskEventType::NodeResolved,
                serde_json::json!({
                    "node_run_id": "node-run-1",
                    "node_id": "schema-design",
                    "final_status": "succeeded"
                }),
            ),
            event(
                5,
                TaskEventType::RunCompleted,
                serde_json::json!({
                    "run_id": "run-1",
                    "final_status": "completed"
                }),
            ),
        ];

        let entries = project_public_entries("graph-1", &events);
        let serialized = serde_json::to_string(&entries).unwrap();

        assert_eq!(entries.len(), 4);
        assert!(entries
            .iter()
            .any(|entry| entry.kind == TaskConversationEntryKind::ApprovalRequested));
        assert!(entries
            .iter()
            .any(|entry| entry.kind == TaskConversationEntryKind::NodeCompleted));
        assert_eq!(
            entries.last().map(|entry| &entry.phase),
            Some(&TaskConversationPhase::Completed)
        );
        assert!(!serialized.contains("write_files"));
        assert!(!serialized.contains("checkpoint JSON"));
        assert!(!serialized.contains("AttemptProgressed"));
    }

    #[test]
    fn public_projection_includes_only_explicit_public_agent_progress() {
        let mut public_progress = event(
            1,
            TaskEventType::AttemptProgressed,
            serde_json::json!({
                "attempt_id": "attempt-1",
                "node_run_id": "node-run-1",
                "message": "已完成权限模型设计",
                "public": true
            }),
        );
        public_progress.actor = "codex".into();
        let mut private_progress = event(
            2,
            TaskEventType::AttemptProgressed,
            serde_json::json!({
                "attempt_id": "attempt-1",
                "node_run_id": "node-run-1",
                "message": "thinking: internal execution contract",
                "public": false
            }),
        );
        private_progress.actor = "codex".into();

        let entries = project_public_entries("graph-1", &[public_progress, private_progress]);
        let serialized = serde_json::to_string(&entries).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, TaskConversationEntryKind::AssistantMessage);
        assert_eq!(entries[0].node_run_id.as_deref(), Some("node-run-1"));
        assert!(serialized.contains("已完成权限模型设计"));
        assert!(!serialized.contains("thinking"));
        assert!(!serialized.contains("execution contract"));
    }

    #[test]
    fn phase_projection_tracks_execution_failure_without_raw_error_text() {
        let entries = project_public_entries(
            "graph-1",
            &[
                event(
                    1,
                    TaskEventType::RunStarted,
                    serde_json::json!({ "revision_id": "revision-1" }),
                ),
                event(
                    2,
                    TaskEventType::AttemptFailed,
                    serde_json::json!({
                        "attempt_id": "attempt-1",
                        "node_run_id": "node-run-1",
                        "error": {
                            "category": "deterministic",
                            "message": "secret system prompt and provider payload",
                            "retryable": false
                        }
                    }),
                ),
                event(
                    3,
                    TaskEventType::RunFailed,
                    serde_json::json!({
                        "reason": "secret system prompt and provider payload"
                    }),
                ),
            ],
        );
        let serialized = serde_json::to_string(&entries).unwrap();

        assert_eq!(
            entries.last().map(|entry| &entry.phase),
            Some(&TaskConversationPhase::Failed)
        );
        assert!(!serialized.contains("secret system prompt"));
        assert!(!serialized.contains("provider payload"));
    }

    #[test]
    fn summary_uses_project_owned_run_and_current_node_context() {
        let graph = TaskGraph {
            graph_id: "graph-1".into(),
            title: "权限管理系统".into(),
            goal: "设计前后端分类的权限管理系统".into(),
            project_root: PathBuf::from("D:/project"),
            owner: "user".into(),
            current_draft_revision: Some("revision-1".into()),
            created_at: 10,
            updated_at: 20,
        };
        let run = GraphRun {
            run_id: "run-1".into(),
            graph_id: graph.graph_id.clone(),
            active_revision_id: "revision-1".into(),
            status: RunStatus::Running,
            run_seq: 4,
            budget_state: BudgetState::default(),
            planning_snapshot: RunPlanningSnapshot::default(),
            started_at: 30,
            finished_at: None,
        };
        let snapshot = GraphSnapshot {
            nodes: vec![
                node("goal", "权限系统目标", NodeKind::Goal),
                node("model", "权限模型设计", NodeKind::Executable),
                node("api", "后端接口实现", NodeKind::Executable),
            ],
            edges: vec![],
        };
        let mut completed = NodeRun::new("nr-model", "run-1", "model", "revision-1");
        completed.status = NodeRunStatus::Succeeded;
        let mut running = NodeRun::new("nr-api", "run-1", "api", "revision-1");
        running.status = NodeRunStatus::Running;

        let summary = build_task_conversation_summary(
            &graph,
            Some(&run),
            &[completed, running],
            Some(&snapshot),
            0,
        );

        assert_eq!(summary.phase, TaskConversationPhase::Executing);
        assert_eq!(summary.current_node_id.as_deref(), Some("api"));
        assert_eq!(summary.current_node_title.as_deref(), Some("后端接口实现"));
        assert_eq!(summary.completed_nodes, 1);
        assert_eq!(summary.total_nodes, 2);
        assert_eq!(summary.owner_agent_id, "jishu-self");
    }

    fn node(node_id: &str, title: &str, node_kind: NodeKind) -> GraphNode {
        GraphNode {
            node_id: node_id.into(),
            parent_id: None,
            title: title.into(),
            description: None,
            node_kind,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: Default::default(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }
    }
}
