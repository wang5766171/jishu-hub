use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::time::sleep;

use crate::orchestrator::conversation::TaskInteractionRequest;
use crate::orchestrator::domain::graph::{
    EvaluatorSpec, ExecutablePayload, GraphNode, GraphSnapshot, NodeKind,
};
use crate::orchestrator::domain::policy::{ApprovalPolicy, IdempotencyPolicy};
use crate::orchestrator::domain::run::{
    ApprovalRequest, ArtifactRef, ArtifactSensitivity, AttemptError, AttemptUsage, ErrorCategory,
    Lease, NodeAttempt, NodeRun, NodeRunStatus, RunStatus,
};
use crate::orchestrator::events::{build_event, payloads, TaskEvent, TaskEventType};
use crate::orchestrator::local_actions::execute_local_action;
use crate::orchestrator::recovery::{decide_recovery, RecoveryContext, RecoveryDecision};
use crate::orchestrator::resources::{ResourceArbiter, ResourceLimits};
use crate::orchestrator::runtime_bridge::{
    map_normalized_event, RuntimeEventContext, RuntimeFact, RuntimeInvocationRequest,
    RuntimeStreamItem, TaskAgentRuntime,
};
use crate::orchestrator::scheduler::ReadySetComputer;
use crate::orchestrator::store::TaskStore;
use crate::util::{gen_id, now_ms, redact_sensitive_text};

use self::budget::{budget_violation, fail_run_for_budget, finish_run};
use self::lease::recover_lost_lease;
use self::loops::{drive_loops, start_loop_iteration};
use self::schedule::schedule_node;

const ENGINE_INTERVAL_MS: u64 = 250;
const EVENT_MESSAGE_LIMIT: usize = 4096;
// Checkpoint every ~30 seconds (120 ticks * 250ms = 30s)
const CHECKPOINT_INTERVAL_TICKS: u64 = 120;
/// Refresh the lease heartbeat while a node is executing (every 5s).
const LEASE_HEARTBEAT_INTERVAL_MS: u64 = 5_000;
/// A lease is considered live if its heartbeat is within this window (30s).
const LEASE_HEARTBEAT_TTL_MS: i64 = 30_000;

pub struct EngineHandle {
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct ExecutionEngine {
    store: Arc<TaskStore>,
    runtime: Arc<dyn TaskAgentRuntime>,
    resource_arbiter: Arc<ResourceArbiter>,
    tick_counter: Arc<AtomicU64>,
    ready_caches: Arc<std::sync::Mutex<std::collections::HashMap<String, ReadySetComputer>>>,
}

impl ExecutionEngine {
    pub fn new(store: Arc<TaskStore>, runtime: Arc<dyn TaskAgentRuntime>) -> Self {
        Self {
            store,
            runtime,
            resource_arbiter: Arc::new(ResourceArbiter::new(ResourceLimits::default())),
            tick_counter: Arc::new(AtomicU64::new(0)),
            ready_caches: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub fn start(&self) -> EngineHandle {
        let store = self.store.clone();
        let runtime = self.runtime.clone();
        let resource_arbiter = self.resource_arbiter.clone();
        let tick_counter = self.tick_counter.clone();
        let ready_caches = self.ready_caches.clone();
        EngineHandle {
            task: tauri::async_runtime::spawn(async move {
                loop {
                    if let Err(error) = tick(
                        &store,
                        &runtime,
                        &resource_arbiter,
                        &tick_counter,
                        &ready_caches,
                    )
                    .await
                    {
                        tracing::error!("task execution engine tick failed: {error}");
                    }
                    sleep(Duration::from_millis(ENGINE_INTERVAL_MS)).await;
                }
            }),
        }
    }
}

// 执行引擎按职责拆分（v0.7.3 需求1-M3）：mod.rs 保留引擎骨架与 tick 主循环，
// 调度/执行/Loop 驱动/预算/租约分属子模块；跨模块项以 pub(super) 互联。
mod budget;
mod execute;
mod lease;
mod loops;
mod schedule;

async fn tick(
    store: &Arc<TaskStore>,
    runtime: &Arc<dyn TaskAgentRuntime>,
    resource_arbiter: &Arc<ResourceArbiter>,
    tick_counter: &Arc<AtomicU64>,
    ready_caches: &Arc<std::sync::Mutex<std::collections::HashMap<String, ReadySetComputer>>>,
) -> Result<(), String> {
    // Increment tick counter and check if we should checkpoint. Skip tick 0
    // (startup): the WAL is empty then, so the first checkpoint lands at tick
    // CHECKPOINT_INTERVAL_TICKS (~30s), matching the documented cadence.
    let tick_count = tick_counter.fetch_add(1, Ordering::Relaxed);
    if tick_count > 0 && tick_count % CHECKPOINT_INTERVAL_TICKS == 0 {
        // Periodically checkpoint the WAL to prevent unbounded growth
        if let Err(error) = store.checkpoint() {
            tracing::warn!("WAL checkpoint failed: {error}");
            // Non-fatal: continue the tick loop
        }
    }

    let active_runs = { store.get_active_runs().map_err(|error| error.to_string())? };

    // Collect active run IDs for cache pruning after the loop
    let active_run_ids: std::collections::HashSet<String> =
        active_runs.iter().map(|run| run.run_id.clone()).collect();

    for run in active_runs {
        let (snapshot, node_runs, project_root) = {
            let graph = store
                .get_graph(&run.graph_id)
                .map_err(|error| error.to_string())?;
            let revision = store
                .get_revision(&run.active_revision_id)
                .map_err(|error| error.to_string())?;
            let snapshot = revision.snapshot().map_err(|error| error.to_string())?;
            let node_runs = store
                .get_node_runs(&run.run_id)
                .map_err(|error| error.to_string())?;
            (snapshot, node_runs, graph.project_root)
        };

        // Ordering matters: `recover_lost_lease` MUST run before `drive_loops`. `drive_loops`
        // derives the next run_seq from the store and assumes no concurrent event appends;
        // lease recovery appends events and returns `Ok(true)` → `continue`, so `drive_loops`
        // only runs on a tick where recovery found nothing to do. Do not reorder these.
        if recover_lost_lease(store, resource_arbiter, &run, &snapshot, &node_runs)? {
            continue;
        }

        if drive_loops(store, &run, &snapshot, &node_runs).await? {
            continue;
        }

        let loop_body_ids = loop_body_ids(&snapshot);
        if node_runs.iter().any(|node_run| {
            node_run.status == NodeRunStatus::Failed
                && (!loop_body_ids.contains(&node_run.node_id)
                    || snapshot
                        .node_by_id(&node_run.node_id)
                        .is_some_and(|node| node.node_kind == NodeKind::ControlLoop))
        }) {
            finish_run(store, &run.run_id, &RunStatus::Failed).await?;
            continue;
        }

        let executable_count = snapshot
            .nodes
            .iter()
            .filter(|node| {
                matches!(
                    node.node_kind,
                    crate::orchestrator::domain::graph::NodeKind::Executable
                        | crate::orchestrator::domain::graph::NodeKind::ControlApprovalGate
                        | crate::orchestrator::domain::graph::NodeKind::ControlLoop
                ) && !loop_body_ids.contains(&node.node_id)
            })
            .count();
        let latest_runs = latest_node_runs(&node_runs);
        let terminal_count = snapshot
            .nodes
            .iter()
            .filter(|node| {
                matches!(
                    node.node_kind,
                    NodeKind::Executable | NodeKind::ControlApprovalGate | NodeKind::ControlLoop
                ) && !loop_body_ids.contains(&node.node_id)
            })
            .filter(|node| {
                latest_runs
                    .get(&node.node_id)
                    .is_some_and(|node_run| node_run.status.is_terminal())
            })
            .count();
        let active_count = snapshot
            .nodes
            .iter()
            .filter(|node| node.node_kind == NodeKind::Executable)
            .filter_map(|node| latest_runs.get(&node.node_id))
            .filter(|node_run| {
                matches!(
                    node_run.status,
                    NodeRunStatus::Leased | NodeRunStatus::Running
                )
            })
            .count();

        if executable_count == 0 || (terminal_count == executable_count && active_count == 0) {
            finish_run(store, &run.run_id, &RunStatus::Completed).await?;
            continue;
        }

        if let Some(violation) = budget_violation(&run, now_ms()) {
            fail_run_for_budget(store, &run, violation).await?;
            continue;
        }

        let capacity = resource_arbiter
            .max_parallel_nodes_per_run()
            .saturating_sub(active_count);
        if capacity == 0 {
            continue;
        }

        let now = now_ms();
        let ready_nodes = {
            let mut caches = ready_caches.lock().map_err(|e| e.to_string())?;
            let computer = caches
                .entry(run.run_id.clone())
                .and_modify(|c| {
                    if !c.revision_matches(&run.active_revision_id) {
                        *c = ReadySetComputer::for_revision(&snapshot, &run.active_revision_id);
                    }
                })
                .or_insert_with(|| {
                    ReadySetComputer::for_revision(&snapshot, &run.active_revision_id)
                });
            let ready = computer.update(&snapshot, &latest_runs, now);
            computer.prioritize(&ready, &snapshot, &latest_runs, now)
        };
        for node_id in ready_nodes.into_iter().take(capacity) {
            let Some(node) = snapshot.node_by_id(&node_id).cloned() else {
                tracing::error!("scheduler returned missing node {node_id}");
                continue;
            };
            if node.node_kind == NodeKind::ControlLoop {
                start_loop_iteration(
                    store,
                    &run,
                    &snapshot,
                    &node,
                    latest_runs.get(&node_id).cloned().cloned(),
                )?;
                continue;
            }
            schedule_node(
                store.clone(),
                run.run_id.clone(),
                run.active_revision_id.clone(),
                node,
                project_root.clone(),
                runtime.clone(),
                resource_arbiter.clone(),
                latest_runs.get(&node_id).cloned().cloned(),
            )
            .await?;
        }
    }

    // Prune ready-set caches for finished runs
    if let Ok(mut caches) = ready_caches.lock() {
        caches.retain(|run_id, _| active_run_ids.contains(run_id));
    }

    Ok(())
}

fn latest_node_runs(node_runs: &[NodeRun]) -> std::collections::HashMap<String, &NodeRun> {
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

fn loop_body_ids(snapshot: &GraphSnapshot) -> std::collections::HashSet<String> {
    snapshot
        .nodes
        .iter()
        .filter_map(|node| node.loop_config.as_ref())
        .flat_map(|config| config.body_node_ids.iter().cloned())
        .collect()
}

fn attempt_error(category: ErrorCategory, message: &str, retryable: bool) -> AttemptError {
    AttemptError {
        category,
        message: message.into(),
        retryable,
        retry_after_ms: None,
        provider_detail: None,
    }
}

fn truncate_event_message(message: &str) -> String {
    let message = redact_sensitive_text(message);
    if message.len() <= EVENT_MESSAGE_LIMIT {
        return message;
    }
    let mut end = EVENT_MESSAGE_LIMIT;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &message[..end])
}

#[cfg(test)]
mod tests;
