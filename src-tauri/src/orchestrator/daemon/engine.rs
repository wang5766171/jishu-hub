use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::time::sleep;

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
use crate::orchestrator::resources::{ResourceArbiter, ResourceLimits};
use crate::orchestrator::runtime_bridge::{
    map_normalized_event, RuntimeEventContext, RuntimeFact, RuntimeInvocationRequest,
    TaskAgentRuntime,
};
use crate::orchestrator::scheduler::compute_ready_set;
use crate::orchestrator::store::TaskStore;
use crate::util::{gen_id, now_ms, redact_sensitive_text};

const ENGINE_INTERVAL_MS: u64 = 250;
const MAX_PARALLEL_NODES_PER_RUN: usize = 4;
const EVENT_MESSAGE_LIMIT: usize = 4096;

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
}

impl ExecutionEngine {
    pub fn new(store: Arc<TaskStore>, runtime: Arc<dyn TaskAgentRuntime>) -> Self {
        Self {
            store,
            runtime,
            resource_arbiter: Arc::new(ResourceArbiter::new(ResourceLimits::default())),
        }
    }

    pub fn start(&self) -> EngineHandle {
        let store = self.store.clone();
        let runtime = self.runtime.clone();
        let resource_arbiter = self.resource_arbiter.clone();
        EngineHandle {
            task: tauri::async_runtime::spawn(async move {
                loop {
                    if let Err(error) = tick(&store, &runtime, &resource_arbiter).await {
                        tracing::error!("task execution engine tick failed: {error}");
                    }
                    sleep(Duration::from_millis(ENGINE_INTERVAL_MS)).await;
                }
            }),
        }
    }
}

async fn tick(
    store: &Arc<TaskStore>,
    runtime: &Arc<dyn TaskAgentRuntime>,
    resource_arbiter: &Arc<ResourceArbiter>,
) -> Result<(), String> {
    let active_runs = { store.get_active_runs().map_err(|error| error.to_string())? };

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

        let capacity = MAX_PARALLEL_NODES_PER_RUN.saturating_sub(active_count);
        if capacity == 0 {
            continue;
        }

        let ready_nodes = compute_ready_set(&snapshot, &node_runs, now_ms());
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

fn recover_lost_lease(
    store: &Arc<TaskStore>,
    resource_arbiter: &ResourceArbiter,
    run: &crate::orchestrator::domain::run::GraphRun,
    snapshot: &GraphSnapshot,
    node_runs: &[NodeRun],
) -> Result<bool, String> {
    let now = now_ms();
    for node_run in node_runs.iter().filter(|node_run| {
        matches!(
            node_run.status,
            NodeRunStatus::Leased | NodeRunStatus::Running
        )
    }) {
        let mut attempt = {
            store
                .latest_attempt(&node_run.node_run_id)
                .map_err(|error| error.to_string())?
        };
        let Some(mut attempt) = attempt.take() else {
            continue;
        };
        let Some(lease) = attempt.lease.clone() else {
            continue;
        };
        if resource_arbiter.is_held(&lease.lease_id) || lease.heartbeat_deadline > now {
            continue;
        }
        let Some(node) = snapshot.node_by_id(&node_run.node_id) else {
            continue;
        };

        let error = AttemptError {
            category: ErrorCategory::LostLease,
            message: "execution lease was lost after process interruption".into(),
            retryable: true,
            retry_after_ms: Some(0),
            provider_detail: None,
        };
        attempt.error = Some(error.clone());
        attempt.finished_at = Some(now);
        attempt.lease = None;
        let mut recovered = node_run.clone();
        recovered.error = Some(error.message.clone());
        let current_run = store
            .get_run(&run.run_id)
            .map_err(|error| error.to_string())?;
        let mut events = vec![
            build_event(
                gen_id("evt"),
                &run.run_id,
                current_run.run_seq + 1,
                TaskEventType::LeaseExpired,
                "recovery_controller",
                now,
                serde_json::json!({
                    "lease_id": lease.lease_id,
                    "node_run_id": node_run.node_run_id.clone(),
                    "attempt_id": attempt.attempt_id.clone(),
                }),
            ),
            build_event(
                gen_id("evt"),
                &run.run_id,
                current_run.run_seq + 2,
                TaskEventType::AttemptFailed,
                "recovery_controller",
                now,
                serde_json::to_value(payloads::AttemptFailedPayload {
                    attempt_id: attempt.attempt_id.clone(),
                    node_run_id: node_run.node_run_id.clone(),
                    error: error.clone(),
                })
                .map_err(|error| error.to_string())?,
            ),
        ];
        if should_retry(node, &attempt, &error) {
            recovered.status = NodeRunStatus::RetryWait;
            recovered.wake_at = Some(now);
            recovered.finished_at = None;
            events.push(build_event(
                gen_id("evt"),
                &run.run_id,
                current_run.run_seq + 3,
                TaskEventType::RetryScheduled,
                "recovery_controller",
                now,
                serde_json::to_value(payloads::RetryScheduledPayload {
                    node_run_id: node_run.node_run_id.clone(),
                    next_attempt_number: attempt.attempt_number + 1,
                    wake_at: now,
                    backoff_ms: 0,
                })
                .map_err(|error| error.to_string())?,
            ));
        } else {
            recovered.status = NodeRunStatus::Failed;
            recovered.finished_at = Some(now);
            events.push(node_resolved_event(
                &run.run_id,
                current_run.run_seq + 3,
                &recovered,
                now,
            )?);
        }
        store
            .save_execution_update(&recovered, Some(&attempt), &[], &events, None, None)
            .map_err(|error| error.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

async fn drive_loops(
    store: &Arc<TaskStore>,
    run: &crate::orchestrator::domain::run::GraphRun,
    snapshot: &GraphSnapshot,
    node_runs: &[NodeRun],
) -> Result<bool, String> {
    let now = now_ms();
    for loop_node in snapshot
        .nodes
        .iter()
        .filter(|node| node.node_kind == NodeKind::ControlLoop)
    {
        let Some(config) = loop_node.loop_config.as_ref() else {
            continue;
        };
        let loop_run = node_runs
            .iter()
            .filter(|node_run| node_run.node_id == loop_node.node_id)
            .max_by_key(|node_run| {
                (
                    node_run.loop_iteration.unwrap_or_default(),
                    node_run.started_at.unwrap_or_default(),
                )
            })
            .cloned();
        let Some(mut loop_run) = loop_run else {
            continue;
        };

        if loop_run.status == NodeRunStatus::RetryWait
            && loop_run.wake_at.is_some_and(|wake_at| wake_at <= now)
        {
            start_loop_iteration(store, run, snapshot, loop_node, Some(loop_run))?;
            return Ok(true);
        }
        if loop_run.status != NodeRunStatus::Running {
            continue;
        }

        let iteration = loop_run.loop_iteration.unwrap_or_default();
        let body_runs = config
            .body_node_ids
            .iter()
            .filter_map(|node_id| {
                node_runs
                    .iter()
                    .filter(|node_run| {
                        node_run.node_id == *node_id && node_run.loop_iteration == Some(iteration)
                    })
                    .max_by_key(|node_run| node_run.attempt_count)
            })
            .collect::<Vec<_>>();
        if body_runs.len() != config.body_node_ids.len()
            || body_runs
                .iter()
                .any(|node_run| !node_run.status.is_terminal())
        {
            continue;
        }

        let body_succeeded = body_runs
            .iter()
            .all(|node_run| node_run.status == NodeRunStatus::Succeeded);
        let evaluator_output = match &config.evaluator {
            EvaluatorSpec::NodeRef { node_id } => {
                let evaluator_run = body_runs
                    .iter()
                    .find(|node_run| node_run.node_id == *node_id)
                    .copied()
                    .or_else(|| {
                        node_runs
                            .iter()
                            .filter(|node_run| node_run.node_id == *node_id)
                            .max_by_key(|node_run| node_run.attempt_count)
                    });
                evaluator_run
                    .map(|node_run| read_evaluator_output(store, &node_run.node_run_id))
                    .transpose()?
            }
            EvaluatorSpec::Inline { .. } => None,
        };
        let mut result = crate::orchestrator::loop_controller::evaluate(
            config,
            iteration,
            now,
            body_succeeded,
            evaluator_output.as_ref(),
        )
        .unwrap_or_else(|error| payloads::EvaluatorResult::Fail { error });
        if config.deadline_ms.is_some_and(|deadline_ms| {
            now.saturating_sub(loop_run.started_at.unwrap_or(now)) >= deadline_ms as i64
        }) {
            result = payloads::EvaluatorResult::Fail {
                error: "loop deadline exceeded".into(),
            };
        }

        let current_run = store
            .get_run(&run.run_id)
            .map_err(|error| error.to_string())?;
        let mut events = vec![build_event(
            gen_id("evt"),
            &run.run_id,
            current_run.run_seq + 1,
            TaskEventType::ProgressEvaluated,
            "loop_controller",
            now,
            serde_json::to_value(payloads::ProgressEvaluatedPayload {
                loop_node_id: loop_node.node_id.clone(),
                iteration,
                result: result.clone(),
            })
            .map_err(|error| error.to_string())?,
        )];

        match result {
            payloads::EvaluatorResult::Continue => {
                let next_iteration = iteration + 1;
                loop_run.loop_iteration = Some(next_iteration);
                loop_run.wake_at = None;
                let mut updates = vec![loop_run];
                updates.extend(new_loop_body_runs(
                    &run.run_id,
                    &run.active_revision_id,
                    config,
                    next_iteration,
                ));
                events.push(iteration_started_event(
                    &run.run_id,
                    current_run.run_seq + 2,
                    &loop_node.node_id,
                    next_iteration,
                    now,
                )?);
                store
                    .save_node_runs_with_events(&updates, &events, None)
                    .map_err(|error| error.to_string())?;
            }
            payloads::EvaluatorResult::Wait { wake_at } => {
                loop_run.status = NodeRunStatus::RetryWait;
                loop_run.loop_iteration = Some(iteration + 1);
                loop_run.wake_at = Some(wake_at);
                loop_run.finished_at = None;
                events.push(build_event(
                    gen_id("evt"),
                    &run.run_id,
                    current_run.run_seq + 2,
                    TaskEventType::LoopSleeping,
                    "loop_controller",
                    now,
                    serde_json::to_value(payloads::LoopSleepingPayload {
                        loop_node_id: loop_node.node_id.clone(),
                        wake_at,
                    })
                    .map_err(|error| error.to_string())?,
                ));
                store
                    .save_node_runs_with_events(&[loop_run], &events, None)
                    .map_err(|error| error.to_string())?;
            }
            payloads::EvaluatorResult::Complete { result } => {
                loop_run.status = NodeRunStatus::Succeeded;
                loop_run.finished_at = Some(now);
                loop_run.wake_at = None;
                events.push(build_event(
                    gen_id("evt"),
                    &run.run_id,
                    current_run.run_seq + 2,
                    TaskEventType::LoopCompleted,
                    "loop_controller",
                    now,
                    serde_json::to_value(payloads::LoopCompletedPayload {
                        loop_node_id: loop_node.node_id.clone(),
                        total_iterations: iteration + 1,
                        final_result: result,
                    })
                    .map_err(|error| error.to_string())?,
                ));
                events.push(node_resolved_event(
                    &run.run_id,
                    current_run.run_seq + 3,
                    &loop_run,
                    now,
                )?);
                store
                    .save_node_runs_with_events(&[loop_run], &events, None)
                    .map_err(|error| error.to_string())?;
            }
            payloads::EvaluatorResult::Pause { reason } => {
                loop_run.status = NodeRunStatus::Blocked;
                loop_run.loop_iteration = Some(iteration + 1);
                loop_run.error = Some(reason);
                events.push(build_event(
                    gen_id("evt"),
                    &run.run_id,
                    current_run.run_seq + 2,
                    TaskEventType::RunPaused,
                    "loop_controller",
                    now,
                    serde_json::Value::Null,
                ));
                store
                    .save_node_runs_with_events(
                        &[loop_run],
                        &events,
                        Some((&RunStatus::Paused, None)),
                    )
                    .map_err(|error| error.to_string())?;
            }
            payloads::EvaluatorResult::Fail { error } => {
                loop_run.status = NodeRunStatus::Failed;
                loop_run.error = Some(error);
                loop_run.finished_at = Some(now);
                events.push(node_resolved_event(
                    &run.run_id,
                    current_run.run_seq + 2,
                    &loop_run,
                    now,
                )?);
                store
                    .save_node_runs_with_events(&[loop_run], &events, None)
                    .map_err(|error| error.to_string())?;
            }
        }
        return Ok(true);
    }
    Ok(false)
}

fn start_loop_iteration(
    store: &Arc<TaskStore>,
    run: &crate::orchestrator::domain::run::GraphRun,
    _snapshot: &GraphSnapshot,
    loop_node: &GraphNode,
    existing_loop_run: Option<NodeRun>,
) -> Result<(), String> {
    let config = loop_node
        .loop_config
        .as_ref()
        .ok_or_else(|| format!("loop node {} has no config", loop_node.node_id))?;
    let now = now_ms();
    let initial = existing_loop_run.is_none();
    let mut loop_run = existing_loop_run.unwrap_or_else(|| {
        let mut node_run = NodeRun::new(
            gen_id("nr"),
            &run.run_id,
            &loop_node.node_id,
            &run.active_revision_id,
        );
        node_run.loop_iteration = Some(0);
        node_run.started_at = Some(now);
        node_run
    });
    let iteration = loop_run.loop_iteration.unwrap_or_default();
    loop_run.status = NodeRunStatus::Running;
    loop_run.wake_at = None;
    loop_run.error = None;

    let current_run = store
        .get_run(&run.run_id)
        .map_err(|error| error.to_string())?;
    let mut events = Vec::new();
    if initial {
        events.push(build_event(
            gen_id("evt"),
            &run.run_id,
            current_run.run_seq + 1,
            TaskEventType::NodeReady,
            "scheduler",
            now,
            serde_json::to_value(payloads::NodeReadyPayload {
                node_run_id: loop_run.node_run_id.clone(),
                node_id: loop_node.node_id.clone(),
            })
            .map_err(|error| error.to_string())?,
        ));
        events.push(build_event(
            gen_id("evt"),
            &run.run_id,
            current_run.run_seq + 2,
            TaskEventType::LoopStarted,
            "loop_controller",
            now,
            serde_json::to_value(payloads::LoopStartedPayload {
                loop_node_id: loop_node.node_id.clone(),
                run_id: run.run_id.clone(),
                max_iterations: config.max_iterations,
            })
            .map_err(|error| error.to_string())?,
        ));
    }
    events.push(iteration_started_event(
        &run.run_id,
        current_run.run_seq + events.len() as u64 + 1,
        &loop_node.node_id,
        iteration,
        now,
    )?);
    let mut updates = vec![loop_run];
    updates.extend(new_loop_body_runs(
        &run.run_id,
        &run.active_revision_id,
        config,
        iteration,
    ));
    store
        .save_node_runs_with_events(&updates, &events, None)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn new_loop_body_runs(
    run_id: &str,
    revision_id: &str,
    config: &crate::orchestrator::domain::graph::LoopControllerConfig,
    iteration: u32,
) -> Vec<NodeRun> {
    config
        .body_node_ids
        .iter()
        .map(|node_id| {
            let mut node_run = NodeRun::new(gen_id("nr"), run_id, node_id, revision_id);
            node_run.loop_iteration = Some(iteration);
            node_run
        })
        .collect()
}

fn iteration_started_event(
    run_id: &str,
    run_seq: u64,
    loop_node_id: &str,
    iteration: u32,
    now: i64,
) -> Result<TaskEvent, String> {
    Ok(build_event(
        gen_id("evt"),
        run_id,
        run_seq,
        TaskEventType::IterationStarted,
        "loop_controller",
        now,
        serde_json::to_value(payloads::IterationStartedPayload {
            loop_node_id: loop_node_id.to_string(),
            iteration,
        })
        .map_err(|error| error.to_string())?,
    ))
}

fn node_resolved_event(
    run_id: &str,
    run_seq: u64,
    node_run: &NodeRun,
    now: i64,
) -> Result<TaskEvent, String> {
    Ok(build_event(
        gen_id("evt"),
        run_id,
        run_seq,
        TaskEventType::NodeResolved,
        "loop_controller",
        now,
        serde_json::to_value(payloads::NodeResolvedPayload {
            node_run_id: node_run.node_run_id.clone(),
            node_id: node_run.node_id.clone(),
            final_status: node_run.status.clone(),
        })
        .map_err(|error| error.to_string())?,
    ))
}

fn read_evaluator_output(
    store: &Arc<TaskStore>,
    node_run_id: &str,
) -> Result<serde_json::Value, String> {
    let attempt = store
        .latest_attempt(node_run_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("evaluator node run {node_run_id} has no attempt"))?;
    let output = attempt
        .checkpoint
        .and_then(|checkpoint| checkpoint.get("output").cloned())
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| format!("evaluator node run {node_run_id} has no output checkpoint"))?;
    serde_json::from_str(&output)
        .map_err(|error| format!("evaluator output is not structured JSON: {error}"))
}

async fn schedule_node(
    store: Arc<TaskStore>,
    run_id: String,
    revision_id: String,
    node: GraphNode,
    project_root: std::path::PathBuf,
    runtime: Arc<dyn TaskAgentRuntime>,
    resource_arbiter: Arc<ResourceArbiter>,
    existing_node_run: Option<NodeRun>,
) -> Result<(), String> {
    let now = now_ms();
    let mut node_run = existing_node_run
        .unwrap_or_else(|| NodeRun::new(gen_id("nr"), &run_id, &node.node_id, &revision_id));
    let node_run_id = node_run.node_run_id.clone();
    let attempt_number = node_run.attempt_count;

    if let Some(requirement) = approval_requirement(&node, attempt_number) {
        let approved = {
            store
                .has_approved_request(&run_id, &node_run_id, &requirement.scope_marker)
                .map_err(|error| error.to_string())?
        };
        if !approved {
            let approval_id = gen_id("approval");
            node_run.status = NodeRunStatus::AwaitingApproval;
            node_run.wake_at = None;
            let approval = ApprovalRequest {
                approval_id: approval_id.clone(),
                run_id: run_id.clone(),
                node_run_id: node_run_id.clone(),
                description: requirement.description,
                risk_level: requirement.risk_level,
                scope: vec![requirement.scope_marker],
                requester: "task_orchestrator".into(),
                resolver: None,
                resolved: false,
                approved: None,
                created_at: now,
                resolved_at: None,
            };
            let run = store.get_run(&run_id).map_err(|error| error.to_string())?;
            if run.status != RunStatus::Running || run.active_revision_id != revision_id {
                return Ok(());
            }
            let events = vec![
                build_event(
                    gen_id("evt"),
                    &run_id,
                    run.run_seq + 1,
                    TaskEventType::NodeReady,
                    "scheduler",
                    now,
                    serde_json::to_value(payloads::NodeReadyPayload {
                        node_run_id: node_run_id.clone(),
                        node_id: node.node_id.clone(),
                    })
                    .map_err(|error| error.to_string())?,
                ),
                build_event(
                    gen_id("evt"),
                    &run_id,
                    run.run_seq + 2,
                    TaskEventType::ApprovalRequested,
                    "task_orchestrator",
                    now,
                    serde_json::to_value(payloads::ApprovalRequestedPayload {
                        approval_id,
                        node_run_id: node_run_id.clone(),
                        description: approval.description.clone(),
                        risk_level: approval.risk_level.clone(),
                        scope: approval.scope.clone(),
                    })
                    .map_err(|error| error.to_string())?,
                ),
            ];
            store
                .save_approval_execution_update(&node_run, &approval, &events)
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
    }

    let attempt_id = gen_id("attempt");
    let lease_id = gen_id("lease");
    let Some(resource_permit) = resource_arbiter.try_acquire(&lease_id, &node, &project_root)
    else {
        return Ok(());
    };
    let leased_resources = resource_permit.resources().to_vec();
    node_run.status = NodeRunStatus::Running;
    node_run.started_at.get_or_insert(now);
    node_run.finished_at = None;
    node_run.error = None;
    node_run.wake_at = None;
    node_run.attempt_count = attempt_number + 1;
    node_run.loop_iteration.get_or_insert(0);

    let lease = Lease {
        lease_id: lease_id.clone(),
        node_run_id: node_run_id.clone(),
        attempt_id: attempt_id.clone(),
        owner: "local_execution_engine".into(),
        resources: leased_resources.clone(),
        expires_at: now + 60_000,
        heartbeat_deadline: now + 30_000,
    };
    let prepared_agent = prepare_agent_execution(runtime.as_ref(), &node, &project_root);
    let mut attempt = NodeAttempt {
        attempt_id: attempt_id.clone(),
        node_run_id: node_run_id.clone(),
        attempt_number,
        agent_assignment: prepared_agent
            .as_ref()
            .ok()
            .and_then(|prepared| prepared.as_ref().map(|value| value.assignment.clone())),
        transport: prepared_agent
            .as_ref()
            .ok()
            .and_then(|prepared| prepared.as_ref().map(|value| value.transport.clone()))
            .or_else(|| Some("local_os_adapter".into())),
        session_id: None,
        lease: Some(lease),
        usage: AttemptUsage::default(),
        error: None,
        idempotency_key: Some(format!("{run_id}:{node_run_id}:{attempt_number}")),
        checkpoint: None,
        started_at: now,
        finished_at: None,
    };

    {
        let run = store.get_run(&run_id).map_err(|error| error.to_string())?;
        if run.status != RunStatus::Running || run.active_revision_id != revision_id {
            return Ok(());
        }
        let events = vec![
            build_event(
                gen_id("evt"),
                &run_id,
                run.run_seq + 1,
                TaskEventType::NodeReady,
                "scheduler",
                now,
                serde_json::to_value(payloads::NodeReadyPayload {
                    node_run_id: node_run_id.clone(),
                    node_id: node.node_id.clone(),
                })
                .map_err(|error| error.to_string())?,
            ),
            build_event(
                gen_id("evt"),
                &run_id,
                run.run_seq + 2,
                TaskEventType::LeaseGranted,
                "resource_arbiter",
                now,
                serde_json::to_value(payloads::LeaseGrantedPayload {
                    lease_id,
                    node_run_id: node_run_id.clone(),
                    attempt_id: attempt_id.clone(),
                    resources: leased_resources
                        .iter()
                        .map(|resource| format!("{resource:?}"))
                        .collect(),
                    expires_at: now + 60_000,
                })
                .map_err(|error| error.to_string())?,
            ),
            build_event(
                gen_id("evt"),
                &run_id,
                run.run_seq + 3,
                TaskEventType::AttemptStarted,
                "task_orchestrator",
                now,
                serde_json::to_value(payloads::AttemptStartedPayload {
                    attempt_id: attempt_id.clone(),
                    node_run_id: node_run_id.clone(),
                    attempt_number,
                    agent_assignment: attempt.agent_assignment.clone(),
                    transport: attempt.transport.clone(),
                    idempotency_key: attempt.idempotency_key.clone(),
                })
                .map_err(|error| error.to_string())?,
            ),
        ];
        store
            .save_execution_update(&node_run, Some(&attempt), &[], &events, None, None)
            .map_err(|error| error.to_string())?;
    }

    tokio::spawn(async move {
        let _resource_permit = resource_permit;
        let cancellation = Arc::new(AtomicBool::new(false));
        let result = tokio::select! {
            result = execute_node(
                &node,
                &project_root,
                runtime.as_ref(),
                prepared_agent,
                RuntimeEventContext {
                    run_id: run_id.clone(),
                    node_run_id: node_run_id.clone(),
                    attempt_id: attempt_id.clone(),
                },
                cancellation.clone(),
            ) => Some(result),
            _ = wait_for_terminal_run(&store, &run_id) => {
                cancellation.store(true, Ordering::Release);
                None
            },
        };
        let Some(result) = result else {
            return;
        };
        let finished_at = now_ms();
        node_run.finished_at = Some(finished_at);
        attempt.finished_at = Some(finished_at);
        attempt.lease = None;

        let run = match store.get_run(&run_id) {
            Ok(run) => run,
            Err(error) => {
                tracing::error!("failed to reload run {run_id}: {error}");
                return;
            }
        };
        if run.status.is_terminal() {
            return;
        }

        let mut events = Vec::<TaskEvent>::new();
        let mut artifacts = Vec::<ArtifactRef>::new();
        let mut resolve_node = true;
        match result {
            Ok(output) => {
                node_run.status = NodeRunStatus::Succeeded;
                attempt.session_id = output.session_id;
                attempt.usage = output.usage.clone();
                let output_text = output
                    .progress
                    .iter()
                    .map(|progress| progress.message.as_str())
                    .collect::<Vec<_>>()
                    .join("");
                let persisted_output = redact_sensitive_text(&output_text);
                attempt.checkpoint = Some(serde_json::json!({
                    "output": persisted_output,
                }));
                for name in &node.output_contract.artifacts {
                    let artifact = ArtifactRef {
                        artifact_id: gen_id("artifact"),
                        run_id: run_id.clone(),
                        node_run_id: node_run_id.clone(),
                        attempt_id: attempt_id.clone(),
                        name: name.clone(),
                        artifact_type: "node_output".into(),
                        hash: format!("{:x}", Sha256::digest(output_text.as_bytes())),
                        sensitivity: ArtifactSensitivity::Internal,
                        created_at: finished_at,
                        metadata: std::collections::HashMap::from([
                            ("node_id".into(), serde_json::json!(node.node_id.clone())),
                            (
                                "content_length".into(),
                                serde_json::json!(output_text.len()),
                            ),
                            ("content_redacted".into(), serde_json::json!(true)),
                        ]),
                    };
                    let payload = match serde_json::to_value(payloads::ArtifactProducedPayload {
                        artifact_id: artifact.artifact_id.clone(),
                        attempt_id: attempt_id.clone(),
                        name: artifact.name.clone(),
                        artifact_type: artifact.artifact_type.clone(),
                        hash: artifact.hash.clone(),
                    }) {
                        Ok(payload) => payload,
                        Err(error) => {
                            tracing::error!(
                                "failed to serialize artifact for node {}: {error}",
                                node.node_id
                            );
                            return;
                        }
                    };
                    events.push(build_event(
                        gen_id("evt"),
                        &run_id,
                        run.run_seq + events.len() as u64 + 1,
                        TaskEventType::ArtifactProduced,
                        "task_orchestrator",
                        finished_at,
                        payload,
                    ));
                    artifacts.push(artifact);
                }
                for progress in output.progress {
                    let payload = match serde_json::to_value(payloads::AttemptProgressedPayload {
                        attempt_id: attempt_id.clone(),
                        node_run_id: node_run_id.clone(),
                        message: truncate_event_message(&progress.message),
                        usage_delta: progress.usage_delta,
                    }) {
                        Ok(payload) => payload,
                        Err(error) => {
                            tracing::error!(
                                "failed to serialize progress for node {}: {error}",
                                node.node_id
                            );
                            return;
                        }
                    };
                    events.push(build_event(
                        gen_id("evt"),
                        &run_id,
                        run.run_seq + events.len() as u64 + 1,
                        TaskEventType::AttemptProgressed,
                        &progress.actor,
                        finished_at,
                        payload,
                    ));
                }
                if attempt.usage.input_tokens > 0
                    || attempt.usage.output_tokens > 0
                    || attempt.usage.cost_usd > 0.0
                {
                    let payload = match serde_json::to_value(payloads::AttemptProgressedPayload {
                        attempt_id: attempt_id.clone(),
                        node_run_id: node_run_id.clone(),
                        message: String::new(),
                        usage_delta: attempt.usage.clone(),
                    }) {
                        Ok(payload) => payload,
                        Err(error) => {
                            tracing::error!(
                                "failed to serialize usage for node {}: {error}",
                                node.node_id
                            );
                            return;
                        }
                    };
                    events.push(build_event(
                        gen_id("evt"),
                        &run_id,
                        run.run_seq + events.len() as u64 + 1,
                        TaskEventType::AttemptProgressed,
                        "task_orchestrator",
                        finished_at,
                        payload,
                    ));
                }
            }
            Err(mut error) => {
                error.message = redact_sensitive_text(&error.message);
                node_run.error = Some(error.message.clone());
                attempt.error = Some(error.clone());
                let payload = match serde_json::to_value(payloads::AttemptFailedPayload {
                    attempt_id: attempt_id.clone(),
                    node_run_id: node_run_id.clone(),
                    error: error.clone(),
                }) {
                    Ok(payload) => payload,
                    Err(error) => {
                        tracing::error!(
                            "failed to serialize failure for node {}: {error}",
                            node.node_id
                        );
                        return;
                    }
                };
                events.push(build_event(
                    gen_id("evt"),
                    &run_id,
                    run.run_seq + 1,
                    TaskEventType::AttemptFailed,
                    "task_orchestrator",
                    finished_at,
                    payload,
                ));
                if should_retry(&node, &attempt, &error) {
                    let backoff_ms = error.retry_after_ms.unwrap_or_else(|| {
                        node.policy.retry_policy.backoff_ms(attempt.attempt_number)
                    });
                    let wake_at = finished_at.saturating_add(backoff_ms as i64);
                    node_run.status = NodeRunStatus::RetryWait;
                    node_run.finished_at = None;
                    node_run.wake_at = Some(wake_at);
                    resolve_node = false;
                    let retry_payload =
                        match serde_json::to_value(payloads::RetryScheduledPayload {
                            node_run_id: node_run_id.clone(),
                            next_attempt_number: attempt.attempt_number + 1,
                            wake_at,
                            backoff_ms,
                        }) {
                            Ok(payload) => payload,
                            Err(error) => {
                                tracing::error!(
                                    "failed to serialize retry for node {}: {error}",
                                    node.node_id
                                );
                                return;
                            }
                        };
                    events.push(build_event(
                        gen_id("evt"),
                        &run_id,
                        run.run_seq + events.len() as u64 + 1,
                        TaskEventType::RetryScheduled,
                        "recovery_controller",
                        finished_at,
                        retry_payload,
                    ));
                } else {
                    node_run.status = NodeRunStatus::Failed;
                }
            }
        }
        if resolve_node {
            let resolved_payload = match serde_json::to_value(payloads::NodeResolvedPayload {
                node_run_id: node_run_id.clone(),
                node_id: node.node_id.clone(),
                final_status: node_run.status.clone(),
            }) {
                Ok(payload) => payload,
                Err(error) => {
                    tracing::error!(
                        "failed to serialize resolution for node {}: {error}",
                        node.node_id
                    );
                    return;
                }
            };
            events.push(build_event(
                gen_id("evt"),
                &run_id,
                run.run_seq + events.len() as u64 + 1,
                TaskEventType::NodeResolved,
                "task_orchestrator",
                finished_at,
                resolved_payload,
            ));
        }

        if let Err(error) = store.save_execution_update(
            &node_run,
            Some(&attempt),
            &artifacts,
            &events,
            Some(&attempt.usage),
            None,
        ) {
            tracing::error!(
                "failed to persist node completion {}: {error}",
                node.node_id
            );
        }
    });

    Ok(())
}

fn should_retry(node: &GraphNode, attempt: &NodeAttempt, error: &AttemptError) -> bool {
    if !error.retryable
        || !matches!(
            error.category,
            ErrorCategory::Transient | ErrorCategory::LostLease
        )
    {
        return false;
    }
    if !node
        .policy
        .retry_policy
        .should_retry(attempt.attempt_number, true)
    {
        return false;
    }
    match node.policy.idempotency_policy {
        IdempotencyPolicy::NoRetry => false,
        IdempotencyPolicy::CheckpointRequired => attempt.checkpoint.is_some(),
        IdempotencyPolicy::None | IdempotencyPolicy::IdempotencyKey => true,
    }
}

async fn execute_node(
    node: &GraphNode,
    project_root: &std::path::Path,
    runtime: &dyn TaskAgentRuntime,
    prepared_agent: Result<Option<PreparedAgentExecution>, String>,
    context: RuntimeEventContext,
    cancellation: Arc<AtomicBool>,
) -> Result<NodeExecutionOutput, AttemptError> {
    let Some(payload) = &node.executable_payload else {
        return Err(attempt_error(
            ErrorCategory::Deterministic,
            "executable node has no payload",
            false,
        ));
    };

    match payload {
        ExecutablePayload::Shell { .. }
        | ExecutablePayload::Read { .. }
        | ExecutablePayload::Write { .. }
        | ExecutablePayload::Verify { .. } => {
            let mut effective_policy = node.policy.clone();
            effective_policy.approval_policy = ApprovalPolicy::Never;
            let effective_payload = match payload {
                ExecutablePayload::Write { path, content, .. } => ExecutablePayload::Write {
                    path: path.clone(),
                    content: content.clone(),
                    requires_approval: false,
                },
                _ => payload.clone(),
            };
            let output =
                execute_local_action(&effective_payload, project_root, &effective_policy).await?;
            if output.exit_code != Some(0) {
                return Err(attempt_error(
                    ErrorCategory::Deterministic,
                    &format!(
                        "command exited with {:?}: {}",
                        output.exit_code,
                        output.stderr.trim()
                    ),
                    false,
                ));
            }
            Ok(NodeExecutionOutput {
                progress: if output.stdout.is_empty() {
                    vec![]
                } else {
                    vec![ExecutionProgress {
                        actor: "local_os_adapter".into(),
                        message: output.stdout,
                        usage_delta: AttemptUsage::default(),
                    }]
                },
                usage: AttemptUsage::default(),
                session_id: None,
            })
        }
        ExecutablePayload::Dispatch {
            prompt,
            project,
            session,
            ..
        } => {
            let prepared = required_prepared_agent(prepared_agent)?;
            let request = RuntimeInvocationRequest {
                agent_id: prepared.assignment.agent_id.clone(),
                role_id: prepared.assignment.role_id.clone(),
                project_path: project
                    .as_deref()
                    .unwrap_or(project_root)
                    .to_string_lossy()
                    .into_owned(),
                session_id: session.clone(),
                prompt: agent_prompt_with_policy(prompt, &node.policy),
                timeout_ms: node.policy.timeout_ms.unwrap_or(600_000),
                cancellation: cancellation.clone(),
            };
            execute_agent(runtime, prepared, request, context).await
        }
        ExecutablePayload::Reflect { question } => {
            let prepared = required_prepared_agent(prepared_agent)?;
            let request = RuntimeInvocationRequest {
                agent_id: prepared.assignment.agent_id.clone(),
                role_id: prepared.assignment.role_id.clone(),
                project_path: project_root.to_string_lossy().into_owned(),
                session_id: None,
                prompt: question.clone(),
                timeout_ms: node.policy.timeout_ms.unwrap_or(600_000),
                cancellation,
            };
            execute_agent(runtime, prepared, request, context).await
        }
    }
}

struct ApprovalRequirement {
    description: String,
    risk_level: String,
    scope_marker: String,
}

fn approval_requirement(node: &GraphNode, attempt_number: u32) -> Option<ApprovalRequirement> {
    if let Some(config) = &node.approval_gate_config {
        return Some(ApprovalRequirement {
            description: config.description.clone(),
            risk_level: format!("{:?}", config.risk_level).to_ascii_lowercase(),
            scope_marker: format!("approval_gate:{attempt_number}"),
        });
    }

    let payload_requires_approval = matches!(
        node.executable_payload,
        Some(ExecutablePayload::Write {
            requires_approval: true,
            ..
        })
    );
    let high_risk = payload_requires_approval
        || matches!(
            node.executable_payload,
            Some(ExecutablePayload::Shell { .. } | ExecutablePayload::Write { .. })
        )
        || node.policy.permission_scope.can_write_files
        || node.policy.permission_scope.can_run_commands
        || node.policy.permission_scope.can_access_network
        || node.policy.permission_scope.can_deploy;

    let required = match node.policy.approval_policy {
        ApprovalPolicy::Never => payload_requires_approval,
        ApprovalPolicy::Once | ApprovalPolicy::Always => true,
        ApprovalPolicy::OnHighRisk => high_risk,
    };
    required.then(|| ApprovalRequirement {
        description: format!("Approve execution of node '{}'", node.title),
        risk_level: if high_risk { "high" } else { "medium" }.into(),
        scope_marker: if matches!(node.policy.approval_policy, ApprovalPolicy::Always) {
            format!("attempt:{attempt_number}")
        } else {
            "node".into()
        },
    })
}

fn agent_prompt_with_policy(
    prompt: &str,
    policy: &crate::orchestrator::domain::policy::NodePolicy,
) -> String {
    let permissions = &policy.permission_scope;
    format!(
        "Task Orchestrator execution contract:\n\
- read_files: {}\n\
- write_files: {}\n\
- run_commands: {}\n\
- access_network: {}\n\
- deploy: {}\n\
Do not perform or ask a sub-agent to perform any action marked false. \
Stay within the project root and the declared task scope. \
Return concrete output and acceptance evidence.\n\n{}",
        permissions.can_read_files,
        permissions.can_write_files,
        permissions.can_run_commands,
        permissions.can_access_network,
        permissions.can_deploy,
        prompt
    )
}

#[derive(Debug, Clone)]
struct PreparedAgentExecution {
    assignment: crate::orchestrator::domain::run::AgentAssignment,
    transport: String,
}

#[derive(Debug)]
struct ExecutionProgress {
    actor: String,
    message: String,
    usage_delta: AttemptUsage,
}

#[derive(Debug)]
struct NodeExecutionOutput {
    progress: Vec<ExecutionProgress>,
    usage: AttemptUsage,
    session_id: Option<String>,
}

fn prepare_agent_execution(
    runtime: &dyn TaskAgentRuntime,
    node: &GraphNode,
    _project_root: &std::path::Path,
) -> Result<Option<PreparedAgentExecution>, String> {
    let resolution = match node.executable_payload.as_ref() {
        Some(ExecutablePayload::Dispatch { role_id, .. }) => Some((node.clone(), role_id.clone())),
        Some(ExecutablePayload::Reflect { .. }) => {
            let mut supervisor_node = node.clone();
            if !supervisor_node
                .capability_requirements
                .iter()
                .any(|capability| capability == "task_supervision")
            {
                supervisor_node
                    .capability_requirements
                    .push("task_supervision".into());
            }
            Some((
                supervisor_node,
                node.role_requirement
                    .as_ref()
                    .map(|role| role.role_id.clone())
                    .unwrap_or_else(|| "supervisor".into()),
            ))
        }
        _ => None,
    };
    resolution
        .map(|(resolution_node, role_id)| {
            runtime
                .resolve_agent(&resolution_node, &role_id)
                .map(|(assignment, transport)| PreparedAgentExecution {
                    assignment,
                    transport,
                })
        })
        .transpose()
}

fn required_prepared_agent(
    prepared: Result<Option<PreparedAgentExecution>, String>,
) -> Result<PreparedAgentExecution, AttemptError> {
    prepared
        .map_err(|message| attempt_error(ErrorCategory::Policy, &message, false))?
        .ok_or_else(|| {
            attempt_error(
                ErrorCategory::Deterministic,
                "agent executable was not prepared",
                false,
            )
        })
}

async fn execute_agent(
    runtime: &dyn TaskAgentRuntime,
    prepared: PreparedAgentExecution,
    request: RuntimeInvocationRequest,
    context: RuntimeEventContext,
) -> Result<NodeExecutionOutput, AttemptError> {
    let output = runtime
        .invoke(request)
        .await
        .map_err(|message| attempt_error(ErrorCategory::Transient, &message, true))?;
    let mut progress = Vec::new();
    let mut usage = AttemptUsage::default();
    let mut session_id = None;
    let mut failure = None;
    let mut completed = false;

    for event in &output.events {
        match map_normalized_event(&context, event) {
            RuntimeFact::Progress {
                message,
                usage_delta,
                ..
            } => progress.push(ExecutionProgress {
                actor: prepared.assignment.agent_id.clone(),
                message,
                usage_delta,
            }),
            RuntimeFact::Diagnostic { payload, .. } => progress.push(ExecutionProgress {
                actor: prepared.assignment.agent_id.clone(),
                message: payload.to_string(),
                usage_delta: AttemptUsage::default(),
            }),
            RuntimeFact::SessionResolved {
                session_id: resolved,
                ..
            } => session_id = Some(resolved),
            RuntimeFact::Completed {
                usage: completed_usage,
                ..
            } => {
                usage = completed_usage;
                completed = true;
            }
            RuntimeFact::Failed { error, .. } => failure = Some(error),
            RuntimeFact::ApprovalRequested {
                request_id,
                approval_kind,
                ..
            } => {
                failure = Some(attempt_error(
                    ErrorCategory::Policy,
                    &format!(
                        "runtime approval {request_id} ({approval_kind}) requires an approval gate"
                    ),
                    false,
                ));
            }
        }
    }

    if let Some(error) = failure {
        return Err(error);
    }
    if !output.exit_success {
        return Err(attempt_error(
            ErrorCategory::Transient,
            &format!("agent process exited with {:?}", output.exit_code),
            true,
        ));
    }
    if !completed {
        progress.push(ExecutionProgress {
            actor: prepared.assignment.agent_id,
            message: "agent process completed without an explicit turn-complete event".into(),
            usage_delta: AttemptUsage::default(),
        });
    }
    Ok(NodeExecutionOutput {
        progress,
        usage,
        session_id,
    })
}

async fn finish_run(
    store: &Arc<TaskStore>,
    run_id: &str,
    final_status: &RunStatus,
) -> Result<(), String> {
    let run = store.get_run(run_id).map_err(|error| error.to_string())?;
    if run.status != RunStatus::Running {
        return Ok(());
    }
    let now = now_ms();
    if final_status == &RunStatus::Failed {
        let node_runs = store
            .get_node_runs(run_id)
            .map_err(|error| error.to_string())?;
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
                "task_orchestrator",
                now,
                serde_json::to_value(payloads::NodeStatusChangedPayload {
                    node_run_id: node_run.node_run_id.clone(),
                    node_id: node_run.node_id.clone(),
                    old_status: node_run.status.clone(),
                    new_status: NodeRunStatus::Cancelled,
                })
                .map_err(|error| error.to_string())?,
            ));
        }
        events.push(build_event(
            gen_id("evt"),
            run_id,
            run.run_seq + events.len() as u64 + 1,
            TaskEventType::RunFailed,
            "task_orchestrator",
            now,
            serde_json::Value::Null,
        ));
        let cancelled_node_run_ids = active_node_runs
            .iter()
            .map(|node_run| node_run.node_run_id.clone())
            .collect::<Vec<_>>();
        return store
            .terminate_run_with_events(
                run_id,
                &run.status,
                final_status,
                now,
                &cancelled_node_run_ids,
                &events,
            )
            .map_err(|error| error.to_string());
    }

    let event = match final_status {
        RunStatus::Completed => build_event(
            gen_id("evt"),
            run_id,
            run.run_seq + 1,
            TaskEventType::RunCompleted,
            "task_orchestrator",
            now,
            serde_json::to_value(payloads::RunCompletedPayload {
                run_id: run_id.into(),
                final_status: RunStatus::Completed,
                total_usage: AttemptUsage {
                    input_tokens: run.budget_state.token_used,
                    output_tokens: 0,
                    cost_usd: run.budget_state.cost_used_usd,
                },
            })
            .map_err(|error| error.to_string())?,
        ),
        _ => return Err(format!("unsupported terminal run status {final_status:?}")),
    };
    store
        .transition_run_with_event(run_id, &run.status, final_status, Some(now), &event)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone)]
struct BudgetViolation {
    budget_type: &'static str,
    used: f64,
    limit: f64,
}

fn budget_violation(
    run: &crate::orchestrator::domain::run::GraphRun,
    now: i64,
) -> Option<BudgetViolation> {
    if let Some(limit) = run.budget_state.token_limit {
        if run.budget_state.token_used >= limit {
            return Some(BudgetViolation {
                budget_type: "token",
                used: run.budget_state.token_used as f64,
                limit: limit as f64,
            });
        }
    }
    if let Some(limit) = run.budget_state.cost_limit_usd {
        if run.budget_state.cost_used_usd >= limit {
            return Some(BudgetViolation {
                budget_type: "cost",
                used: run.budget_state.cost_used_usd,
                limit,
            });
        }
    }
    if let Some(limit) = run.budget_state.deadline_ms {
        let elapsed = now.saturating_sub(run.started_at).max(0) as u64;
        if elapsed >= limit {
            return Some(BudgetViolation {
                budget_type: "deadline",
                used: elapsed as f64,
                limit: limit as f64,
            });
        }
    }
    None
}

async fn fail_run_for_budget(
    store: &Arc<TaskStore>,
    run: &crate::orchestrator::domain::run::GraphRun,
    violation: BudgetViolation,
) -> Result<(), String> {
    let current = store
        .get_run(&run.run_id)
        .map_err(|error| error.to_string())?;
    if current.status != RunStatus::Running {
        return Ok(());
    }
    let now = now_ms();
    let node_runs = store
        .get_node_runs(&run.run_id)
        .map_err(|error| error.to_string())?;
    let active = node_runs
        .iter()
        .filter(|node_run| !node_run.status.is_terminal())
        .collect::<Vec<_>>();
    let mut events = Vec::with_capacity(active.len() + 2);
    for node_run in &active {
        events.push(build_event(
            gen_id("evt"),
            &run.run_id,
            current.run_seq + events.len() as u64 + 1,
            TaskEventType::NodeCancelled,
            "budget_controller",
            now,
            serde_json::to_value(payloads::NodeStatusChangedPayload {
                node_run_id: node_run.node_run_id.clone(),
                node_id: node_run.node_id.clone(),
                old_status: node_run.status.clone(),
                new_status: NodeRunStatus::Cancelled,
            })
            .map_err(|error| error.to_string())?,
        ));
    }
    events.push(build_event(
        gen_id("evt"),
        &run.run_id,
        current.run_seq + events.len() as u64 + 1,
        TaskEventType::BudgetExceeded,
        "budget_controller",
        now,
        serde_json::to_value(payloads::BudgetExceededPayload {
            run_id: run.run_id.clone(),
            budget_type: violation.budget_type.into(),
            used: violation.used,
            limit: violation.limit,
        })
        .map_err(|error| error.to_string())?,
    ));
    events.push(build_event(
        gen_id("evt"),
        &run.run_id,
        current.run_seq + events.len() as u64 + 1,
        TaskEventType::RunFailed,
        "budget_controller",
        now,
        serde_json::Value::Null,
    ));
    let cancelled = active
        .iter()
        .map(|node_run| node_run.node_run_id.clone())
        .collect::<Vec<_>>();
    store
        .terminate_run_with_events(
            &run.run_id,
            &current.status,
            &RunStatus::Failed,
            now,
            &cancelled,
            &events,
        )
        .map_err(|error| error.to_string())
}

async fn wait_for_terminal_run(store: &Arc<TaskStore>, run_id: &str) {
    loop {
        sleep(Duration::from_millis(100)).await;
        let status = match store.get_run(run_id) {
            Ok(run) => run.status,
            Err(error) => {
                tracing::error!("failed to inspect run {run_id} during execution: {error}");
                continue;
            }
        };
        if status.is_terminal() {
            return;
        }
    }
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
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    use crate::agent::normalized::{NormalizedEvent, TurnEndReason, UsageStats};
    use crate::agent_runtime::AgentTurnOutput;
    use crate::orchestrator::domain::graph::{
        EvaluatorSpec, GraphNode, GraphSnapshot, LoopControllerConfig, NodeKind, TaskGraph,
    };
    use crate::orchestrator::domain::policy::{ApprovalPolicy, NodePolicy};
    use crate::orchestrator::domain::revision::GraphRevision;
    use crate::orchestrator::domain::run::{BudgetState, GraphRun};
    use crate::orchestrator::runtime_bridge::DefaultTaskAgentRuntime;

    struct FakeAgentRuntime;

    impl TaskAgentRuntime for FakeAgentRuntime {
        fn resolve_agent(
            &self,
            _node: &GraphNode,
            role_id: &str,
        ) -> Result<(crate::orchestrator::domain::run::AgentAssignment, String), String> {
            Ok((
                crate::orchestrator::domain::run::AgentAssignment {
                    agent_id: "fake-agent".into(),
                    role_id: role_id.into(),
                    adapter_capability_snapshot: vec!["stream_text_delta".into()],
                },
                "test".into(),
            ))
        }

        fn invoke(
            &self,
            request: RuntimeInvocationRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<AgentTurnOutput, String>> + Send>,
        > {
            Box::pin(async move {
                assert_eq!(request.agent_id, "fake-agent");
                assert_eq!(request.role_id, "implementer");
                assert!(request.prompt.contains("Implement the feature"));
                assert!(request.prompt.contains("write_files: false"));
                Ok(AgentTurnOutput {
                    events: vec![
                        NormalizedEvent::SessionResolved {
                            session_id: "native-session".into(),
                        },
                        NormalizedEvent::TextDelta {
                            delta: "implemented".into(),
                        },
                        NormalizedEvent::TurnComplete {
                            reason: TurnEndReason::Complete,
                            usage: Some(UsageStats {
                                input_tokens: Some(10),
                                output_tokens: Some(20),
                                total_cost: Some(0.1),
                                context_remaining: None,
                            }),
                        },
                    ],
                    exit_success: true,
                    exit_code: Some(0),
                })
            })
        }
    }

    #[test]
    fn agent_write_or_command_permissions_require_high_risk_approval() {
        let mut node = GraphNode {
            node_id: "agent".into(),
            parent_id: None,
            title: "Agent".into(),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: NodePolicy::default(),
            metadata: HashMap::new(),
            executable_payload: Some(ExecutablePayload::Dispatch {
                role_id: "implementer".into(),
                prompt: "Implement".into(),
                project: None,
                session: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        };
        node.policy.permission_scope.can_write_files = true;
        assert_eq!(
            approval_requirement(&node, 0)
                .expect("write-capable agent node should require approval")
                .risk_level,
            "high"
        );

        node.policy.permission_scope.can_write_files = false;
        node.policy.permission_scope.can_run_commands = true;
        assert!(approval_requirement(&node, 0).is_some());
    }

    #[tokio::test]
    async fn engine_executes_shell_and_completes_run() {
        let store = Arc::new(TaskStore::open_in_memory().unwrap());
        let mut policy = NodePolicy::default();
        policy.permission_scope.can_run_commands = true;
        policy.approval_policy = ApprovalPolicy::Never;
        let snapshot = GraphSnapshot {
            nodes: vec![
                GraphNode {
                    node_id: "goal".into(),
                    parent_id: None,
                    title: "Goal".into(),
                    description: None,
                    node_kind: NodeKind::Goal,
                    input_contract: Default::default(),
                    output_contract: Default::default(),
                    role_requirement: None,
                    capability_requirements: vec![],
                    agent_assignment_constraint: None,
                    policy: Default::default(),
                    metadata: HashMap::new(),
                    executable_payload: None,
                    loop_config: None,
                    approval_gate_config: None,
                },
                GraphNode {
                    node_id: "shell".into(),
                    parent_id: Some("goal".into()),
                    title: "Shell".into(),
                    description: None,
                    node_kind: NodeKind::Executable,
                    input_contract: Default::default(),
                    output_contract: Default::default(),
                    role_requirement: None,
                    capability_requirements: vec![],
                    agent_assignment_constraint: None,
                    policy,
                    metadata: HashMap::new(),
                    executable_payload: Some(ExecutablePayload::Shell {
                        command: "echo engine-ok".into(),
                        cwd: None,
                        timeout_ms: Some(5_000),
                    }),
                    loop_config: None,
                    approval_gate_config: None,
                },
            ],
            edges: vec![],
        };
        let graph = TaskGraph {
            graph_id: "g1".into(),
            title: "Test".into(),
            goal: "Run shell".into(),
            project_root: PathBuf::from("."),
            owner: "test".into(),
            current_draft_revision: Some("r1".into()),
            created_at: 1,
            updated_at: 1,
        };
        let revision =
            GraphRevision::from_snapshot("r1", "g1", None, &snapshot, "test", 1).unwrap();
        let run = GraphRun {
            run_id: "run1".into(),
            graph_id: "g1".into(),
            active_revision_id: "r1".into(),
            status: RunStatus::Running,
            run_seq: 1,
            budget_state: BudgetState::default(),
            planning_snapshot: Default::default(),
            started_at: 1,
            finished_at: None,
        };
        let started = build_event(
            "e1",
            "run1",
            1,
            TaskEventType::RunStarted,
            "test",
            1,
            serde_json::to_value(payloads::RunStartedPayload {
                run_id: "run1".into(),
                graph_id: "g1".into(),
                revision_id: "r1".into(),
                initial_status: RunStatus::Running,
                budget_state: BudgetState::default(),
            })
            .unwrap(),
        );
        {
            store.create_graph_with_revision(&graph, &revision).unwrap();
            store.create_run_with_event(&run, &started).unwrap();
        }

        let runtime: Arc<dyn TaskAgentRuntime> = Arc::new(DefaultTaskAgentRuntime::new(Arc::new(
            crate::agent::AgentRegistry::new(),
        )));
        let arbiter = Arc::new(ResourceArbiter::new(ResourceLimits::default()));
        tick(&store, &runtime, &arbiter).await.unwrap();
        for _ in 0..40 {
            let finished = {
                store
                    .get_node_runs("run1")
                    .unwrap()
                    .iter()
                    .any(|node_run| node_run.status == NodeRunStatus::Succeeded)
            };
            if finished {
                break;
            }
            sleep(Duration::from_millis(25)).await;
        }
        tick(&store, &runtime, &arbiter).await.unwrap();

        let store = store;
        assert_eq!(store.get_run("run1").unwrap().status, RunStatus::Completed);
        let events = store.all_events("run1").unwrap();
        assert!(events
            .iter()
            .any(|event| event.event_type == TaskEventType::AttemptStarted));
        assert!(events
            .iter()
            .any(|event| event.event_type == TaskEventType::NodeResolved));
        assert_eq!(
            events.last().map(|event| &event.event_type),
            Some(&TaskEventType::RunCompleted)
        );
    }

    #[tokio::test]
    async fn engine_dispatches_agent_through_runtime_and_records_assignment() {
        let store = Arc::new(TaskStore::open_in_memory().unwrap());
        let snapshot = GraphSnapshot {
            nodes: vec![GraphNode {
                node_id: "dispatch".into(),
                parent_id: None,
                title: "Dispatch".into(),
                description: None,
                node_kind: NodeKind::Executable,
                input_contract: Default::default(),
                output_contract: Default::default(),
                role_requirement: None,
                capability_requirements: vec![],
                agent_assignment_constraint: None,
                policy: NodePolicy {
                    approval_policy: ApprovalPolicy::Never,
                    ..Default::default()
                },
                metadata: HashMap::new(),
                executable_payload: Some(ExecutablePayload::Dispatch {
                    role_id: "implementer".into(),
                    prompt: "Implement the feature".into(),
                    project: None,
                    session: None,
                }),
                loop_config: None,
                approval_gate_config: None,
            }],
            edges: vec![],
        };
        let graph = TaskGraph {
            graph_id: "g-agent".into(),
            title: "Agent Test".into(),
            goal: "Dispatch".into(),
            project_root: PathBuf::from("."),
            owner: "test".into(),
            current_draft_revision: Some("r-agent".into()),
            created_at: 1,
            updated_at: 1,
        };
        let revision =
            GraphRevision::from_snapshot("r-agent", "g-agent", None, &snapshot, "test", 1).unwrap();
        let run = GraphRun {
            run_id: "run-agent".into(),
            graph_id: "g-agent".into(),
            active_revision_id: "r-agent".into(),
            status: RunStatus::Running,
            run_seq: 1,
            budget_state: BudgetState {
                token_limit: Some(100),
                cost_limit_usd: Some(1.0),
                ..Default::default()
            },
            planning_snapshot: Default::default(),
            started_at: 1,
            finished_at: None,
        };
        let started = build_event(
            "e-agent",
            "run-agent",
            1,
            TaskEventType::RunStarted,
            "test",
            1,
            serde_json::to_value(payloads::RunStartedPayload {
                run_id: "run-agent".into(),
                graph_id: "g-agent".into(),
                revision_id: "r-agent".into(),
                initial_status: RunStatus::Running,
                budget_state: run.budget_state.clone(),
            })
            .unwrap(),
        );
        {
            store.create_graph_with_revision(&graph, &revision).unwrap();
            store.create_run_with_event(&run, &started).unwrap();
        }

        let runtime: Arc<dyn TaskAgentRuntime> = Arc::new(FakeAgentRuntime);
        let arbiter = Arc::new(ResourceArbiter::new(ResourceLimits::default()));
        tick(&store, &runtime, &arbiter).await.unwrap();
        for _ in 0..40 {
            let finished = store
                .get_node_runs("run-agent")
                .unwrap()
                .iter()
                .any(|node_run| node_run.status == NodeRunStatus::Succeeded);
            if finished {
                break;
            }
            sleep(Duration::from_millis(25)).await;
        }
        tick(&store, &runtime, &arbiter).await.unwrap();

        let store = store;
        assert_eq!(
            store.get_run("run-agent").unwrap().status,
            RunStatus::Completed
        );
        let persisted_run = store.get_run("run-agent").unwrap();
        assert_eq!(persisted_run.budget_state.token_used, 30);
        assert_eq!(persisted_run.budget_state.cost_used_usd, 0.1);
        let events = store.all_events("run-agent").unwrap();
        let started = events
            .iter()
            .find(|event| event.event_type == TaskEventType::AttemptStarted)
            .unwrap();
        let payload: payloads::AttemptStartedPayload =
            serde_json::from_value(started.payload.clone()).unwrap();
        assert_eq!(payload.agent_assignment.unwrap().agent_id, "fake-agent");
        assert_eq!(payload.transport.as_deref(), Some("test"));
        assert!(events.iter().any(|event| {
            event.event_type == TaskEventType::AttemptProgressed
                && event.payload.to_string().contains("implemented")
        }));
        let projection =
            crate::orchestrator::events::rebuild_projection("run-agent", &events).unwrap();
        assert_eq!(projection.budget_state.token_used, 30);
        assert_eq!(projection.budget_state.cost_used_usd, 0.1);
    }

    #[tokio::test]
    async fn durable_loop_runs_body_and_completes_from_inline_evaluator() {
        let store = Arc::new(TaskStore::open_in_memory().unwrap());
        let mut shell_policy = NodePolicy::default();
        shell_policy.permission_scope.can_run_commands = true;
        shell_policy.approval_policy = ApprovalPolicy::Never;
        let snapshot = GraphSnapshot {
            nodes: vec![
                GraphNode {
                    node_id: "goal".into(),
                    parent_id: None,
                    title: "Goal".into(),
                    description: None,
                    node_kind: NodeKind::Goal,
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
                },
                GraphNode {
                    node_id: "loop".into(),
                    parent_id: Some("goal".into()),
                    title: "Check until healthy".into(),
                    description: None,
                    node_kind: NodeKind::ControlLoop,
                    input_contract: Default::default(),
                    output_contract: Default::default(),
                    role_requirement: None,
                    capability_requirements: vec![],
                    agent_assignment_constraint: None,
                    policy: Default::default(),
                    metadata: Default::default(),
                    executable_payload: None,
                    loop_config: Some(LoopControllerConfig {
                        body_node_ids: vec!["check".into()],
                        evaluator: EvaluatorSpec::Inline {
                            rules: serde_json::json!({
                                "complete_when": {"all_succeeded": true},
                                "result": {"healthy": true}
                            }),
                        },
                        interval_ms: 10,
                        backoff_multiplier: None,
                        max_interval_ms: None,
                        termination_condition: "healthy".into(),
                        max_iterations: Some(3),
                        deadline_ms: None,
                        token_budget: None,
                        cost_budget_usd: None,
                        no_progress_threshold: None,
                        escalation_policy: "pause".into(),
                    }),
                    approval_gate_config: None,
                },
                GraphNode {
                    node_id: "check".into(),
                    parent_id: Some("loop".into()),
                    title: "Health check".into(),
                    description: None,
                    node_kind: NodeKind::Executable,
                    input_contract: Default::default(),
                    output_contract: Default::default(),
                    role_requirement: None,
                    capability_requirements: vec![],
                    agent_assignment_constraint: None,
                    policy: shell_policy,
                    metadata: Default::default(),
                    executable_payload: Some(ExecutablePayload::Shell {
                        command: "echo healthy".into(),
                        cwd: None,
                        timeout_ms: Some(5_000),
                    }),
                    loop_config: None,
                    approval_gate_config: None,
                },
            ],
            edges: vec![],
        };
        let graph = TaskGraph {
            graph_id: "g-loop".into(),
            title: "Loop".into(),
            goal: "Check".into(),
            project_root: PathBuf::from("."),
            owner: "test".into(),
            current_draft_revision: Some("r-loop".into()),
            created_at: 1,
            updated_at: 1,
        };
        let revision =
            GraphRevision::from_snapshot("r-loop", "g-loop", None, &snapshot, "test", 1).unwrap();
        let run = GraphRun {
            run_id: "run-loop".into(),
            graph_id: "g-loop".into(),
            active_revision_id: "r-loop".into(),
            status: RunStatus::Running,
            run_seq: 1,
            budget_state: BudgetState::default(),
            planning_snapshot: Default::default(),
            started_at: 1,
            finished_at: None,
        };
        let started = build_event(
            "e-loop",
            "run-loop",
            1,
            TaskEventType::RunStarted,
            "test",
            1,
            serde_json::to_value(payloads::RunStartedPayload {
                run_id: "run-loop".into(),
                graph_id: "g-loop".into(),
                revision_id: "r-loop".into(),
                initial_status: RunStatus::Running,
                budget_state: BudgetState::default(),
            })
            .unwrap(),
        );
        {
            store.create_graph_with_revision(&graph, &revision).unwrap();
            store.create_run_with_event(&run, &started).unwrap();
        }
        let runtime: Arc<dyn TaskAgentRuntime> = Arc::new(FakeAgentRuntime);
        let arbiter = Arc::new(ResourceArbiter::new(ResourceLimits::default()));

        tick(&store, &runtime, &arbiter).await.unwrap();
        tick(&store, &runtime, &arbiter).await.unwrap();
        for _ in 0..40 {
            if store
                .get_node_runs("run-loop")
                .unwrap()
                .iter()
                .any(|node_run| {
                    node_run.node_id == "check" && node_run.status == NodeRunStatus::Succeeded
                })
            {
                break;
            }
            sleep(Duration::from_millis(25)).await;
        }
        tick(&store, &runtime, &arbiter).await.unwrap();
        tick(&store, &runtime, &arbiter).await.unwrap();

        let store = store;
        assert_eq!(
            store.get_run("run-loop").unwrap().status,
            RunStatus::Completed
        );
        let events = store.all_events("run-loop").unwrap();
        assert!(events
            .iter()
            .any(|event| event.event_type == TaskEventType::LoopStarted));
        assert!(events
            .iter()
            .any(|event| event.event_type == TaskEventType::IterationStarted));
        assert!(events
            .iter()
            .any(|event| event.event_type == TaskEventType::LoopCompleted));
    }

    #[test]
    fn retry_policy_only_retries_transient_idempotent_attempts() {
        let mut node = GraphNode {
            node_id: "retry".into(),
            parent_id: None,
            title: "Retry".into(),
            description: None,
            node_kind: NodeKind::Executable,
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
        };
        let attempt = NodeAttempt {
            attempt_id: "a".into(),
            node_run_id: "nr".into(),
            attempt_number: 0,
            agent_assignment: None,
            transport: None,
            session_id: None,
            lease: None,
            usage: Default::default(),
            error: None,
            idempotency_key: Some("key".into()),
            checkpoint: None,
            started_at: 1,
            finished_at: None,
        };
        let transient = attempt_error(ErrorCategory::Transient, "temporary", true);
        assert!(should_retry(&node, &attempt, &transient));
        assert!(should_retry(
            &node,
            &attempt,
            &attempt_error(ErrorCategory::LostLease, "lost", true)
        ));
        node.policy.idempotency_policy = IdempotencyPolicy::NoRetry;
        assert!(!should_retry(&node, &attempt, &transient));
        assert!(!should_retry(
            &node,
            &attempt,
            &attempt_error(ErrorCategory::Deterministic, "bad input", false)
        ));
    }
}
