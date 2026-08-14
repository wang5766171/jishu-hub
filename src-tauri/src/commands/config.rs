use std::sync::Mutex;

use crate::config;
use crate::history;
use crate::{agent, AppState};

#[tauri::command]
pub(crate) fn load_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    // Each adapter owns its typed config surface. The frontend decides
    // which command to call from AgentStatus.config_surface.
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.require_agent(&agent_id)?.load_config()
}

/// Read the agent's model store config (routes through adapter).
#[tauri::command]
pub(crate) fn get_models_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    if !matches!(
        agent.config_surface(),
        agent::ConfigSurface::ModelStore { .. }
    ) {
        return Err("Agent does not support model store".to_string());
    }
    agent.load_model_store()
}

/// Write the agent's model store config (routes through adapter).
#[tauri::command]
pub(crate) fn set_models_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    config: serde_json::Value,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    if !matches!(
        agent.config_surface(),
        agent::ConfigSurface::ModelStore { .. }
    ) {
        return Err("Agent does not support model store".to_string());
    }
    agent.save_model_store(&config)
}

/// Read the agent's active model selection (routes through adapter).
#[tauri::command]
pub(crate) fn get_active(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    if !matches!(
        agent.config_surface(),
        agent::ConfigSurface::ModelStore { .. }
    ) {
        return Ok(None);
    }
    agent.get_active_model()
}

/// Persist the active model selection (routes through adapter).
#[tauri::command]
pub(crate) fn set_active(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    active: Option<serde_json::Value>,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    if !matches!(
        agent.config_surface(),
        agent::ConfigSurface::ModelStore { .. }
    ) {
        return Err("Agent does not support model store".to_string());
    }
    agent.set_active_model(active.as_ref())
}

#[derive(serde::Serialize)]
pub(crate) struct RawConfigInfo {
    content: String,
    format: String,
}

#[tauri::command]
pub(crate) fn load_raw_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<RawConfigInfo, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    let format = agent
        .config_format()
        .unwrap_or_else(|| "unknown".to_string());
    let content = agent.load_raw_config()?;
    Ok(RawConfigInfo { content, format })
}

#[tauri::command]
pub(crate) fn save_raw_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    content: String,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .save_raw_config(&content)
}

#[tauri::command]
pub(crate) async fn load_history(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Vec<history::HistoryEntry>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.require_agent(&agent_id)?.load_history())
}

#[tauri::command]
pub(crate) fn save_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    config: serde_json::Value,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.require_agent(&agent_id)?.save_config(&config)
}

#[tauri::command]
pub(crate) fn list_backups(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Vec<config::BackupEntry>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.require_agent(&agent_id)?.list_backups()
}

#[tauri::command]
pub(crate) fn restore_backup(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    backup_path: String,
) -> Result<(), String> {
    {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let backups = s.registry.require_agent(&agent_id)?.list_backups()?;
        let valid = backups.iter().any(|b| b.path == backup_path);
        if !valid {
            return Err("Backup path not found in backup list".to_string());
        }
    }
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .restore_backup(&backup_path)
}
