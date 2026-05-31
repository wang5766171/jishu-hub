mod acp_runtime;
mod agent;
mod chat;
mod cli_runtime;
mod command;
mod config;
mod history;
mod hub;
mod image;
mod process_command;
mod process_control;
mod project;
mod project_config;
mod session;

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

const TEXT_PREVIEW_MAX_BYTES: usize = 512 * 1024;

#[derive(serde::Serialize)]
struct TextFilePreview {
    path: String,
    content: String,
    truncated: bool,
    size: usize,
}

pub struct AppState {
    pub registry: agent::AgentRegistry,
}

#[tauri::command]
fn list_agents(state: tauri::State<'_, Mutex<AppState>>) -> Vec<agent::AgentInfo> {
    let s = state.lock().unwrap();
    s.registry.list_agents()
}

#[tauri::command]
fn scan_projects(state: tauri::State<'_, Mutex<AppState>>) -> Vec<project::Project> {
    let s = state.lock().unwrap();
    s.registry.scan_projects()
}

#[tauri::command]
fn add_project(
    state: tauri::State<'_, Mutex<AppState>>,
    path: String,
) -> Result<project::Project, String> {
    let s = state.lock().unwrap();
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
fn list_sessions(
    state: tauri::State<'_, Mutex<AppState>>,
    encoded_name: String,
) -> Result<Vec<session::Session>, String> {
    let s = state.lock().unwrap();
    s.registry.active().list_sessions(&encoded_name)
}

#[tauri::command]
fn get_session_messages(
    state: tauri::State<'_, Mutex<AppState>>,
    session_id: String,
    encoded_name: String,
) -> Result<Vec<session::Message>, String> {
    let s = state.lock().unwrap();
    s.registry
        .active()
        .get_session_messages(&session_id, &encoded_name)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<TextFilePreview, String> {
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
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    // Only allow writing to regular files under user-writable locations
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let allowed = p.starts_with(&home)
        || p.starts_with(std::path::Path::new("/tmp"))
        || p.starts_with(std::path::Path::new("/var/folders"));
    if !allowed {
        return Err(format!("Path not allowed: {}", path));
    }
    // Prevent writing to hidden/system files
    if p.file_name()
        .map(|n| n.to_string_lossy().starts_with('.'))
        .unwrap_or(false)
        && !p.extension().map(|e| e == "json" || e == "toml" || e == "md").unwrap_or(false)
    {
        return Err(format!("Cannot write to hidden file: {}", path));
    }
    std::fs::write(p, content).map_err(|e| e.to_string())
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
fn load_config(state: tauri::State<'_, Mutex<AppState>>) -> Result<config::ClaudeConfig, String> {
    let s = state.lock().unwrap();
    s.registry.active().load_config()
}

#[derive(serde::Serialize)]
struct RawConfigInfo {
    content: String,
    format: String,
}

#[tauri::command]
fn load_raw_config(state: tauri::State<'_, Mutex<AppState>>) -> Result<RawConfigInfo, String> {
    let s = state.lock().unwrap();
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
    let s = state.lock().unwrap();
    s.registry.active().save_raw_config(&content)
}

#[tauri::command]
fn load_history(state: tauri::State<'_, Mutex<AppState>>) -> Vec<history::HistoryEntry> {
    let s = state.lock().unwrap();
    s.registry.active().load_history()
}

#[tauri::command]
fn save_config(
    state: tauri::State<'_, Mutex<AppState>>,
    config: config::ClaudeConfig,
) -> Result<(), String> {
    let s = state.lock().unwrap();
    s.registry.active().save_config(&config)
}

#[tauri::command]
fn list_presets() -> Result<Vec<hub::Preset>, String> {
    hub::list_presets().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_preset(preset: hub::Preset) -> Result<(), String> {
    hub::save_preset(preset).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_preset(id: String) -> Result<(), String> {
    hub::delete_preset(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_preset(state: tauri::State<'_, Mutex<AppState>>, id: String) -> Result<(), String> {
    let presets = hub::list_presets().map_err(|e| e.to_string())?;
    let preset = presets
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("Preset not found")?;
    let s = state.lock().unwrap();
    s.registry.active().save_config(&preset.config)
}

#[tauri::command]
fn list_backups(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<config::BackupEntry>, String> {
    let s = state.lock().unwrap();
    s.registry.active().list_backups()
}

#[tauri::command]
fn restore_backup(
    state: tauri::State<'_, Mutex<AppState>>,
    backup_path: String,
) -> Result<(), String> {
    let s = state.lock().unwrap();
    s.registry.active().restore_backup(&backup_path)
}

#[tauri::command]
fn export_config(state: tauri::State<'_, Mutex<AppState>>, path: String) -> Result<(), String> {
    let s = state.lock().unwrap();
    s.registry.active().export_config(&path)
}

#[tauri::command]
fn import_config(
    state: tauri::State<'_, Mutex<AppState>>,
    path: String,
) -> Result<config::ClaudeConfig, String> {
    let s = state.lock().unwrap();
    s.registry.active().import_config(&path)
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
) -> Vec<agent::command_config::AgentCommandPreset> {
    let s = state.lock().unwrap();
    agent::command_config::built_in_commands(s.registry.active_id())
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
    let s = state.lock().unwrap();
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
        let s = state.lock().unwrap();
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
    let s = state.lock().unwrap();
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
    let s = state.lock().unwrap();
    s.registry.active().load_project_settings(&project_path)
}

#[tauri::command]
fn load_project_settings_local(
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
) -> Result<project_config::ProjectSettings, String> {
    let s = state.lock().unwrap();
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
    let s = state.lock().unwrap();
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
    let s = state.lock().unwrap();
    s.registry
        .active()
        .save_project_settings_local(&project_path, &settings)
}

#[tauri::command]
fn load_claude_md(
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
) -> Result<Option<String>, String> {
    let s = state.lock().unwrap();
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
    let s = state.lock().unwrap();
    let decoded = s.registry.active().decode_project_path(&encoded_name);
    Ok(s.registry.active().get_level1_dir(&decoded))
}

#[tauri::command]
fn get_mergeable_projects(
    state: tauri::State<'_, Mutex<AppState>>,
    encoded_name: String,
) -> Result<Vec<String>, String> {
    let s = state.lock().unwrap();
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
fn list_config_templates(state: tauri::State<'_, Mutex<AppState>>) -> Vec<hub::ConfigTemplate> {
    let s = state.lock().unwrap();
    s.registry.active().config_templates()
}

#[tauri::command]
fn agent_list_statuses(state: tauri::State<'_, Mutex<AppState>>) -> Vec<agent::AgentStatus> {
    let s = state.lock().unwrap();
    s.registry.list_agent_statuses()
}

#[tauri::command]
fn agent_set_active(state: tauri::State<'_, Mutex<AppState>>, id: String) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    s.registry.set_active(&id)?;
    hub::save_active_agent_id(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_get_active(state: tauri::State<'_, Mutex<AppState>>) -> String {
    let s = state.lock().unwrap();
    s.registry.active_id().to_string()
}

#[tauri::command]
fn agent_refresh_health(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
    let s = state.lock().unwrap();
    // Each agent's probe_sync() is synchronous — no await needed
    let agents: Vec<_> = s.registry.agents_info();
    let results: Vec<(String, agent::AgentHealth)> = agents
        .iter()
        .map(|(id, plugin)| (id.clone(), plugin.probe_sync()))
        .collect();
    drop(s);

    // Re-lock to update cache
    let s = state.lock().unwrap();
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
    let mut lookup = std::process::Command::new("where");
    crate::process_command::std_no_window(lookup.arg(&command))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
async fn install_agent_command(command: String) -> Result<String, String> {
    let mut installer = std::process::Command::new("powershell");
    let output =
        crate::process_command::std_no_window(installer.args(["-NoProfile", "-Command", &command]))
            .output()
            .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[derive(serde::Serialize)]
pub struct EnvStatus {
    pub node_installed: bool,
    pub node_version: Option<String>,
    pub npm_installed: bool,
    pub npm_version: Option<String>,
    pub python_installed: bool,
    pub python_version: Option<String>,
}

/// Build a platform-aware command. On Windows, .cmd/.bat scripts (npm, npx, etc.)
/// must be invoked via `cmd /C <command>` since `Command::new("npm")` won't resolve
/// npm.cmd. On Unix, invoke the binary directly.
fn shell_command(program: &str, args: Vec<String>) -> tokio::process::Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = tokio::process::Command::new("cmd");
        let mut full_args = vec!["/C".to_string(), program.to_string()];
        full_args.extend(args);
        cmd.args(&full_args);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(&args);
        cmd
    }
}

#[tauri::command]
async fn check_environment() -> Result<EnvStatus, String> {
    let node_out = crate::process_command::tokio_no_window(&mut shell_command("node", vec!["--version".into()]))
        .output()
        .await;

    let npm_out = crate::process_command::tokio_no_window(&mut shell_command("npm", vec!["--version".into()]))
        .output()
        .await;

    let python_out = crate::process_command::tokio_no_window(&mut shell_command("python", vec!["--version".into()]))
        .output()
        .await;

    let (node_installed, node_version) = match node_out {
        Ok(out) if out.status.success() => (true, Some(String::from_utf8_lossy(&out.stdout).trim().to_string())),
        _ => (false, None),
    };

    let (npm_installed, npm_version) = match npm_out {
        Ok(out) if out.status.success() => (true, Some(String::from_utf8_lossy(&out.stdout).trim().to_string())),
        _ => (false, None),
    };

    let (python_installed, python_version) = match python_out {
        Ok(out) if out.status.success() => {
            let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let ver = if ver.is_empty() {
                String::from_utf8_lossy(&out.stderr).trim().to_string()
            } else {
                ver
            };
            (true, Some(ver))
        }
        _ => (false, None),
    };

    Ok(EnvStatus {
        node_installed,
        node_version,
        npm_installed,
        npm_version,
        python_installed,
        python_version,
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
        if pkg == "python" {
            results.push(check_python_latest(&id).await);
            continue;
        }

        let mut cmd = shell_command("npm", vec!["view".into(), pkg.clone(), "version".into(), "--json".into()]);
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

async fn check_python_latest(id: &str) -> LatestVersion {
    let url = "https://endoflife.date/api/python.json";

    // Platform-adaptive HTTP fetch
    #[cfg(target_os = "windows")]
    let body: Result<String, String> = {
        let script = format!(
            "(Invoke-WebRequest -Uri '{}' -UseBasicParsing).Content",
            url
        );
        let mut ps_cmd = tokio::process::Command::new("powershell");
        let output = crate::process_command::tokio_no_window(
            ps_cmd.args(["-NoProfile", "-Command", &script]),
        )
        .output()
        .await;
        match output {
            Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => Err(e.to_string()),
        }
    };
    #[cfg(not(target_os = "windows"))]
    let body: Result<String, String> = {
        let mut cmd = tokio::process::Command::new("curl");
        let output = crate::process_command::tokio_no_window(
            cmd.args(["-sf", url]),
        )
        .output()
        .await;
        match output {
            Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => Err(e.to_string()),
        }
    };

    let body = match body {
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
        .and_then(|v| v.as_array()?.first()?.get("latest")?.as_str().map(String::from));

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let _ = hub::migrate_v0_5_0();
            let mut registry = agent::AgentRegistry::new();
            if let Ok(Some(active_id)) = hub::load_active_agent_id() {
                let _ = registry.set_active(&active_id);
            }
            app.manage(Mutex::new(AppState { registry }));
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
            write_text_file,
            get_session_names,
            rename_session,
            delete_session_name,
            load_config,
            load_raw_config,
            save_raw_config,
            load_history,
            save_config,
            list_presets,
            save_preset,
            delete_preset,
            apply_preset,
            list_backups,
            restore_backup,
            export_config,
            import_config,
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
            get_app_dir,
            agent_list_statuses,
            agent_set_active,
            agent_get_active,
            agent_refresh_health,
            check_prerequisite,
            install_agent_command,
            check_environment,
            check_available_updates,
            chat::send_message,
            chat::abort_chat,
            image::save_session_files,
            image::read_image_as_data_url,
            image::read_file_as_base64,
            image::get_clipboard_file_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_text_file_preview() {
        let path =
            std::env::temp_dir().join(format!("jishu-hub-text-preview-{}.txt", std::process::id()));
        std::fs::write(&path, "line 1\nline 2").unwrap();

        let preview = super::read_text_file(path.to_string_lossy().to_string()).unwrap();

        assert_eq!(preview.content, "line 1\nline 2");
        assert!(!preview.truncated);
        assert_eq!(preview.size, 13);

        let _ = std::fs::remove_file(path);
    }
}
