use crate::task_launch;
use tauri::Emitter;

#[tauri::command]
pub(crate) fn task_launch_list_sessions(
    project_root: String,
) -> Result<Vec<task_launch::TaskLaunchInstance>, String> {
    task_launch::list_task_instances(&project_root)
}

/// v0.9.2 需求6：任务实例创建/阶段推进后向 webview 广播，前端即时刷新任务
/// 列表并在会话模式下关联当前会话的任务实例（替代 4.8s 一次性发现窗口）。
fn emit_task_instance_changed(
    app: &tauri::AppHandle,
    project_root: &str,
    instance: &task_launch::TaskLaunchInstance,
) {
    let _ = app.emit(
        "task-instance-changed",
        serde_json::json!({
            "project_root": project_root,
            "task_id": instance.task_id,
            "current_phase": instance.current_phase,
        }),
    );
}

#[tauri::command]
pub(crate) fn task_launch_mark_session(
    app: tauri::AppHandle,
    project_root: String,
    task_id: Option<String>,
    session_id: String,
    skill_id: String,
    phase: Option<String>,
    title: Option<String>,
) -> Result<task_launch::TaskLaunchInstance, String> {
    let instance = task_launch::mark_task_stage_session(
        &project_root,
        task_id.as_deref(),
        &session_id,
        &skill_id,
        phase.as_deref().unwrap_or("requirements"),
        title.as_deref(),
    )?;
    emit_task_instance_changed(&app, &project_root, &instance);
    Ok(instance)
}

#[tauri::command]
pub(crate) fn task_requirement_finalize(
    project_root: String,
    request: task_launch::RequirementFinalizeRequest,
) -> Result<task_launch::TaskRequirementFinalized, String> {
    task_launch::finalize_requirement(&project_root, request)
}

#[tauri::command]
pub(crate) fn task_launch_start_run(
    request: task_launch::TaskLaunchStartRunRequest,
) -> Result<task_launch::StartRunFromRevisionResult, String> {
    task_launch::task_launch_start_run(request)
}

#[tauri::command]
pub(crate) fn task_launch_attach_graph(
    project_root: String,
    task_id: String,
    graph_id: String,
) -> Result<task_launch::TaskLaunchInstance, String> {
    task_launch::attach_graph(&project_root, &task_id, &graph_id)
}

#[tauri::command]
pub(crate) fn task_launch_sync_run_status(
    project_root: String,
    task_id: String,
    run_id: String,
    run_status: String,
) -> Result<task_launch::TaskLaunchInstance, String> {
    task_launch::sync_run_status(&project_root, &task_id, &run_id, &run_status)
}

#[tauri::command]
pub(crate) fn task_launch_get_instance(
    project_root: String,
    task_id: String,
) -> Result<Option<task_launch::TaskLaunchInstance>, String> {
    task_launch::get_task_instance(&project_root, &task_id)
}

#[tauri::command]
pub(crate) fn task_planning_instruction(
    project_root: String,
    task_id: String,
) -> Result<String, String> {
    task_launch::planning_instruction_for_instance(&project_root, &task_id)
}

#[tauri::command]
pub(crate) fn task_launch_create_from_existing_graph(
    project_root: String,
    graph_id: String,
    title: String,
    skill_id: String,
) -> Result<task_launch::TaskLaunchInstance, String> {
    task_launch::create_from_existing_graph(&project_root, &graph_id, &title, &skill_id)
}

#[tauri::command]
pub(crate) fn task_launch_rename_task(
    project_root: String,
    task_id: String,
    title: String,
) -> Result<task_launch::TaskLaunchInstance, String> {
    task_launch::rename_task(&project_root, &task_id, &title)
}

#[tauri::command]
pub(crate) fn task_launch_delete_task(project_root: String, task_id: String) -> Result<(), String> {
    task_launch::delete_task(&project_root, &task_id)
}

#[tauri::command]
pub(crate) fn conductor_sync_phase(
    app: tauri::AppHandle,
    request: task_launch::ConductorSyncPhaseRequest,
) -> Result<task_launch::ConductorSyncPhaseResult, String> {
    // v0.9.2 需求7：任务模式防呆——阶段强依赖的工具插件被禁用时明确报错到
    // 会话（防"工具静默缺失 → 流程停摆"的不可诊断形态；白名单闸门见
    // jishu_self::ensure_default_tools_arg 的插件聚合注入）。
    if matches!(request.phase.as_str(), "discuss" | "plan") {
        let required = if request.phase == "discuss" {
            "task-requirements"
        } else {
            "task-plan"
        };
        use tauri::Manager;
        let enabled = app
            .state::<std::sync::Mutex<crate::AppState>>()
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .registry
                    .list_plugins()
                    .into_iter()
                    .find(|plugin| plugin.id == required)
                    .map(|plugin| plugin.enabled)
            })
            .unwrap_or(false);
        if !enabled {
            return Err(format!(
                "任务流程依赖的插件「{required}」已被禁用，请在「插件管理」中启用后重试。"
            ));
        }
    }
    let project_root = request.project_root.clone();
    let result = task_launch::conductor_sync_phase(request)?;
    if result.success {
        emit_task_instance_changed(&app, &project_root, &result.instance);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn conductor_load_task_state(
    project_root: String,
    task_id: String,
) -> Result<task_launch::ConductorLoadStateResult, String> {
    task_launch::conductor_load_task_state(&project_root, &task_id)
}
