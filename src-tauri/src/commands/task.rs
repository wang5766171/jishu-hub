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
///
/// v0.9.8 评审修复轮 R3（P1-1）：任务实例的创建点移到了发送入口（`chat::
/// send_message` 在拉起进程之前建、会话解析后改绑、拉起失败撤销），那里也经
/// 这一处广播。
pub(crate) fn emit_task_instance_changed(app: &tauri::AppHandle, project_root: &str) {
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
/// 需求9 #4：可选 title（runner 扩展随步骤上报 goal，仅默认标题时覆盖）。
#[tauri::command]
pub(crate) fn runner_update_steps(
    app: tauri::AppHandle,
    project_root: String,
    task_id: String,
    steps_json: String,
    title: Option<String>,
) -> Result<task_launch::TaskLaunchInstance, String> {
    let project_root = resolve_root(&project_root);
    let instance =
        task_launch::runner_update_steps(&project_root, &task_id, &steps_json, title.as_deref())?;
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

// ── v0.9.8 需求22（评审修复轮 R2 / C4）：任务「不询问」按会话 ──
// 开关记在任务实例上（见 task_launch::TaskLaunchInstance::no_ask）：该任务的
// 主会话与它派发出去的节点会话生效，别的会话（含普通对话）一律不生效。
// 三个消费方同源——前端开关（这两个命令）、执行器扩展、工具审批扩展都按
// 「会话号 → hub 的任务登记」向同一个出处查询（扩展走 hubInvoke 的
// runner_capability_plugins）。此前的全局键 `taskNoAsk` 不再读：不迁移、
// 不清理，留在配置文件里没有任何作用。

#[tauri::command]
pub(crate) fn task_get_no_ask(
    session_id: String,
    // 可选：调用方知道项目根就带上，省去「会话号 → 项目」的定位；不带也能查。
    project_root: Option<String>,
) -> Result<bool, String> {
    task_launch::no_ask_for_session(project_root.as_deref(), &session_id)
}

/// 返回设置后的值。会话不是任务会话 → Err（开关只对任务会话有意义）。
#[tauri::command]
pub(crate) fn task_set_no_ask(
    session_id: String,
    enabled: bool,
    project_root: Option<String>,
) -> Result<bool, String> {
    task_launch::set_no_ask_for_session(project_root.as_deref(), &session_id, enabled)
}
