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

impl AgentPlugin for CodexAdapter {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "codex".to_string(),
            display_name: "Codex".to_string(),
            version: "1.0".to_string(),
            icon: "bot".to_string(),
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

    fn probe_sync(&self) -> AgentHealth {
        let candidates = super::super::discovery::default_candidates_for("codex");
        let runtime = tokio::runtime::Runtime::new();
        let result = if let Ok(rt) = runtime {
            rt.block_on(async {
                let binary = super::super::discovery::probe_binary(
                    "codex",
                    &candidates.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
                )
                .await;
                match binary {
                    Some(path) => {
                        let version = super::super::discovery::version_of(&path).await;
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
            })
        } else {
            AgentHealth {
                installed: false,
                version: None,
                error: Some("Failed to create tokio runtime".to_string()),
                binary_path: None,
                last_checked_at: now_ms(),
            }
        };
        result
    }

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
                            let last_active =
                                chrono::DateTime::parse_from_rfc3339(updated_at_str)
                                    .ok()
                                    .map(|dt| dt.with_timezone(&chrono::Utc));

                            let messages = parse_rollout_messages(&rollout_path)
                                .unwrap_or_default();

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

    fn load_config(&self) -> Result<crate::config::ClaudeConfig, String> {
        Err("Codex uses native TOML config, use load_raw_config instead".to_string())
    }

    fn save_config(&self, _config: &crate::config::ClaudeConfig) -> Result<(), String> {
        Err("Codex uses native TOML config, use save_raw_config instead".to_string())
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
        std::fs::write(&config_path, content).map_err(|e| e.to_string())
    }

    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        vec![]
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

    fn import_config(&self, _path: &str) -> Result<crate::config::ClaudeConfig, String> {
        Err("Not supported".to_string())
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

    fn build_resume_command(&self, session_id: &str) -> String {
        crate::agent::command_config::resume_command("codex", session_id)
    }

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

    fn load_history(&self) -> Vec<crate::history::HistoryEntry> {
        vec![]
    }

    fn open_in_terminal(
        &self,
        project_path: &str,
        resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        let command = resume_session_id
            .map(|sid| crate::agent::command_config::resume_command("codex", sid))
            .unwrap_or_else(|| crate::agent::command_config::launch_command("codex"));
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

    fn init_project(&self, project_path: &str) -> Result<bool, String> {
        let command = crate::agent::command_config::init_command("codex");
        crate::command::open_agent_terminal(project_path, &command, None)
            .map(|_| true)
            .map_err(|e| e.to_string())
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
fn parse_rollout_messages(
    path: &std::path::Path,
) -> Result<Vec<crate::session::Message>, String> {
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
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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
