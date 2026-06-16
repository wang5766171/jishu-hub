use crate::agent::{
    normalized::{NormalizedEvent, TurnEndReason},
    AgentCapabilities, AgentHealth, AgentInfo, AgentPlugin, ChatRequest,
};
use std::io::BufRead;

pub struct CodexAdapter;

impl CodexAdapter {
    pub fn new() -> Self {
        Self
    }
}

pub fn normalize_stream_event(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    match event.get("type").and_then(|v| v.as_str()) {
        Some("message_delta") | Some("exec_command_output_delta") => {
            let delta = event
                .get("delta")
                .or_else(|| event.get("text"))
                .or_else(|| event.get("output"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if delta.is_empty() {
                raw(event)
            } else {
                vec![NormalizedEvent::TextDelta {
                    delta: delta.to_string(),
                }]
            }
        }
        Some("message") => normalize_codex_message(event),
        Some("result") | Some("turn_complete") => normalize_codex_complete(event),
        _ => raw(event),
    }
}

fn normalize_codex_message(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    if let Some(text) = event
        .get("message")
        .or_else(|| event.get("content"))
        .and_then(|v| v.as_str())
    {
        return vec![NormalizedEvent::TextDelta {
            delta: text.to_string(),
        }];
    }

    raw(event)
}

fn normalize_codex_complete(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let mut normalized = Vec::new();
    if let Some(session_id) = event
        .get("session_id")
        .or_else(|| event.get("sessionId"))
        .and_then(|v| v.as_str())
    {
        normalized.push(NormalizedEvent::SessionResolved {
            session_id: session_id.to_string(),
        });
    }

    if let Some(error) = event.get("error").and_then(|v| v.as_str()) {
        normalized.push(NormalizedEvent::Error {
            message: error.to_string(),
            recoverable: false,
        });
        normalized.push(NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Error,
            usage: None,
        });
    } else {
        normalized.push(NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Complete,
            usage: None,
        });
    }
    normalized
}

fn raw(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    vec![NormalizedEvent::Raw {
        agent: "codex".to_string(),
        raw: event.clone(),
    }]
}

use crate::agent::traits::{
    AgentManifest, ConfigAdapter, EventNormalizer, ProjectAdapter, SessionAdapter, TerminalAdapter,
    TransportAdapter,
};
impl AgentManifest for CodexAdapter {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "codex".to_string(),
            display_name: "Codex".to_string(),
            version: "1.0".to_string(),
            icon: "bot".to_string(),
            logo_path: Some("codex-color.svg".to_string()),
            enabled: true,
        }
    }

    fn capabilities(&self) -> AgentCapabilities {
        use AgentCapabilities as C;
        C::RESUME_LATEST
            | C::RESUME_PICKER
            | C::SESSION_FORK
            | C::SESSION_LIST
            | C::IMAGE_INPUT
            | C::FILE_INPUT
            | C::STREAM_TEXT_DELTA
            | C::STREAM_TOOL_CALLS
            | C::ABORT
            | C::APPROVAL_REQUEST
            | C::CONFIG_GLOBAL
            | C::RPC_BIDIRECTIONAL
    }

    fn install_hint(&self) -> Option<String> {
        Some("npm install -g @openai/codex".to_string())
    }

    fn install_package_manager(&self) -> Option<String> {
        Some("choco".to_string())
    }

    fn probe_sync(&self) -> AgentHealth {
        let candidates = super::super::discovery::default_candidates_for("codex");
        let cands: Vec<&str> = candidates.iter().map(|s| s.as_str()).collect();
        match super::super::discovery::probe_binary_sync("codex", &cands) {
            Some(path) => {
                let version = super::super::discovery::version_of_sync(&path);
                AgentHealth {
                    installed: true,
                    version,
                    error: None,
                    binary_path: Some(path.to_string_lossy().to_string()),
                    last_checked_at: now_ms(),
                }
            }
            None => AgentHealth {
                installed: false,
                version: None,
                error: Some("codex not found in PATH".to_string()),
                binary_path: None,
                last_checked_at: now_ms(),
            },
        }
    }
}

impl TransportAdapter for CodexAdapter {
    fn transport_surface(&self) -> crate::agent::TransportSurface {
        crate::agent::TransportSurface::CodexAppServer
    }

    /// Spawn `codex app-server` for the interactive GUI path (turn-based JSON-RPC
    /// with mid-turn pause-resume via `item/tool/requestUserInput`). Mirrors the
    /// opencode `acp` spec shape; the GUI spawn host resolves the binary.
    fn build_acp_command(
        &self,
        _req: &ChatRequest,
    ) -> Result<crate::agent::AcpCommandSpec, String> {
        Ok(crate::agent::AcpCommandSpec {
            program: "codex".to_string(),
            args: vec!["app-server".to_string()],
            envs: Vec::new(),
        })
    }

    fn build_chat_command(&self, req: ChatRequest) -> tokio::process::Command {
        let mut args: Vec<String> = vec!["exec".into(), "--json".into(), req.message];

        if let Some(ref sid) = req.session_id {
            args.push("--resume".into());
            args.push(sid.clone());
        }

        #[cfg(target_os = "windows")]
        {
            let mut full_args = vec!["/C".to_string(), "codex".to_string()];
            full_args.extend(args);
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.args(&full_args).current_dir(&req.project_path);
            crate::process_command::tokio_no_window(&mut cmd);
            cmd
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = tokio::process::Command::new("codex");
            cmd.args(&args).current_dir(&req.project_path);
            cmd
        }
    }
}

impl ConfigAdapter for CodexAdapter {
    fn config_surface(&self) -> crate::agent::ConfigSurface {
        crate::agent::ConfigSurface::Structured {
            schema_id: "codex-config".to_string(),
            supports_model_picker: false,
            supports_small_model: false,
            supports_large_model: false,
            supports_api_provider: false,
        }
    }

    fn load_config(&self) -> Result<serde_json::Value, String> {
        let raw = self.load_raw_config()?;
        let mut config_json = serde_json::json!({});
        if raw.is_empty() {
            return Ok(config_json);
        }
        let toml_val: toml::Value =
            toml::from_str(&raw).map_err(|e| format!("Invalid TOML: {}", e))?;

        if let Some(model) = toml_val.get("model").and_then(|v| v.as_str()) {
            config_json["model"] = serde_json::Value::String(model.to_string());
        }

        if let Some(env) = toml_val
            .get("shell_environment_policy")
            .and_then(|v| v.get("set"))
            .and_then(|v| v.as_table())
        {
            let mut env_map = serde_json::Map::new();
            for (k, v) in env {
                if let Some(s) = v.as_str() {
                    env_map.insert(k.clone(), serde_json::Value::String(s.to_string()));
                }
            }
            config_json["env"] = serde_json::Value::Object(env_map);
        }

        if let Some(plugins) = toml_val.get("plugins").and_then(|v| v.as_table()) {
            let mut pl_map = serde_json::Map::new();
            for (k, v) in plugins {
                if let Some(enabled) = v.get("enabled").and_then(|e| e.as_bool()) {
                    pl_map.insert(k.clone(), serde_json::Value::Bool(enabled));
                }
            }
            config_json["enabledPlugins"] = serde_json::Value::Object(pl_map);
        }

        if let Some(mcp) = toml_val.get("mcp_servers").and_then(|v| v.as_table()) {
            let mut mcp_map = serde_json::Map::new();
            for (k, v) in mcp {
                if let Ok(json_v) = serde_json::to_value(v) {
                    mcp_map.insert(k.clone(), json_v);
                }
            }
            config_json["mcpServers"] = serde_json::Value::Object(mcp_map);
        }

        Ok(config_json)
    }

    fn save_config(&self, config: &serde_json::Value) -> Result<(), String> {
        let raw = self.load_raw_config()?;
        let mut toml_val: toml::Value = if raw.is_empty() {
            toml::Value::Table(toml::map::Map::new())
        } else {
            toml::from_str(&raw).map_err(|e| format!("Invalid TOML: {}", e))?
        };

        if let Some(table) = toml_val.as_table_mut() {
            if let Some(model) = config.get("model").and_then(|v| v.as_str()) {
                table.insert("model".to_string(), toml::Value::String(model.to_string()));
            }

            if let Some(env_obj) = config.get("env").and_then(|v| v.as_object()) {
                let sep = table
                    .entry("shell_environment_policy".to_string())
                    .or_insert_with(|| {
                        let mut m = toml::map::Map::new();
                        m.insert(
                            "inherit".to_string(),
                            toml::Value::String("core".to_string()),
                        );
                        toml::Value::Table(m)
                    });
                if let Some(sep_table) = sep.as_table_mut() {
                    let set = sep_table
                        .entry("set".to_string())
                        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
                    if let Some(set_table) = set.as_table_mut() {
                        let mut new_set = toml::map::Map::new();
                        for (k, v) in env_obj {
                            if let Some(s) = v.as_str() {
                                new_set.insert(k.clone(), toml::Value::String(s.to_string()));
                            }
                        }
                        *set_table = new_set;
                    }
                }
            } else if config
                .get("env")
                .unwrap_or(&serde_json::Value::Null)
                .is_null()
            {
                if let Some(sep) = table
                    .get_mut("shell_environment_policy")
                    .and_then(|v| v.as_table_mut())
                {
                    sep.remove("set");
                }
            }

            if let Some(plugins_obj) = config.get("enabledPlugins").and_then(|v| v.as_object()) {
                let plugins = table
                    .entry("plugins".to_string())
                    .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
                if let Some(plugins_table) = plugins.as_table_mut() {
                    for (k, v) in plugins_obj {
                        if let Some(enabled) = v.as_bool() {
                            let pl = plugins_table
                                .entry(k.clone())
                                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
                            if let Some(pl_table) = pl.as_table_mut() {
                                pl_table
                                    .insert("enabled".to_string(), toml::Value::Boolean(enabled));
                            }
                        }
                    }
                    let to_remove: Vec<String> = plugins_table
                        .keys()
                        .filter(|k| !plugins_obj.contains_key(*k))
                        .cloned()
                        .collect();
                    for k in to_remove {
                        plugins_table.remove(&k);
                    }
                }
            }

            if let Some(mcp_obj) = config.get("mcpServers").and_then(|v| v.as_object()) {
                let mut new_mcp = toml::map::Map::new();
                for (k, v) in mcp_obj {
                    if let Ok(mcp_server) =
                        serde_json::from_value::<crate::config::McpServerConfig>(v.clone())
                    {
                        if let Ok(toml_str) = toml::to_string(&mcp_server) {
                            if let Ok(toml_val) = toml::from_str::<toml::Value>(&toml_str) {
                                new_mcp.insert(k.clone(), toml_val);
                            }
                        }
                    }
                }
                table.insert("mcp_servers".to_string(), toml::Value::Table(new_mcp));
            } else if config
                .get("mcpServers")
                .unwrap_or(&serde_json::Value::Null)
                .is_null()
            {
                table.remove("mcp_servers");
            }
        }

        let new_content =
            toml::to_string_pretty(&toml_val).map_err(|e| format!("Serialization error: {}", e))?;
        self.save_raw_config(&new_content)
    }

    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        vec![]
    }

    fn config_format(&self) -> Option<String> {
        Some("toml".to_string())
    }

    fn load_raw_config(&self) -> Result<String, String> {
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        let config_path = home.join(".codex").join("config.toml");
        if !config_path.exists() {
            return Ok(String::new());
        }
        std::fs::read_to_string(&config_path).map_err(|e| e.to_string())
    }

    fn save_raw_config(&self, content: &str) -> Result<(), String> {
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        let codex_dir = home.join(".codex");
        std::fs::create_dir_all(&codex_dir).map_err(|e| e.to_string())?;
        let config_path = codex_dir.join("config.toml");
        // Validate TOML before saving
        let _: toml::Value = toml::from_str(content).map_err(|e| format!("Invalid TOML: {}", e))?;
        // Backup existing config before overwriting
        if config_path.exists() {
            let backup_dir = codex_dir.join("backups");
            std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
            let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S");
            let backup_path = backup_dir.join(format!("config_{}.toml", ts));
            std::fs::copy(&config_path, &backup_path).map_err(|e| e.to_string())?;
        }
        crate::util::atomic_write(&config_path, content.as_bytes()).map_err(|e| e.to_string())
    }

    fn list_backups(&self) -> Result<Vec<crate::config::BackupEntry>, String> {
        Ok(vec![])
    }

    fn restore_backup(&self, _path: &str) -> Result<(), String> {
        Err("Not supported".to_string())
    }

    fn export_config(&self, _path: &str) -> Result<(), String> {
        Err("Not supported".to_string())
    }

    fn import_config(&self, _path: &str) -> Result<serde_json::Value, String> {
        Err("Not supported".to_string())
    }
}

impl SessionAdapter for CodexAdapter {
    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<crate::session::Session>, String> {
        let decoded_path = crate::project::decode_project_path(encoded_name);
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        let index_path = home.join(".codex").join("session_index.jsonl");
        if !index_path.exists() {
            return Ok(vec![]);
        }

        let content = std::fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
        let mut sessions = Vec::new();

        for line in content.lines().rev() {
            if let Ok(item) = serde_json::from_str::<serde_json::Value>(line) {
                let id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let thread_name = item
                    .get("thread_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let updated_at_str = item
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();

                if id.is_empty() {
                    continue;
                }

                if let Some(rollout_path) = self.find_rollout_file(&id, updated_at_str) {
                    if let Ok(cwd) = self.get_rollout_cwd(&rollout_path) {
                        if cwd == decoded_path {
                            let last_active = chrono::DateTime::parse_from_rfc3339(updated_at_str)
                                .ok()
                                .map(|dt| dt.with_timezone(&chrono::Utc));

                            let messages =
                                parse_rollout_messages(&rollout_path).unwrap_or_default();

                            sessions.push(crate::session::Session {
                                id,
                                path: rollout_path,
                                messages,
                                started_at: last_active, // Approximating
                                display_name: Some(thread_name),
                                last_active,
                                project_path: Some(cwd),
                            });
                        }
                    }
                }
            }
        }
        Ok(sessions)
    }

    fn get_session_messages(
        &self,
        session_id: &str,
        _encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String> {
        let rollout_path = self.search_rollout_file(session_id)?;
        parse_rollout_messages(&rollout_path)
    }

    fn load_history(&self) -> Vec<crate::history::HistoryEntry> {
        vec![]
    }
}

impl TerminalAdapter for CodexAdapter {
    fn open_in_terminal(
        &self,
        project_path: &str,
        resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        let command = resume_session_id
            .map(|sid| self.build_resume_command(sid))
            .unwrap_or_else(|| self.build_launch_command());
        let window_id = resume_session_id
            .map(|sid| crate::agent::command_config::terminal_window_id("codex", sid));
        crate::command::open_agent_terminal(project_path, &command, window_id.as_deref())
    }

    fn open_in_terminal_with_command(
        &self,
        project_path: &str,
        command: &str,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        crate::command::open_in_terminal_with_command(project_path, command)
    }

    fn build_resume_command(&self, session_id: &str) -> String {
        format!("codex resume {session_id}")
    }

    fn build_launch_command(&self) -> String {
        "codex".to_string()
    }

    fn built_in_commands(&self) -> Vec<crate::agent::command_config::AgentCommandPreset> {
        use crate::agent::command_config::AgentCommandPreset;
        vec![
            AgentCommandPreset {
                name: "codex --version".into(),
                command: "codex --version".into(),
            },
            AgentCommandPreset {
                name: "codex exec".into(),
                command: "codex exec \"Say hello\"".into(),
            },
        ]
    }
}

impl ProjectAdapter for CodexAdapter {
    fn scan_projects(&self) -> Vec<crate::project::Project> {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return Vec::new(),
        };
        let state_path = home.join(".codex").join(".codex-global-state.json");
        if !state_path.exists() {
            return Vec::new();
        }

        let content = std::fs::read_to_string(&state_path).unwrap_or_default();
        let state: serde_json::Value =
            serde_json::from_str(&content).unwrap_or(serde_json::json!({}));

        let roots = state
            .get("electron-saved-workspace-roots")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let mut projects = Vec::new();
        let session_counts = self.session_counts_by_cwd();
        for path_str in roots {
            let path = std::path::Path::new(&path_str);
            if !path.exists() {
                continue;
            }

            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path_str.clone());

            let encoded = crate::project::encode_project_path(&path_str);

            projects.push(crate::project::Project {
                name,
                path: path.to_path_buf(),
                encoded_name: encoded,
                session_count: session_counts.get(&path_str).copied().unwrap_or(0),
                last_active: None,
                has_claude_md: path.join(".claude").join("CLAUDE.md").exists(),
                agent_ids: vec!["codex".to_string()],
                initialized: true,
            });
        }
        projects
    }

    fn add_project(&self, path: &str) -> Option<crate::project::Project> {
        crate::project::add_project(path)
    }

    fn decode_project_path(&self, encoded: &str) -> String {
        crate::project::decode_project_path(encoded)
    }

    fn encode_project_path(&self, path: &str) -> String {
        crate::project::encode_project_path(path)
    }

    fn get_level1_dir(&self, path: &str) -> Option<String> {
        crate::project::get_level1_dir(path)
    }

    fn init_project(&self, project_path: &str) -> Result<bool, String> {
        let command = self.build_init_command();
        crate::command::open_agent_terminal(project_path, &command, None)
            .map(|_| true)
            .map_err(|e| e.to_string())
    }

    fn load_project_settings(
        &self,
        _path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String> {
        Ok(crate::project_config::ProjectSettings::default())
    }

    fn load_project_settings_local(
        &self,
        _path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String> {
        Ok(crate::project_config::ProjectSettings::default())
    }

    fn save_project_settings(
        &self,
        _path: &str,
        _settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String> {
        Err("Not supported".to_string())
    }

    fn save_project_settings_local(
        &self,
        _path: &str,
        _settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String> {
        Err("Not supported".to_string())
    }

    fn load_claude_md(&self, _path: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
}

impl EventNormalizer for CodexAdapter {
    fn parse_stream_event(&self, event: &serde_json::Value) -> String {
        match event.get("type").and_then(|v| v.as_str()) {
            Some("message_delta") => "delta",
            Some("message") => "message",
            Some("result") => "result",
            Some(t) => t,
            None => "unknown",
        }
        .to_string()
    }
}

impl CodexAdapter {
    /// Count sessions per project cwd in a single pass over the global index,
    /// avoiding an O(projects × sessions) rescan (the previous per-project
    /// counter re-read the whole index and reopened every rollout file).
    fn session_counts_by_cwd(&self) -> std::collections::HashMap<String, usize> {
        let mut counts = std::collections::HashMap::new();
        for session in self.list_sessions_all_internal().unwrap_or_default() {
            if let Some(cwd) = session.project_path {
                *counts.entry(cwd).or_insert(0) += 1;
            }
        }
        counts
    }

    fn list_sessions_all_internal(&self) -> Result<Vec<crate::session::Session>, String> {
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        let index_path = home.join(".codex").join("session_index.jsonl");
        if !index_path.exists() {
            return Ok(vec![]);
        }

        let content = std::fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
        let mut sessions = Vec::new();

        for line in content.lines().rev() {
            if let Ok(item) = serde_json::from_str::<serde_json::Value>(line) {
                let id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let thread_name = item
                    .get("thread_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let updated_at_str = item
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();

                if id.is_empty() {
                    continue;
                }

                if let Some(rollout_path) = self.find_rollout_file(&id, updated_at_str) {
                    if let Ok(cwd) = self.get_rollout_cwd(&rollout_path) {
                        let last_active = chrono::DateTime::parse_from_rfc3339(updated_at_str)
                            .ok()
                            .map(|dt| dt.with_timezone(&chrono::Utc));

                        sessions.push(crate::session::Session {
                            id,
                            path: rollout_path,
                            messages: vec![],
                            started_at: last_active,
                            display_name: Some(thread_name),
                            last_active,
                            project_path: Some(cwd),
                        });
                    }
                }
            }
        }
        Ok(sessions)
    }

    fn find_rollout_file(&self, id: &str, updated_at: &str) -> Option<std::path::PathBuf> {
        let home = dirs::home_dir()?;
        let sessions_dir = home.join(".codex").join("sessions");

        // updated_at is like "2026-05-25T12:36:33.5204339Z"
        let parts: Vec<&str> = updated_at.split('T').collect();
        if parts.is_empty() {
            return None;
        }
        let date_parts: Vec<&str> = parts[0].split('-').collect();
        if date_parts.len() < 3 {
            return None;
        }

        let year = date_parts[0];
        let month = date_parts[1];
        let day = date_parts[2];

        let target_dir = sessions_dir.join(year).join(month).join(day);
        if !target_dir.exists() {
            // Fallback: search recursively if date matching fails (unlikely but safe)
            return self.recursive_search_id(&sessions_dir, id);
        }

        if let Ok(entries) = std::fs::read_dir(target_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.contains(id) && name.ends_with(".jsonl") {
                    return Some(entry.path());
                }
            }
        }

        self.recursive_search_id(&sessions_dir, id)
    }

    fn recursive_search_id(&self, dir: &std::path::Path, id: &str) -> Option<std::path::PathBuf> {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(found) = self.recursive_search_id(&path, id) {
                        return Some(found);
                    }
                } else if path.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.contains(id) && name.ends_with(".jsonl") {
                        return Some(path);
                    }
                }
            }
        }
        None
    }

    fn get_rollout_cwd(&self, path: &std::path::Path) -> Result<String, String> {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let reader = std::io::BufReader::new(file);
        use std::io::BufRead;

        if let Some(Ok(line)) = reader.lines().next() {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(cwd) = val
                    .get("payload")
                    .and_then(|p| p.get("cwd"))
                    .and_then(|v| v.as_str())
                {
                    return Ok(cwd.to_string());
                }
            }
        }
        Err("CWD not found in rollout".to_string())
    }

    fn search_rollout_file(&self, id: &str) -> Result<std::path::PathBuf, String> {
        let home = dirs::home_dir().ok_or("Home dir not found")?;
        let sessions_dir = home.join(".codex").join("sessions");

        self.recursive_search_id(&sessions_dir, id)
            .ok_or_else(|| format!("Rollout file for session {} not found", id))
    }
}

/// Parse codex rollout JSONL at a known path into normalized messages.
/// Used both when listing sessions (path already resolved) and when opening a
/// session, so we never re-run a recursive filesystem search per session.
fn parse_rollout_messages(path: &std::path::Path) -> Result<Vec<crate::session::Message>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);

    let mut messages = Vec::new();
    for line in reader.lines().flatten() {
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if val.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(payload) = val.get("payload") else {
            continue;
        };
        let p_type = payload.get("type").and_then(|v| v.as_str());
        let role = match p_type {
            Some("user_message") => "user",
            Some("agent_message") => "assistant",
            _ => continue,
        };
        let Some(msg) = payload.get("message").and_then(|v| v.as_str()) else {
            continue;
        };
        let timestamp = val
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp_millis());

        messages.push(crate::session::Message {
            role: role.to_string(),
            content: vec![crate::session::ContentBlock::Text {
                text: msg.to_string(),
            }],
            timestamp,
        });
    }
    Ok(messages)
}

fn now_ms() -> i64 {
    crate::util::now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::normalized::{NormalizedEvent, TurnEndReason};

    #[test]
    fn normalizes_codex_message_delta() {
        let event = serde_json::json!({
            "type": "message_delta",
            "delta": "hello"
        });

        assert_eq!(
            normalize_stream_event(&event),
            vec![NormalizedEvent::TextDelta {
                delta: "hello".to_string()
            }]
        );
    }

    #[test]
    fn normalizes_codex_turn_complete_with_session() {
        let event = serde_json::json!({
            "type": "turn_complete",
            "session_id": "codex-session"
        });

        assert_eq!(
            normalize_stream_event(&event),
            vec![
                NormalizedEvent::SessionResolved {
                    session_id: "codex-session".to_string()
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Complete,
                    usage: None,
                },
            ]
        );
    }
}
