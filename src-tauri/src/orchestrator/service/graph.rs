use super::*;

impl TaskService {
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

    pub fn list_graphs_for_project(
        &self,
        project_root: &std::path::Path,
    ) -> Result<Vec<TaskGraph>, TaskServiceError> {
        Ok(self.store.list_graphs_for_project(project_root)?)
    }

    /// 所有节点 attempt 的去重非空 session_id（供前端常规会话列表过滤）。
    pub fn list_node_session_ids(&self) -> Result<Vec<String>, TaskServiceError> {
        Ok(self.store.list_node_session_ids()?)
    }

    /// 列出某次 run 下所有节点的最新 attempt 摘要（侧边栏任务二级树用）。
    pub fn list_node_sessions(
        &self,
        run_id: &str,
    ) -> Result<Vec<crate::orchestrator::domain::run::NodeSessionSummary>, TaskServiceError> {
        Ok(self.store.list_node_sessions(run_id)?)
    }

    /// 列出某节点所有 attempt 的派发 prompt（三角色识别用）。
    pub fn list_attempt_dispatches(
        &self,
        node_run_id: &str,
    ) -> Result<Vec<crate::orchestrator::domain::run::AttemptDispatch>, TaskServiceError> {
        Ok(self.store.list_attempt_dispatches(node_run_id)?)
    }

    pub fn delete_graph(&self, graph_id: &str) -> Result<(), TaskServiceError> {
        self.store.delete_graph(graph_id)?;
        Ok(())
    }

    pub fn list_task_conversations(
        &self,
        project_root: &std::path::Path,
    ) -> Result<Vec<TaskConversationSummary>, TaskServiceError> {
        let graphs = self.store.list_graphs_for_project(project_root)?;
        let mut summaries = Vec::with_capacity(graphs.len());

        for graph in graphs {
            let pending_interactions = self.store.pending_task_interactions(&graph.graph_id)?;
            let runs = self.store.list_runs(&graph.graph_id)?;
            let run = runs.first();
            let node_runs = match run {
                Some(value) => self.store.get_node_runs(&value.run_id)?,
                None => Vec::new(),
            };
            let revision_id = run
                .map(|value| value.active_revision_id.as_str())
                .or(graph.current_draft_revision.as_deref());
            let snapshot = match revision_id {
                Some(value) => Some(self.store.get_revision(value)?.snapshot()?),
                None => None,
            };
            summaries.push(build_task_conversation_summary(
                &graph,
                run,
                &node_runs,
                snapshot.as_ref(),
                pending_interactions.len(),
            ));
        }

        summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(summaries)
    }

    pub fn get_task_conversation(
        &self,
        graph_id: &str,
        after_sequence: u64,
    ) -> Result<TaskConversationDetail, TaskServiceError> {
        let graph = self.store.get_graph(graph_id)?;
        let pending_interactions = self.store.pending_task_interactions(graph_id)?;
        let runs = self.store.list_runs(graph_id)?;
        let run = runs.first();
        let node_runs = match run {
            Some(value) => self.store.get_node_runs(&value.run_id)?,
            None => Vec::new(),
        };
        let revision_id = run
            .map(|value| value.active_revision_id.as_str())
            .or(graph.current_draft_revision.as_deref());
        let snapshot = match revision_id {
            Some(value) => Some(self.store.get_revision(value)?.snapshot()?),
            None => None,
        };
        let summary = build_task_conversation_summary(
            &graph,
            run,
            &node_runs,
            snapshot.as_ref(),
            pending_interactions.len(),
        );
        let mut entries = Vec::new();
        if after_sequence == 0 {
            entries.push(original_goal_entry(&graph));
        }
        if let Some(value) = run {
            let events = self
                .store
                .events_after(&value.run_id, after_sequence, 500)?;
            entries.extend(project_public_entries(graph_id, &events));
        }

        Ok(TaskConversationDetail {
            summary,
            entries,
            pending_interactions,
        })
    }

    pub fn submit_task_interaction(
        &self,
        request_id: &str,
        submission: TaskInteractionSubmission,
    ) -> Result<TaskInteractionRequest, TaskServiceError> {
        let request = self.store.get_task_interaction(request_id)?;
        let selected = submission
            .selected_option_ids
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        if selected.len() != submission.selected_option_ids.len() {
            return Err(TaskServiceError::InvalidInput(
                "interaction selection contains duplicate option ids".into(),
            ));
        }
        if !request.allow_multiple && selected.len() > 1 {
            return Err(TaskServiceError::InvalidInput(
                "interaction only allows one option".into(),
            ));
        }
        let valid_option_ids = request
            .options
            .iter()
            .map(|option| option.option_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if !selected.is_subset(&valid_option_ids) {
            return Err(TaskServiceError::InvalidInput(
                "interaction selection contains an unknown option".into(),
            ));
        }
        let custom_text = submission
            .custom_text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if custom_text.is_some() && !request.allow_custom_text {
            return Err(TaskServiceError::InvalidInput(
                "interaction does not allow custom text".into(),
            ));
        }
        if request.required && selected.is_empty() && custom_text.is_none() {
            return Err(TaskServiceError::InvalidInput(
                "interaction requires a selection or custom text".into(),
            ));
        }

        let resolved = self
            .store
            .resolve_task_interaction(
                request_id,
                &TaskInteractionSubmission {
                    selected_option_ids: submission.selected_option_ids,
                    custom_text,
                },
                now_ms(),
            )
            .map_err(TaskServiceError::from)?;

        if let Some(node_run_id) = resolved.node_run_id.as_deref() {
            let mut node_run = self.store.get_node_run(node_run_id)?;
            if node_run.status == NodeRunStatus::AwaitingApproval {
                node_run.status = NodeRunStatus::Ready;
                node_run.finished_at = None;
                node_run.error = None;
                self.store.save_node_run(&node_run)?;
            }
        }
        if let Some(run_id) = resolved.run_id.as_deref() {
            let run = self.store.get_run(run_id)?;
            if run.status == RunStatus::AwaitingHuman {
                self.resume_run(run_id)?;
            }
        }

        Ok(resolved)
    }

    pub fn submit_task_message(
        &self,
        graph_id: &str,
        node_id: Option<&str>,
        message: &str,
    ) -> Result<TaskConversationDetail, TaskServiceError> {
        let text = message.trim();
        if text.is_empty() {
            return Err(TaskServiceError::InvalidInput(
                "task message cannot be empty".into(),
            ));
        }

        let run = self
            .store
            .list_runs(graph_id)?
            .into_iter()
            .next()
            .ok_or_else(|| TaskServiceError::InvalidInput("task has no run".into()))?;
        let node_runs = self.store.get_node_runs(&run.run_id)?;
        let selected_node_run = node_id
            .and_then(|selected| {
                node_runs
                    .iter()
                    .filter(|node_run| node_run.node_id == selected)
                    .max_by_key(|node_run| node_run.started_at.unwrap_or_default())
            })
            .or_else(|| {
                node_runs
                    .iter()
                    .find(|node_run| node_run.status.is_active())
            })
            .or_else(|| {
                node_runs
                    .iter()
                    .max_by_key(|node_run| node_run.started_at.unwrap_or_default())
            });

        let latest_attempt = selected_node_run
            .and_then(|node_run| self.store.latest_attempt(&node_run.node_run_id).ok())
            .flatten();
        let mut payload = serde_json::json!({
            "message": text,
            "public": true,
        });
        if let Some(selected) = node_id {
            payload["node_id"] = serde_json::Value::String(selected.to_string());
        } else if let Some(node_run) = selected_node_run {
            payload["node_id"] = serde_json::Value::String(node_run.node_id.clone());
        }
        if let Some(node_run) = selected_node_run {
            payload["node_run_id"] = serde_json::Value::String(node_run.node_run_id.clone());
        }
        if let Some(attempt) = latest_attempt {
            payload["attempt_id"] = serde_json::Value::String(attempt.attempt_id);
        }

        let event = build_event(
            gen_id("event"),
            run.run_id,
            run.run_seq + 1,
            TaskEventType::AttemptProgressed,
            "user",
            now_ms(),
            payload,
        );
        self.store.append_events(&[event])?;
        self.get_task_conversation(graph_id, 0)
    }
}
