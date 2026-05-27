use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::path::PathBuf;

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
    match event_type(event) {
        Some("step_start") | Some("step-start") => normalize_opencode_session(event),
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
        Some("step_finish") | Some("step-finish") => normalize_opencode_step_finish(event),
        Some("error") => normalize_opencode_error(event),
        Some("session.idle") | Some("result") => normalize_opencode_complete(event),
        _ => raw(event),
    }
}

fn event_type(event: &serde_json::Value) -> Option<&str> {
    event
        .get("type")
        .or_else(|| event.get("part").and_then(|part| part.get("type")))
        .and_then(|v| v.as_str())
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

#[derive(Debug, Deserialize)]
struct OpencodeSessionListEntry {
    id: String,
    title: Option<String>,
    updated: Option<i64>,
    created: Option<i64>,
    directory: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpencodeExport {
    messages: Vec<OpencodeExportMessage>,
}

#[derive(Debug, Deserialize)]
struct OpencodeExportMessage {
    info: OpencodeExportMessageInfo,
    #[serde(default)]
    parts: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct OpencodeExportMessageInfo {
    role: String,
    time: Option<OpencodeExportTime>,
}

#[derive(Debug, Deserialize)]
struct OpencodeExportTime {
    created: Option<i64>,
}

fn parse_session_list(
    raw: &str,
    project_path: &str,
) -> Result<Vec<crate::session::Session>, String> {
    let json = extract_json(raw).ok_or_else(|| "No JSON session list found".to_string())?;
    let entries: Vec<OpencodeSessionListEntry> =
        serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut sessions = entries
        .into_iter()
        .filter(|entry| {
            entry
                .directory
                .as_deref()
                .map(|dir| same_path(dir, project_path))
                .unwrap_or(false)
        })
        .map(|entry| {
            let started_at = entry.created.and_then(datetime_from_millis);
            let last_active = entry.updated.and_then(datetime_from_millis);
            crate::session::Session {
                id: entry.id.clone(),
                path: PathBuf::from(project_path).join(format!("{}.opencode.json", entry.id)),
                messages: Vec::new(),
                started_at,
                display_name: entry.title.filter(|title| !title.trim().is_empty()),
                last_active,
                project_path: Some(project_path.to_string()),
            }
        })
        .collect::<Vec<_>>();

    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(sessions)
}

fn parse_export_messages(raw: &str) -> Result<Vec<crate::session::Message>, String> {
    let json = extract_json(raw).ok_or_else(|| "No JSON export found".to_string())?;
    let exported: OpencodeExport = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();

    for message in exported.messages {
        if message.info.role != "user" && message.info.role != "assistant" {
            continue;
        }

        let mut content = Vec::new();
        for part in message.parts {
            let part_type = part
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            match part_type {
                "text" => {
                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                        if !text.trim().is_empty() {
                            content.push(crate::session::ContentBlock::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                }
                "thinking" | "reasoning" => {
                    if let Some(text) = part
                        .get("thinking")
                        .or_else(|| part.get("text"))
                        .and_then(|v| v.as_str())
                    {
                        if !text.trim().is_empty() {
                            content.push(crate::session::ContentBlock::Thinking {
                                thinking: text.to_string(),
                            });
                        }
                    }
                }
                _ => {}
            }
        }

        if content.is_empty() {
            continue;
        }

        messages.push(crate::session::Message {
            role: message.info.role,
            content,
            timestamp: message.info.time.and_then(|time| time.created),
        });
    }

    Ok(messages)
}

fn extract_json(raw: &str) -> Option<&str> {
    let start = raw.find(|ch| ch == '{' || ch == '[')?;
    let end = raw.rfind(|ch| ch == '}' || ch == ']')?;
    if end > start {
        Some(raw[start..=end].trim())
    } else {
        None
    }
}

fn same_path(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        value
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    normalize(left) == normalize(right)
}

fn datetime_from_millis(value: i64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(value)
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

    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<crate::session::Session>, String> {
        let project_path = crate::project::decode_project_path(encoded_name);
        let output = std::process::Command::new("opencode")
            .args(["session", "list", "--format", "json", "--max-count", "500"])
            .current_dir(&project_path)
            .output()
            .map_err(|e| format!("Failed to list opencode sessions: {e}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        parse_session_list(&String::from_utf8_lossy(&output.stdout), &project_path)
    }

    fn get_session_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String> {
        let project_path = crate::project::decode_project_path(encoded_name);
        let output = std::process::Command::new("opencode")
            .args(["export", session_id])
            .current_dir(&project_path)
            .output()
            .map_err(|e| format!("Failed to export opencode session: {e}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        parse_export_messages(&String::from_utf8_lossy(&output.stdout))
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
            let mut cmd = tokio::process::Command::new("opencode");
            cmd.args(&args).current_dir(&req.project_path);
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
        match event_type(event) {
            Some("step_start") | Some("step-start") => "session",
            Some("text") => "delta",
            Some("reasoning") => "thinking",
            Some("tool_use") => "tool",
            Some("step_finish") | Some("step-finish") => "result",
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
    fn parses_opencode_session_list_for_project() {
        let raw = r#"[
            {
                "id": "ses_1",
                "title": "打招呼与确认回复请求",
                "updated": 1779924225844,
                "created": 1779924224291,
                "directory": "D:\\MyCodes\\jishu-hub"
            },
            {
                "id": "ses_other",
                "title": "Other",
                "updated": 1779924000000,
                "created": 1779923000000,
                "directory": "E:\\Other"
            }
        ]"#;

        let sessions = parse_session_list(raw, "D:\\MyCodes\\jishu-hub").unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "ses_1");
        assert_eq!(
            sessions[0].display_name.as_deref(),
            Some("打招呼与确认回复请求")
        );
        assert_eq!(
            sessions[0].project_path.as_deref(),
            Some("D:\\MyCodes\\jishu-hub")
        );
        assert_eq!(
            sessions[0].last_active.unwrap().timestamp_millis(),
            1779924225844
        );
    }

    #[test]
    fn parses_opencode_export_messages() {
        let raw = r#"{
            "info": {
                "id": "ses_1",
                "title": "打招呼",
                "directory": "D:\\MyCodes\\jishu-hub",
                "time": { "created": 1779924224291, "updated": 1779924225844 }
            },
            "messages": [
                {
                    "info": { "role": "user", "time": { "created": 1779924224348 } },
                    "parts": [{ "type": "text", "text": "你好" }]
                },
                {
                    "info": { "role": "assistant", "time": { "created": 1779924224453 } },
                    "parts": [
                        { "type": "step-start" },
                        { "type": "text", "text": "你好！有什么可以帮你的？" },
                        { "type": "step-finish", "reason": "stop" }
                    ]
                }
            ]
        }"#;

        let messages = parse_export_messages(raw).unwrap();

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        match &messages[1].content[0] {
            crate::session::ContentBlock::Text { text } => {
                assert_eq!(text, "你好！有什么可以帮你的？");
            }
            other => panic!("Expected text block, got {:?}", other),
        }
    }

    #[test]
    fn parses_opencode_export_with_trailing_status_text() {
        let raw = r#"{
            "messages": [
                {
                    "info": { "role": "assistant", "time": { "created": 1779924224453 } },
                    "parts": [{ "type": "text", "text": "ok" }]
                }
            ]
        }
        Exporting session: ses_1"#;

        let messages = parse_export_messages(raw).unwrap();

        assert_eq!(messages.len(), 1);
    }

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

        let finish_hyphen = serde_json::json!({
            "type": "step-finish",
            "sessionID": "ses_abc",
            "part": {
                "type": "step-finish",
                "reason": "stop"
            }
        });
        assert_eq!(
            normalize_stream_event(&finish_hyphen),
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
