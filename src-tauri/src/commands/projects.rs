use std::collections::HashMap;
use std::sync::Mutex;

use crate::hub;
use crate::project;
use crate::project_config;
use crate::{agent, with_app_state, AppState};

#[tauri::command]
pub(crate) async fn scan_projects(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<project::Project>, String> {
    // v0.7.2 需求 1 / M2.1：只极短持锁克隆 Arc<registry>，立即释放，再放到
    // spawn_blocking 跑扫描。此前整个扫描期间持 std::sync::Mutex，把阻塞 IO +
    // 子进程 spawn 锁在临界区内，饿死 tokio worker 并串行化所有 AppState 命令。
    let __t = std::time::Instant::now();
    let registry = with_app_state(&state, |s| s.registry.clone())?;
    let result = tauri::async_runtime::spawn_blocking(move || registry.scan_projects())
        .await
        .map_err(|e| e.to_string());
    log::info!(
        "[startup] scan_projects: {:?} ({} projects)",
        __t.elapsed(),
        result.as_ref().map(|v| v.len()).unwrap_or(0)
    );
    result
}

#[tauri::command]
pub(crate) fn add_project(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    path: String,
) -> Result<project::Project, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .add_project(&path)
        .ok_or_else(|| format!("No project directory found at: {}", path))
}

#[tauri::command]
pub(crate) fn remove_project(encoded_name: String) -> Result<(), String> {
    hub::hide_project(&encoded_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn init_project(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
) -> Result<bool, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .init_project(&project_path)
}

#[tauri::command]
pub(crate) fn load_project_settings(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
) -> Result<project_config::ProjectSettings, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .load_project_settings(&project_path)
}

#[tauri::command]
pub(crate) fn load_project_settings_local(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
) -> Result<project_config::ProjectSettings, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .load_project_settings_local(&project_path)
}

#[tauri::command]
pub(crate) fn save_project_settings(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
    settings: project_config::ProjectSettings,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .save_project_settings(&project_path, &settings)
}

#[tauri::command]
pub(crate) fn save_project_settings_local(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
    settings: project_config::ProjectSettings,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .save_project_settings_local(&project_path, &settings)
}

#[tauri::command]
pub(crate) fn load_claude_md(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
) -> Result<Option<String>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .load_claude_md(&project_path)
}

#[tauri::command]
pub(crate) fn load_project_metas() -> Result<HashMap<String, hub::ProjectMeta>, String> {
    hub::load_project_metas().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn save_project_meta(
    encoded_name: String,
    meta: hub::ProjectMeta,
) -> Result<(), String> {
    hub::save_project_meta(&encoded_name, meta).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_level1_dir_cmd(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    encoded_name: String,
) -> Result<Option<String>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    let decoded = agent.decode_project_path(&encoded_name);
    Ok(agent.get_level1_dir(&decoded))
}

#[tauri::command]
pub(crate) fn get_mergeable_projects(
    state: tauri::State<'_, Mutex<AppState>>,
    encoded_name: String,
) -> Result<Vec<String>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let projects = s.registry.scan_projects();
    let mergeable: Vec<String> = projects
        .iter()
        .filter(|p| p.encoded_name != encoded_name)
        .map(|p| p.encoded_name.clone())
        .collect();
    Ok(mergeable)
}

#[tauri::command]
pub(crate) fn merge_projects_logical(
    primary: String,
    secondaries: Vec<String>,
) -> Result<(), String> {
    hub::merge_projects_logical(&primary, secondaries).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn split_project(primary: String) -> Result<(), String> {
    hub::split_project(&primary).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_project_merges() -> Result<HashMap<String, Vec<String>>, String> {
    let merges = hub::load_project_merges().map_err(|e| e.to_string())?;
    Ok(merges.merges)
}

#[tauri::command]
pub(crate) fn get_merged_secondaries(primary: String) -> Result<Vec<String>, String> {
    hub::get_merged_secondaries(&primary).map_err(|e| e.to_string())
}
