use std::path::PathBuf;
use std::sync::Arc;

use crate::orchestrator::commands::{
    apply_commands, graph_create, graph_validate, CreateGraphInput, GraphCommand, RevisionResult,
};
use crate::orchestrator::conversation::{
    build_task_conversation_summary, original_goal_entry, project_public_entries,
    TaskConversationDetail, TaskConversationSummary, TaskInteractionRequest,
    TaskInteractionSubmission,
};
use crate::orchestrator::domain::graph::TaskGraph;
use crate::orchestrator::domain::revision::GraphRevision;
use crate::orchestrator::domain::run::{
    ApprovalRequest, ArtifactRef, BudgetState, GraphRun, NodeRun, NodeRunStatus,
    RunPlanningSnapshot, RunRevisionProposal, RunStatus, TaskError, TaskErrorCategory,
};
use crate::orchestrator::domain::state_machine::ValidationError;
use crate::orchestrator::events::{build_event, payloads, TaskEvent, TaskEventType};
use crate::orchestrator::runtime_bridge::{DefaultTaskAgentRuntime, TaskAgentRuntime};
use crate::orchestrator::store::{default_db_path, StoreError, TaskStore};
use crate::util::{gen_id, now_ms};

/// Application-level service that coordinates domain, commands, events and store.
pub struct TaskService {
    store: Arc<TaskStore>,
    planner: Option<crate::orchestrator::planner::PlannerService>,
    _engine: Option<crate::orchestrator::daemon::engine::EngineHandle>,
}

/// Error from the task service.
#[derive(Debug)]
pub enum TaskServiceError {
    Store(StoreError),
    Validation(ValidationError),
    InvalidInput(String),
    NotFound(String),
    Conflict {
        message: String,
        current_revision: Option<String>,
        current_run_seq: Option<u64>,
    },
    Internal(String),
}

impl std::fmt::Display for TaskServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Validation(e) => write!(f, "validation error: {e}"),
            Self::InvalidInput(msg) => write!(f, "invalid input: {msg}"),
            Self::NotFound(msg) => write!(f, "not found: {msg}"),
            Self::Conflict { message, .. } => write!(f, "conflict: {message}"),
            Self::Internal(msg) => write!(f, "internal error: {msg}"),
        }
    }
}

impl std::error::Error for TaskServiceError {}

impl From<StoreError> for TaskServiceError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<ValidationError> for TaskServiceError {
    fn from(e: ValidationError) -> Self {
        Self::Validation(e)
    }
}

impl From<serde_json::Error> for TaskServiceError {
    fn from(e: serde_json::Error) -> Self {
        Self::Internal(format!("serde: {e}"))
    }
}

impl From<TaskServiceError> for TaskError {
    fn from(error: TaskServiceError) -> Self {
        let (code, category, retryable, remediation, current_revision, current_run_seq) =
            match &error {
                TaskServiceError::Conflict {
                    current_revision: rev,
                    current_run_seq: seq,
                    ..
                } => (
                    "TASK_CONFLICT",
                    TaskErrorCategory::Conflict,
                    true,
                    Some("Reload the latest revision or run projection and retry.".into()),
                    rev.clone(),
                    *seq,
                ),
                TaskServiceError::Store(StoreError::Conflict(_)) => (
                    "TASK_CONFLICT",
                    TaskErrorCategory::Conflict,
                    true,
                    Some("Reload the latest revision or run projection and retry.".into()),
                    None,
                    None,
                ),
                TaskServiceError::Store(_) => (
                    "TASK_STORE_ERROR",
                    TaskErrorCategory::Store,
                    true,
                    Some(
                        "Retry the operation. If it persists, inspect the local task store.".into(),
                    ),
                    None,
                    None,
                ),
                TaskServiceError::Validation(_) => (
                    "TASK_VALIDATION_ERROR",
                    TaskErrorCategory::Domain,
                    false,
                    Some("Correct the graph command or node configuration.".into()),
                    None,
                    None,
                ),
                TaskServiceError::InvalidInput(_) => (
                    "TASK_INVALID_INPUT",
                    TaskErrorCategory::Domain,
                    false,
                    Some("Correct the request values and retry.".into()),
                    None,
                    None,
                ),
                TaskServiceError::NotFound(_) => (
                    "TASK_NOT_FOUND",
                    TaskErrorCategory::Domain,
                    false,
                    Some("Reload the project task graph.".into()),
                    None,
                    None,
                ),
                TaskServiceError::Internal(_) => (
                    "TASK_INTERNAL_ERROR",
                    TaskErrorCategory::Internal,
                    false,
                    Some("Inspect application logs and the task event stream.".into()),
                    None,
                    None,
                ),
            };
        Self {
            code: code.into(),
            category,
            message_key: error.to_string(),
            field_path: None,
            retryable,
            retry_after_ms: None,
            current_revision,
            current_run_seq,
            remediation,
            provider_detail: None,
        }
    }
}

// TaskService 按用例拆分（v0.7.3 需求1-M2）：多 impl 块扩展同一类型，mod.rs 保留
// 结构体、错误类型、构造器与跨用例共享助手。
mod commands;
mod graph;
mod projection;
mod recovery;
mod run;

impl TaskService {
    pub fn open_default(
        registry: Arc<crate::agent::AgentRegistry>,
    ) -> Result<Self, TaskServiceError> {
        Self::open_default_inner(registry, None, None)
    }

    /// Same as [`Self::open_default`], but mirrors node-agent events to the GUI
    /// via `event_sink` so task node sessions stream through the regular chat
    /// `agent-event` pipeline, and registers resolved node-session ACP controls
    /// into the GUI chat state via `acp_register` (so the agent's mid-turn
    /// interaction/steer during the execution phase resolves correctly).
    /// Design §3.1/D4 still holds — both are injected closures, not a
    /// `tauri::AppHandle`.
    pub fn open_default_with_event_sink(
        registry: Arc<crate::agent::AgentRegistry>,
        event_sink: crate::orchestrator::runtime_bridge::NodeEventSink,
        acp_register: crate::orchestrator::runtime_bridge::NodeAcpRegister,
    ) -> Result<Self, TaskServiceError> {
        Self::open_default_inner(registry, Some(event_sink), Some(acp_register))
    }

    fn open_default_inner(
        registry: Arc<crate::agent::AgentRegistry>,
        event_sink: Option<crate::orchestrator::runtime_bridge::NodeEventSink>,
        acp_register: Option<crate::orchestrator::runtime_bridge::NodeAcpRegister>,
    ) -> Result<Self, TaskServiceError> {
        let db_path = default_db_path();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                TaskServiceError::Internal(format!("failed to create db directory: {e}"))
            })?;
        }
        // v0.7.2 需求 1 / M1.1+M1.2：文件 DB 打开失败（损坏/权限/迁移失败）时回退到
        // 内存数据库，保证应用仍可启动。崩溃 1 根因：此前这里的 `?` 失败会让 setup
        // 返回 Err → 末尾 .expect() panic 闪退。降级态下任务数据不持久化（重启丢失），
        // 但会话/项目扫描等主功能不受影响；日志会记录降级原因。
        let store = match TaskStore::open(&db_path) {
            Ok(s) => s,
            Err(e) => {
                log::error!(
                    "TaskStore 在 {} 打开失败 ({})；回退到内存数据库降级模式，任务数据本次不会持久化。",
                    db_path.display(),
                    e
                );
                TaskStore::open_in_memory()?
            }
        };
        let store_arc = Arc::new(store);
        let runtime = Arc::new({
            let mut rt = match event_sink {
                Some(sink) => DefaultTaskAgentRuntime::with_event_sink(registry.clone(), sink),
                None => DefaultTaskAgentRuntime::new(registry.clone()),
            };
            if let Some(register) = acp_register {
                rt = rt.with_acp_register(register);
            }
            rt
        });
        let planner = Some(crate::orchestrator::planner::PlannerService::new(
            store_arc.clone(),
            runtime.clone(),
            registry.clone(),
        ));
        let engine = Some(
            crate::orchestrator::daemon::engine::ExecutionEngine::new(store_arc.clone(), runtime)
                .start(),
        );
        Ok(Self {
            store: store_arc,
            planner,
            _engine: engine,
        })
    }

    /// Open with a custom database path (for testing).
    pub fn open(
        db_path: &std::path::Path,
        registry: Arc<crate::agent::AgentRegistry>,
    ) -> Result<Self, TaskServiceError> {
        let store = TaskStore::open(db_path)?;
        let store_arc = Arc::new(store);
        let runtime = Arc::new(DefaultTaskAgentRuntime::new(registry.clone()));
        let planner = Some(crate::orchestrator::planner::PlannerService::new(
            store_arc.clone(),
            runtime.clone(),
            registry,
        ));
        let engine = Some(
            crate::orchestrator::daemon::engine::ExecutionEngine::new(store_arc.clone(), runtime)
                .start(),
        );
        Ok(Self {
            store: store_arc,
            planner,
            _engine: engine,
        })
    }

    /// Open an in-memory store (for testing).
    pub fn open_in_memory() -> Result<Self, TaskServiceError> {
        let store = TaskStore::open_in_memory()?;
        let store_arc = Arc::new(store);
        Ok(Self {
            store: store_arc,
            planner: None,
            _engine: None,
        })
    }

    #[cfg(test)]
    pub fn open_in_memory_with_runtime(
        runtime: Arc<dyn TaskAgentRuntime>,
    ) -> Result<Self, TaskServiceError> {
        let store = TaskStore::open_in_memory()?;
        let store_arc = Arc::new(store);
        let engine = Some(
            crate::orchestrator::daemon::engine::ExecutionEngine::new(store_arc.clone(), runtime)
                .start(),
        );
        Ok(Self {
            store: store_arc,
            planner: None,
            _engine: engine,
        })
    }

    pub fn planner_service(
        &self,
    ) -> Result<crate::orchestrator::planner::PlannerService, TaskServiceError> {
        self.planner
            .clone()
            .ok_or_else(|| TaskServiceError::Internal("planner service is not configured".into()))
    }
}

fn latest_node_runs_by_id(node_runs: &[NodeRun]) -> std::collections::HashMap<String, &NodeRun> {
    let mut latest = std::collections::HashMap::new();
    for node_run in node_runs {
        let replace = latest
            .get(&node_run.node_id)
            .map(|current: &&NodeRun| {
                (
                    node_run.loop_iteration.unwrap_or_default(),
                    node_run.attempt_count,
                    node_run.started_at.unwrap_or_default(),
                ) > (
                    current.loop_iteration.unwrap_or_default(),
                    current.attempt_count,
                    current.started_at.unwrap_or_default(),
                )
            })
            .unwrap_or(true);
        if replace {
            latest.insert(node_run.node_id.clone(), node_run);
        }
    }
    latest
}

/// Collect node_ids frozen (Leased/Running/AwaitingApproval/Succeeded/Failed/Repairing) across
/// all non-terminal runs of a graph. Mirrors the per-run computation in `propose_run_revision`
/// but spans every run — `apply_commands` is graph-scoped, not bound to a single run.
fn frozen_node_ids_for_runs(
    store: &TaskStore,
    runs: &[GraphRun],
) -> Result<Vec<String>, TaskServiceError> {
    let mut ids = Vec::new();
    for run in runs {
        if run.status.is_terminal() {
            continue;
        }
        let node_runs = store.get_node_runs(&run.run_id)?;
        for node_run in latest_node_runs_by_id(&node_runs).values() {
            if node_run.status.is_frozen() {
                ids.push(node_run.node_id.clone());
            }
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Node_ids a command mutates, for A8 freeze checking. Edges count only their target — an edge
/// change alters the target's incoming dependencies, while a frozen node may gain outgoing edges
/// without affecting its own execution (consistent with `incoming_edge_signature` in
/// `propose_run_revision`, which guards only incoming edges of frozen nodes). AddNode/SetGoal
/// introduce new nodes and touch no existing frozen node.
fn command_target_node_ids<'a>(
    command: &'a GraphCommand,
    base_snapshot: &'a crate::orchestrator::domain::graph::GraphSnapshot,
) -> Vec<&'a str> {
    match command {
        GraphCommand::RemoveNode { node_id, .. }
        | GraphCommand::ReparentNode { node_id, .. }
        | GraphCommand::ReorderNode { node_id, .. }
        | GraphCommand::UpdateNode { node_id, .. }
        | GraphCommand::UpdatePolicy { node_id, .. } => vec![node_id.as_str()],
        GraphCommand::UngroupNodes { group_node_id, .. } => vec![group_node_id.as_str()],
        GraphCommand::AddEdge { edge, .. } => vec![edge.target_node_id.as_str()],
        GraphCommand::RemoveEdge { edge_id, .. } => base_snapshot
            .edges
            .iter()
            .find(|edge| edge.edge_id == *edge_id)
            .map(|edge| vec![edge.target_node_id.as_str()])
            .unwrap_or_default(),
        GraphCommand::GroupNodes { node_ids, .. } => node_ids.iter().map(String::as_str).collect(),
        GraphCommand::AddNode { .. } | GraphCommand::SetGoal { .. } => Vec::new(),
    }
}

fn incoming_edge_signature(
    snapshot: &crate::orchestrator::domain::graph::GraphSnapshot,
    node_id: &str,
) -> std::collections::BTreeSet<(String, String, String)> {
    snapshot
        .edges
        .iter()
        .filter(|edge| edge.target_node_id == node_id)
        .map(|edge| {
            (
                edge.source_node_id.clone(),
                edge.target_node_id.clone(),
                format!("{:?}", edge.kind),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests;
