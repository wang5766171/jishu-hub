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
        Some("step_start") => normalize_opencode_session(event),
        Some("text") | Some("text_delta") | Some("message.delta") => {
            let delta = event
                .get("text")
                .or_else(|| event.get("delta"))
                .or_else(|| event.get("content"))
                .or_else(|| event.get("part").and_then(|part| part.get("text")))
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
        Some("reasoning") => normalize_opencode_reasoning(event),
        Some("tool_use") => normalize_opencode_tool_use(event),
        Some("message") | Some("message.completed") => normalize_opencode_message(event),
        Some("step_finish") => normalize_opencode_step_finish(event),
        Some("error") => normalize_opencode_error(event),
        Some("session.idle") | Some("result") => normalize_opencode_complete(event),
        _ => raw(event),
    }
}

fn normalize_opencode_session(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    if let Some(session_id) = opencode_session_id(event) {
        return vec![NormalizedEvent::SessionResolved {
            session_id: session_id.to_string(),
        }];
    }
    raw(event)
}

fn normalize_opencode_message(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    if let Some(text) = event
        .get("text")
        .or_else(|| event.get("content"))
        .or_else(|| event.get("part").and_then(|part| part.get("text")))
        .and_then(|v| v.as_str())
    {
        return vec![NormalizedEvent::TextDelta {
            delta: text.to_string(),
        }];
    }
    raw(event)
}

fn normalize_opencode_reasoning(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    if let Some(thinking) = event
        .get("text")
        .or_else(|| event.get("content"))
        .or_else(|| event.get("part").and_then(|part| part.get("text")))
        .and_then(|v| v.as_str())
    {
        return vec![NormalizedEvent::Thinking {
            delta: thinking.to_string(),
        }];
    }
    raw(event)
}

fn normalize_opencode_tool_use(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let part = event.get("part").unwrap_or(event);
    let state = part.get("state").unwrap_or(part);
    let call_id = part
        .get("callID")
        .or_else(|| part.get("call_id"))
        .or_else(|| event.get("callID"))
        .or_else(|| event.get("call_id"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let tool = part
        .get("tool")
        .or_else(|| event.get("tool"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let input = state
        .get("input")
        .or_else(|| part.get("input"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    if call_id.is_empty() {
        return raw(event);
    }

    let mut normalized = vec![NormalizedEvent::ToolUseStart {
        call_id: call_id.clone(),
        tool,
        input,
    }];

    if let Some(output) = state.get("output").or_else(|| part.get("output")).cloned() {
        let is_error = state
            .get("status")
            .and_then(|v| v.as_str())
            .map(|status| status.eq_ignore_ascii_case("error"))
            .unwrap_or(false);
        normalized.push(NormalizedEvent::ToolUseResult {
            call_id,
            output,
            is_error,
        });
    }

    normalized
}

fn normalize_opencode_step_finish(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    match event
        .get("reason")
        .or_else(|| event.get("part").and_then(|part| part.get("reason")))
        .and_then(|v| v.as_str())
    {
        Some("tool-calls") => vec![],
        Some("error") => vec![NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Error,
            usage: None,
        }],
        _ => vec![NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Complete,
            usage: None,
        }],
    }
}

fn normalize_opencode_error(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let message = event
        .get("error")
        .and_then(|error| error.get("data"))
        .and_then(|data| data.get("message"))
        .or_else(|| event.get("error").and_then(|error| error.get("message")))
        .or_else(|| event.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or("opencode error")
        .to_string();

    vec![
        NormalizedEvent::Error {
            message,
            recoverable: false,
        },
        NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Error,
            usage: None,
        },
    ]
}

fn normalize_opencode_complete(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let mut normalized = Vec::new();
    if let Some(session_id) = opencode_session_id(event) {
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

fn opencode_session_id(event: &serde_json::Value) -> Option<&str> {
    event
        .get("sessionID")
        .or_else(|| event.get("session_id"))
        .or_else(|| event.get("sessionId"))
        .or_else(|| event.get("part").and_then(|part| part.get("sessionID")))
        .or_else(|| event.get("part").and_then(|part| part.get("session_id")))
        .or_else(|| event.get("part").and_then(|part| part.get("sessionId")))
        .and_then(|v| v.as_str())
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
        let args = build_run_args(&req);

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
        crate::agent::command_config::resume_command("opencode", session_id)
    }

    fn parse_stream_event(&self, event: &serde_json::Value) -> String {
        match event.get("type").and_then(|v| v.as_str()) {
            Some("step_start") => "session",
            Some("text") => "delta",
            Some("reasoning") => "thinking",
            Some("tool_use") => "tool",
            Some("step_finish") => "result",
            Some("error") => "error",
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
        let command = resume_session_id
            .map(|sid| crate::agent::command_config::resume_command("opencode", sid))
            .unwrap_or_else(|| crate::agent::command_config::launch_command("opencode"));
        let window_id =
            resume_session_id.map(|sid| crate::agent::command_config::terminal_window_id("opencode", sid));
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
        let command = crate::agent::command_config::init_command("opencode");
        crate::command::open_in_terminal_with_command(project_path, &command)
            .map(|_| true)
            .map_err(|e| e.to_string())
    }
}

fn build_run_args(req: &ChatRequest) -> Vec<String> {
    let mut args = vec!["run".to_string(), "--format".to_string(), "json".to_string()];
    if let Some(ref sid) = req.session_id {
        args.push("--session".to_string());
        args.push(sid.clone());
    }
    args.push(req.message.clone());
    args
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

    #[test]
    fn builds_opencode_run_json_args() {
        assert_eq!(
            build_run_args(&ChatRequest {
                project_path: "D:\\MyCodes\\jishu-hub".to_string(),
                session_id: None,
                message: "hello opencode".to_string(),
            }),
            vec!["run", "--format", "json", "hello opencode"]
        );
    }

    #[test]
    fn builds_opencode_run_json_resume_args() {
        assert_eq!(
            build_run_args(&ChatRequest {
                project_path: "D:\\MyCodes\\jishu-hub".to_string(),
                session_id: Some("ses_123".to_string()),
                message: "continue".to_string(),
            }),
            vec!["run", "--format", "json", "--session", "ses_123", "continue"]
        );
    }

    #[test]
    fn normalizes_opencode_jsonl_events() {
        let start = serde_json::json!({
            "type": "step_start",
            "sessionID": "ses_abc"
        });
        assert_eq!(
            normalize_stream_event(&start),
            vec![NormalizedEvent::SessionResolved {
                session_id: "ses_abc".to_string()
            }]
        );

        let text = serde_json::json!({
            "type": "text",
            "text": "hello"
        });
        assert_eq!(
            normalize_stream_event(&text),
            vec![NormalizedEvent::TextDelta {
                delta: "hello".to_string()
            }]
        );

        let finish = serde_json::json!({
            "type": "step_finish",
            "reason": "stop"
        });
        assert_eq!(
            normalize_stream_event(&finish),
            vec![NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: None,
            }]
        );

        let tool_step = serde_json::json!({
            "type": "step_finish",
            "part": {
                "reason": "tool-calls"
            }
        });
        assert_eq!(normalize_stream_event(&tool_step), Vec::<NormalizedEvent>::new());

        let error = serde_json::json!({
            "type": "error",
            "error": {
                "data": {
                    "message": "rate limit"
                }
            }
        });
        assert_eq!(
            normalize_stream_event(&error),
            vec![
                NormalizedEvent::Error {
                    message: "rate limit".to_string(),
                    recoverable: false,
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Error,
                    usage: None,
                },
            ]
        );
    }
}
