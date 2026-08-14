use std::sync::Mutex;

use crate::command;
use crate::{agent, AppState};

#[tauri::command]
pub(crate) fn list_custom_commands() -> Result<Vec<command::CustomCommand>, String> {
    command::list_custom_commands().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn agent_command_presets(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Vec<agent::command_config::AgentCommandPreset>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.require_agent(&agent_id)?.built_in_commands())
}

#[tauri::command]
pub(crate) fn save_custom_command(cmd: command::CustomCommand) -> Result<(), String> {
    command::save_custom_command(cmd).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn delete_custom_command(id: String) -> Result<(), String> {
    command::delete_custom_command(&id).map_err(|e| e.to_string())
}
