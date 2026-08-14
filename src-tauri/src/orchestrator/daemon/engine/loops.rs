use super::schedule::should_retry;
use super::*;

pub(super) async fn drive_loops(
    store: &Arc<TaskStore>,
    run: &crate::orchestrator::domain::run::GraphRun,
    snapshot: &GraphSnapshot,
    node_runs: &[NodeRun],
) -> Result<bool, String> {
    let now = now_ms();
    // Re-check the run is still Running on the same revision we were called
    // with — a revision may have been applied between the tick reading the run
    // and this point (same guard `schedule_node` applies). Bail to avoid
    // driving a loop against a stale snapshot.
    {
        let current = store
            .get_run(&run.run_id)
            .map_err(|error| error.to_string())?;
        if current.active_revision_id != run.active_revision_id
            || current.status != RunStatus::Running
        {
            return Ok(false);
        }
    }
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

        // Compute accumulated usage over all body node runs across all iterations
        let mut accumulated_usage = AttemptUsage::default();
        for body_node_id in &config.body_node_ids {
            for node_run in node_runs.iter().filter(|nr| &nr.node_id == body_node_id) {
                if let Ok(Some(attempt)) = store.latest_attempt(&node_run.node_run_id) {
                    accumulated_usage.input_tokens += attempt.usage.input_tokens;
                    accumulated_usage.output_tokens += attempt.usage.output_tokens;
                    accumulated_usage.cost_usd += attempt.usage.cost_usd;
                }
            }
        }

        let mut result = crate::orchestrator::loop_controller::evaluate(
            config,
            iteration,
            now,
            loop_run.started_at.unwrap_or(now),
            body_succeeded,
            evaluator_output.as_ref(),
            &accumulated_usage,
            iteration,
        )
        .unwrap_or_else(|error| payloads::EvaluatorResult::Fail { error });

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

pub(super) fn start_loop_iteration(
    store: &Arc<TaskStore>,
    run: &crate::orchestrator::domain::run::GraphRun,
    _snapshot: &GraphSnapshot,
    loop_node: &GraphNode,
    existing_loop_run: Option<NodeRun>,
) -> Result<(), String> {
    // Guard against the run's revision/status changing between the tick reading
    // the run and us starting an iteration (mirrors `schedule_node`). If the run
    // moved on, skip rather than iterate against a stale snapshot.
    {
        let current = store
            .get_run(&run.run_id)
            .map_err(|error| error.to_string())?;
        if current.active_revision_id != run.active_revision_id
            || current.status != RunStatus::Running
        {
            return Ok(());
        }
    }
    let config = loop_node
        .loop_config
        .as_ref()
        .ok_or_else(|| format!("loop node {} has no config", loop_node.node_id))?;

    // Runtime gate: a loop must have at least one hard budget
    if !crate::orchestrator::loop_controller::has_hard_budget(config) {
        let now = now_ms();
        let mut failed = existing_loop_run.unwrap_or_else(|| {
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
        failed.status = NodeRunStatus::Failed;
        failed.error = Some(
            "control loop has no hard budget (set max_iterations, deadline_ms, token_budget, or cost_budget_usd)"
                .into(),
        );
        failed.finished_at = Some(now);
        let current_run = store
            .get_run(&run.run_id)
            .map_err(|error| error.to_string())?;
        let events = vec![node_resolved_event(
            &run.run_id,
            current_run.run_seq + 1,
            &failed,
            now,
        )?];
        store
            .save_node_runs_with_events(&[failed], &events, None)
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

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

pub(super) fn node_resolved_event(
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
