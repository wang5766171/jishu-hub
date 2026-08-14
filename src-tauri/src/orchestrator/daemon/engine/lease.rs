use super::loops::node_resolved_event;
use super::schedule::should_retry;
use super::*;

pub(super) fn recover_lost_lease(
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
        // Lease is live if the resource is still held in-process OR the heartbeat was refreshed within the TTL.
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

/// Periodically refresh the execution lease's heartbeat deadline while a node runs.
pub(super) async fn heartbeat_loop(store: Arc<TaskStore>, node_run_id: String) {
    loop {
        sleep(Duration::from_millis(LEASE_HEARTBEAT_INTERVAL_MS)).await;
        let deadline = now_ms() + LEASE_HEARTBEAT_TTL_MS;
        if let Err(error) = store.refresh_lease_heartbeat(&node_run_id, deadline) {
            tracing::warn!("lease heartbeat refresh failed for {node_run_id}: {error}");
        }
    }
}
