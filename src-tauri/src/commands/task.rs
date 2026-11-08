use crate::task_launch;
use tauri::Emitter;

// v0.9.7 需求5 E2：任务命令 project_root 兜底换算统一入口——空 → 默认空间
//（不选项目直接发起任务，实例/图库/产物/节点会话 cwd 全归默认空间名下，E4）。
fn resolve_root(project_root: &str) -> String {
    crate::project::resolve_project_root_or_default(project_root)
}

#[tauri::command]
pub(crate) fn task_launch_list_sessions(
    project_root: String,
) -> Result<Vec<task_launch::TaskLaunchInstance>, String> {
    let project_root = resolve_root(&project_root);
    task_launch::list_task_instances(&project_root)
}

/// v0.9.2 需求6：任务实例创建/更新后向 webview 广播，前端即时刷新任务
/// 列表并在会话模式下关联当前会话的任务实例（替代 4.8s 一次性发现窗口）。
fn emit_task_instance_changed(app: &tauri::AppHandle, project_root: &str) {
    let _ = app.emit(
        "task-instance-changed",
        serde_json::json!({
            "project_root": project_root,
        }),
    );
}

/// v0.9.7 需求2 C2：标记任务主会话（无 phase——单对话流）。
#[tauri::command]
pub(crate) fn task_launch_mark_session(
    app: tauri::AppHandle,
    project_root: String,
    task_id: Option<String>,
    session_id: String,
    skill_id: String,
    title: Option<String>,
) -> Result<task_launch::TaskLaunchInstance, String> {
    let project_root = resolve_root(&project_root);
    let instance = task_launch::mark_task_session(
        &project_root,
        task_id.as_deref(),
        &session_id,
        &skill_id,
        title.as_deref(),
    )?;
    emit_task_instance_changed(&app, &project_root);
    Ok(instance)
}

#[tauri::command]
pub(crate) fn task_launch_start_run(
    request: task_launch::TaskLaunchStartRunRequest,
) -> Result<task_launch::StartRunFromRevisionResult, String> {
    // v0.9.7 需求5 E2：request 结构在解析后换算（设计订正：首参是 request）。
    let request = task_launch::TaskLaunchStartRunRequest {
        project_root: resolve_root(&request.project_root),
        ..request
    };
    task_launch::task_launch_start_run(request)
}

#[tauri::command]
pub(crate) fn task_launch_attach_graph(
    project_root: String,
    task_id: String,
    graph_id: String,
) -> Result<task_launch::TaskLaunchInstance, String> {
    let project_root = resolve_root(&project_root);
    task_launch::attach_graph(&project_root, &task_id, &graph_id)
}

#[tauri::command]
pub(crate) fn task_launch_sync_run_status(
    project_root: String,
    task_id: String,
    run_id: String,
    run_status: String,
) -> Result<task_launch::TaskLaunchInstance, String> {
    let project_root = resolve_root(&project_root);
    task_launch::sync_run_status(&project_root, &task_id, &run_id, &run_status)
}

#[tauri::command]
pub(crate) fn task_launch_get_instance(
    project_root: String,
    task_id: String,
) -> Result<Option<task_launch::TaskLaunchInstance>, String> {
    let project_root = resolve_root(&project_root);
    task_launch::get_task_instance(&project_root, &task_id)
}

#[tauri::command]
pub(crate) fn task_launch_create_from_existing_graph(
    project_root: String,
    graph_id: String,
    title: String,
    skill_id: String,
) -> Result<task_launch::TaskLaunchInstance, String> {
    let project_root = resolve_root(&project_root);
    task_launch::create_from_existing_graph(&project_root, &graph_id, &title, &skill_id)
}

#[tauri::command]
pub(crate) fn task_launch_rename_task(
    project_root: String,
    task_id: String,
    title: String,
) -> Result<task_launch::TaskLaunchInstance, String> {
    let project_root = resolve_root(&project_root);
    task_launch::rename_task(&project_root, &task_id, &title)
}

#[tauri::command]
pub(crate) fn task_launch_delete_task(project_root: String, task_id: String) -> Result<(), String> {
    let project_root = resolve_root(&project_root);
    task_launch::delete_task(&project_root, &task_id)
}

/// v0.9.7 需求2 C2：runner 步骤清单上报（任务卡数据源）。成功广播事件。
#[tauri::command]
pub(crate) fn runner_update_steps(
    app: tauri::AppHandle,
    project_root: String,
    task_id: String,
    steps_json: String,
) -> Result<task_launch::TaskLaunchInstance, String> {
    let project_root = resolve_root(&project_root);
    let instance = task_launch::runner_update_steps(&project_root, &task_id, &steps_json)?;
    emit_task_instance_changed(&app, &project_root);
    Ok(instance)
}

/// v0.9.7 需求2 C2：runner 状态加载（session_start 权威恢复；原
/// conductor_load_task_state 改名）。
#[tauri::command]
pub(crate) fn runner_load_task_state(
    project_root: String,
    task_id: String,
) -> Result<task_launch::ConductorLoadStateResult, String> {
    let project_root = resolve_root(&project_root);
    task_launch::runner_load_task_state(&project_root, &task_id)
}
