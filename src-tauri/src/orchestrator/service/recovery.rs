use super::*;

impl TaskService {
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

    /// Fetch a single artifact by id (§11.2 `artifact_get`).
    pub fn get_artifact(&self, artifact_id: &str) -> Result<ArtifactRef, TaskServiceError> {
        self.store
            .get_artifact(artifact_id)?
            .ok_or_else(|| TaskServiceError::NotFound(format!("artifact {artifact_id}")))
    }

    /// Compute the structured diff between two revisions (§11.2 `graph_diff`).
    pub fn get_diff(
        &self,
        from_revision_id: &str,
        to_revision_id: &str,
    ) -> Result<crate::orchestrator::domain::revision::RevisionDiff, TaskServiceError> {
        let from = self.store.get_revision(from_revision_id)?;
        let to = self.store.get_revision(to_revision_id)?;
        crate::orchestrator::commands::graph_diff(&from, &to)
            .map_err(|e| TaskServiceError::Internal(format!("revision diff failed: {e}")))
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
            return Err(TaskServiceError::Conflict {
                message: format!("approval {approval_id} is already resolved"),
                current_revision: None,
                current_run_seq: None,
            });
        }
        let mut node_run = store.get_node_run(&approval.node_run_id)?;
        if node_run.status != NodeRunStatus::AwaitingApproval {
            return Err(TaskServiceError::Conflict {
                message: format!("node run {} is not awaiting approval", node_run.node_run_id),
                current_revision: None,
                current_run_seq: None,
            });
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
        // 审批通过（非 gate）→ node_run 置 Blocked = 就绪重跑。若 run 当前为
        // AwaitingHuman 必须显式 resume，scheduler 才会重新拾起该节点——对称
        // `choose_recovery`（service.rs:1505）与 `submit_task_interaction`（:478）。
        // 不补这步，审批期间因别的原因进入 AwaitingHuman 的 run 会停在死锁态。
        if node_run.status == NodeRunStatus::Blocked {
            let latest_run = store.get_run(&approval.run_id)?;
            if latest_run.status == RunStatus::AwaitingHuman {
                self.resume_run(&approval.run_id)?;
            }
        }
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
            return Err(TaskServiceError::Conflict {
                message: "terminal runs cannot accept recovery decisions".into(),
                current_revision: None,
                current_run_seq: None,
            });
        }
        let now = now_ms();
        crate::orchestrator::recovery::apply_recovery(&mut node_run, strategy, now).map_err(
            |e| TaskServiceError::Conflict {
                message: e.to_string(),
                current_revision: None,
                current_run_seq: None,
            },
        )?;
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
                category: None,
                repair_depth: None,
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
        // A retry decision must resume a paused run so the scheduler picks the
        // node back up — mirrors how `submit_task_interaction` resumes after an
        // interaction is resolved. Without this, manual recovery on an
        // AwaitingHuman run would leave the run paused (deadlock).
        if node_run.status == NodeRunStatus::Blocked {
            let latest_run = store.get_run(&run.run_id)?;
            if latest_run.status == RunStatus::AwaitingHuman {
                self.resume_run(&run.run_id)?;
            }
        }
        Ok(node_run)
    }
}
