use crate::agent::{
    normalized::{NormalizedEvent, TurnEndReason},
    AgentCapabilities, AgentHealth, AgentInfo, AgentPlugin, ChatRequest,
};

pub struct OpencodeAdapter;

impl OpencodeAdapter {
    pub fn new() -> Self {
        Self
    }
}

pub fn normalize_stream_event(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    match event.get("type").and_then(|v| v.as_str()) {
        Some("text_delta") | Some("message.delta") => {
            let delta = event
                .get("text")
                .or_else(|| event.get("delta"))
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
        Some("message") | Some("message.completed") => normalize_opencode_message(event),
        Some("session.idle") | Some("result") => normalize_opencode_complete(event),
        _ => raw(event),
    }
}

fn normalize_opencode_message(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    if let Some(text) = event
        .get("text")
        .or_else(|| event.get("content"))
        .and_then(|v| v.as_str())
    {
        return vec![NormalizedEvent::TextDelta {
            delta: text.to_string(),
        }];
    }
    raw(event)
}

fn normalize_opencode_complete(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let mut normalized = Vec::new();
    if let Some(session_id) = event
        .get("sessionID")
        .or_else(|| event.get("session_id"))
        .or_else(|| event.get("sessionId"))
        .and_then(|v| v.as_str())
    {
        normalized.push(NormalizedEvent::SessionResolved {
            session_id: session_id.to_string(),
        });
    }
    normalized.push(NormalizedEvent::TurnComplete {
        reason: TurnEndReason::Complete,
        usage: None,
    });
    normalized
}

fn raw(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    vec![NormalizedEvent::Raw {
        agent: "opencode".to_string(),
        raw: event.clone(),
    }]
}

impl AgentPlugin for OpencodeAdapter {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "opencode".to_string(),
            display_name: "opencode".to_string(),
            version: "1.0".to_string(),
            icon: "code".to_string(),
            enabled: true,
        }
    }

    fn capabilities(&self) -> AgentCapabilities {
        use AgentCapabilities as C;
        C::RESUME_BY_ID
            | C::SESSION_FORK
            | C::SESSION_LIST
            | C::SESSION_DELETE
            | C::SESSION_EXPORT
            | C::SESSION_IMPORT
            | C::FILE_INPUT
            | C::STREAM_TEXT_DELTA
            | C::STREAM_THINKING
            | C::ABORT
            | C::CONFIG_GLOBAL
            | C::SUBAGENT_DISPATCH
            | C::SUBAGENT_RECEIVE
            | C::RPC_BIDIRECTIONAL
    }

    fn install_hint(&self) -> Option<String> {
        Some("npm install -g opencode".to_string())
    }

    fn probe_sync(&self) -> AgentHealth {
        let candidates = super::super::discovery::default_candidates_for("opencode");
        let runtime = tokio::runtime::Runtime::new();
        let result = if let Ok(rt) = runtime {
            rt.block_on(async {
                let binary = super::super::discovery::probe_binary(
                    "opencode",
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
                        error: Some("opencode not found in PATH".to_string()),
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
        crate::project::scan_projects()
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

    fn list_sessions(&self, _encoded_name: &str) -> Result<Vec<crate::session::Session>, String> {
        Ok(vec![])
    }

    fn get_session_messages(
        &self,
        _session_id: &str,
        _encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String> {
        Ok(vec![])
    }

    fn load_config(&self) -> Result<crate::config::ClaudeConfig, String> {
        Err("opencode config not yet supported".to_string())
    }

    fn save_config(&self, _config: &crate::config::ClaudeConfig) -> Result<(), String> {
        Err("Not supported".to_string())
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
        let mut args: Vec<String> = vec![req.message];

        if let Some(ref sid) = req.session_id {
            args.push("--session".into());
            args.push(sid.clone());
        }

        #[cfg(target_os = "windows")]
        {
            let mut full_args = vec!["/C".to_string(), "opencode".to_string()];
            full_args.extend(args);
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.args(&full_args).current_dir(&req.project_path);
            cmd
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = tokio::process::Command::new("opencode");
            cmd.args(&args).current_dir(&req.project_path);
            cmd
        }
    }

    fn build_resume_command(&self, session_id: &str) -> String {
        format!("opencode --session {}", session_id)
    }

    fn parse_stream_event(&self, event: &serde_json::Value) -> String {
        match event.get("type").and_then(|v| v.as_str()) {
            Some("text_delta") => "delta",
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
        let command = match resume_session_id {
            Some(sid) => format!("opencode --session {}", sid),
            None => "opencode".to_string(),
        };
        crate::command::open_in_terminal_with_command(project_path, &command)
    }

    fn open_in_terminal_with_command(
        &self,
        project_path: &str,
        command: &str,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        crate::command::open_in_terminal_with_command(project_path, command)
    }

    fn init_project(&self, project_path: &str) -> Result<bool, String> {
        let command = "opencode \"Please initialize this project and tell me when it's done.\"";
        crate::command::open_in_terminal_with_command(project_path, command)
            .map(|_| true)
            .map_err(|e| e.to_string())
    }
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
    fn normalizes_opencode_text_delta() {
        let event = serde_json::json!({
            "type": "text_delta",
            "text": "hello"
        });

        assert_eq!(
            normalize_stream_event(&event),
            vec![NormalizedEvent::TextDelta {
                delta: "hello".to_string()
            }]
        );
    }

    #[test]
    fn normalizes_opencode_idle_as_complete() {
        let event = serde_json::json!({
            "type": "session.idle",
            "sessionID": "open-session"
        });

        assert_eq!(
            normalize_stream_event(&event),
            vec![
                NormalizedEvent::SessionResolved {
                    session_id: "open-session".to_string()
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Complete,
                    usage: None,
                },
            ]
        );
    }
}
