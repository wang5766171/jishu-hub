mod acp;
mod acp_runtime;
mod agent;
mod agent_runtime;
mod chat;
mod cli_runtime;
mod command;
mod config;
mod dialog_commands;
mod history;
mod hub;
mod image;
mod llm;
mod orchestrator;
pub mod os_adapter;
mod pi_rpc_runtime;
mod process_command;
mod process_control;
mod project;
mod project_config;
mod session;
mod task_plan;
mod util;

#[cfg(feature = "cli")]
pub mod cli;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

const TEXT_PREVIEW_MAX_BYTES: usize = 512 * 1024;

#[derive(serde::Serialize)]
struct TextFilePreview {
    path: String,
    content: String,
    truncated: bool,
    size: usize,
}

pub struct AppState {
    pub registry: Arc<agent::AgentRegistry>,
    #[cfg(feature = "orchestrator")]
    pub task_service: std::sync::Mutex<orchestrator::TaskService>,
}

#[tauri::command]
fn list_agents(state: tauri::State<'_, Mutex<AppState>>) -> Result<Vec<agent::AgentInfo>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.list_agents())
}

#[tauri::command]
async fn scan_projects(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<project::Project>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.scan_projects())
}

#[tauri::command]
fn add_project(
    state: tauri::State<'_, Mutex<AppState>>,
    path: String,
) -> Result<project::Project, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .active()
        .add_project(&path)
        .ok_or_else(|| format!("No .claude directory found at: {}", path))
}

#[tauri::command]
fn remove_project(encoded_name: String) -> Result<(), String> {
    hub::hide_project(&encoded_name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_sessions(
    state: tauri::State<'_, Mutex<AppState>>,
    encoded_name: String,
) -> Result<Vec<session::Session>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().list_sessions(&encoded_name)
}

#[tauri::command]
async fn get_session_messages(
    state: tauri::State<'_, Mutex<AppState>>,
    session_id: String,
    encoded_name: String,
) -> Result<Vec<session::Message>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .active()
        .get_session_messages(&session_id, &encoded_name)
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<TextFilePreview, String> {
    // Use the same path validation as the other read commands so all three
    // file-read entry points enforce identical rules (K-CRIT-1 consistency).
    image::validate_path(&std::path::PathBuf::from(&path))?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.iter().take(TEXT_PREVIEW_MAX_BYTES).any(|b| *b == 0) {
        return Err("Binary files cannot be previewed as text".to_string());
    }

    let size = bytes.len();
    let truncated = size > TEXT_PREVIEW_MAX_BYTES;
    let slice = if truncated {
        &bytes[..TEXT_PREVIEW_MAX_BYTES]
    } else {
        &bytes
    };
    let content = String::from_utf8_lossy(slice).to_string();

    Ok(TextFilePreview {
        path,
        content,
        truncated,
        size,
    })
}

#[tauri::command]
fn get_session_names() -> Result<HashMap<String, String>, String> {
    hub::get_session_names().map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_session(session_id: String, name: String) -> Result<(), String> {
    hub::rename_session(session_id, name).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_session_name(session_id: String) -> Result<(), String> {
    hub::delete_session_name(session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_config(state: tauri::State<'_, Mutex<AppState>>) -> Result<serde_json::Value, String> {
    // Each adapter owns its typed config surface. The frontend decides
    // which command to call from AgentStatus.config_surface.
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().load_config()
}

/// Read the active agent's model store config (routes through adapter).
#[tauri::command]
fn get_models_config(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<serde_json::Value, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.active();
    if !matches!(
        agent.config_surface(),
        agent::ConfigSurface::ModelStore { .. }
    ) {
        return Err("Active agent does not support model store".to_string());
    }
    agent.load_model_store()
}

/// Write the active agent's model store config (routes through adapter).
#[tauri::command]
fn set_models_config(
    state: tauri::State<'_, Mutex<AppState>>,
    config: serde_json::Value,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.active();
    if !matches!(
        agent.config_surface(),
        agent::ConfigSurface::ModelStore { .. }
    ) {
        return Err("Active agent does not support model store".to_string());
    }
    agent.save_model_store(&config)
}

/// Read the active agent's active model selection (routes through adapter).
#[tauri::command]
fn get_active(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Option<serde_json::Value>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.active();
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
fn set_active(
    state: tauri::State<'_, Mutex<AppState>>,
    active: Option<serde_json::Value>,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.active();
    if !matches!(
        agent.config_surface(),
        agent::ConfigSurface::ModelStore { .. }
    ) {
        return Err("Active agent does not support model store".to_string());
    }
    agent.set_active_model(active.as_ref())
}

#[derive(serde::Serialize)]
struct RawConfigInfo {
    content: String,
    format: String,
}

#[tauri::command]
fn load_raw_config(state: tauri::State<'_, Mutex<AppState>>) -> Result<RawConfigInfo, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let active = s.registry.active();
    let format = active
        .config_format()
        .unwrap_or_else(|| "unknown".to_string());
    let content = active.load_raw_config()?;
    Ok(RawConfigInfo { content, format })
}

#[tauri::command]
fn save_raw_config(
    state: tauri::State<'_, Mutex<AppState>>,
    content: String,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().save_raw_config(&content)
}

#[tauri::command]
async fn load_history(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<history::HistoryEntry>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.active().load_history())
}

#[tauri::command]
fn save_config(
    state: tauri::State<'_, Mutex<AppState>>,
    config: serde_json::Value,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().save_config(&config)
}

#[tauri::command]
fn list_backups(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<config::BackupEntry>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().list_backups()
}

#[tauri::command]
fn restore_backup(
    state: tauri::State<'_, Mutex<AppState>>,
    backup_path: String,
) -> Result<(), String> {
    {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let backups = s.registry.active().list_backups()?;
        let valid = backups.iter().any(|b| b.path == backup_path);
        if !valid {
            return Err("Backup path not found in backup list".to_string());
        }
    }
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().restore_backup(&backup_path)
}

#[tauri::command]
fn load_language() -> Result<Option<String>, String> {
    hub::load_language().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_language(lang: String) -> Result<(), String> {
    hub::save_language(&lang).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_always_on_top() -> Result<bool, String> {
    hub::load_always_on_top().map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_always_on_top(app: tauri::AppHandle) -> Result<bool, String> {
    let current = hub::load_always_on_top().map_err(|e| e.to_string())?;
    let new_value = !current;

    if let Some(window) = app.get_webview_window("main") {
        window
            .set_always_on_top(new_value)
            .map_err(|e| e.to_string())?;
    }

    hub::save_always_on_top(new_value).map_err(|e| e.to_string())?;
    Ok(new_value)
}

#[tauri::command]
fn load_theme() -> Result<String, String> {
    let state = hub::load_state().map_err(|e| e.to_string())?;
    Ok(state.theme.unwrap_or_else(|| "colorful".to_string()))
}

#[tauri::command]
fn save_theme(theme: String) -> Result<(), String> {
    let mut state = hub::load_state().map_err(|e| e.to_string())?;
    state.theme = Some(theme);
    hub::save_state(&state).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_last_project() -> Result<Option<String>, String> {
    hub::load_last_project().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("Only http(s) URLs can be opened".to_string());
    }
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_last_project(encoded_name: String) -> Result<(), String> {
    hub::save_last_project(&encoded_name).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_font_sizes() -> Result<(Option<String>, Option<String>), String> {
    hub::load_font_sizes().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_font_sizes(font_size_base: String, font_size_prose: String) -> Result<(), String> {
    hub::save_font_sizes(&font_size_base, &font_size_prose).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_custom_commands() -> Result<Vec<command::CustomCommand>, String> {
    command::list_custom_commands().map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_command_presets(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<agent::command_config::AgentCommandPreset>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.active().built_in_commands())
}

#[tauri::command]
fn save_custom_command(cmd: command::CustomCommand) -> Result<(), String> {
    command::save_custom_command(cmd).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_custom_command(id: String) -> Result<(), String> {
    command::delete_custom_command(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_terminal(
    state: tauri::State<'_, Mutex<AppState>>,
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
        .active()
        .open_in_terminal(&project_path, resume_session_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn register_terminal_session(
    state: tauri::State<'_, Mutex<AppState>>,
    session_id: String,
    pid: u32,
    project_path: String,
    agent_id: Option<String>,
) -> Result<(), String> {
    let fallback_agent_id = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        s.registry.active_id().to_string()
    };
    let agent_id = agent_id.unwrap_or(fallback_agent_id);
    let window_id = agent::command_config::terminal_window_id(&agent_id, &session_id);
    hub::register_terminal_session(session_id, pid, project_path, agent_id, window_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn find_session_terminal(session_id: String) -> Result<Option<hub::TerminalSessionInfo>, String> {
    hub::find_session_terminal(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn focus_session_terminal(session_id: String) -> Result<bool, String> {
    hub::focus_session_terminal(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn cleanup_dead_sessions() -> Result<u32, String> {
    hub::cleanup_dead_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
fn init_project(
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
) -> Result<bool, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().init_project(&project_path)
}

#[tauri::command]
fn run_in_terminal(command_str: String, cwd: Option<String>) -> Result<bool, String> {
    command::run_in_terminal(&command_str, cwd.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_project_settings(
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
) -> Result<project_config::ProjectSettings, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().load_project_settings(&project_path)
}

#[tauri::command]
fn load_project_settings_local(
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
) -> Result<project_config::ProjectSettings, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .active()
        .load_project_settings_local(&project_path)
}

#[tauri::command]
fn save_project_settings(
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
    settings: project_config::ProjectSettings,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .active()
        .save_project_settings(&project_path, &settings)
}

#[tauri::command]
fn save_project_settings_local(
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
    settings: project_config::ProjectSettings,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .active()
        .save_project_settings_local(&project_path, &settings)
}

#[tauri::command]
fn load_claude_md(
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
) -> Result<Option<String>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().load_claude_md(&project_path)
}

#[tauri::command]
fn load_project_metas() -> Result<HashMap<String, hub::ProjectMeta>, String> {
    hub::load_project_metas().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_project_meta(encoded_name: String, meta: hub::ProjectMeta) -> Result<(), String> {
    hub::save_project_meta(&encoded_name, meta).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_level1_dir_cmd(
    state: tauri::State<'_, Mutex<AppState>>,
    encoded_name: String,
) -> Result<Option<String>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let decoded = s.registry.active().decode_project_path(&encoded_name);
    Ok(s.registry.active().get_level1_dir(&decoded))
}

#[tauri::command]
fn get_mergeable_projects(
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
fn merge_projects_logical(primary: String, secondaries: Vec<String>) -> Result<(), String> {
    hub::merge_projects_logical(&primary, secondaries).map_err(|e| e.to_string())
}

#[tauri::command]
fn split_project(primary: String) -> Result<(), String> {
    hub::split_project(&primary).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_project_merges() -> Result<HashMap<String, Vec<String>>, String> {
    let merges = hub::load_project_merges().map_err(|e| e.to_string())?;
    Ok(merges.merges)
}

#[tauri::command]
fn get_merged_secondaries(primary: String) -> Result<Vec<String>, String> {
    hub::get_merged_secondaries(&primary).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_config_templates(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<hub::ConfigTemplate>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.active().config_templates())
}

#[tauri::command]
fn list_presets(state: tauri::State<'_, Mutex<AppState>>) -> Result<Vec<hub::Preset>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent_id = s.registry.active_id().to_string();
    hub::list_presets(&agent_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_preset(
    state: tauri::State<'_, Mutex<AppState>>,
    preset: hub::Preset,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent_id = s.registry.active_id().to_string();
    hub::save_preset(&agent_id, preset).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_preset(state: tauri::State<'_, Mutex<AppState>>, id: String) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent_id = s.registry.active_id().to_string();
    hub::delete_preset(&agent_id, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_preset(state: tauri::State<'_, Mutex<AppState>>, id: String) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent_id = s.registry.active_id().to_string();
    let presets = hub::list_presets(&agent_id).map_err(|e| e.to_string())?;
    let preset = presets
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("Preset not found")?;
    s.registry.active().save_config(&preset.config)
}

#[tauri::command]
fn agent_list_statuses(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<agent::AgentStatus>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.list_agent_statuses())
}

#[tauri::command]
fn agent_set_active(state: tauri::State<'_, Mutex<AppState>>, id: String) -> Result<(), String> {
    let mut s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.set_active(&id)?;
    hub::save_active_agent_id(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_get_active(state: tauri::State<'_, Mutex<AppState>>) -> Result<String, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.active_id().to_string())
}

#[tauri::command]
async fn agent_refresh_health(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
    let results: Vec<(String, agent::AgentHealth)> = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        // Each agent's probe_sync() is synchronous 鈥?no await needed
        s.registry
            .agents_info()
            .iter()
            .map(|(id, plugin)| (id.clone(), plugin.probe_sync()))
            .collect()
    };

    // Re-lock to update cache
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.update_health_cache(results);
    Ok(())
}

#[tauri::command]
fn get_app_dir() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("No parent dir")?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn check_prerequisite(command: String) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut lookup = std::process::Command::new("where");
        crate::process_command::std_no_window(lookup.arg(&command))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut lookup = std::process::Command::new("which");
        lookup
            .arg(&command)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Whitelist for `install_agent_command`. The frontend only ever sends the
/// agents' built-in `install_hint` / `native_install_command` strings (and the
/// runtime install/update commands), all of which are fixed
/// `npm/winget/choco install <pkg>` or `winget upgrade <pkg>` patterns. Restricting to these patterns
/// closes the "execute arbitrary PowerShell" hole (K-HIGH-3 / original H1)
/// without affecting any current install flow.
fn is_allowed_install_command(cmd: &str) -> bool {
    fn safe_pkg(s: &str) -> bool {
        let s = s.trim();
        !s.is_empty()
            && !s.contains(char::is_whitespace)
            && s.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-' | '+')
            })
    }
    if cmd == "jishu-hub-internal-install" {
        return true;
    }
    if runtime_registry()
        .iter()
        .any(|runtime| runtime.install_command == Some(cmd) || runtime.update_command == Some(cmd))
    {
        return true;
    }
    for prefix in [
        "npm install -g ",
        "winget install ",
        "winget upgrade ",
        "choco install ",
    ] {
        if let Some(rest) = cmd.strip_prefix(prefix) {
            return safe_pkg(rest);
        }
    }
    false
}

#[tauri::command]
async fn install_agent_command(app: tauri::AppHandle, command: String) -> Result<String, String> {
    if !is_allowed_install_command(&command) {
        return Err(format!("Install command not allowed: {}", command));
    }
    if command == "jishu-hub-internal-install" {
        return install_internal_jishu_agent(app).await;
    }
    crate::os_adapter::shell::run_install_command(&command, None).await
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(&entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

async fn install_internal_jishu_agent(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let res_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;
    let mut source = res_dir.join("third_party").join("pi-bundle");
    if !source.exists() {
        source = res_dir.join("_up_").join("third_party").join("pi-bundle");
    }

    let target = crate::agent::jishu_self::pi_agent_dir().ok_or("Failed to get target dir")?;

    if !source.exists() {
        // LITE MODE: If bundled pi is missing, fallback to installing from NPM globally
        // This is safe because if we get here, it means the user clicked install and we are in lite build
        // JISHU_AGENT_BINDING_START
        let mut cmd = shell_command(
            "npm",
            vec![
                "install".to_string(),
                "-g".to_string(),
                "@jishu-hub/jishu-agent@0.79.1-7".to_string(),
            ],
        );
        // JISHU_AGENT_BINDING_END
        let mut installer = crate::process_command::tokio_no_window(&mut cmd);

        let output = installer.output().await.map_err(|e| e.to_string())?;

        if output.status.success() {
            return Ok("Pi agent installed globally from NPM (Lite version).".to_string());
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("NPM installation failed: {}", stderr));
        }
    }

    // Ensure target directory exists to prevent xcopy from asking F/D
    if let Err(e) = std::fs::create_dir_all(&target) {
        return Err(format!("Failed to create target directory: {}", e));
    }

    // Copy files
    if let Err(e) = copy_dir_recursive(&source, std::path::Path::new(&target)) {
        return Err(format!("Failed to copy bundled pi agent files: {}", e));
    }

    // Run npm install --production
    let mut cmd = shell_command(
        "npm",
        vec!["install".to_string(), "--production".to_string()],
    );
    let mut installer = crate::process_command::tokio_no_window(&mut cmd);
    installer.current_dir(&target);

    let output = installer.output().await.map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Check MCP adapter installation status for a specific agent (routed through adapter contract).
#[tauri::command]
fn check_mcp_adapter(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s
        .registry
        .get(&agent_id)
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    agent.check_mcp()
}

/// Install MCP adapter for a specific agent (routed through adapter contract).
/// The MutexGuard is released before .await to keep the future Send-safe.
#[tauri::command]
async fn install_mcp_adapter(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<String, String> {
    // Validate agent supports MCP under the lock (synchronous), then release.
    {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let agent = s
            .registry
            .get(&agent_id)
            .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
        if !agent.supports_mcp() {
            return Err(format!("Agent {} does not support MCP", agent_id));
        }
    }
    // Lock released — delegate to adapter's standalone install helper.
    crate::agent::jishu_self::JishuSelfAgent::install_mcp_standalone().await
}

#[derive(serde::Serialize)]
pub struct EnvStatus {
    pub node_installed: bool,
    pub node_version: Option<String>,
    pub npm_installed: bool,
    pub npm_version: Option<String>,
    pub python_installed: bool,
    pub python_version: Option<String>,
    pub git_installed: bool,
    pub git_version: Option<String>,
    pub runtimes: Vec<RuntimeStatus>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeStatus {
    pub id: String,
    pub installed: bool,
    pub version: Option<String>,
    pub install_command: Option<String>,
    pub update_command: Option<String>,
    pub download_url: Option<String>,
    pub latest_package: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum RuntimeLatestSource {
    Npm { package: &'static str },
    Python,
    GitForWindows,
}

#[derive(Debug, Clone, Copy)]
struct RuntimeDefinition {
    id: &'static str,
    program: &'static str,
    version_args: &'static [&'static str],
    version_prefixes: &'static [&'static str],
    install_command: Option<&'static str>,
    update_command: Option<&'static str>,
    download_url: Option<&'static str>,
    latest: Option<RuntimeLatestSource>,
}

const RUNTIME_REGISTRY: &[RuntimeDefinition] = &[
    RuntimeDefinition {
        id: "node",
        program: "node",
        version_args: &["--version"],
        version_prefixes: &["v"],
        install_command: None,
        update_command: None,
        download_url: Some("https://nodejs.org/"),
        latest: Some(RuntimeLatestSource::Npm { package: "node" }),
    },
    RuntimeDefinition {
        id: "npm",
        program: "npm",
        version_args: &["--version"],
        version_prefixes: &[],
        install_command: None,
        update_command: Some("npm install -g npm@latest"),
        download_url: None,
        latest: Some(RuntimeLatestSource::Npm { package: "npm" }),
    },
    RuntimeDefinition {
        id: "python",
        program: "python",
        version_args: &["--version"],
        version_prefixes: &["Python "],
        install_command: None,
        update_command: None,
        download_url: Some("https://www.python.org/downloads/"),
        latest: Some(RuntimeLatestSource::Python),
    },
    RuntimeDefinition {
        id: "git",
        program: "git",
        version_args: &["--version"],
        version_prefixes: &["git version "],
        install_command: crate::os_adapter::package_manager::get_git_install_command(),
        update_command: crate::os_adapter::package_manager::get_git_update_command(),
        download_url: crate::os_adapter::package_manager::get_git_download_url(),
        latest: Some(RuntimeLatestSource::GitForWindows),
    },
];

fn runtime_registry() -> &'static [RuntimeDefinition] {
    RUNTIME_REGISTRY
}

/// Build a platform-aware command. On Windows, .cmd/.bat scripts (npm, npx, etc.)
/// must be invoked via `cmd /C <command>` since `Command::new("npm")` won't resolve
/// npm.cmd. On Unix, invoke the binary directly.
fn shell_command(program: &str, args: Vec<String>) -> tokio::process::Command {
    crate::os_adapter::shell::shell_command(program, args)
}

fn normalize_version_output(stdout: &[u8], stderr: &[u8], prefixes: &[&str]) -> Option<String> {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let raw = if stdout.is_empty() { stderr } else { stdout };
    let mut version = raw.trim().to_string();
    for prefix in prefixes {
        if let Some(rest) = version.strip_prefix(prefix) {
            version = rest.trim().to_string();
            break;
        }
    }
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

async fn check_runtime(definition: &RuntimeDefinition) -> RuntimeStatus {
    let args = definition
        .version_args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    let output =
        crate::process_command::tokio_no_window(&mut shell_command(definition.program, args))
            .output()
            .await;
    let (installed, version) = match output {
        Ok(out) if out.status.success() => (
            true,
            normalize_version_output(&out.stdout, &out.stderr, definition.version_prefixes),
        ),
        _ => (false, None),
    };
    RuntimeStatus {
        id: definition.id.to_string(),
        installed,
        version,
        install_command: definition.install_command.map(str::to_string),
        update_command: definition.update_command.map(str::to_string),
        download_url: definition.download_url.map(str::to_string),
        latest_package: runtime_latest_package(definition).map(str::to_string),
    }
}

fn runtime_latest_package(definition: &RuntimeDefinition) -> Option<&'static str> {
    match definition.latest {
        Some(RuntimeLatestSource::Npm { package }) => Some(package),
        Some(RuntimeLatestSource::Python) => Some("python"),
        Some(RuntimeLatestSource::GitForWindows) => Some("git"),
        None => None,
    }
}

fn runtime_status<'a>(runtimes: &'a [RuntimeStatus], id: &str) -> Option<&'a RuntimeStatus> {
    runtimes.iter().find(|runtime| runtime.id == id)
}

#[tauri::command]
async fn check_environment() -> Result<EnvStatus, String> {
    let mut runtimes = Vec::new();
    for definition in runtime_registry() {
        runtimes.push(check_runtime(definition).await);
    }
    let node = runtime_status(&runtimes, "node");
    let npm = runtime_status(&runtimes, "npm");
    let python = runtime_status(&runtimes, "python");
    let git = runtime_status(&runtimes, "git");

    Ok(EnvStatus {
        node_installed: node.is_some_and(|runtime| runtime.installed),
        node_version: node.and_then(|runtime| runtime.version.clone()),
        npm_installed: npm.is_some_and(|runtime| runtime.installed),
        npm_version: npm.and_then(|runtime| runtime.version.clone()),
        python_installed: python.is_some_and(|runtime| runtime.installed),
        python_version: python.and_then(|runtime| runtime.version.clone()),
        git_installed: git.is_some_and(|runtime| runtime.installed),
        git_version: git.and_then(|runtime| runtime.version.clone()),
        runtimes,
    })
}

#[derive(serde::Serialize)]
pub struct LatestVersion {
    pub id: String,
    pub latest_version: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
async fn check_available_updates(packages: Vec<(String, String)>) -> Vec<LatestVersion> {
    let mut results = Vec::new();
    for (id, pkg) in packages {
        if let Some(definition) = runtime_registry().iter().find(|runtime| {
            runtime.id == id || runtime_latest_package(runtime) == Some(pkg.as_str())
        }) {
            results.push(check_runtime_latest(&id, definition).await);
            continue;
        }

        let mut cmd = shell_command(
            "npm",
            vec![
                "view".into(),
                pkg.clone(),
                "version".into(),
                "--json".into(),
            ],
        );
        let output = crate::process_command::tokio_no_window(&mut cmd)
            .output()
            .await;

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let version = stdout.trim_matches('"').trim().to_string();
                if !version.is_empty() {
                    results.push(LatestVersion {
                        id,
                        latest_version: Some(version),
                        error: None,
                    });
                } else {
                    results.push(LatestVersion {
                        id,
                        latest_version: None,
                        error: Some("empty response".into()),
                    });
                }
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                results.push(LatestVersion {
                    id,
                    latest_version: None,
                    error: Some(stderr),
                });
            }
            Err(e) => {
                results.push(LatestVersion {
                    id,
                    latest_version: None,
                    error: Some(e.to_string()),
                });
            }
        }
    }
    results
}

async fn check_runtime_latest(id: &str, definition: &RuntimeDefinition) -> LatestVersion {
    match definition.latest {
        Some(RuntimeLatestSource::Npm { package }) => check_npm_latest(id, package).await,
        Some(RuntimeLatestSource::Python) => check_python_latest(id).await,
        Some(RuntimeLatestSource::GitForWindows) => check_git_latest(id).await,
        None => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some("runtime has no latest-version source".to_string()),
        },
    }
}

async fn check_npm_latest(id: &str, package: &str) -> LatestVersion {
    let mut cmd = shell_command(
        "npm",
        vec![
            "view".into(),
            package.to_string(),
            "version".into(),
            "--json".into(),
        ],
    );
    let output = crate::process_command::tokio_no_window(&mut cmd)
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let version = stdout.trim_matches('"').trim().to_string();
            if !version.is_empty() {
                LatestVersion {
                    id: id.to_string(),
                    latest_version: Some(version),
                    error: None,
                }
            } else {
                LatestVersion {
                    id: id.to_string(),
                    latest_version: None,
                    error: Some("empty response".into()),
                }
            }
        }
        Ok(out) => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        },
        Err(e) => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some(e.to_string()),
        },
    }
}

async fn fetch_text_url(url: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "(Invoke-WebRequest -Uri '{}' -UseBasicParsing).Content",
            url
        );
        let mut ps_cmd = tokio::process::Command::new("powershell");
        let output = crate::process_command::tokio_no_window(ps_cmd.args([
            "-NoProfile",
            "-Command",
            &script,
        ]))
        .output()
        .await;
        match output {
            Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = tokio::process::Command::new("curl");
        let output = crate::process_command::tokio_no_window(cmd.args([
            "-sfL",
            "-H",
            "User-Agent: jishu-hub",
            url,
        ]))
        .output()
        .await;
        match output {
            Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => Err(e.to_string()),
        }
    }
}

async fn check_python_latest(id: &str) -> LatestVersion {
    let url = "https://endoflife.date/api/python.json";

    let body = match fetch_text_url(url).await {
        Ok(b) => b,
        Err(e) => {
            return LatestVersion {
                id: id.to_string(),
                latest_version: None,
                error: Some(e),
            };
        }
    };

    // Parse JSON array and extract latest version from first entry
    let version = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.as_array()?
                .first()?
                .get("latest")?
                .as_str()
                .map(String::from)
        });

    match version {
        Some(v) => LatestVersion {
            id: id.to_string(),
            latest_version: Some(v),
            error: None,
        },
        None => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some("could not parse version from API response".into()),
        },
    }
}

async fn check_git_latest(id: &str) -> LatestVersion {
    let url = "https://api.github.com/repos/git-for-windows/git/releases/latest";

    let body = match fetch_text_url(url).await {
        Ok(b) => b,
        Err(e) => {
            return LatestVersion {
                id: id.to_string(),
                latest_version: None,
                error: Some(e),
            };
        }
    };

    let version = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("tag_name")?.as_str().map(String::from))
        .map(|tag| tag.trim_start_matches('v').to_string());

    match version {
        Some(v) if !v.is_empty() => LatestVersion {
            id: id.to_string(),
            latest_version: Some(v),
            error: None,
        },
        _ => LatestVersion {
            id: id.to_string(),
            latest_version: None,
            error: Some("could not parse version from GitHub response".into()),
        },
    }
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub release_url: String,
    pub source: String,
    pub error: Option<String>,
}

const GH_API: &str = "https://api.github.com/repos/wang5766171/jishu-hub/releases/latest";
const GH_PAGE: &str = "https://github.com/wang5766171/jishu-hub/releases/latest";
const GITEE_API: &str = "https://gitee.com/api/v5/repos/wangzwa/jishu-hub/releases/latest";
const GITEE_PAGE: &str = "https://gitee.com/wangzwa/jishu-hub/releases/latest";

/// HTTP GET returning the response body. Reuses the existing platform pattern
/// (PowerShell on Windows, curl elsewhere). URLs are fixed constants 鈥?no
/// untrusted interpolation.
async fn http_get_text(url: &str, timeout_secs: u32) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "(Invoke-WebRequest -Uri '{}' -UseBasicParsing -TimeoutSec {}).Content",
            url, timeout_secs
        );
        let mut cmd = tokio::process::Command::new("powershell");
        let output = crate::process_command::tokio_no_window(cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ]))
        .output()
        .await
        .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = tokio::process::Command::new("curl");
        let output = cmd
            .args([
                "-sfL",
                "--max-time",
                &timeout_secs.to_string(),
                "-A",
                "jishu-hub",
                url,
            ])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(format!("request failed: {}", url))
        }
    }
}

/// Detect whether the host is on an overseas network by probing a resource
/// that is reachable abroad but typically blocked/timed-out within mainland CN.
async fn is_overseas_network() -> bool {
    http_get_text("https://www.google.com/generate_204", 3)
        .await
        .is_ok()
}

fn version_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .map(|p| {
            p.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (version_parts(latest), version_parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

/// Fetch the latest release JSON, picking gitee for CN networks and github
/// abroad, with the other acting as fallback (github is always a fallback).
async fn fetch_latest_release() -> Result<(String, String, serde_json::Value), String> {
    let overseas = is_overseas_network().await;
    let order = if overseas {
        [
            ("github", GH_API, GH_PAGE),
            ("gitee", GITEE_API, GITEE_PAGE),
        ]
    } else {
        [
            ("gitee", GITEE_API, GITEE_PAGE),
            ("github", GH_API, GH_PAGE),
        ]
    };
    let mut last_err = String::from("network unavailable");
    for (source, api, page) in order {
        match http_get_text(api, 8).await {
            Ok(body) => match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) if v.get("tag_name").is_some() => {
                    return Ok((source.to_string(), page.to_string(), v))
                }
                _ => last_err = format!("{}: cannot parse release", source),
            },
            Err(e) => last_err = format!("{}: {}", source, e),
        }
    }
    Err(last_err)
}

/// Check for a newer release (no download). Used by the manual "click version
/// to check" flow in the About panel.
#[tauri::command]
async fn check_for_update() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();
    match fetch_latest_release().await {
        Ok((source, page, release)) => {
            let tag = release
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            UpdateInfo {
                has_update: is_newer(&tag, &current),
                latest_version: Some(tag),
                current_version: current,
                release_url: page,
                source,
                error: None,
            }
        }
        Err(e) => UpdateInfo {
            current_version: current,
            latest_version: None,
            has_update: false,
            release_url: GH_PAGE.to_string(),
            source: "github".to_string(),
            error: Some(e),
        },
    }
}

#[derive(serde::Serialize)]
pub struct DownloadResult {
    pub version: Option<String>,
    pub installer_path: Option<String>,
    pub error: Option<String>,
}

/// Whether the installed copy was placed by the MSI installer (vs NSIS).
#[cfg(target_os = "windows")]
async fn installed_via_msi() -> bool {
    let script = "$ErrorActionPreference='SilentlyContinue';\
$p='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';\
$e=Get-ItemProperty $p | Where-Object { $_.DisplayName -like '*Jishu Hub*' } | Select-Object -First 1;\
if ($e -and ($e.WindowsInstaller -eq 1 -or $e.UninstallString -match 'msiexec')) { 'msi' } else { 'nsis' }";
    let mut cmd = tokio::process::Command::new("powershell");
    let out = crate::process_command::tokio_no_window(cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]))
    .output()
    .await;
    matches!(out, Ok(o) if String::from_utf8_lossy(&o.stdout).trim() == "msi")
}

#[cfg(not(target_os = "windows"))]
async fn installed_via_msi() -> bool {
    false
}

/// Pick the installer asset matching the user's install method, defaulting to
/// the NSIS `-setup.exe` package when MSI isn't preferred or can't be matched.
fn pick_installer_asset(release: &serde_json::Value, prefer_msi: bool) -> Option<(String, String)> {
    let assets: Vec<(String, String)> = release
        .get("assets")?
        .as_array()?
        .iter()
        .filter_map(|a| {
            Some((
                a.get("name")?.as_str()?.to_string(),
                a.get("browser_download_url")?.as_str()?.to_string(),
            ))
        })
        .collect();
    let ends = |n: &str, suf: &str| n.to_lowercase().ends_with(suf);
    let x64 = |n: &str| n.to_lowercase().contains("x64");
    let want = if prefer_msi { ".msi" } else { "-setup.exe" };
    assets
        .iter()
        .find(|(n, _)| ends(n, want) && x64(n))
        .or_else(|| assets.iter().find(|(n, _)| ends(n, want)))
        .or_else(|| assets.iter().find(|(n, _)| ends(n, "-setup.exe") && x64(n)))
        .or_else(|| assets.iter().find(|(n, _)| ends(n, "-setup.exe")))
        .cloned()
}

async fn download_to_file(url: &str, dest: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "(New-Object Net.WebClient).DownloadFile('{}','{}')",
            url.replace('\'', "''"),
            dest.to_string_lossy().replace('\'', "''")
        );
        let mut cmd = tokio::process::Command::new("powershell");
        let out = crate::process_command::tokio_no_window(cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ]))
        .output()
        .await
        .map_err(|e| e.to_string())?;
        if out.status.success() && dest.exists() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = tokio::process::Command::new("curl")
            .args(["-sfL", "-o", &dest.to_string_lossy(), url])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err("download failed".into())
        }
    }
}

/// Check for a newer release and, if found, download the matching installer.
/// Triggered automatically (async) on app startup.
#[tauri::command]
async fn download_update() -> DownloadResult {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let release = match fetch_latest_release().await {
        Ok((_, _, r)) => r,
        Err(e) => {
            return DownloadResult {
                version: None,
                installer_path: None,
                error: Some(e),
            }
        }
    };
    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if tag.is_empty() || !is_newer(&tag, &current) {
        return DownloadResult {
            version: None,
            installer_path: None,
            error: None,
        };
    }
    let Some((name, url)) = pick_installer_asset(&release, installed_via_msi().await) else {
        return DownloadResult {
            version: Some(tag),
            installer_path: None,
            error: Some("no matching installer asset".into()),
        };
    };
    let dest = dirs::download_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(&name);
    match download_to_file(&url, &dest).await {
        Ok(()) => DownloadResult {
            version: Some(tag),
            installer_path: Some(dest.to_string_lossy().to_string()),
            error: None,
        },
        Err(e) => DownloadResult {
            version: Some(tag),
            installer_path: None,
            error: Some(e),
        },
    }
}

/// Launch the downloaded installer and quit so it can replace the running app.
#[tauri::command]
fn install_update(app: tauri::AppHandle, installer_path: String) -> Result<(), String> {
    let p = std::path::Path::new(&installer_path);
    let is_installer = p
        .extension()
        .map(|e| e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("msi"))
        .unwrap_or(false);
    if !is_installer {
        return Err("Invalid installer: not .exe or .msi".to_string());
    }

    let canon_p =
        std::fs::canonicalize(p).map_err(|e| format!("Cannot resolve installer path: {}", e))?;
    if !canon_p.is_file() {
        return Err("Installer file not found".to_string());
    }

    let allowed_dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    let canon_dir = std::fs::canonicalize(&allowed_dir).unwrap_or(allowed_dir);
    let temp_dir = std::env::temp_dir();
    let canon_temp = std::fs::canonicalize(&temp_dir).unwrap_or(temp_dir);

    if !(canon_p.starts_with(&canon_dir) || canon_p.starts_with(&canon_temp)) {
        return Err("Installer path not in allowed directory".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        if p.extension()
            .map(|e| e.eq_ignore_ascii_case("msi"))
            .unwrap_or(false)
        {
            let mut cmd = std::process::Command::new("msiexec");
            crate::process_command::std_no_window(cmd.args(["/i", &installer_path]))
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new(&installer_path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        open::that(&installer_path).map_err(|e| e.to_string())?;
    }
    app.exit(0);
    Ok(())
}

// 鈹€鈹€ Model management IPC commands 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

#[tauri::command]
fn list_models() -> Result<serde_json::Value, String> {
    let store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let mut val = serde_json::to_value(store).map_err(|e| e.to_string())?;
    // Mask api_key before sending to frontend 鈥?plaintext never leaves the backend
    if let Some(presets) = val.get_mut("presets").and_then(|p| p.as_array_mut()) {
        for preset in presets {
            if let Some(key) = preset.get("api_key").and_then(|k| k.as_str()) {
                if !key.is_empty() {
                    preset["api_key"] = serde_json::Value::String(llm::http::mask_key(key));
                }
            }
        }
    }
    Ok(val)
}

#[tauri::command]
fn add_model(preset: serde_json::Value) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let preset: llm::config::ModelPreset =
        serde_json::from_value(preset).map_err(|e| e.to_string())?;
    store.add(preset).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_model(id: String, preset: serde_json::Value) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let preset: llm::config::ModelPreset =
        serde_json::from_value(preset).map_err(|e| e.to_string())?;
    store.update(&id, preset).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_model(id: String) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    store.remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_active_model(id: String) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    store.set_active(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn deactivate_model() -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    store.clear_active().map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_model(id: String) -> Result<serde_json::Value, String> {
    let store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let preset = store
        .presets
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Model '{id}' not found"))?
        .clone();

    llm::http::resolve_api_key(&preset).map_err(|e| format!("{e}"))?;

    let provider = llm::create_provider(&preset).map_err(|e| e.to_string())?;
    let req = llm::message::LlmRequest {
        model: preset.model.clone(),
        messages: vec![llm::message::LlmMessage {
            role: llm::message::LlmRole::User,
            content: Some("Say hello in one word.".to_string()),
            tool_calls: None,
            tool_call_id: None,
        }],
        tools: vec![],
        stream: true,
        max_tokens: Some(64),
        temperature: Some(0.0),
    };

    let cancel = llm::CancelToken::new();
    let response = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let usage = std::sync::Arc::new(std::sync::Mutex::new(None::<agent::normalized::UsageStats>));

    let resp_clone = response.clone();
    let usage_clone = usage.clone();
    let emitter = Box::new(move |event| match event {
        agent::NormalizedEvent::TextDelta { delta } => {
            if let Ok(mut s) = resp_clone.lock() {
                s.push_str(&delta);
            }
        }
        agent::NormalizedEvent::TurnComplete { usage: Some(u), .. } => {
            if let Ok(mut info) = usage_clone.lock() {
                *info = Some(u);
            }
        }
        _ => {}
    });

    let turn = provider
        .stream_chat(req, emitter, &cancel)
        .await
        .map_err(|e| e.to_string())?;

    let resp_text = response.lock().map_err(|e| e.to_string())?.clone();
    let usage_val = usage.lock().map_err(|e| e.to_string())?.clone();

    Ok(serde_json::json!({
        "response": resp_text,
        "stop_reason": format!("{:?}", turn.stop_reason),
        "usage": usage_val,
    }))
}

#[tauri::command]
fn set_model_key(id: String, key: String) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let preset = store
        .presets
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Model '{id}' not found"))?;
    preset.api_key = if key.is_empty() { None } else { Some(key) };
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn mask_model_key(key: String) -> String {
    llm::http::mask_key(&key)
}

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
fn orchestrator_create_graph(
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
fn orchestrator_get_graph(
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
fn orchestrator_get_latest_graph_for_project(
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
fn orchestrator_list_graphs_for_project(
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
fn orchestrator_list_task_conversations(
    state: tauri::State<'_, std::sync::Mutex<AppState>>,
    project_root: String,
) -> Result<
    Vec<crate::orchestrator::conversation::TaskConversationSummary>,
    crate::orchestrator::domain::run::TaskError,
> {
    let app_state = state.lock().map_err(|e| task_ipc_internal(e.to_string()))?;
    let task_service = app_state
        .task_service
        .lock()
        .map_err(|e| task_ipc_internal(e.to_string()))?;
    task_service
        .list_task_conversations(std::path::Path::new(&project_root))
        .map_err(Into::into)
}

#[cfg(feature = "orchestrator")]
#[tauri::command]
fn orchestrator_get_task_conversation(
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
fn orchestrator_submit_task_interaction(
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
fn orchestrator_get_revision(
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
fn orchestrator_apply_commands(
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
fn orchestrator_validate_commands(
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
async fn orchestrator_generate_proposal(
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
fn orchestrator_start_run(
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
fn orchestrator_propose_run_revision(
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
fn orchestrator_apply_run_revision(
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
fn orchestrator_list_runs(
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
fn orchestrator_get_node_runs(
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
fn orchestrator_get_attempt(
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
fn orchestrator_get_run_projection(
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
fn orchestrator_pause_run(
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
fn orchestrator_resume_run(
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
fn orchestrator_cancel_run(
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
fn orchestrator_pending_approvals(
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
fn orchestrator_resolve_approval(
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
fn orchestrator_run_events_after(
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
fn orchestrator_list_artifacts(
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
fn orchestrator_get_artifact(
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
fn orchestrator_get_diff(
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
fn orchestrator_list_revisions(
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
fn orchestrator_checkout_draft_revision(
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
fn orchestrator_choose_recovery(
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
fn orchestrator_attach_repair(
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

#[tauri::command]
fn task_plan_skill_list() -> Result<Vec<task_plan::TaskPlanSkill>, String> {
    task_plan::list_task_plan_skills()
}

#[tauri::command]
fn task_plan_skill_install(skill_id: String) -> Result<task_plan::TaskPlanSkill, String> {
    task_plan::install_builtin_skill(&skill_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let _ = hub::migrate_v0_5_0();
            let registry = Arc::new(agent::AgentRegistry::new());
            if let Ok(Some(active_id)) = hub::load_active_agent_id() {
                let _ = registry.set_active(&active_id);
            }
            #[cfg(feature = "orchestrator")]
            let task_service = std::sync::Mutex::new(
                crate::orchestrator::TaskService::open_default(registry.clone())?,
            );
            app.manage(Mutex::new(AppState {
                registry,
                #[cfg(feature = "orchestrator")]
                task_service,
            }));
            app.manage(std::sync::Mutex::new(chat::ChatState::new()));
            if let Ok(pinned) = hub::load_always_on_top() {
                if pinned {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_always_on_top(true);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_agents,
            scan_projects,
            add_project,
            remove_project,
            list_sessions,
            get_session_messages,
            read_text_file,
            get_session_names,
            rename_session,
            delete_session_name,
            load_config,
            load_raw_config,
            save_raw_config,
            load_history,
            save_config,
            get_models_config,
            set_models_config,
            get_active,
            set_active,
            list_backups,
            restore_backup,
            dialog_commands::export_config_dialog,
            dialog_commands::import_config_dialog,
            dialog_commands::export_raw_config_dialog,
            load_language,
            save_language,
            load_always_on_top,
            toggle_always_on_top,
            load_theme,
            save_theme,
            load_last_project,
            open_url,
            save_last_project,
            load_font_sizes,
            save_font_sizes,
            list_custom_commands,
            agent_command_presets,
            save_custom_command,
            delete_custom_command,
            open_in_terminal,
            register_terminal_session,
            find_session_terminal,
            focus_session_terminal,
            cleanup_dead_sessions,
            init_project,
            run_in_terminal,
            load_project_settings,
            load_project_settings_local,
            save_project_settings,
            save_project_settings_local,
            load_claude_md,
            load_project_metas,
            save_project_meta,
            get_level1_dir_cmd,
            get_mergeable_projects,
            merge_projects_logical,
            split_project,
            get_project_merges,
            get_merged_secondaries,
            list_config_templates,
            list_presets,
            save_preset,
            delete_preset,
            apply_preset,
            get_app_dir,
            agent_list_statuses,
            agent_set_active,
            agent_get_active,
            agent_refresh_health,
            check_prerequisite,
            install_agent_command,
            check_environment,
            check_mcp_adapter,
            install_mcp_adapter,
            check_available_updates,
            check_for_update,
            download_update,
            os_adapter::cli_link::check_cli_symlink,
            os_adapter::cli_link::install_cli_symlink,
            install_update,
            chat::send_message,
            chat::abort_chat,
            chat::resolve_chat_permission,
            image::save_session_files,
            image::read_image_as_data_url,
            image::read_file_as_base64,
            image::get_clipboard_file_paths,
            #[cfg(feature = "orchestrator")]
            orchestrator_create_graph,
            #[cfg(feature = "orchestrator")]
            orchestrator_get_graph,
            #[cfg(feature = "orchestrator")]
            orchestrator_get_latest_graph_for_project,
            #[cfg(feature = "orchestrator")]
            orchestrator_list_graphs_for_project,
            #[cfg(feature = "orchestrator")]
            orchestrator_list_task_conversations,
            #[cfg(feature = "orchestrator")]
            orchestrator_get_task_conversation,
            #[cfg(feature = "orchestrator")]
            orchestrator_submit_task_interaction,
            #[cfg(feature = "orchestrator")]
            orchestrator_get_revision,
            #[cfg(feature = "orchestrator")]
            orchestrator_apply_commands,
            #[cfg(feature = "orchestrator")]
            orchestrator_validate_commands,
            #[cfg(feature = "orchestrator")]
            orchestrator_generate_proposal,
            #[cfg(feature = "orchestrator")]
            orchestrator_start_run,
            #[cfg(feature = "orchestrator")]
            orchestrator_propose_run_revision,
            #[cfg(feature = "orchestrator")]
            orchestrator_apply_run_revision,
            #[cfg(feature = "orchestrator")]
            orchestrator_list_runs,
            #[cfg(feature = "orchestrator")]
            orchestrator_get_node_runs,
            #[cfg(feature = "orchestrator")]
            orchestrator_get_attempt,
            #[cfg(feature = "orchestrator")]
            orchestrator_get_run_projection,
            #[cfg(feature = "orchestrator")]
            orchestrator_pause_run,
            #[cfg(feature = "orchestrator")]
            orchestrator_resume_run,
            #[cfg(feature = "orchestrator")]
            orchestrator_cancel_run,
            #[cfg(feature = "orchestrator")]
            orchestrator_pending_approvals,
            #[cfg(feature = "orchestrator")]
            orchestrator_resolve_approval,
            #[cfg(feature = "orchestrator")]
            orchestrator_run_events_after,
            #[cfg(feature = "orchestrator")]
            orchestrator_list_artifacts,
            #[cfg(feature = "orchestrator")]
            orchestrator_get_artifact,
            #[cfg(feature = "orchestrator")]
            orchestrator_get_diff,
            #[cfg(feature = "orchestrator")]
            orchestrator_list_revisions,
            #[cfg(feature = "orchestrator")]
            orchestrator_checkout_draft_revision,
            #[cfg(feature = "orchestrator")]
            orchestrator_choose_recovery,
            #[cfg(feature = "orchestrator")]
            orchestrator_attach_repair,
            task_plan_skill_list,
            task_plan_skill_install,
            list_models,
            add_model,
            update_model,
            remove_model,
            set_active_model,
            deactivate_model,
            test_model,
            set_model_key,
            mask_model_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    #[test]
    fn reads_text_file_preview() {
        let path =
            std::env::temp_dir().join(format!("jishu-hub-text-preview-{}.txt", std::process::id()));
        std::fs::write(&path, "line 1\nline 2").unwrap();

        let preview = tauri::async_runtime::block_on(super::read_text_file(
            path.to_string_lossy().to_string(),
        ))
        .unwrap();

        assert_eq!(preview.content, "line 1\nline 2");
        assert!(!preview.truncated);
        assert_eq!(preview.size, 13);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn normalizes_runtime_version_outputs() {
        assert_eq!(
            super::normalize_version_output(b"Python 3.12.4\r\n", b"", &["Python "]),
            Some("3.12.4".to_string())
        );
        assert_eq!(
            super::normalize_version_output(
                b"git version 2.50.1.windows.1\n",
                b"",
                &["git version "]
            ),
            Some("2.50.1.windows.1".to_string())
        );
    }

    #[test]
    fn allows_git_winget_update_command() {
        assert!(super::is_allowed_install_command(
            "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements"
        ));
        assert!(super::is_allowed_install_command(
            "winget upgrade --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements"
        ));
        assert!(!super::is_allowed_install_command(
            "winget upgrade Git.Git; whoami"
        ));
    }
}
