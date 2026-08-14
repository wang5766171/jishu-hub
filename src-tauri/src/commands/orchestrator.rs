use tauri::Emitter;

use crate::AppState;

#[cfg(feature = "orchestrator")]
fn task_ipc_internal(message: impl Into<String>) -> crate::orchestrator::domain::run::TaskError {
    crate::orchestrator::domain::run::TaskError {
        code: "TASK_IPC_INTERNAL".into(),
        category: crate::orchestrator::domain::run::TaskErrorCategory::Internal,
        message_key: message.into(),
        field_path: None,
        retryable: false,
        retry_after_ms: None,
        current_revision: None,
        current_run_seq: None,
        remediation: Some("Retry after restarting the local application.".into()),
        provider_detail: None,
    }
}

// ── Orchestrator IPC commands ────────────────────────────────────────

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_create_graph(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    input: crate::orchestrator::commands::CreateGraphInput,
) -> Result<
    (
        crate::orchestrator::domain::graph::TaskGraph,
        crate::orchestrator::domain::revision::GraphRevision,
    ),
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.create_graph(&input).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_get_graph(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    graph_id: String,
) -> Result<
    crate::orchestrator::domain::graph::TaskGraph,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.get_graph(&graph_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_get_latest_graph_for_project(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    project_root: String,
) -> Result<
    Option<crate::orchestrator::domain::graph::TaskGraph>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .latest_graph_for_project(std::path::Path::new(&project_root))
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_list_graphs_for_project(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    project_root: String,
) -> Result<
    Vec<crate::orchestrator::domain::graph::TaskGraph>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .list_graphs_for_project(std::path::Path::new(&project_root))
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_list_node_session_ids(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
) -> Result<Vec<String>, crate::orchestrator::domain::run::TaskError> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.list_node_session_ids().map_err(Into::into)
}

/// 列出某次 run 下所有节点的最新 attempt 摘要（侧边栏任务二级树用）。
/// 设计 `docs/task-exec-dev/02-总体设计.md` §6.2。
#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_list_node_sessions(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
) -> Result<
    Vec<crate::orchestrator::domain::run::NodeSessionSummary>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.list_node_sessions(&run_id).map_err(Into::into)
}

/// 列出某节点所有 attempt 的派发 prompt（三角色识别用）。
/// 设计 `docs/task-exec-dev/02-总体设计.md` §7.1 方案 A。
#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_list_attempt_dispatches(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    node_run_id: String,
) -> Result<
    Vec<crate::orchestrator::domain::run::AttemptDispatch>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .list_attempt_dispatches(&node_run_id)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_delete_graph(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    graph_id: String,
) -> Result<(), crate::orchestrator::domain::run::TaskError> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.delete_graph(&graph_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_get_task_conversation(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    graph_id: String,
    after_sequence: Option<u64>,
) -> Result<
    crate::orchestrator::conversation::TaskConversationDetail,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .get_task_conversation(&graph_id, after_sequence.unwrap_or_default())
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_submit_task_interaction(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    request_id: String,
    submission: crate::orchestrator::conversation::TaskInteractionSubmission,
) -> Result<
    crate::orchestrator::conversation::TaskInteractionRequest,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .submit_task_interaction(&request_id, submission)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_submit_task_message(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    graph_id: String,
    node_id: Option<String>,
    message: String,
) -> Result<
    crate::orchestrator::conversation::TaskConversationDetail,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .submit_task_message(&graph_id, node_id.as_deref(), &message)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_get_revision(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    revision_id: String,
) -> Result<
    crate::orchestrator::domain::revision::GraphRevision,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.get_revision(&revision_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_apply_commands(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    graph_id: String,
    expected_revision_id: String,
    commands: Vec<crate::orchestrator::commands::GraphCommand>,
    author: String,
) -> Result<
    crate::orchestrator::commands::RevisionResult,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .apply_commands(&graph_id, &expected_revision_id, &commands, &author)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_validate_commands(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    revision_id: String,
    commands: Vec<crate::orchestrator::commands::GraphCommand>,
) -> Result<Vec<String>, crate::orchestrator::domain::run::TaskError> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .validate_commands(&revision_id, &commands)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) async fn orchestrator_generate_proposal(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    request: crate::orchestrator::planner::PlanningRequest,
) -> Result<crate::orchestrator::planner::GraphProposal, crate::orchestrator::domain::run::TaskError>
{
    let planner = {
        let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
        let task_service = app_state
            .task_service
            .lock()
            .map_err(|e| task_ipc_internal(e.to_string()))?;
        task_service
            .planner_service()
            .map_err(Into::<crate::orchestrator::domain::run::TaskError>::into)?
    };
    let graph_id = request.graph_id.clone();
    let progress_app = app.clone();
    let result = planner
        .generate_with_progress(request, move |progress| {
            let _ = progress_app.emit("task-planning-progress", progress);
        })
        .await;
    result.map_err(|message| {
        let _ = app.emit(
            "task-planning-progress",
            crate::orchestrator::planner::PlanningProgress {
                graph_id,
                stage: "failed".into(),
                attempt: None,
                max_attempts: Some(2),
                text: None,
            },
        );
        crate::orchestrator::domain::run::TaskError {
            code: "TASK_PLANNER_ERROR".into(),
            category: crate::orchestrator::domain::run::TaskErrorCategory::Adapter,
            message_key: message,
            field_path: None,
            retryable: true,
            retry_after_ms: None,
            current_revision: None,
            current_run_seq: None,
            remediation: Some(
                "Check the planning skill installation and Jishu Agent configuration, then retry."
                    .into(),
            ),
            provider_detail: None,
        }
    })
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_steer_planner(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    message: String,
) -> Result<(), crate::orchestrator::domain::run::TaskError> {
    let planner = {
        let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
        let task_service = app_state
            .task_service
            .lock()
            .map_err(|e| task_ipc_internal(e.to_string()))?;
        task_service
            .planner_service()
            .map_err(Into::<crate::orchestrator::domain::run::TaskError>::into)?
    };
    planner
        .steer(message)
        .map_err(|message| crate::orchestrator::domain::run::TaskError {
            code: "TASK_STEER_ERROR".into(),
            category: crate::orchestrator::domain::run::TaskErrorCategory::Adapter,
            message_key: message,
            field_path: None,
            retryable: false,
            retry_after_ms: None,
            current_revision: None,
            current_run_seq: None,
            remediation: None,
            provider_detail: None,
        })
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_stop_planner_turn(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
) -> Result<(), crate::orchestrator::domain::run::TaskError> {
    let planner = {
        let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
        let task_service = app_state
            .task_service
            .lock()
            .map_err(|e| task_ipc_internal(e.to_string()))?;
        task_service
            .planner_service()
            .map_err(Into::<crate::orchestrator::domain::run::TaskError>::into)?
    };
    planner
        .stop_current_turn()
        .map_err(|message| crate::orchestrator::domain::run::TaskError {
            code: "TASK_PLANNER_STOP_ERROR".into(),
            category: crate::orchestrator::domain::run::TaskErrorCategory::Adapter,
            message_key: message,
            field_path: None,
            retryable: false,
            retry_after_ms: None,
            current_revision: None,
            current_run_seq: None,
            remediation: None,
            provider_detail: None,
        })
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_start_run(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    graph_id: String,
    revision_id: String,
    budget_state: Option<crate::orchestrator::domain::run::BudgetState>,
) -> Result<crate::orchestrator::domain::run::GraphRun, crate::orchestrator::domain::run::TaskError>
{
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .start_run_with_budget(&graph_id, &revision_id, budget_state.unwrap_or_default())
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_propose_run_revision(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
    candidate_revision_id: String,
) -> Result<
    crate::orchestrator::domain::run::RunRevisionProposal,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .propose_run_revision(&run_id, &candidate_revision_id)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_apply_run_revision(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
    proposal_id: String,
    expected_run_seq: u64,
) -> Result<crate::orchestrator::domain::run::GraphRun, crate::orchestrator::domain::run::TaskError>
{
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .apply_run_revision(&run_id, &proposal_id, expected_run_seq)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_list_runs(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    graph_id: String,
) -> Result<
    Vec<crate::orchestrator::domain::run::GraphRun>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.list_runs(&graph_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_get_node_runs(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
) -> Result<
    Vec<crate::orchestrator::domain::run::NodeRun>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.get_node_runs(&run_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_get_attempt(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    node_run_id: String,
    attempt_number: u32,
) -> Result<
    crate::orchestrator::domain::run::NodeAttempt,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .get_attempt(&node_run_id, attempt_number)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_get_run_projection(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
) -> Result<crate::orchestrator::events::RunProjection, crate::orchestrator::domain::run::TaskError>
{
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.run_projection(&run_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_pause_run(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
) -> Result<(), crate::orchestrator::domain::run::TaskError> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.pause_run(&run_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_resume_run(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
) -> Result<(), crate::orchestrator::domain::run::TaskError> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.resume_run(&run_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_cancel_run(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
) -> Result<(), crate::orchestrator::domain::run::TaskError> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.cancel_run(&run_id).map_err(Into::into)
}

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_pending_approvals(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
) -> Result<
    Vec<crate::orchestrator::domain::run::ApprovalRequest>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.pending_approvals(&run_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_resolve_approval(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    approval_id: String,
    approved: bool,
) -> Result<
    crate::orchestrator::domain::run::ApprovalRequest,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .resolve_approval(&approval_id, approved, "local_user")
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_run_events_after(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
    after_seq: u64,
) -> Result<Vec<crate::orchestrator::events::TaskEvent>, crate::orchestrator::domain::run::TaskError>
{
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .run_events_after(&run_id, after_seq)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_list_artifacts(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
) -> Result<
    Vec<crate::orchestrator::domain::run::ArtifactRef>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.list_artifacts(&run_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_get_artifact(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    artifact_id: String,
) -> Result<
    crate::orchestrator::domain::run::ArtifactRef,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.get_artifact(&artifact_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_get_diff(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    from_revision_id: String,
    to_revision_id: String,
) -> Result<
    crate::orchestrator::domain::revision::RevisionDiff,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .get_diff(&from_revision_id, &to_revision_id)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_list_revisions(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    graph_id: String,
) -> Result<
    Vec<crate::orchestrator::domain::revision::GraphRevision>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service.list_revisions(&graph_id).map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_checkout_draft_revision(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    graph_id: String,
    expected_revision_id: String,
    target_revision_id: String,
) -> Result<
    crate::orchestrator::domain::revision::GraphRevision,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .checkout_draft_revision(&graph_id, &expected_revision_id, &target_revision_id)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_choose_recovery(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    node_run_id: String,
    strategy: crate::orchestrator::recovery::RecoveryStrategy,
    reason: String,
) -> Result<crate::orchestrator::domain::run::NodeRun, crate::orchestrator::domain::run::TaskError>
{
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .choose_recovery(&node_run_id, &strategy, &reason)
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
pub(crate) fn orchestrator_attach_repair(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    run_id: String,
    node_run_id: String,
    commands: Vec<crate::orchestrator::commands::GraphCommand>,
    repair_depth: u32,
) -> Result<String, crate::orchestrator::domain::run::TaskError> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .attach_repair(&run_id, &node_run_id, &commands, repair_depth)
        .map_err(Into::into)
}
