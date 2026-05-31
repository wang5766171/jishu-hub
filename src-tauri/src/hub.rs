use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

fn hub_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(".jishu-hub");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn read_json<T: for<'de> Deserialize<'de>>(
    path: &PathBuf,
) -> Result<T, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

fn write_json<T: Serialize>(path: &PathBuf, data: &T) -> Result<(), Box<dyn std::error::Error>> {
    let json = serde_json::to_string_pretty(data)?;
    crate::util::atomic_write(path, json.as_bytes())?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SessionNames {
    pub names: HashMap<String, String>,
}

fn session_names_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hub_dir()?.join("sessions.json"))
}

pub fn get_session_names() -> Result<HashMap<String, String>, Box<dyn std::error::Error>> {
    let path = session_names_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let data: SessionNames = read_json(&path)?;
    Ok(data.names)
}

pub fn rename_session(session_id: String, name: String) -> Result<(), Box<dyn std::error::Error>> {
    let path = session_names_path()?;
    let mut data = if path.exists() {
        read_json::<SessionNames>(&path)?
    } else {
        SessionNames::default()
    };
    data.names.insert(session_id, name);
    write_json(&path, &data)
}

pub fn delete_session_name(session_id: String) -> Result<(), Box<dyn std::error::Error>> {
    let path = session_names_path()?;
    if !path.exists() {
        return Ok(());
    }
    let mut data: SessionNames = read_json(&path)?;
    data.names.remove(&session_id);
    write_json(&path, &data)
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct AppState {
    pub last_page: Option<String>,
    pub last_project: Option<String>,
    pub language: Option<String>,
    pub always_on_top: Option<bool>,
    pub theme: Option<String>,
    pub font_size_base: Option<String>,
    pub font_size_prose: Option<String>,
    #[serde(default)]
    pub active_agent_id: Option<String>,
    #[serde(default)]
    pub agent_binary_paths: HashMap<String, String>,
    #[serde(default)]
    pub agent_last_health: HashMap<String, serde_json::Value>,
}

fn state_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hub_dir()?.join("state.json"))
}

pub fn load_state() -> Result<AppState, Box<dyn std::error::Error>> {
    let path = state_path()?;
    if !path.exists() {
        return Ok(AppState::default());
    }
    read_json(&path)
}

pub fn save_state(state: &AppState) -> Result<(), Box<dyn std::error::Error>> {
    let path = state_path()?;
    write_json(&path, state)
}

pub fn migrate_v0_5_0() -> Result<(), Box<dyn std::error::Error>> {
    let session_path = session_names_path()?;
    if session_path.exists() {
        let mut data: SessionNames = read_json(&session_path)?;
        let legacy_names: Vec<(String, String)> = data
            .names
            .iter()
            .filter(|(key, _)| !key.contains(':'))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let mut changed = false;
        for (key, value) in legacy_names {
            let namespaced = format!("claude-code:{key}");
            if let std::collections::hash_map::Entry::Vacant(entry) = data.names.entry(namespaced) {
                entry.insert(value);
                changed = true;
            }
        }
        if changed {
            write_json(&session_path, &data)?;
        }
    }

    let mut state = load_state().unwrap_or_default();
    if state.active_agent_id.is_none() {
        state.active_agent_id = Some("claude-code".to_string());
        save_state(&state)?;
    }
    Ok(())
}

pub fn load_active_agent_id() -> Result<Option<String>, Box<dyn std::error::Error>> {
    Ok(load_state()?.active_agent_id)
}

pub fn save_active_agent_id(id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = load_state().unwrap_or_default();
    state.active_agent_id = Some(id.to_string());
    save_state(&state)
}

pub fn load_language() -> Result<Option<String>, Box<dyn std::error::Error>> {
    let state = load_state()?;
    Ok(state.language)
}

pub fn save_language(lang: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = load_state().unwrap_or_default();
    state.language = Some(lang.to_string());
    save_state(&state)
}

pub fn load_always_on_top() -> Result<bool, Box<dyn std::error::Error>> {
    let state = load_state();
    Ok(state.unwrap_or_default().always_on_top.unwrap_or(false))
}

pub fn save_always_on_top(value: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = load_state().unwrap_or_default();
    state.always_on_top = Some(value);
    save_state(&state)
}

pub fn load_last_project() -> Result<Option<String>, Box<dyn std::error::Error>> {
    let state = load_state()?;
    Ok(state.last_project)
}

pub fn save_last_project(encoded_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = load_state().unwrap_or_default();
    state.last_project = Some(encoded_name.to_string());
    save_state(&state)
}

pub fn load_font_sizes() -> Result<(Option<String>, Option<String>), Box<dyn std::error::Error>> {
    let state = load_state()?;
    Ok((state.font_size_base, state.font_size_prose))
}

pub fn save_font_sizes(base: &str, prose: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = load_state().unwrap_or_default();
    state.font_size_base = Some(base.to_string());
    state.font_size_prose = Some(prose.to_string());
    save_state(&state)
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct HiddenProjects {
    pub encoded_names: Vec<String>,
}

fn hidden_projects_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hub_dir()?.join("hidden_projects.json"))
}

pub fn hide_project(encoded_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = hidden_projects_path()?;
    let mut data = if path.exists() {
        read_json::<HiddenProjects>(&path)?
    } else {
        HiddenProjects::default()
    };
    if !data.encoded_names.contains(&encoded_name.to_string()) {
        data.encoded_names.push(encoded_name.to_string());
    }
    write_json(&path, &data)
}

pub fn unhide_project(encoded_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = hidden_projects_path()?;
    if !path.exists() {
        return Ok(());
    }
    let mut data: HiddenProjects = read_json(&path)?;
    data.encoded_names.retain(|e| e != encoded_name);
    write_json(&path, &data)
}

pub fn is_project_hidden(encoded_name: &str) -> Result<bool, Box<dyn std::error::Error>> {
    let path = hidden_projects_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let data: HiddenProjects = read_json(&path)?;
    Ok(data.encoded_names.contains(&encoded_name.to_string()))
}

// --- Manual Projects ---

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ManualProjects {
    #[serde(default)]
    pub paths: Vec<String>,
}

fn manual_projects_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hub_dir()?.join("manual_projects.json"))
}

pub fn add_manual_project(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path_obj = manual_projects_path()?;
    let mut data = if path_obj.exists() {
        read_json::<ManualProjects>(&path_obj)?
    } else {
        ManualProjects::default()
    };
    if !data.paths.contains(&path.to_string()) {
        data.paths.push(path.to_string());
    }
    write_json(&path_obj, &data)
}

pub fn remove_manual_project(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path_obj = manual_projects_path()?;
    if !path_obj.exists() {
        return Ok(());
    }
    let mut data: ManualProjects = read_json(&path_obj)?;
    data.paths.retain(|p| p != path);
    write_json(&path_obj, &data)
}

pub fn load_manual_projects() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let path = manual_projects_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data: ManualProjects = read_json(&path)?;
    Ok(data.paths)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub config: crate::config::ClaudeConfig,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Presets {
    pub presets: Vec<Preset>,
}

fn presets_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hub_dir()?.join("presets.json"))
}

pub fn list_presets() -> Result<Vec<Preset>, Box<dyn std::error::Error>> {
    let path = presets_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data: Presets = read_json(&path)?;
    Ok(data.presets)
}

pub fn save_preset(preset: Preset) -> Result<(), Box<dyn std::error::Error>> {
    let path = presets_path()?;
    let mut data = if path.exists() {
        read_json::<Presets>(&path)?
    } else {
        Presets::default()
    };
    if let Some(idx) = data.presets.iter().position(|p| p.id == preset.id) {
        data.presets[idx] = preset;
    } else {
        data.presets.push(preset);
    }
    write_json(&path, &data)
}

pub fn delete_preset(id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = presets_path()?;
    if !path.exists() {
        return Ok(());
    }
    let mut data: Presets = read_json(&path)?;
    data.presets.retain(|p| p.id != id);
    write_json(&path, &data)
}

// --- ProjectMeta (custom names, tags, notes) ---

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectMetas {
    #[serde(default)]
    pub metas: HashMap<String, ProjectMeta>,
}

fn project_metas_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hub_dir()?.join("project_meta.json"))
}

pub fn load_project_metas() -> Result<HashMap<String, ProjectMeta>, Box<dyn std::error::Error>> {
    let path = project_metas_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let metas: ProjectMetas = read_json(&path)?;
    Ok(metas.metas)
}

pub fn save_project_meta(
    encoded_name: &str,
    meta: ProjectMeta,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = project_metas_path()?;
    let mut metas = if path.exists() {
        read_json::<ProjectMetas>(&path)?
    } else {
        ProjectMetas::default()
    };

    // If meta is all None/default, remove the entry
    if meta.custom_name.is_none() && meta.tags.is_none() && meta.notes.is_none() {
        metas.metas.remove(encoded_name);
    } else {
        metas.metas.insert(encoded_name.to_string(), meta);
    }

    write_json(&path, &metas)
}

// --- Project Merges ---

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectMerges {
    #[serde(default)]
    pub merges: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PhysicalMergeUndo {
    pub primary: String,
    pub secondaries: Vec<SecondaryMove>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecondaryMove {
    pub encoded_name: String,
    pub claude_dir_backup: Option<String>,
    pub project_claude_dir_backup: Option<String>,
}

fn project_merges_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hub_dir()?.join("project_merges.json"))
}

fn physical_merge_undo_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hub_dir()?.join("physical_merge_undo.json"))
}

pub fn load_project_merges() -> Result<ProjectMerges, Box<dyn std::error::Error>> {
    let path = project_merges_path()?;
    if !path.exists() {
        return Ok(ProjectMerges::default());
    }
    read_json(&path)
}

fn save_project_merges(merges: &ProjectMerges) -> Result<(), Box<dyn std::error::Error>> {
    write_json(&project_merges_path()?, merges)
}

pub fn merge_projects_logical(
    primary: &str,
    secondaries: Vec<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut merges = load_project_merges()?;

    // First, remove all secondaries from being primaries themselves
    for s in &secondaries {
        merges.merges.remove(s);
    }

    // Then, add secondaries to the primary's list
    let existing = merges.merges.entry(primary.to_string()).or_default();
    for s in secondaries {
        if !existing.contains(&s) {
            existing.push(s);
        }
    }

    save_project_merges(&merges)
}

pub fn split_project(primary: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut merges = load_project_merges()?;
    merges.merges.remove(primary);
    save_project_merges(&merges)
}

pub fn get_merged_secondaries(primary: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let merges = load_project_merges()?;
    Ok(merges.merges.get(primary).cloned().unwrap_or_default())
}

/// Get all secondary encoded names across all merges
pub fn get_all_secondaries() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let merges = load_project_merges()?;
    Ok(merges.merges.values().flatten().cloned().collect())
}

/// Given a secondary encoded name, find which primary it belongs to
pub fn resolve_primary(secondary: &str) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let merges = load_project_merges()?;
    for (primary, secondaries) in &merges.merges {
        if secondaries.contains(&secondary.to_string()) {
            return Ok(Some(primary.clone()));
        }
    }
    Ok(None)
}

// --- Terminal Session Tracking ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSessionInfo {
    pub pid: u32,
    pub project_path: String,
    pub started_at: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub window_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct TerminalSessions {
    pub sessions: HashMap<String, TerminalSessionInfo>,
}

fn terminal_sessions_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hub_dir()?.join("terminal_sessions.json"))
}

pub fn register_terminal_session(
    session_id: String,
    pid: u32,
    project_path: String,
    agent_id: String,
    window_id: String,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = terminal_sessions_path()?;
    let mut sessions: TerminalSessions = if path.exists() {
        read_json(&path)?
    } else {
        TerminalSessions::default()
    };
    sessions.sessions.insert(
        session_id,
        TerminalSessionInfo {
            pid,
            project_path,
            agent_id: Some(agent_id),
            window_id: Some(window_id),
            started_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    write_json(&path, &sessions)
}

/// Find a running terminal for the given session by searching process command lines.
/// More reliable than PID tracking because wt.exe may delegate to existing WindowsTerminal.exe
/// and the spawned PID dies immediately.
pub fn find_session_terminal(
    session_id: &str,
) -> Result<Option<TerminalSessionInfo>, Box<dyn std::error::Error>> {
    if let Some(pid) = find_process_by_resume(session_id)? {
        let path = terminal_sessions_path()?;
        let mut sessions: TerminalSessions = if path.exists() {
            read_json(&path)?
        } else {
            TerminalSessions::default()
        };
        let info = TerminalSessionInfo {
            pid,
            project_path: sessions
                .sessions
                .get(session_id)
                .map(|s| s.project_path.clone())
                .unwrap_or_default(),
            started_at: sessions
                .sessions
                .get(session_id)
                .map(|s| s.started_at.clone())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            agent_id: sessions
                .sessions
                .get(session_id)
                .and_then(|s| s.agent_id.clone()),
            window_id: sessions
                .sessions
                .get(session_id)
                .and_then(|s| s.window_id.clone()),
        };
        sessions
            .sessions
            .insert(session_id.to_string(), info.clone());
        write_json(&path, &sessions)?;
        Ok(Some(info))
    } else {
        let path = terminal_sessions_path()?;
        if path.exists() {
            let mut sessions: TerminalSessions = read_json(&path)?;
            if sessions.sessions.remove(session_id).is_some() {
                write_json(&path, &sessions)?;
            }
        }
        Ok(None)
    }
}

/// Focus the Windows Terminal window for a given session using its named window.
pub fn focus_session_terminal(session_id: &str) -> Result<bool, Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates = Vec::new();
        let path = terminal_sessions_path()?;
        if path.exists() {
            let sessions: TerminalSessions = read_json(&path)?;
            if let Some(info) = sessions.sessions.get(session_id) {
                if let Some(window_id) = &info.window_id {
                    candidates.push(window_id.clone());
                }
                if let Some(agent_id) = &info.agent_id {
                    candidates.push(crate::agent::command_config::terminal_window_id(
                        agent_id, session_id,
                    ));
                }
            }
        }
        candidates.extend([
            crate::agent::command_config::terminal_window_id("claude-code", session_id),
            crate::agent::command_config::terminal_window_id("codex", session_id),
            crate::agent::command_config::terminal_window_id("opencode", session_id),
        ]);
        candidates.sort();
        candidates.dedup();

        for window_name in candidates {
            let output = std::process::Command::new("wt")
                .args(["-w", &window_name, "focus-tab"])
                .output()?;
            if output.status.success() {
                return Ok(true);
            }
        }
        Ok(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = session_id;
        Ok(false)
    }
}

fn find_process_by_resume(session_id: &str) -> Result<Option<u32>, Box<dyn std::error::Error>> {
    if !crate::agent::command_config::is_safe_session_id(session_id) {
        return Ok(None);
    }
    #[cfg(target_os = "windows")]
    {
        let marker_filter = crate::agent::command_config::resume_markers(session_id)
            .into_iter()
            .map(|marker| {
                let escaped = marker.replace('\'', "''").replace('[', "`[").replace(']', "`]").replace('*', "`*").replace('?', "`?");
                format!("$_.CommandLine -like '*{}*'", escaped)
            })
            .collect::<Vec<_>>()
            .join(" -or ");
        let mut command = std::process::Command::new("powershell");
        let output = crate::process_command::std_no_window(
            command.args([
                "-NoProfile", "-NonInteractive", "-Command",
                &format!(
                    "$p = Get-CimInstance Win32_Process | Where-Object {{ ({}) -and $_.Name -ne 'powershell.exe' -and $_.Name -ne 'bash.exe' }}; if ($p) {{ ($p | Select-Object -First 1).ProcessId }}",
                    marker_filter
                ),
            ]),
        )
            .output()?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !stdout.is_empty() {
                if let Ok(pid) = stdout.lines().next().unwrap_or("").trim().parse::<u32>() {
                    return Ok(Some(pid));
                }
            }
        }
        Ok(None)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let pattern = crate::agent::command_config::resume_markers(session_id).join("|");
        let output = std::process::Command::new("pgrep")
            .args(["-f", &pattern])
            .output()?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(pid_str) = stdout.lines().next() {
                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                    return Ok(Some(pid));
                }
            }
        }
        Ok(None)
    }
}

pub fn cleanup_dead_sessions() -> Result<u32, Box<dyn std::error::Error>> {
    let path = terminal_sessions_path()?;
    let mut sessions: TerminalSessions = if path.exists() {
        read_json(&path)?
    } else {
        TerminalSessions::default()
    };
    let before = sessions.sessions.len();
    sessions.sessions.retain(|session_id, _info| {
        find_process_by_resume(session_id)
            .map(|r| r.is_some())
            .unwrap_or(false)
    });
    let removed = (before - sessions.sessions.len()) as u32;
    write_json(&path, &sessions)?;
    Ok(removed)
}

// --- Config Templates ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub config: crate::config::ClaudeConfig,
}

pub fn list_config_templates() -> Vec<ConfigTemplate> {
    vec![
        ConfigTemplate {
            id: "native-api".into(),
            name: "原生 API (Native)".into(),
            description: "使用 Anthropic 官方 API，直接触发原生授权引导。".into(),
            config: anthropic_official_config(),
        },
        ConfigTemplate {
            id: "proxy-config".into(),
            name: "中转配置 (Proxy)".into(),
            description: "使用国内主流模型供应商（如智谱、阿里、Minimax）进行中转。".into(),
            config: third_party_proxy_config(),
        }
    ]
}

fn anthropic_official_config() -> crate::config::ClaudeConfig {
    let mut env = std::collections::HashMap::new();
    env.insert("ANTHROPIC_AUTH_TOKEN".into(), String::new());
    crate::config::ClaudeConfig {
        api_provider: Some("anthropic".into()),
        model: Some("claude-sonnet-4-6".into()),
        env: Some(env),
        ..Default::default()
    }
}

fn third_party_proxy_config() -> crate::config::ClaudeConfig {
    let mut env = std::collections::HashMap::new();
    env.insert("ANTHROPIC_BASE_URL".into(), String::new());
    env.insert("ANTHROPIC_AUTH_TOKEN".into(), String::new());
    env.insert("ANTHROPIC_MODEL".into(), String::new());
    crate::config::ClaudeConfig {
        api_provider: Some("anthropic".into()),
        env: Some(env),
        ..Default::default()
    }
}
