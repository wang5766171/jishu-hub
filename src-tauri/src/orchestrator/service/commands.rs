use super::*;

impl TaskService {
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
            return Err(TaskServiceError::Conflict {
                message: format!(
                    "revision {expected_revision_id} does not belong to graph {graph_id}"
                ),
                current_revision: None,
                current_run_seq: None,
            });
        }

        // Verify it's still the current draft.
        let graph = store.get_graph(graph_id)?;

        // 完成态只读（簇B / 设计 §11 done）：图已有终态 run（completed/failed/cancelled）时
        // 禁止再改图。仅终态拦截；运行中/草稿态保留原行为——不误伤 pre-run 编辑，也不影响
        // hot-swap（其候选走纯函数 `commands::apply_commands`，不经此服务方法）。
        let runs = store.list_runs(graph_id)?;
        if runs.iter().any(|run| run.status.is_terminal()) {
            return Err(TaskServiceError::Conflict {
                message: format!(
                    "graph {graph_id} has a terminal run; editing is disabled in done state"
                ),
                current_revision: graph.current_draft_revision.clone(),
                current_run_seq: runs.iter().map(|run| run.run_seq).max(),
            });
        }

        match &graph.current_draft_revision {
            Some(draft) if draft == expected_revision_id => {}
            Some(draft) => {
                return Err(TaskServiceError::Conflict {
                    message: format!(
                        "expected revision {expected_revision_id} but current draft is {draft}"
                    ),
                    current_revision: graph.current_draft_revision.clone(),
                    current_run_seq: None,
                });
            }
            None => {
                return Err(TaskServiceError::Conflict {
                    message: "graph has no current draft revision".into(),
                    current_revision: graph.current_draft_revision.clone(),
                    current_run_seq: None,
                });
            }
        }

        // Apply commands.
        let base_snapshot = base_revision.snapshot()?;

        // A8 冻结校验（设计 §10.6 / 10 §3.5.6）：已租赁/运行中/待审批/已完成/失败/自愈中
        // 的节点不可经主编辑路径改动——与 propose_run_revision（:835-879）口径一致，闭合
        // 「冻结不变量在主编辑路径上不成立」的缺口。首版仅 run-前编排（无 run）时为 no-op；
        // 图有非终态 run（paused/awaiting_human）编辑草稿时，保护其冻结节点不被静默改动。
        let frozen_node_ids = frozen_node_ids_for_runs(&self.store, &runs)?;
        for command in commands {
            for target in command_target_node_ids(command, &base_snapshot) {
                if frozen_node_ids.iter().any(|id| id == target) {
                    return Err(TaskServiceError::Conflict {
                        message: format!(
                            "command {} mutates frozen node {target}; frozen nodes cannot be edited via the draft path",
                            command.command_id()
                        ),
                        current_revision: graph.current_draft_revision.clone(),
                        current_run_seq: runs.iter().map(|run| run.run_seq).max(),
                    });
                }
            }
        }

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
            return Err(TaskServiceError::Conflict {
                message: format!(
                    "revision {target_revision_id} does not belong to graph {graph_id}"
                ),
                current_revision: None,
                current_run_seq: None,
            });
        }
        store.checkout_graph_draft_revision(
            graph_id,
            expected_revision_id,
            target_revision_id,
            now_ms(),
        )?;
        Ok(target)
    }
}
