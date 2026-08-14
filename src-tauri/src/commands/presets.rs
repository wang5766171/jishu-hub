use std::sync::Mutex;

use crate::hub;
use crate::AppState;

#[tauri::command]
pub(crate) fn list_config_templates(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Vec<hub::ConfigTemplate>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.require_agent(&agent_id)?.config_templates())
}

#[tauri::command]
pub(crate) fn list_presets(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Vec<hub::Preset>, String> {
    let _s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    hub::list_presets(&agent_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn save_preset(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    preset: hub::Preset,
) -> Result<(), String> {
    let _s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    hub::save_preset(&agent_id, preset).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn delete_preset(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    id: String,
) -> Result<(), String> {
    let _s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    hub::delete_preset(&agent_id, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn apply_preset(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    id: String,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let presets = hub::list_presets(&agent_id).map_err(|e| e.to_string())?;
    let preset = presets
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("Preset not found")?;
    s.registry
        .require_agent(&agent_id)?
        .save_config(&preset.config)
}
