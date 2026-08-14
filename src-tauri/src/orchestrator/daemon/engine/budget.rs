use super::*;

pub(super) async fn finish_run(
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
        store
            .terminate_run_with_events(
                run_id,
                &run.status,
                final_status,
                now,
                &cancelled_node_run_ids,
                &events,
            )
            .map_err(|error| error.to_string())?;

        // 完成态投影：同步 run 终态到 TaskInstance
        sync_run_status_hook(store, &run.graph_id, run_id, final_status);
        return Ok(());
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
        .map_err(|error| error.to_string())?;

    // 完成态投影：同步 run 终态到 TaskInstance
    sync_run_status_hook(store, &run.graph_id, run_id, final_status);
    Ok(())
}

/// 完成态投影钩子：将 run 终态同步到 TaskInstance。
/// 失败只 warn 不阻塞 engine（投影是最终一致，不是事务）。
fn sync_run_status_hook(
    store: &Arc<TaskStore>,
    graph_id: &str,
    run_id: &str,
    final_status: &RunStatus,
) {
    let status_str = match final_status {
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        _ => return,
    };
    let project_root = match store.get_graph(graph_id) {
        Ok(graph) => graph.project_root.to_string_lossy().to_string(),
        Err(_) => return,
    };
    if let Err(e) =
        crate::task_launch::sync_run_status_to_task_instance(&project_root, run_id, status_str)
    {
        tracing::warn!(
            "sync_run_status_to_task_instance failed (non-blocking): run={run_id}, err={e}"
        );
    }
}

#[derive(Debug, Clone)]
pub(super) struct BudgetViolation {
    pub(super) budget_type: &'static str,
    pub(super) used: f64,
    pub(super) limit: f64,
}

pub(super) fn budget_violation(
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

pub(super) async fn fail_run_for_budget(
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

pub(super) async fn wait_for_terminal_run(store: &Arc<TaskStore>, run_id: &str) {
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
