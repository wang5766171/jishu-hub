use crate::task_launch;

#[tauri::command]
pub(crate) fn task_launch_list_sessions(
    project_root: String,
) -> Result<Vec<task_launch::TaskLaunchInstance>, String> {
    task_launch::list_task_instances(&project_root)
}

#[tauri::command]
pub(crate) fn task_launch_mark_session(
    project_root: String,
    task_id: Option<String>,
    session_id: String,
    skill_id: String,
    phase: Option<String>,
    title: Option<String>,
) -> Result<task_launch::TaskLaunchInstance, String> {
    task_launch::mark_task_stage_session(
        &project_root,
        task_id.as_deref(),
        &session_id,
        &skill_id,
        phase.as_deref().unwrap_or("requirements"),
        title.as_deref(),
    )
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
    request: task_launch::ConductorSyncPhaseRequest,
) -> Result<task_launch::ConductorSyncPhaseResult, String> {
    task_launch::conductor_sync_phase(request)
}

#[tauri::command]
pub(crate) fn conductor_load_task_state(
    project_root: String,
    task_id: String,
) -> Result<task_launch::ConductorLoadStateResult, String> {
    task_launch::conductor_load_task_state(&project_root, &task_id)
}
