use super::budget::wait_for_terminal_run;
use super::execute::{
    approval_requirement, execute_node, prepare_agent_execution, task_continuation_from_request,
};
use super::lease::heartbeat_loop;
use super::*;

pub(super) async fn schedule_node(
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
    let continuation = store
        .take_resolved_task_interaction(&node_run_id, now)
        .map_err(|error| error.to_string())?
        .and_then(|request| task_continuation_from_request(&request));
    node_run.status = NodeRunStatus::Leased;
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
        heartbeat_deadline: now + LEASE_HEARTBEAT_TTL_MS,
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
        dispatch_prompt: None,
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
        ];
        store
            .save_execution_update(&node_run, Some(&attempt), &[], &events, None, None)
            .map_err(|error| error.to_string())?;
    }

    tokio::spawn(async move {
        let _resource_permit = resource_permit;

        // Transition Leased -> Running now that execution is actually starting.
        {
            let run = match store.get_run(&run_id) {
                Ok(run) => run,
                Err(error) => {
                    tracing::error!("failed to reload run {run_id} for start: {error}");
                    return;
                }
            };
            if run.status.is_terminal() {
                return;
            }
            let mut node_run = match store.get_node_run(&node_run_id) {
                Ok(run) => run,
                Err(error) => {
                    tracing::error!("failed to reload node_run {node_run_id} for start: {error}");
                    return;
                }
            };
            if node_run.status.is_terminal() {
                return;
            }
            node_run.status = NodeRunStatus::Running;
            let started_at = now_ms();
            let running_events = vec![build_event(
                gen_id("evt"),
                &run_id,
                run.run_seq + 1,
                TaskEventType::AttemptStarted,
                "task_orchestrator",
                started_at,
                serde_json::to_value(payloads::AttemptStartedPayload {
                    attempt_id: attempt_id.clone(),
                    node_run_id: node_run_id.clone(),
                    attempt_number,
                    agent_assignment: attempt.agent_assignment.clone(),
                    transport: attempt.transport.clone(),
                    idempotency_key: attempt.idempotency_key.clone(),
                })
                .unwrap_or(serde_json::Value::Null),
            )];
            if let Err(error) = store.save_execution_update(
                &node_run,
                Some(&attempt),
                &[],
                &running_events,
                None,
                None,
            ) {
                tracing::error!("failed to persist Running transition for {node_run_id}: {error}");
                return;
            }
        }

        let cancellation = Arc::new(AtomicBool::new(false));

        // Spawn heartbeat task and abort it when execution ends
        let heartbeat = tokio::spawn(heartbeat_loop(store.clone(), node_run_id.clone()));

        let result = tokio::select! {
            result = execute_node(
                &node,
                &project_root,
                runtime.as_ref(),
                prepared_agent,
                continuation,
                RuntimeEventContext {
                    run_id: run_id.clone(),
                    node_run_id: node_run_id.clone(),
                    attempt_id: attempt_id.clone(),
                },
                cancellation.clone(),
                Some(Arc::new({
                    let store = store.clone();
                    let attempt_id = attempt_id.clone();
                    move |sid: String| {
                        if let Err(e) = store.set_node_attempt_session_id(&attempt_id, &sid) {
                            tracing::error!("failed to persist node attempt session_id for {attempt_id}: {e}");
                        }
                    }
                })),
            ) => Some(result),
            _ = wait_for_terminal_run(&store, &run_id) => {
                cancellation.store(true, Ordering::Release);
                None
            },
        };
        heartbeat.abort(); // Stop heartbeat refreshes

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
        let mut pending_interaction = None;
        let mut run_status_update = None;
        match result {
            Ok(output) => {
                attempt.session_id = output.session_id.clone();
                attempt.usage = output.usage.clone();
                attempt.dispatch_prompt = output.dispatch_prompt.clone();
                if let Some(interaction) = output.interaction {
                    node_run.status = NodeRunStatus::AwaitingApproval;
                    node_run.finished_at = None;
                    resolve_node = false;
                    run_status_update = Some((RunStatus::AwaitingHuman, None));
                    pending_interaction = Some(TaskInteractionRequest {
                        request_id: interaction.request_id,
                        graph_id: run.graph_id.clone(),
                        run_id: Some(run_id.clone()),
                        node_id: Some(node.node_id.clone()),
                        node_run_id: Some(node_run_id.clone()),
                        session_id: output.session_id,
                        prompt: interaction.prompt,
                        options: interaction.options,
                        allow_multiple: interaction.allow_multiple,
                        allow_custom_text: interaction.allow_custom_text,
                        required: interaction.required,
                        created_at: finished_at,
                        resolved_at: None,
                        consumed_at: None,
                        submission: None,
                    });
                    events.push(build_event(
                        gen_id("evt"),
                        &run_id,
                        run.run_seq + 1,
                        TaskEventType::AttemptProgressed,
                        "task_orchestrator",
                        finished_at,
                        serde_json::to_value(payloads::AttemptProgressedPayload {
                            attempt_id: attempt_id.clone(),
                            node_run_id: node_run_id.clone(),
                            node_id: Some(node.node_id.clone()),
                            message: String::new(),
                            public: false,
                            usage_delta: attempt.usage.clone(),
                        })
                        .unwrap_or(serde_json::Value::Null),
                    ));
                } else {
                    node_run.status = NodeRunStatus::Succeeded;
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
                        let payload =
                            match serde_json::to_value(payloads::ArtifactProducedPayload {
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
                        let payload =
                            match serde_json::to_value(payloads::AttemptProgressedPayload {
                                attempt_id: attempt_id.clone(),
                                node_run_id: node_run_id.clone(),
                                node_id: Some(node.node_id.clone()),
                                message: truncate_event_message(&progress.message),
                                public: progress.public,
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
                        let payload =
                            match serde_json::to_value(payloads::AttemptProgressedPayload {
                                attempt_id: attempt_id.clone(),
                                node_run_id: node_run_id.clone(),
                                node_id: Some(node.node_id.clone()),
                                message: String::new(),
                                public: false,
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
                let retries_remaining = error.retryable
                    && node
                        .policy
                        .retry_policy
                        .should_retry(attempt.attempt_number, true)
                    && match node.policy.idempotency_policy {
                        IdempotencyPolicy::NoRetry => false,
                        IdempotencyPolicy::CheckpointRequired => attempt.checkpoint.is_some(),
                        IdempotencyPolicy::None | IdempotencyPolicy::IdempotencyKey => true,
                    };
                let decision = decide_recovery(&RecoveryContext {
                    category: error.category.clone(),
                    retries_remaining,
                    repair_depth: 0,
                    repair_allowed: node.policy.repair_depth_limit() > 0,
                    budget_remaining: true,
                });
                // HumanGate (and Repair, until M3.3 wires supervisor-generated
                // repair subgraphs) pause for a human recovery decision. Compute
                // the pause reason from a borrow first, then move `decision` below.
                let pause_reason = match &decision {
                    RecoveryDecision::HumanGate { reason } => Some(reason.clone()),
                    RecoveryDecision::Repair => {
                        Some("repair subgraph pending supervisor proposal".to_string())
                    }
                    _ => None,
                };
                if let Some(reason) = pause_reason {
                    // Gating is fail-safe: never auto-acts, always defers to a human.
                    node_run.status = NodeRunStatus::Failed;
                    node_run.finished_at = Some(finished_at);
                    run_status_update = Some((RunStatus::AwaitingHuman, None));
                    resolve_node = false;
                    events.push(build_event(
                        gen_id("evt"),
                        &run_id,
                        run.run_seq + events.len() as u64 + 1,
                        TaskEventType::RecoveryChosen,
                        "recovery_controller",
                        finished_at,
                        serde_json::to_value(payloads::RecoveryChosenPayload {
                            node_run_id: node_run_id.clone(),
                            strategy: "human_gate".into(),
                            reason,
                            category: Some(error.category.clone()),
                            repair_depth: Some(0),
                        })
                        .unwrap_or(serde_json::Value::Null),
                    ));
                } else {
                    match decision {
                        RecoveryDecision::Retry => {
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
                        }
                        RecoveryDecision::Fail
                        | RecoveryDecision::HumanGate { .. }
                        | RecoveryDecision::Repair => {
                            node_run.status = NodeRunStatus::Failed;
                        }
                    }
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

        if let Some(request) = pending_interaction.as_ref() {
            if let Err(error) = store.save_task_interaction(request) {
                tracing::error!(
                    "failed to persist interaction request for node {}: {error}",
                    node.node_id
                );
                return;
            }
        }

        if let Err(error) = store.save_execution_update(
            &node_run,
            Some(&attempt),
            &artifacts,
            &events,
            Some(&attempt.usage),
            run_status_update
                .as_ref()
                .map(|(status, finished_at)| (status, *finished_at)),
        ) {
            tracing::error!(
                "failed to persist node completion {}: {error}",
                node.node_id
            );
        }
    });

    Ok(())
}

pub(super) fn should_retry(node: &GraphNode, attempt: &NodeAttempt, error: &AttemptError) -> bool {
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
