use super::*;

impl TaskService {
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
            return Err(TaskServiceError::Conflict {
                message: format!("revision {revision_id} does not belong to graph {graph_id}"),
                current_revision: None,
                current_run_seq: None,
            });
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
            return Err(TaskServiceError::Conflict {
                message: "terminal runs cannot accept revision proposals".into(),
                current_revision: None,
                current_run_seq: None,
            });
        }
        if run.active_revision_id == candidate_revision_id {
            return Err(TaskServiceError::Conflict {
                message: "candidate revision is already active".into(),
                current_revision: None,
                current_run_seq: None,
            });
        }

        let base_revision = store.get_revision(&run.active_revision_id)?;
        let candidate_revision = store.get_revision(candidate_revision_id)?;
        if candidate_revision.graph_id != run.graph_id {
            return Err(TaskServiceError::Conflict {
                message: format!(
                    "revision {candidate_revision_id} does not belong to run graph {}",
                    run.graph_id
                ),
                current_revision: None,
                current_run_seq: None,
            });
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
            let base_node =
                base_snapshot
                    .node_by_id(node_id)
                    .ok_or_else(|| TaskServiceError::Conflict {
                        message: format!("frozen node {node_id} is missing from active revision"),
                        current_revision: None,
                        current_run_seq: None,
                    })?;
            let candidate_node = candidate_snapshot.node_by_id(node_id).ok_or_else(|| {
                TaskServiceError::Conflict {
                    message: format!("candidate revision removes frozen node {node_id}"),
                    current_revision: None,
                    current_run_seq: None,
                }
            })?;
            if serde_json::to_value(base_node)? != serde_json::to_value(candidate_node)? {
                return Err(TaskServiceError::Conflict {
                    message: format!("candidate revision changes frozen node {node_id}"),
                    current_revision: None,
                    current_run_seq: None,
                });
            }
            if incoming_edge_signature(&base_snapshot, node_id)
                != incoming_edge_signature(&candidate_snapshot, node_id)
            {
                return Err(TaskServiceError::Conflict {
                    message: format!(
                        "candidate revision changes dependencies of frozen node {node_id}"
                    ),
                    current_revision: None,
                    current_run_seq: None,
                });
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
            return Err(TaskServiceError::Conflict {
                message: format!("revision proposal {proposal_id} belongs to another run"),
                current_revision: None,
                current_run_seq: None,
            });
        }
        let run = store.get_run(run_id)?;
        if run.status.is_terminal() {
            return Err(TaskServiceError::Conflict {
                message: "terminal runs cannot apply revisions".into(),
                current_revision: None,
                current_run_seq: None,
            });
        }
        if run.run_seq != expected_run_seq
            || proposal.expected_run_seq != expected_run_seq
            || run.active_revision_id != proposal.base_revision_id
        {
            return Err(TaskServiceError::Conflict {
                message: "run changed after the revision proposal was validated".into(),
                current_revision: Some(run.active_revision_id.to_string()),
                current_run_seq: Some(run.run_seq),
            });
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
        let updated_run = store.apply_run_revision(
            &proposal,
            expected_run_seq,
            &planning_snapshot,
            &node_runs,
            &events,
        )?;

        // Emit RevisionCreated event to notify frontend of active revision change
        let final_seq = updated_run.run_seq;
        let revision_created_event = build_event(
            gen_id("evt"),
            run_id,
            final_seq + 1,
            TaskEventType::RevisionCreated,
            "task_orchestrator",
            now,
            serde_json::to_value(&payloads::RevisionCreatedPayload {
                revision_id: proposal.candidate_revision_id.clone(),
                run_id: run_id.to_string(),
                graph_id: updated_run.graph_id.clone(),
                source: "run_revision_apply".into(),
            })?,
        );
        store.append_events(&[revision_created_event])?;

        Ok(updated_run)
    }

    /// Attach a Supervisor-generated repair to a failed node (design §9.3, M3.3).
    ///
    /// Builds a candidate revision from the run's ACTIVE revision (without
    /// touching the user's draft — repair is run-scoped), attaches it via the
    /// two-phase revision protocol (frozen-node safe), emits `RepairGraphAttached`
    /// for event-sourced depth tracking, and resets the failed node so the
    /// scheduler re-runs it under the repaired revision. The Supervisor
    /// invocation that produces `commands` is the caller's responsibility (seam).
    pub fn attach_repair(
        &self,
        run_id: &str,
        node_run_id: &str,
        commands: &[GraphCommand],
        repair_depth: u32,
    ) -> Result<String, TaskServiceError> {
        let store = &self.store;
        let run = store.get_run(run_id)?;
        if run.status.is_terminal() {
            return Err(TaskServiceError::Conflict {
                message: "terminal runs cannot accept repairs".into(),
                current_revision: None,
                current_run_seq: None,
            });
        }
        let node_run = store.get_node_run(node_run_id)?;
        if node_run.run_id != run.run_id {
            return Err(TaskServiceError::Conflict {
                message: format!("node run {node_run_id} belongs to another run"),
                current_revision: None,
                current_run_seq: None,
            });
        }

        // Candidate revision from the run's active revision. Must NOT update the
        // graph draft (run-scoped repair).
        let base = store.get_revision(&run.active_revision_id)?;
        let base_snapshot = base.snapshot()?;
        let new_snapshot = apply_commands(&base_snapshot, commands)?;
        graph_validate(&new_snapshot)?;
        let now = now_ms();
        let candidate_id = gen_id("rev");
        let mut candidate = GraphRevision::from_snapshot(
            &candidate_id,
            &run.graph_id,
            Some(run.active_revision_id.clone()),
            &new_snapshot,
            "supervisor",
            now,
        )?;
        candidate.skill_refs = base.skill_refs.clone();
        candidate.template_refs = base.template_refs.clone();
        candidate.planner_policy_refs = base.planner_policy_refs.clone();
        candidate.refresh_content_hash()?;
        store.save_revision(&candidate)?;

        // Attach via the two-phase protocol. The failed node is terminal, so
        // apply_run_revision will not advance it — we reset it manually below.
        let proposal = self.propose_run_revision(run_id, &candidate_id)?;
        self.apply_run_revision(run_id, &proposal.proposal_id, proposal.expected_run_seq)?;
        // apply_run_revision also appends a RevisionCreated event, so re-read the
        // run to get the authoritative run_seq before appending our repair event.
        let latest_run = store.get_run(run_id)?;

        // Record the repair (event-sourced depth → Repair-of-Repair guard).
        let repair_event = build_event(
            gen_id("evt"),
            run_id,
            latest_run.run_seq + 1,
            TaskEventType::RepairGraphAttached,
            "supervisor",
            now,
            serde_json::to_value(payloads::RepairGraphAttachedPayload {
                node_run_id: node_run_id.to_string(),
                repair_revision_id: candidate_id.clone(),
                depth: repair_depth,
            })?,
        );
        store.append_events(&[repair_event])?;

        // Reset the failed node to re-run under the repaired revision.
        let mut failed = store.get_node_run(node_run_id)?;
        failed.status = NodeRunStatus::Blocked;
        failed.revision_id = candidate_id.clone();
        failed.error = None;
        failed.finished_at = None;
        failed.wake_at = None;
        store.save_node_run(&failed)?;

        Ok(candidate_id)
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

    /// Get a single attempt by node_run_id and attempt_number.
    pub fn get_attempt(
        &self,
        node_run_id: &str,
        attempt_number: u32,
    ) -> Result<crate::orchestrator::domain::run::NodeAttempt, TaskServiceError> {
        let store = &self.store;
        Ok(store.get_attempt(node_run_id, attempt_number)?)
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
        .map_err(|e| TaskServiceError::Conflict {
            message: e.to_string(),
            current_revision: None,
            current_run_seq: None,
        })?;

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
        .map_err(|e| TaskServiceError::Conflict {
            message: e.to_string(),
            current_revision: None,
            current_run_seq: None,
        })?;

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
        .map_err(|e| TaskServiceError::Conflict {
            message: e.to_string(),
            current_revision: None,
            current_run_seq: None,
        })?;

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
}
