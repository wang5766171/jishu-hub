use std::sync::Mutex;

use crate::command;
use crate::hub;
use crate::{agent, AppState};

#[tauri::command]
pub(crate) fn open_in_terminal(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
    resume_session_id: Option<String>,
) -> Result<u32, String> {
    if let Some(sid) = resume_session_id.as_deref() {
        if !agent::command_config::is_safe_session_id(sid) {
            return Err("Invalid session id".to_string());
        }
    }
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .open_in_terminal(&project_path, resume_session_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn register_terminal_session(
    state: tauri::State<'_, Mutex<AppState>>,
    session_id: String,
    pid: u32,
    project_path: String,
    agent_id: String,
) -> Result<(), String> {
    // v0.7.0：agent_id 改为必填入参（前端从会话作用域传入），不再从全局 active 兜底。
    let window_id = agent::command_config::terminal_window_id(&agent_id, &session_id);
    hub::register_terminal_session(session_id, pid, project_path, agent_id, window_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn find_session_terminal(
    session_id: String,
) -> Result<Option<hub::TerminalSessionInfo>, String> {
    hub::find_session_terminal(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn focus_session_terminal(session_id: String) -> Result<bool, String> {
    hub::focus_session_terminal(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn cleanup_dead_sessions() -> Result<u32, String> {
    hub::cleanup_dead_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn run_in_terminal(command_str: String, cwd: Option<String>) -> Result<bool, String> {
    command::run_in_terminal(&command_str, cwd.as_deref()).map_err(|e| e.to_string())
}
