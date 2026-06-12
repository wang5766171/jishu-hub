use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::orchestrator::commands::{
    apply_commands, graph_create, graph_validate, CreateGraphInput, GraphCommand, RevisionResult,
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
    Conflict(String),
    Internal(String),
}

impl std::fmt::Display for TaskServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Validation(e) => write!(f, "validation error: {e}"),
            Self::InvalidInput(msg) => write!(f, "invalid input: {msg}"),
            Self::NotFound(msg) => write!(f, "not found: {msg}"),
            Self::Conflict(msg) => write!(f, "conflict: {msg}"),
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
        let (code, category, retryable, remediation) = match &error {
            TaskServiceError::Store(StoreError::Conflict(_)) | TaskServiceError::Conflict(_) => (
                "TASK_CONFLICT",
                TaskErrorCategory::Conflict,
                true,
                Some("Reload the latest revision or run projection and retry.".into()),
            ),
            TaskServiceError::Store(_) => (
                "TASK_STORE_ERROR",
                TaskErrorCategory::Store,
                true,
                Some("Retry the operation. If it persists, inspect the local task store.".into()),
            ),
            TaskServiceError::Validation(_) => (
                "TASK_VALIDATION_ERROR",
                TaskErrorCategory::Domain,
                false,
                Some("Correct the graph command or node configuration.".into()),
            ),
            TaskServiceError::InvalidInput(_) => (
                "TASK_INVALID_INPUT",
                TaskErrorCategory::Domain,
                false,
                Some("Correct the request values and retry.".into()),
            ),
            TaskServiceError::NotFound(_) => (
                "TASK_NOT_FOUND",
                TaskErrorCategory::Domain,
                false,
                Some("Reload the project task graph.".into()),
            ),
            TaskServiceError::Internal(_) => (
                "TASK_INTERNAL_ERROR",
                TaskErrorCategory::Internal,
                false,
                Some("Inspect application logs and the task event stream.".into()),
            ),
        };
        Self {
            code: code.into(),
            category,
            message_key: error.to_string(),
            field_path: None,
            retryable,
            retry_after_ms: None,
            current_revision: None,
            current_run_seq: None,
            remediation,
            provider_detail: None,
        }
    }
}

impl TaskService {
    /// Open the task service at the default database path.
    pub fn open_default(
        registry: Arc<crate::agent::AgentRegistry>,
    ) -> Result<Self, TaskServiceError> {
        let db_path = default_db_path();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                TaskServiceError::Internal(format!("failed to create db directory: {e}"))
            })?;
        }
        let store = TaskStore::open(&db_path)?;
        let store_arc = Arc::new(store);
        let runtime = Arc::new(DefaultTaskAgentRuntime::new(registry.clone()));
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

    // ── Graph lifecycle ───────────────────────────────────────────────

    /// Create a new task graph with an initial revision.
    pub fn create_graph(
        &self,
        input: &CreateGraphInput,
    ) -> Result<(TaskGraph, GraphRevision), TaskServiceError> {
        let store = &self.store;

        let now = now_ms();
        let graph_id = gen_id("graph");
        let revision_id = gen_id("rev");

        let graph = TaskGraph {
            graph_id: graph_id.clone(),
            title: input.title.clone(),
            goal: input.goal.clone(),
            project_root: PathBuf::from(&input.project_root),
            owner: input.owner.clone(),
            current_draft_revision: Some(revision_id.clone()),
            created_at: now,
            updated_at: now,
        };

        let snapshot = graph_create(input);
        let mut warnings: Vec<String> = Vec::new();
        graph_validate(&snapshot)?;
        let _ = &mut warnings; // warnings available for logging

        let mut revision = GraphRevision::from_snapshot(
            revision_id,
            &graph_id,
            None,
            &snapshot,
            &input.owner,
            now,
        )?;
        revision.skill_refs = input.skill_refs.clone();
        revision.template_refs = input.template_refs.clone();
        revision.planner_policy_refs = input.planner_policy_refs.clone();
        revision.change_summary = "Initial task graph".into();
        revision.refresh_content_hash()?;

        store.create_graph_with_revision(&graph, &revision)?;

        Ok((graph, revision))
    }

    /// Get a graph by id.
    pub fn get_graph(&self, graph_id: &str) -> Result<TaskGraph, TaskServiceError> {
        let store = &self.store;
        Ok(store.get_graph(graph_id)?)
    }

    pub fn latest_graph_for_project(
        &self,
        project_root: &std::path::Path,
    ) -> Result<Option<TaskGraph>, TaskServiceError> {
        let store = &self.store;
        Ok(store.latest_graph_for_project(project_root)?)
    }

    /// Get a revision by id, optionally deserializing the snapshot.
    pub fn get_revision(&self, revision_id: &str) -> Result<GraphRevision, TaskServiceError> {
        let store = &self.store;
        Ok(store.get_revision(revision_id)?)
    }

    /// Apply commands to the current draft revision and create a new revision.
    pub fn apply_commands(
        &self,
        graph_id: &str,
        expected_revision_id: &str,
        commands: &[GraphCommand],
        author: &str,
    ) -> Result<RevisionResult, TaskServiceError> {
        let store = &self.store;

        // Load the expected revision.
        let base_revision = store.get_revision(expected_revision_id)?;
        if base_revision.graph_id != graph_id {
            return Err(TaskServiceError::Conflict(format!(
                "revision {expected_revision_id} does not belong to graph {graph_id}"
            )));
        }

        // Verify it's still the current draft.
        let graph = store.get_graph(graph_id)?;
        match &graph.current_draft_revision {
            Some(draft) if draft == expected_revision_id => {}
            Some(draft) => {
                return Err(TaskServiceError::Conflict(format!(
                    "expected revision {expected_revision_id} but current draft is {draft}"
                )));
            }
            None => {
                return Err(TaskServiceError::Conflict(
                    "graph has no current draft revision".into(),
                ));
            }
        }

        // Apply commands.
        let base_snapshot = base_revision.snapshot()?;
        let new_snapshot = apply_commands(&base_snapshot, commands)?;
        graph_validate(&new_snapshot)?;

        // Create new revision.
        let now = now_ms();
        let new_revision_id = gen_id("rev");
        let mut new_revision = GraphRevision::from_snapshot(
            &new_revision_id,
            graph_id,
            Some(expected_revision_id.to_string()),
            &new_snapshot,
            author,
            now,
        )?;
        new_revision.skill_refs = base_revision.skill_refs.clone();
        new_revision.template_refs = base_revision.template_refs.clone();
        new_revision.planner_policy_refs = base_revision.planner_policy_refs.clone();
        new_revision.change_summary = commands
            .iter()
            .map(|command| command.command_id())
            .collect::<Vec<_>>()
            .join(", ");
        new_revision.refresh_content_hash()?;

        // Compute diff.
        use crate::orchestrator::domain::revision::diff_snapshots;
        let diff = diff_snapshots(
            &base_snapshot,
            &new_snapshot,
            expected_revision_id,
            &new_revision_id,
        );

        // Persist atomically.
        store.save_revision_and_update_draft(graph_id, expected_revision_id, &new_revision, now)?;

        Ok(RevisionResult {
            revision: new_revision,
            diff: Some(diff),
        })
    }

    /// Validate a snapshot without persisting.
    pub fn validate_commands(
        &self,
        revision_id: &str,
        commands: &[GraphCommand],
    ) -> Result<Vec<String>, TaskServiceError> {
        let store = &self.store;

        let revision = store.get_revision(revision_id)?;
        let snapshot = revision.snapshot()?;
        let new_snapshot = apply_commands(&snapshot, commands)?;
        let warnings = graph_validate(&new_snapshot)?;
        Ok(warnings)
    }

    /// List all revisions for a graph.
    pub fn list_revisions(&self, graph_id: &str) -> Result<Vec<GraphRevision>, TaskServiceError> {
        let store = &self.store;
        Ok(store.list_revisions(graph_id)?)
    }

    pub fn checkout_draft_revision(
        &self,
        graph_id: &str,
        expected_revision_id: &str,
        target_revision_id: &str,
    ) -> Result<GraphRevision, TaskServiceError> {
        let store = &self.store;
        let target = store.get_revision(target_revision_id)?;
        if target.graph_id != graph_id {
            return Err(TaskServiceError::Conflict(format!(
                "revision {target_revision_id} does not belong to graph {graph_id}"
            )));
        }
        store.checkout_graph_draft_revision(
            graph_id,
            expected_revision_id,
            target_revision_id,
            now_ms(),
        )?;
        Ok(target)
    }

    // ── Run lifecycle ─────────────────────────────────────────────────

    /// Start a new run bound to a specific revision.
    pub fn start_run(
        &self,
        graph_id: &str,
        revision_id: &str,
    ) -> Result<GraphRun, TaskServiceError> {
        self.start_run_with_budget(graph_id, revision_id, BudgetState::default())
    }

    pub fn start_run_with_budget(
        &self,
        graph_id: &str,
        revision_id: &str,
        mut budget_state: BudgetState,
    ) -> Result<GraphRun, TaskServiceError> {
        let store = &self.store;
        if budget_state.token_limit == Some(0)
            || budget_state
                .cost_limit_usd
                .is_some_and(|limit| limit <= 0.0)
            || budget_state.deadline_ms == Some(0)
        {
            return Err(TaskServiceError::InvalidInput(
                "run budget limits must be greater than zero".into(),
            ));
        }
        budget_state.token_used = 0;
        budget_state.cost_used_usd = 0.0;

        let revision = store.get_revision(revision_id)?;
        if revision.graph_id != graph_id {
            return Err(TaskServiceError::Conflict(format!(
                "revision {revision_id} does not belong to graph {graph_id}"
            )));
        }

        let run_id = gen_id("run");
        let now = now_ms();
        let snapshot = revision.snapshot()?;
        let planning_snapshot = RunPlanningSnapshot {
            revision_content_hash: revision.content_hash.0.clone(),
            skill_refs: revision.skill_refs.clone(),
            template_refs: revision.template_refs.clone(),
            planner_policy_refs: revision.planner_policy_refs.clone(),
            node_policies: snapshot
                .nodes
                .into_iter()
                .map(|node| (node.node_id, node.policy))
                .collect(),
        };

        let run = GraphRun {
            run_id: run_id.clone(),
            graph_id: graph_id.to_string(),
            active_revision_id: revision_id.to_string(),
            status: RunStatus::Running,
            run_seq: 1,
            budget_state: budget_state.clone(),
            planning_snapshot,
            started_at: now,
            finished_at: None,
        };

        let event = build_event(
            gen_id("evt"),
            &run_id,
            1,
            TaskEventType::RunStarted,
            "system",
            now,
            serde_json::to_value(&payloads::RunStartedPayload {
                run_id: run_id.clone(),
                graph_id: graph_id.to_string(),
                revision_id: revision_id.to_string(),
                initial_status: RunStatus::Running,
                budget_state,
            })?,
        );
        store.create_run_with_event(&run, &event)?;

        Ok(run)
    }

    pub fn propose_run_revision(
        &self,
        run_id: &str,
        candidate_revision_id: &str,
    ) -> Result<RunRevisionProposal, TaskServiceError> {
        let store = &self.store;
        let run = store.get_run(run_id)?;
        if run.status.is_terminal() {
            return Err(TaskServiceError::Conflict(
                "terminal runs cannot accept revision proposals".into(),
            ));
        }
        if run.active_revision_id == candidate_revision_id {
            return Err(TaskServiceError::Conflict(
                "candidate revision is already active".into(),
            ));
        }

        let base_revision = store.get_revision(&run.active_revision_id)?;
        let candidate_revision = store.get_revision(candidate_revision_id)?;
        if candidate_revision.graph_id != run.graph_id {
            return Err(TaskServiceError::Conflict(format!(
                "revision {candidate_revision_id} does not belong to run graph {}",
                run.graph_id
            )));
        }
        let base_snapshot = base_revision.snapshot()?;
        let candidate_snapshot = candidate_revision.snapshot()?;
        graph_validate(&candidate_snapshot)?;

        let node_runs = store.get_node_runs(run_id)?;
        let latest_runs = latest_node_runs_by_id(&node_runs);
        let mut frozen_node_ids = latest_runs
            .values()
            .filter(|node_run| node_run.status.is_frozen())
            .map(|node_run| node_run.node_id.clone())
            .collect::<Vec<_>>();
        frozen_node_ids.sort();
        frozen_node_ids.dedup();

        for node_id in &frozen_node_ids {
            let base_node = base_snapshot.node_by_id(node_id).ok_or_else(|| {
                TaskServiceError::Conflict(format!(
                    "frozen node {node_id} is missing from active revision"
                ))
            })?;
            let candidate_node = candidate_snapshot.node_by_id(node_id).ok_or_else(|| {
                TaskServiceError::Conflict(format!(
                    "candidate revision removes frozen node {node_id}"
                ))
            })?;
            if serde_json::to_value(base_node)? != serde_json::to_value(candidate_node)? {
                return Err(TaskServiceError::Conflict(format!(
                    "candidate revision changes frozen node {node_id}"
                )));
            }
            if incoming_edge_signature(&base_snapshot, node_id)
                != incoming_edge_signature(&candidate_snapshot, node_id)
            {
                return Err(TaskServiceError::Conflict(format!(
                    "candidate revision changes dependencies of frozen node {node_id}"
                )));
            }
        }

        let candidate_node_ids = candidate_snapshot
            .nodes
            .iter()
            .map(|node| node.node_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut superseded_node_ids = latest_runs
            .values()
            .filter(|node_run| {
                !node_run.status.is_terminal()
                    && !node_run.status.is_frozen()
                    && !candidate_node_ids.contains(node_run.node_id.as_str())
            })
            .map(|node_run| node_run.node_id.clone())
            .collect::<Vec<_>>();
        superseded_node_ids.sort();
        superseded_node_ids.dedup();

        let proposal = RunRevisionProposal {
            proposal_id: gen_id("run-revision-proposal"),
            run_id: run_id.to_string(),
            base_revision_id: run.active_revision_id,
            candidate_revision_id: candidate_revision_id.to_string(),
            expected_run_seq: run.run_seq,
            frozen_node_ids,
            superseded_node_ids,
            created_at: now_ms(),
        };
        store.save_run_revision_proposal(&proposal)?;
        Ok(proposal)
    }

    pub fn apply_run_revision(
        &self,
        run_id: &str,
        proposal_id: &str,
        expected_run_seq: u64,
    ) -> Result<GraphRun, TaskServiceError> {
        let store = &self.store;
        let proposal = store.get_run_revision_proposal(proposal_id)?;
        if proposal.run_id != run_id {
            return Err(TaskServiceError::Conflict(format!(
                "revision proposal {proposal_id} belongs to another run"
            )));
        }
        let run = store.get_run(run_id)?;
        if run.status.is_terminal() {
            return Err(TaskServiceError::Conflict(
                "terminal runs cannot apply revisions".into(),
            ));
        }
        if run.run_seq != expected_run_seq
            || proposal.expected_run_seq != expected_run_seq
            || run.active_revision_id != proposal.base_revision_id
        {
            return Err(TaskServiceError::Conflict(
                "run changed after the revision proposal was validated".into(),
            ));
        }

        let candidate_revision = store.get_revision(&proposal.candidate_revision_id)?;
        let candidate_snapshot = candidate_revision.snapshot()?;
        let candidate_node_ids = candidate_snapshot
            .nodes
            .iter()
            .map(|node| node.node_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let frozen_node_ids = proposal
            .frozen_node_ids
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        let now = now_ms();
        let mut node_runs = store.get_node_runs(run_id)?;
        let mut events = Vec::new();
        for node_run in &mut node_runs {
            if frozen_node_ids.contains(node_run.node_id.as_str()) {
                continue;
            }
            if candidate_node_ids.contains(node_run.node_id.as_str()) {
                if !node_run.status.is_terminal() {
                    node_run.revision_id = candidate_revision.revision_id.clone();
                }
                continue;
            }
            if !node_run.status.is_terminal() {
                let old_status = node_run.status.clone();
                node_run.status = NodeRunStatus::Superseded;
                node_run.superseded = true;
                node_run.finished_at = Some(now);
                node_run.wake_at = None;
                events.push(build_event(
                    gen_id("evt"),
                    run_id,
                    expected_run_seq + events.len() as u64 + 1,
                    TaskEventType::NodeSuperseded,
                    "task_orchestrator",
                    now,
                    serde_json::to_value(payloads::NodeStatusChangedPayload {
                        node_run_id: node_run.node_run_id.clone(),
                        node_id: node_run.node_id.clone(),
                        old_status,
                        new_status: NodeRunStatus::Superseded,
                    })?,
                ));
            }
        }

        let planning_snapshot = RunPlanningSnapshot {
            revision_content_hash: candidate_revision.content_hash.0.clone(),
            skill_refs: candidate_revision.skill_refs.clone(),
            template_refs: candidate_revision.template_refs.clone(),
            planner_policy_refs: candidate_revision.planner_policy_refs.clone(),
            node_policies: candidate_snapshot
                .nodes
                .iter()
                .map(|node| (node.node_id.clone(), node.policy.clone()))
                .collect(),
        };
        events.push(build_event(
            gen_id("evt"),
            run_id,
            expected_run_seq + events.len() as u64 + 1,
            TaskEventType::RevisionAppliedToRun,
            "task_orchestrator",
            now,
            serde_json::to_value(payloads::RevisionAppliedToRunPayload {
                run_id: run_id.to_string(),
                old_revision_id: proposal.base_revision_id.clone(),
                new_revision_id: proposal.candidate_revision_id.clone(),
                frozen_node_ids: proposal.frozen_node_ids.clone(),
                superseded_node_ids: proposal.superseded_node_ids.clone(),
            })?,
        ));
        Ok(store.apply_run_revision(
            &proposal,
            expected_run_seq,
            &planning_snapshot,
            &node_runs,
            &events,
        )?)
    }

    /// Get a run by id.
    pub fn get_run(&self, run_id: &str) -> Result<GraphRun, TaskServiceError> {
        let store = &self.store;
        Ok(store.get_run(run_id)?)
    }

    /// Get node runs for a graph run.
    pub fn get_node_runs(&self, run_id: &str) -> Result<Vec<NodeRun>, TaskServiceError> {
        let store = &self.store;
        Ok(store.get_node_runs(run_id)?)
    }

    /// List runs for a graph.
    pub fn list_runs(&self, graph_id: &str) -> Result<Vec<GraphRun>, TaskServiceError> {
        let store = &self.store;
        Ok(store.list_runs(graph_id)?)
    }

    /// Pause a run.
    pub fn pause_run(&self, run_id: &str) -> Result<(), TaskServiceError> {
        let store = &self.store;

        let run = store.get_run(run_id)?;
        crate::orchestrator::domain::state_machine::validate_run_transition(
            &run.status,
            &RunStatus::Paused,
        )
        .map_err(|e| TaskServiceError::Conflict(e.to_string()))?;

        let now = now_ms();
        let new_seq = run.run_seq + 1;
        let event = build_event(
            gen_id("evt"),
            run_id,
            new_seq,
            TaskEventType::RunPaused,
            "user",
            now,
            serde_json::Value::Null,
        );
        store.transition_run_with_event(run_id, &run.status, &RunStatus::Paused, None, &event)?;

        Ok(())
    }

    /// Resume a run.
    pub fn resume_run(&self, run_id: &str) -> Result<(), TaskServiceError> {
        let store = &self.store;

        let run = store.get_run(run_id)?;
        crate::orchestrator::domain::state_machine::validate_run_transition(
            &run.status,
            &RunStatus::Running,
        )
        .map_err(|e| TaskServiceError::Conflict(e.to_string()))?;

        let now = now_ms();
        let new_seq = run.run_seq + 1;
        let event = build_event(
            gen_id("evt"),
            run_id,
            new_seq,
            TaskEventType::RunResumed,
            "user",
            now,
            serde_json::Value::Null,
        );
        store.transition_run_with_event(run_id, &run.status, &RunStatus::Running, None, &event)?;

        Ok(())
    }

    /// Cancel a run.
    pub fn cancel_run(&self, run_id: &str) -> Result<(), TaskServiceError> {
        let store = &self.store;

        let run = store.get_run(run_id)?;
        crate::orchestrator::domain::state_machine::validate_run_transition(
            &run.status,
            &RunStatus::Cancelled,
        )
        .map_err(|e| TaskServiceError::Conflict(e.to_string()))?;

        let now = now_ms();
        let node_runs = store.get_node_runs(run_id)?;
        let active_node_runs = node_runs
            .iter()
            .filter(|node_run| !node_run.status.is_terminal())
            .collect::<Vec<_>>();
        let mut events = Vec::with_capacity(active_node_runs.len() + 1);
        for node_run in &active_node_runs {
            events.push(build_event(
                gen_id("evt"),
                run_id,
                run.run_seq + events.len() as u64 + 1,
                TaskEventType::NodeCancelled,
                "user",
                now,
                serde_json::to_value(payloads::NodeStatusChangedPayload {
                    node_run_id: node_run.node_run_id.clone(),
                    node_id: node_run.node_id.clone(),
                    old_status: node_run.status.clone(),
                    new_status: crate::orchestrator::domain::run::NodeRunStatus::Cancelled,
                })?,
            ));
        }
        events.push(build_event(
            gen_id("evt"),
            run_id,
            run.run_seq + events.len() as u64 + 1,
            TaskEventType::RunCancelled,
            "user",
            now,
            serde_json::Value::Null,
        ));
        let cancelled_node_run_ids = active_node_runs
            .iter()
            .map(|node_run| node_run.node_run_id.clone())
            .collect::<Vec<_>>();
        store.terminate_run_with_events(
            run_id,
            &run.status,
            &RunStatus::Cancelled,
            now,
            &cancelled_node_run_ids,
            &events,
        )?;

        Ok(())
    }

    // ── Event queries ─────────────────────────────────────────────────

    pub fn pending_approvals(
        &self,
        run_id: &str,
    ) -> Result<Vec<ApprovalRequest>, TaskServiceError> {
        let store = &self.store;
        Ok(store.pending_approvals(run_id)?)
    }

    pub fn list_artifacts(&self, run_id: &str) -> Result<Vec<ArtifactRef>, TaskServiceError> {
        let store = &self.store;
        Ok(store.list_artifacts(run_id)?)
    }

    pub fn resolve_approval(
        &self,
        approval_id: &str,
        approved: bool,
        resolver: &str,
    ) -> Result<ApprovalRequest, TaskServiceError> {
        let store = &self.store;
        let mut approval = store.get_approval(approval_id)?;
        if approval.resolved {
            return Err(TaskServiceError::Conflict(format!(
                "approval {approval_id} is already resolved"
            )));
        }
        let mut node_run = store.get_node_run(&approval.node_run_id)?;
        if node_run.status != NodeRunStatus::AwaitingApproval {
            return Err(TaskServiceError::Conflict(format!(
                "node run {} is not awaiting approval",
                node_run.node_run_id
            )));
        }
        let run = store.get_run(&approval.run_id)?;
        let revision = store.get_revision(&run.active_revision_id)?;
        let snapshot = revision.snapshot()?;
        let node = snapshot
            .node_by_id(&node_run.node_id)
            .ok_or_else(|| TaskServiceError::NotFound(format!("node {}", node_run.node_id)))?;

        let now = now_ms();
        approval.resolved = true;
        approval.approved = Some(approved);
        approval.resolver = Some(resolver.to_string());
        approval.resolved_at = Some(now);

        let mut events = vec![build_event(
            gen_id("evt"),
            &approval.run_id,
            run.run_seq + 1,
            TaskEventType::ApprovalResolved,
            resolver,
            now,
            serde_json::to_value(payloads::ApprovalResolvedPayload {
                approval_id: approval.approval_id.clone(),
                node_run_id: node_run.node_run_id.clone(),
                approved,
                resolver: resolver.to_string(),
            })?,
        )];

        if approved
            && node.node_kind == crate::orchestrator::domain::graph::NodeKind::ControlApprovalGate
        {
            node_run.status = NodeRunStatus::Succeeded;
            node_run.finished_at = Some(now);
            events.push(build_event(
                gen_id("evt"),
                &approval.run_id,
                run.run_seq + 2,
                TaskEventType::NodeResolved,
                resolver,
                now,
                serde_json::to_value(payloads::NodeResolvedPayload {
                    node_run_id: node_run.node_run_id.clone(),
                    node_id: node_run.node_id.clone(),
                    final_status: NodeRunStatus::Succeeded,
                })?,
            ));
        } else if approved {
            node_run.status = NodeRunStatus::Blocked;
            events.push(build_event(
                gen_id("evt"),
                &approval.run_id,
                run.run_seq + 2,
                TaskEventType::NodeBlocked,
                resolver,
                now,
                serde_json::to_value(payloads::NodeReadyPayload {
                    node_run_id: node_run.node_run_id.clone(),
                    node_id: node_run.node_id.clone(),
                })?,
            ));
        } else {
            node_run.status = NodeRunStatus::Failed;
            node_run.error = Some("approval denied".into());
            node_run.finished_at = Some(now);
            events.push(build_event(
                gen_id("evt"),
                &approval.run_id,
                run.run_seq + 2,
                TaskEventType::NodeResolved,
                resolver,
                now,
                serde_json::to_value(payloads::NodeResolvedPayload {
                    node_run_id: node_run.node_run_id.clone(),
                    node_id: node_run.node_id.clone(),
                    final_status: NodeRunStatus::Failed,
                })?,
            ));
        }
        store.save_approval_execution_update(&node_run, &approval, &events)?;
        Ok(approval)
    }

    pub fn choose_recovery(
        &self,
        node_run_id: &str,
        strategy: &crate::orchestrator::recovery::RecoveryStrategy,
        reason: &str,
    ) -> Result<NodeRun, TaskServiceError> {
        let store = &self.store;
        let mut node_run = store.get_node_run(node_run_id)?;
        let run = store.get_run(&node_run.run_id)?;
        if run.status.is_terminal() {
            return Err(TaskServiceError::Conflict(
                "terminal runs cannot accept recovery decisions".into(),
            ));
        }
        let now = now_ms();
        crate::orchestrator::recovery::apply_recovery(&mut node_run, strategy, now)
            .map_err(TaskServiceError::Conflict)?;
        let strategy_name = serde_json::to_value(strategy)?
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let mut events = vec![build_event(
            gen_id("evt"),
            &run.run_id,
            run.run_seq + 1,
            TaskEventType::RecoveryChosen,
            "local_user",
            now,
            serde_json::to_value(payloads::RecoveryChosenPayload {
                node_run_id: node_run.node_run_id.clone(),
                strategy: strategy_name,
                reason: reason.to_string(),
            })?,
        )];
        match node_run.status {
            NodeRunStatus::Blocked => events.push(build_event(
                gen_id("evt"),
                &run.run_id,
                run.run_seq + 2,
                TaskEventType::NodeBlocked,
                "recovery_controller",
                now,
                serde_json::to_value(payloads::NodeReadyPayload {
                    node_run_id: node_run.node_run_id.clone(),
                    node_id: node_run.node_id.clone(),
                })?,
            )),
            NodeRunStatus::Skipped | NodeRunStatus::Failed => events.push(build_event(
                gen_id("evt"),
                &run.run_id,
                run.run_seq + 2,
                TaskEventType::NodeResolved,
                "recovery_controller",
                now,
                serde_json::to_value(payloads::NodeResolvedPayload {
                    node_run_id: node_run.node_run_id.clone(),
                    node_id: node_run.node_id.clone(),
                    final_status: node_run.status.clone(),
                })?,
            )),
            _ => {}
        }
        store.save_node_runs_with_events(&[node_run.clone()], &events, None)?;
        Ok(node_run)
    }

    /// Get events for a run after a given sequence.
    pub fn run_events_after(
        &self,
        run_id: &str,
        after_seq: u64,
    ) -> Result<Vec<TaskEvent>, TaskServiceError> {
        let store = &self.store;
        Ok(store.events_after(run_id, after_seq, 500)?)
    }

    /// Get the current run projection.
    pub fn run_projection(
        &self,
        run_id: &str,
    ) -> Result<crate::orchestrator::events::RunProjection, TaskServiceError> {
        let store = &self.store;
        let events = store.all_events(run_id)?;
        if events.is_empty() {
            return Err(TaskServiceError::NotFound(format!("run {run_id}")));
        }
        let proj = crate::orchestrator::events::rebuild_projection(run_id, &events)
            .map_err(|e| TaskServiceError::Internal(e.to_string()))?;
        Ok(proj)
    }

    /// Run a WAL checkpoint.
    pub fn checkpoint(&self) -> Result<(), TaskServiceError> {
        let store = &self.store;
        store.checkpoint()?;
        Ok(())
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
mod tests {
    use super::*;
    use crate::orchestrator::commands::{CreateGraphInput, NodePatch};
    use crate::orchestrator::domain::graph::{
        EdgeKind, ExecutablePayload, GraphEdge, GraphNode, NodeKind,
    };
    use crate::orchestrator::domain::policy::{ApprovalPolicy, NodePolicy};
    use std::collections::HashMap;

    fn shell_node(node_id: &str, title: &str) -> GraphNode {
        GraphNode {
            node_id: node_id.into(),
            parent_id: Some("goal".into()),
            title: title.into(),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: HashMap::new(),
            executable_payload: Some(ExecutablePayload::Shell {
                command: format!("echo {node_id}"),
                cwd: None,
                timeout_ms: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        }
    }

    #[test]
    fn create_graph_and_revision() {
        let svc = TaskService::open_in_memory().unwrap();
        let input = CreateGraphInput {
            title: "Test Task".into(),
            goal: "Build feature X".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            skill_refs: vec![crate::orchestrator::domain::revision::SkillRef {
                skill_id: "superpowers".into(),
                version_or_hash: "sha256:test".into(),
                inputs: serde_json::json!({"mode": "tdd"}),
            }],
            ..Default::default()
        };
        let (graph, revision) = svc.create_graph(&input).unwrap();
        assert_eq!(graph.title, "Test Task");
        assert_eq!(revision.graph_id, graph.graph_id);
        assert_eq!(revision.skill_refs.len(), 1);

        let recovered_graph = svc.get_graph(&graph.graph_id).unwrap();
        assert_eq!(recovered_graph.goal, "Build feature X");
        let recovered_revision = svc.get_revision(&revision.revision_id).unwrap();
        assert_eq!(recovered_revision.skill_refs[0].skill_id, "superpowers");
    }

    #[test]
    fn apply_commands_creates_new_revision() {
        let svc = TaskService::open_in_memory().unwrap();
        let input = CreateGraphInput {
            title: "Test".into(),
            goal: "Do X".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            template_refs: vec![crate::orchestrator::domain::revision::TemplateRef {
                template_id: "review".into(),
                version_or_hash: "sha256:review".into(),
                inputs: serde_json::json!({"strict": true}),
            }],
            ..Default::default()
        };
        let (_, revision) = svc.create_graph(&input).unwrap();

        let new_node = GraphNode {
            node_id: "n1".into(),
            parent_id: Some("goal".into()),
            title: "Step 1".into(),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: HashMap::new(),
            executable_payload: Some(ExecutablePayload::Shell {
                command: "echo hello".into(),
                cwd: None,
                timeout_ms: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        };

        let commands = vec![GraphCommand::AddNode {
            command_id: "c1".into(),
            node: new_node,
        }];

        let result = svc
            .apply_commands(&revision.graph_id, &revision.revision_id, &commands, "user")
            .unwrap();

        assert_ne!(result.revision.revision_id, revision.revision_id);
        assert!(result.diff.is_some());
        let diff = result.diff.unwrap();
        assert!(diff.nodes_added.contains(&"n1".to_string()));
    }

    #[test]
    fn checkout_draft_revision_uses_optimistic_lock() {
        let svc = TaskService::open_in_memory().unwrap();
        let input = CreateGraphInput {
            title: "Test".into(),
            goal: "Do X".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        };
        let (graph, first_revision) = svc.create_graph(&input).unwrap();
        let second_revision = svc
            .apply_commands(
                &graph.graph_id,
                &first_revision.revision_id,
                &[GraphCommand::AddNode {
                    command_id: "add-n1".into(),
                    node: GraphNode {
                        node_id: "n1".into(),
                        parent_id: Some("goal".into()),
                        title: "N1".into(),
                        description: None,
                        node_kind: NodeKind::Executable,
                        input_contract: Default::default(),
                        output_contract: Default::default(),
                        role_requirement: None,
                        capability_requirements: vec![],
                        agent_assignment_constraint: None,
                        policy: Default::default(),
                        metadata: HashMap::new(),
                        executable_payload: Some(ExecutablePayload::Shell {
                            command: "echo 1".into(),
                            cwd: None,
                            timeout_ms: None,
                        }),
                        loop_config: None,
                        approval_gate_config: None,
                    },
                }],
                "user",
            )
            .unwrap()
            .revision;

        let restored = svc
            .checkout_draft_revision(
                &graph.graph_id,
                &second_revision.revision_id,
                &first_revision.revision_id,
            )
            .unwrap();
        assert_eq!(restored.revision_id, first_revision.revision_id);
        assert_eq!(
            svc.get_graph(&graph.graph_id)
                .unwrap()
                .current_draft_revision
                .as_deref(),
            Some(first_revision.revision_id.as_str())
        );
        assert!(svc
            .checkout_draft_revision(
                &graph.graph_id,
                &second_revision.revision_id,
                &first_revision.revision_id,
            )
            .is_err());
    }

    #[test]
    fn apply_commands_conflict_on_stale_revision() {
        let svc = TaskService::open_in_memory().unwrap();
        let input = CreateGraphInput {
            title: "Test".into(),
            goal: "Do X".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        };
        let (_, revision) = svc.create_graph(&input).unwrap();

        // First command succeeds.
        let node1 = GraphNode {
            node_id: "n1".into(),
            parent_id: Some("goal".into()),
            title: "N1".into(),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: HashMap::new(),
            executable_payload: Some(ExecutablePayload::Shell {
                command: "echo 1".into(),
                cwd: None,
                timeout_ms: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        };

        let commands1 = vec![GraphCommand::AddNode {
            command_id: "c1".into(),
            node: node1,
        }];

        let result1 = svc
            .apply_commands(
                &revision.graph_id,
                &revision.revision_id,
                &commands1,
                "user",
            )
            .unwrap();

        // Second command using stale revision should fail.
        let node2 = GraphNode {
            node_id: "n2".into(),
            parent_id: Some("goal".into()),
            title: "N2".into(),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: HashMap::new(),
            executable_payload: Some(ExecutablePayload::Shell {
                command: "echo 2".into(),
                cwd: None,
                timeout_ms: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        };

        let commands2 = vec![GraphCommand::AddNode {
            command_id: "c2".into(),
            node: node2,
        }];

        let result2 = svc.apply_commands(
            &revision.graph_id,
            &revision.revision_id,
            &commands2,
            "user",
        );
        assert!(result2.is_err());
    }

    #[test]
    fn start_run_emits_event() {
        let svc = TaskService::open_in_memory().unwrap();
        let input = CreateGraphInput {
            title: "Test".into(),
            goal: "Do X".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            template_refs: vec![crate::orchestrator::domain::revision::TemplateRef {
                template_id: "review".into(),
                version_or_hash: "sha256:review".into(),
                inputs: serde_json::json!({"strict": true}),
            }],
            ..Default::default()
        };
        let (graph, revision) = svc.create_graph(&input).unwrap();

        let run = svc
            .start_run(&graph.graph_id, &revision.revision_id)
            .unwrap();
        assert_eq!(run.status, RunStatus::Running);
        assert_eq!(run.planning_snapshot.template_refs.len(), 1);
        assert_eq!(
            run.planning_snapshot.revision_content_hash,
            revision.content_hash.0
        );
        assert!(run.planning_snapshot.node_policies.contains_key("goal"));

        let events = svc.run_events_after(&run.run_id, 0).unwrap();
        assert!(!events.is_empty());
        assert_eq!(events[0].event_type, TaskEventType::RunStarted);
    }

    #[test]
    fn run_revision_proposal_rejects_changes_to_frozen_nodes() {
        let svc = TaskService::open_in_memory().unwrap();
        let (graph, initial_revision) = svc
            .create_graph(&CreateGraphInput {
                title: "Hot update".into(),
                goal: "Test frozen nodes".into(),
                project_root: "/project".into(),
                owner: "user".into(),
                ..Default::default()
            })
            .unwrap();
        let active_revision = svc
            .apply_commands(
                &graph.graph_id,
                &initial_revision.revision_id,
                &[GraphCommand::AddNode {
                    command_id: "add-n1".into(),
                    node: shell_node("n1", "Original"),
                }],
                "user",
            )
            .unwrap()
            .revision;
        let run = svc
            .start_run(&graph.graph_id, &active_revision.revision_id)
            .unwrap();
        let mut node_run = NodeRun::new("nr-n1", &run.run_id, "n1", &active_revision.revision_id);
        node_run.status = NodeRunStatus::Running;
        svc.store.save_node_run(&node_run).unwrap();

        let candidate = svc
            .apply_commands(
                &graph.graph_id,
                &active_revision.revision_id,
                &[GraphCommand::UpdateNode {
                    command_id: "rename-n1".into(),
                    node_id: "n1".into(),
                    patch: NodePatch {
                        title: Some("Changed".into()),
                        ..Default::default()
                    },
                }],
                "user",
            )
            .unwrap()
            .revision;

        let error = svc
            .propose_run_revision(&run.run_id, &candidate.revision_id)
            .unwrap_err()
            .to_string();
        assert!(error.contains("frozen node n1"));
    }

    #[test]
    fn apply_run_revision_supersedes_removed_unstarted_nodes() {
        let svc = TaskService::open_in_memory().unwrap();
        let (graph, initial_revision) = svc
            .create_graph(&CreateGraphInput {
                title: "Hot update".into(),
                goal: "Apply a safe candidate".into(),
                project_root: "/project".into(),
                owner: "user".into(),
                ..Default::default()
            })
            .unwrap();
        let active_revision = svc
            .apply_commands(
                &graph.graph_id,
                &initial_revision.revision_id,
                &[
                    GraphCommand::AddNode {
                        command_id: "add-n1".into(),
                        node: shell_node("n1", "Completed"),
                    },
                    GraphCommand::AddNode {
                        command_id: "add-n2".into(),
                        node: shell_node("n2", "Pending"),
                    },
                ],
                "user",
            )
            .unwrap()
            .revision;
        let run = svc
            .start_run(&graph.graph_id, &active_revision.revision_id)
            .unwrap();
        let mut completed = NodeRun::new("nr-n1", &run.run_id, "n1", &active_revision.revision_id);
        completed.status = NodeRunStatus::Succeeded;
        completed.finished_at = Some(now_ms());
        let pending = NodeRun::new("nr-n2", &run.run_id, "n2", &active_revision.revision_id);
        {
            let store = &svc.store;
            store.save_node_run(&completed).unwrap();
            store.save_node_run(&pending).unwrap();
        }

        let candidate = svc
            .apply_commands(
                &graph.graph_id,
                &active_revision.revision_id,
                &[GraphCommand::RemoveNode {
                    command_id: "remove-n2".into(),
                    node_id: "n2".into(),
                }],
                "user",
            )
            .unwrap()
            .revision;
        let proposal = svc
            .propose_run_revision(&run.run_id, &candidate.revision_id)
            .unwrap();
        assert_eq!(proposal.superseded_node_ids, vec!["n2"]);

        let updated_run = svc
            .apply_run_revision(
                &run.run_id,
                &proposal.proposal_id,
                proposal.expected_run_seq,
            )
            .unwrap();
        assert_eq!(updated_run.active_revision_id, candidate.revision_id);
        assert_eq!(
            svc.get_node_runs(&run.run_id)
                .unwrap()
                .into_iter()
                .find(|node_run| node_run.node_id == "n2")
                .unwrap()
                .status,
            NodeRunStatus::Superseded
        );
        assert_eq!(
            svc.run_events_after(&run.run_id, 0)
                .unwrap()
                .last()
                .unwrap()
                .event_type,
            TaskEventType::RevisionAppliedToRun
        );
    }

    #[test]
    fn pause_resume_run() {
        let svc = TaskService::open_in_memory().unwrap();
        let input = CreateGraphInput {
            title: "Test".into(),
            goal: "Do X".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        };
        let (graph, revision) = svc.create_graph(&input).unwrap();
        let run = svc
            .start_run(&graph.graph_id, &revision.revision_id)
            .unwrap();

        svc.pause_run(&run.run_id).unwrap();
        let paused = svc.get_run(&run.run_id).unwrap();
        assert_eq!(paused.status, RunStatus::Paused);

        svc.resume_run(&run.run_id).unwrap();
        let resumed = svc.get_run(&run.run_id).unwrap();
        assert_eq!(resumed.status, RunStatus::Running);
    }

    #[test]
    fn cancel_run_cancels_non_terminal_node_runs_and_emits_node_events() {
        let svc = TaskService::open_in_memory().unwrap();
        let input = CreateGraphInput {
            title: "Test".into(),
            goal: "Do X".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        };
        let (graph, revision) = svc.create_graph(&input).unwrap();
        let run = svc
            .start_run(&graph.graph_id, &revision.revision_id)
            .unwrap();
        let mut node_run = NodeRun::new("node-run-1", &run.run_id, "node-1", &revision.revision_id);
        node_run.status = crate::orchestrator::domain::run::NodeRunStatus::Running;
        node_run.started_at = Some(now_ms());
        svc.store.save_node_run(&node_run).unwrap();

        svc.cancel_run(&run.run_id).unwrap();

        let cancelled = svc.get_run(&run.run_id).unwrap();
        assert_eq!(cancelled.status, RunStatus::Cancelled);
        let node_runs = svc.get_node_runs(&run.run_id).unwrap();
        assert_eq!(
            node_runs[0].status,
            crate::orchestrator::domain::run::NodeRunStatus::Cancelled
        );
        assert!(node_runs[0].finished_at.is_some());

        let events = svc.run_events_after(&run.run_id, 0).unwrap();
        assert_eq!(
            events[events.len() - 2].event_type,
            TaskEventType::NodeCancelled
        );
        assert_eq!(
            events.last().map(|event| &event.event_type),
            Some(&TaskEventType::RunCancelled)
        );
    }

    #[test]
    fn run_projection_replay() {
        let svc = TaskService::open_in_memory().unwrap();
        let input = CreateGraphInput {
            title: "Test".into(),
            goal: "Do X".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        };
        let (graph, revision) = svc.create_graph(&input).unwrap();
        let run = svc
            .start_run(&graph.graph_id, &revision.revision_id)
            .unwrap();

        let proj = svc.run_projection(&run.run_id).unwrap();
        assert_eq!(proj.graph_id, graph.graph_id);
        assert_eq!(proj.status, RunStatus::Running);
    }

    #[test]
    fn approval_resolution_is_persisted_with_node_transition_and_event() {
        let svc = TaskService::open_in_memory().unwrap();
        let (graph, revision) = svc
            .create_graph(&CreateGraphInput {
                title: "Approval".into(),
                goal: "Approve a write".into(),
                project_root: "/project".into(),
                owner: "user".into(),
                ..Default::default()
            })
            .unwrap();
        let mut policy = NodePolicy::default();
        policy.approval_policy = ApprovalPolicy::Always;
        policy.permission_scope.can_write_files = true;
        let result = svc
            .apply_commands(
                &graph.graph_id,
                &revision.revision_id,
                &[GraphCommand::AddNode {
                    command_id: "add-write".into(),
                    node: GraphNode {
                        node_id: "write".into(),
                        parent_id: Some("goal".into()),
                        title: "Write".into(),
                        description: None,
                        node_kind: NodeKind::Executable,
                        input_contract: Default::default(),
                        output_contract: Default::default(),
                        role_requirement: None,
                        capability_requirements: vec![],
                        agent_assignment_constraint: None,
                        policy,
                        metadata: Default::default(),
                        executable_payload: Some(ExecutablePayload::Write {
                            path: "out.txt".into(),
                            content: "ok".into(),
                            requires_approval: true,
                        }),
                        loop_config: None,
                        approval_gate_config: None,
                    },
                }],
                "user",
            )
            .unwrap();
        let run = svc
            .start_run(&graph.graph_id, &result.revision.revision_id)
            .unwrap();
        let mut node_run = NodeRun::new(
            "nr-approval",
            &run.run_id,
            "write",
            &result.revision.revision_id,
        );
        node_run.status = NodeRunStatus::AwaitingApproval;
        let approval = ApprovalRequest {
            approval_id: "approval-1".into(),
            run_id: run.run_id.clone(),
            node_run_id: node_run.node_run_id.clone(),
            description: "Approve write".into(),
            risk_level: "high".into(),
            scope: vec!["attempt:0".into()],
            requester: "test".into(),
            resolver: None,
            resolved: false,
            approved: None,
            created_at: 2,
            resolved_at: None,
        };
        let events = vec![
            build_event(
                "approval-ready",
                &run.run_id,
                2,
                TaskEventType::NodeReady,
                "test",
                2,
                serde_json::to_value(payloads::NodeReadyPayload {
                    node_run_id: node_run.node_run_id.clone(),
                    node_id: node_run.node_id.clone(),
                })
                .unwrap(),
            ),
            build_event(
                "approval-requested",
                &run.run_id,
                3,
                TaskEventType::ApprovalRequested,
                "test",
                2,
                serde_json::to_value(payloads::ApprovalRequestedPayload {
                    approval_id: approval.approval_id.clone(),
                    node_run_id: node_run.node_run_id.clone(),
                    description: approval.description.clone(),
                    risk_level: approval.risk_level.clone(),
                    scope: approval.scope.clone(),
                })
                .unwrap(),
            ),
        ];
        svc.store
            .save_approval_execution_update(&node_run, &approval, &events)
            .unwrap();

        let resolved = svc
            .resolve_approval("approval-1", true, "reviewer")
            .unwrap();

        assert_eq!(resolved.approved, Some(true));
        assert!(svc.pending_approvals(&run.run_id).unwrap().is_empty());
        assert_eq!(
            svc.get_node_runs(&run.run_id).unwrap()[0].status,
            NodeRunStatus::Blocked
        );
        assert!(svc
            .run_events_after(&run.run_id, 0)
            .unwrap()
            .iter()
            .any(|event| event.event_type == TaskEventType::ApprovalResolved));
        assert!(svc
            .resolve_approval("approval-1", true, "reviewer")
            .is_err());
    }
}
