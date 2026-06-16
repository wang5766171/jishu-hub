use super::normalized::{NormalizedEvent, TurnEndReason};
use super::{AgentCapabilities, AgentHealth, AgentInfo, AgentPlugin, ChatRequest};

pub struct ClaudeCodeAgent;

impl ClaudeCodeAgent {
    pub fn new() -> Self {
        Self
    }
}

pub fn normalize_stream_event(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    match event.get("type").and_then(|v| v.as_str()) {
        Some("stream_event") => normalize_claude_stream_event(event),
        Some("assistant") => normalize_claude_assistant(event),
        Some("result") => normalize_claude_result(event),
        Some("system") => normalize_claude_system(event),
        _ => vec![NormalizedEvent::Raw {
            agent: "claude-code".to_string(),
            raw: event.clone(),
        }],
    }
}

fn normalize_claude_stream_event(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let inner = event.get("event").unwrap_or(event);
    let delta = inner.get("delta");

    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(|v| v.as_str()) {
        return vec![NormalizedEvent::TextDelta {
            delta: text.to_string(),
        }];
    }

    if let Some(thinking) = delta
        .and_then(|d| d.get("thinking"))
        .and_then(|v| v.as_str())
    {
        return vec![NormalizedEvent::Thinking {
            delta: thinking.to_string(),
        }];
    }

    vec![NormalizedEvent::Raw {
        agent: "claude-code".to_string(),
        raw: event.clone(),
    }]
}

fn normalize_claude_assistant(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let content = event
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| event.get("content"))
        .and_then(|v| v.as_array());

    let Some(content) = content else {
        return vec![NormalizedEvent::Raw {
            agent: "claude-code".to_string(),
            raw: event.clone(),
        }];
    };

    let mut normalized = Vec::new();
    for block in content {
        // Only extract tool_use from assistant snapshots.
        // Text/thinking already arrive via stream_event deltas — emitting them
        // here would duplicate every piece of text.
        if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
            let call_id = block
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let tool = block
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let input = block
                .get("input")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            normalized.push(NormalizedEvent::ToolUseStart {
                call_id,
                tool,
                input,
            });
        }
    }

    if normalized.is_empty() {
        vec![NormalizedEvent::Raw {
            agent: "claude-code".to_string(),
            raw: event.clone(),
        }]
    } else {
        normalized
    }
}

fn normalize_claude_result(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let mut normalized = Vec::new();
    if let Some(session_id) = event.get("session_id").and_then(|v| v.as_str()) {
        normalized.push(NormalizedEvent::SessionResolved {
            session_id: session_id.to_string(),
        });
    }

    let reason = match event.get("subtype").and_then(|v| v.as_str()) {
        Some("error") => TurnEndReason::Error,
        _ => TurnEndReason::Complete,
    };
    normalized.push(NormalizedEvent::TurnComplete {
        reason,
        usage: None,
    });
    normalized
}

fn normalize_claude_system(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    if let Some(session_id) = event.get("session_id").and_then(|v| v.as_str()) {
        return vec![NormalizedEvent::SessionResolved {
            session_id: session_id.to_string(),
        }];
    }
    vec![NormalizedEvent::Raw {
        agent: "claude-code".to_string(),
        raw: event.clone(),
    }]
}

fn is_claude_internal_jsonl_record(v: &serde_json::Value) -> bool {
    if v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
        return true;
    }

    // Context continuation summaries injected by Claude Code on compaction.
    if v.get("isVisibleInTranscriptOnly")
        .and_then(|f| f.as_bool())
        .unwrap_or(false)
        || v.get("isCompactSummary")
            .and_then(|f| f.as_bool())
            .unwrap_or(false)
    {
        return true;
    }

    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return false;
    }

    if v.get("origin")
        .and_then(|origin| origin.get("kind"))
        .and_then(|kind| kind.as_str())
        == Some("task-notification")
    {
        return true;
    }

    let content = v
        .get("message")
        .and_then(|message| message.get("content"))
        .unwrap_or(&serde_json::Value::Null);

    match content {
        serde_json::Value::String(s) => s.trim_start().starts_with("<task-notification>"),
        serde_json::Value::Array(items) => items.iter().any(|item| {
            item.get("type").and_then(|t| t.as_str()) == Some("text")
                && item
                    .get("text")
                    .and_then(|text| text.as_str())
                    .map(|text| text.trim_start().starts_with("<task-notification>"))
                    .unwrap_or(false)
        }),
        _ => false,
    }
}

use crate::agent::traits::{
    AgentManifest, ConfigAdapter, EventNormalizer, ProjectAdapter, SessionAdapter, TerminalAdapter,
    TransportAdapter,
};
impl AgentManifest for ClaudeCodeAgent {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "claude-code".to_string(),
            display_name: "Claude Code".to_string(),
            version: "1.0".to_string(),
            icon: "terminal".to_string(),
            logo_path: Some("claude.svg".to_string()),
            enabled: true,
        }
    }

    fn capabilities(&self) -> AgentCapabilities {
        use AgentCapabilities as C;
        C::RESUME_BY_ID
            | C::SESSION_LIST
            | C::IMAGE_INPUT
            | C::FILE_INPUT
            | C::STREAM_TEXT_DELTA
            | C::STREAM_TOOL_CALLS
            | C::STREAM_THINKING
            | C::PARTIAL_MESSAGE
            | C::ABORT
            | C::CONFIG_GLOBAL
            | C::CONFIG_PROJECT
            | C::CONFIG_BACKUP
            | C::CONFIG_TEMPLATES
    }

    fn install_hint(&self) -> Option<String> {
        Some("npm install -g @anthropic-ai/claude-code".to_string())
    }

    fn native_install_command(&self) -> Option<String> {
        Some("winget install Anthropic.ClaudeCode".to_string())
    }

    fn install_package_manager(&self) -> Option<String> {
        Some("winget".to_string())
    }

    fn probe_sync(&self) -> AgentHealth {
        let candidates = super::discovery::default_candidates_for("claude");
        let cands: Vec<&str> = candidates.iter().map(|s| s.as_str()).collect();
        match super::discovery::probe_binary_sync("claude", &cands) {
            Some(path) => {
                let version = super::discovery::version_of_sync(&path);
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
                error: Some("claude not found in PATH".to_string()),
                binary_path: None,
                last_checked_at: now_ms(),
            },
        }
    }
}

/// Whether the `claude-agent-acp` bridge binary is resolvable on PATH. This
/// gates claude_code's effective transport (design R4 "探针 + 降级"): present →
/// AcpPreferred (mid-turn `elicitation/create` business questions), absent → Cli
/// fallback so ordinary chat keeps working exactly as before.
fn claude_acp_bridge_available() -> bool {
    let candidates = super::discovery::default_candidates_for("claude-agent-acp");
    let cands: Vec<&str> = candidates.iter().map(|s| s.as_str()).collect();
    super::discovery::probe_binary_sync("claude-agent-acp", &cands).is_some()
}

/// Pure resolution decision, factored out so the logic is unit-testable without
/// depending on the host PATH: AcpPreferred when the bridge is present, Cli
/// otherwise (identical to the pre-migration behavior).
fn resolve_transport_given(bridge_available: bool) -> crate::agent::TransportSurface {
    if bridge_available {
        crate::agent::TransportSurface::AcpPreferred
    } else {
        crate::agent::TransportSurface::Cli
    }
}

impl TransportAdapter for ClaudeCodeAgent {
    fn transport_surface(&self) -> crate::agent::TransportSurface {
        // Declarative target (design R4): claude_code speaks ACP via the
        // claude-agent-acp bridge, which routes AskUserQuestion to
        // `elicitation/create` for mid-turn business questions (unstable,
        // capability-gated, no fork). The EFFECTIVE transport — probed at
        // dispatch — is `resolve_transport()`; this stays AcpPreferred so the
        // dispatch upgrades claude_code to ACP whenever the bridge is installed.
        crate::agent::TransportSurface::AcpPreferred
    }

    fn resolve_transport(&self) -> crate::agent::TransportSurface {
        resolve_transport_given(claude_acp_bridge_available())
    }

    fn build_acp_command(
        &self,
        _req: &ChatRequest,
    ) -> Result<crate::agent::AcpCommandSpec, String> {
        // claude-agent-acp is a stdio JSON-RPC server launched with no args
        // (it reads ACP requests from stdin). On Windows the npm bin is a `.cmd`
        // shim that CreateProcess cannot resolve directly, so wrap it in
        // `cmd /C` — mirroring build_chat_command's Windows handling.
        #[cfg(target_os = "windows")]
        {
            Ok(crate::agent::AcpCommandSpec {
                program: "cmd".to_string(),
                args: vec!["/C".to_string(), "claude-agent-acp".to_string()],
                envs: Vec::new(),
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(crate::agent::AcpCommandSpec {
                program: "claude-agent-acp".to_string(),
                args: Vec::new(),
                envs: Vec::new(),
            })
        }
    }

    fn build_chat_command(&self, req: ChatRequest) -> tokio::process::Command {
        let escaped_message = req.message.replace('\r', "").replace('\n', "\\n");

        let mut args: Vec<String> = vec![
            "-p".into(),
            escaped_message,
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
        ];

        if let Some(ref sid) = req.session_id {
            args.push("--resume".into());
            args.push(sid.clone());
        }

        #[cfg(target_os = "windows")]
        {
            let mut full_args = vec!["/C".to_string(), "claude".to_string()];
            full_args.extend(args);
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.args(&full_args).current_dir(&req.project_path);
            crate::process_command::tokio_no_window(&mut cmd);
            cmd
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = tokio::process::Command::new("claude");
            cmd.args(&args).current_dir(&req.project_path);
            cmd
        }
    }

    fn abort_chat_sequence(&self) -> Option<&'static [u8]> {
        Some(b"\x1b")
    }
}

impl ConfigAdapter for ClaudeCodeAgent {
    fn config_surface(&self) -> crate::agent::ConfigSurface {
        crate::agent::ConfigSurface::Structured {
            schema_id: "claude-config".to_string(),
            supports_model_picker: true,
            supports_small_model: true,
            supports_large_model: true,
            supports_api_provider: true,
        }
    }

    fn load_config(&self) -> Result<serde_json::Value, String> {
        let config = crate::config::load_config().map_err(|e| e.to_string())?;
        serde_json::to_value(config).map_err(|e| e.to_string())
    }

    fn save_config(&self, config: &serde_json::Value) -> Result<(), String> {
        let typed: crate::config::ClaudeConfig =
            serde_json::from_value(config.clone()).map_err(|e| format!("Invalid config: {}", e))?;
        crate::config::save_config(&typed).map_err(|e| e.to_string())
    }

    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        crate::hub::list_config_templates()
    }

    fn config_format(&self) -> Option<String> {
        Some("json".to_string())
    }

    fn load_raw_config(&self) -> Result<String, String> {
        let path = crate::config::config_path().map_err(|e| e.to_string())?;
        if !path.exists() {
            return Ok(String::new());
        }
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    }

    fn save_raw_config(&self, content: &str) -> Result<(), String> {
        // Validate JSON before saving
        let _: serde_json::Value =
            serde_json::from_str(content).map_err(|e| format!("Invalid JSON: {}", e))?;
        crate::config::backup_config().map_err(|e| e.to_string())?;
        let path = crate::config::config_path().map_err(|e| e.to_string())?;
        crate::util::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())
    }

    fn list_backups(&self) -> Result<Vec<crate::config::BackupEntry>, String> {
        crate::config::list_backups().map_err(|e| e.to_string())
    }

    fn restore_backup(&self, path: &str) -> Result<(), String> {
        crate::config::restore_backup(path).map_err(|e| e.to_string())
    }

    fn export_config(&self, path: &str) -> Result<(), String> {
        crate::config::export_config(path).map_err(|e| e.to_string())
    }

    fn import_config(&self, path: &str) -> Result<serde_json::Value, String> {
        let config = crate::config::import_config(path).map_err(|e| e.to_string())?;
        serde_json::to_value(config).map_err(|e| e.to_string())
    }
}

impl SessionAdapter for ClaudeCodeAgent {
    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<crate::session::Session>, String> {
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        let projects_dir = home.join(".claude").join("projects");
        let project_dir = projects_dir.join(encoded_name);
        if !project_dir.exists() {
            return Err(format!("Project directory not found: {}", encoded_name));
        }

        let mut all_sessions = crate::session::list_sessions_with_filter(
            &project_dir,
            is_claude_internal_jsonl_record,
        );

        if let Ok(secondaries) = crate::hub::get_merged_secondaries(encoded_name) {
            for sec in secondaries {
                let sec_dir = projects_dir.join(&sec);
                if sec_dir.exists() {
                    let mut sec_sessions = crate::session::list_sessions_with_filter(
                        &sec_dir,
                        is_claude_internal_jsonl_record,
                    );
                    all_sessions.append(&mut sec_sessions);
                }
            }
        }

        all_sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(all_sessions)
    }

    fn get_session_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String> {
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        let session_path = home
            .join(".claude")
            .join("projects")
            .join(encoded_name)
            .join(format!("{}.jsonl", session_id));
        if !session_path.exists() {
            return Err(format!("Session file not found: {}", session_id));
        }
        crate::session::load_session_with_filter(&session_path, is_claude_internal_jsonl_record)
            .map(|s| s.messages)
            .ok_or_else(|| format!("Failed to parse session: {}", session_id))
    }

    fn load_history(&self) -> Vec<crate::history::HistoryEntry> {
        crate::history::load_history()
    }
}

impl TerminalAdapter for ClaudeCodeAgent {
    fn open_in_terminal(
        &self,
        project_path: &str,
        resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        let command = resume_session_id
            .map(|sid| self.build_resume_command(sid))
            .unwrap_or_else(|| self.build_launch_command());
        let window_id = resume_session_id
            .map(|sid| crate::agent::command_config::terminal_window_id("claude-code", sid));
        crate::command::open_agent_terminal(project_path, &command, window_id.as_deref())
    }

    fn open_in_terminal_with_command(
        &self,
        project_path: &str,
        command: &str,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        crate::command::open_in_terminal_with_command(project_path, &command)
    }

    fn build_resume_command(&self, session_id: &str) -> String {
        format!("claude --resume {session_id}")
    }

    fn build_launch_command(&self) -> String {
        "claude".to_string()
    }

    fn built_in_commands(&self) -> Vec<crate::agent::command_config::AgentCommandPreset> {
        use crate::agent::command_config::AgentCommandPreset;
        vec![
            AgentCommandPreset {
                name: "claude --version".into(),
                command: "claude --version".into(),
            },
            AgentCommandPreset {
                name: "claude mcp list".into(),
                command: "claude mcp list".into(),
            },
        ]
    }
}

impl ProjectAdapter for ClaudeCodeAgent {
    fn project_settings_surface(&self) -> crate::agent::ProjectSettingsSurface {
        crate::agent::ProjectSettingsSurface::Supported {
            scopes: vec![
                crate::agent::ProjectSettingsScope::Shared,
                crate::agent::ProjectSettingsScope::Local,
            ],
            access_modes: vec![
                "default".to_string(),
                "bypassPermissions".to_string(),
                "plan".to_string(),
            ],
        }
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

    fn init_project(&self, project_path: &str) -> Result<bool, String> {
        let command = self.build_init_command();
        crate::command::open_in_terminal_with_command(project_path, &command)
            .map(|_| true)
            .map_err(|e| e.to_string())
    }

    fn load_project_settings(
        &self,
        path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String> {
        crate::project_config::load_project_settings(path).map_err(|e| e.to_string())
    }

    fn load_project_settings_local(
        &self,
        path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String> {
        crate::project_config::load_project_settings_local(path).map_err(|e| e.to_string())
    }

    fn save_project_settings(
        &self,
        path: &str,
        settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String> {
        crate::project_config::save_project_settings(path, settings).map_err(|e| e.to_string())
    }

    fn save_project_settings_local(
        &self,
        path: &str,
        settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String> {
        crate::project_config::save_project_settings_local(path, settings)
            .map_err(|e| e.to_string())
    }

    fn load_claude_md(&self, path: &str) -> Result<Option<String>, String> {
        crate::project_config::load_claude_md(path).map_err(|e| e.to_string())
    }
}

impl EventNormalizer for ClaudeCodeAgent {
    fn stream_event_normalizer(&self) -> super::StreamEventNormalizer {
        normalize_stream_event
    }

    fn parse_stream_event(&self, event: &serde_json::Value) -> String {
        match event.get("type").and_then(|v| v.as_str()) {
            Some("system") => event
                .get("subtype")
                .and_then(|v| v.as_str())
                .unwrap_or("system"),
            Some("stream_event") => "delta",
            Some("result") => "result",
            Some("assistant") => "message",
            Some(t) => t,
            None => "unknown",
        }
        .to_string()
    }
}

fn now_ms() -> i64 {
    crate::util::now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::normalized::{NormalizedEvent, TurnEndReason};

    #[test]
    fn normalizes_claude_text_delta() {
        let event = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "hello" }
            }
        });

        assert_eq!(
            normalize_stream_event(&event),
            vec![NormalizedEvent::TextDelta {
                delta: "hello".to_string()
            }]
        );
    }

    #[test]
    fn normalizes_claude_tool_use_message() {
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Read",
                    "input": { "file_path": "README.md" }
                }]
            }
        });

        assert_eq!(
            normalize_stream_event(&event),
            vec![NormalizedEvent::ToolUseStart {
                call_id: "toolu_1".to_string(),
                tool: "Read".to_string(),
                input: serde_json::json!({ "file_path": "README.md" }),
            }]
        );
    }

    #[test]
    fn normalizes_claude_result() {
        let event = serde_json::json!({
            "type": "result",
            "session_id": "abc123",
            "subtype": "success"
        });

        assert_eq!(
            normalize_stream_event(&event),
            vec![
                NormalizedEvent::SessionResolved {
                    session_id: "abc123".to_string()
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Complete,
                    usage: None,
                },
            ]
        );
    }

    #[test]
    fn filters_claude_meta_skill_context_records() {
        let record = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "sourceToolUseID": "call_skill",
            "message": {
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\graphify"
                }]
            }
        });

        assert!(is_claude_internal_jsonl_record(&record));
    }

    #[test]
    fn filters_claude_task_notification_records() {
        let record = serde_json::json!({
            "type": "user",
            "origin": { "kind": "task-notification" },
            "message": {
                "role": "user",
                "content": "<task-notification>\n<task-id>a24c09786e84bbcda</task-id>\n</task-notification>"
            }
        });

        assert!(is_claude_internal_jsonl_record(&record));
    }

    #[test]
    fn keeps_normal_claude_user_records() {
        let record = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "Please run /graphify . --update"
            }
        });

        assert!(!is_claude_internal_jsonl_record(&record));
    }

    // --- transport migration: Cli → AcpPreferred (probe-gated, design R4) -----

    #[test]
    fn declarative_transport_surface_is_acp_preferred() {
        // The design target is AcpPreferred (claude-agent-acp bridge). The
        // EFFECTIVE transport is probed separately by resolve_transport().
        let agent = ClaudeCodeAgent::new();
        assert_eq!(
            agent.transport_surface(),
            crate::agent::TransportSurface::AcpPreferred
        );
    }

    #[test]
    fn resolve_transport_upgrades_to_acp_when_bridge_present() {
        assert_eq!(
            resolve_transport_given(true),
            crate::agent::TransportSurface::AcpPreferred
        );
    }

    #[test]
    fn resolve_transport_falls_back_to_cli_when_bridge_absent() {
        // Bridge absent (the common case without claude-agent-acp installed) →
        // Cli, identical to the pre-migration behavior. This is the safety
        // guarantee: no regression when the bridge is missing.
        assert_eq!(
            resolve_transport_given(false),
            crate::agent::TransportSurface::Cli
        );
    }

    #[test]
    fn build_acp_command_targets_claude_agent_acp() {
        let agent = ClaudeCodeAgent::new();
        let spec = agent
            .build_acp_command(&ChatRequest {
                project_path: "/p".to_string(),
                session_id: None,
                message: "hi".to_string(),
            })
            .expect("claude_code supports ACP");

        // claude-agent-acp is a no-arg stdio server. On Windows the npm `.cmd`
        // shim is wrapped in `cmd /C`; elsewhere it is invoked directly.
        #[cfg(target_os = "windows")]
        {
            assert_eq!(spec.program, "cmd");
            assert_eq!(spec.args, vec!["/C".to_string(), "claude-agent-acp".to_string()]);
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(spec.program, "claude-agent-acp");
            assert!(spec.args.is_empty());
        }
        assert!(spec.envs.is_empty());
    }
}
