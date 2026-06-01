mod probe;
mod stream;
mod store;

use crate::agent::capability::AgentCapabilities;
use crate::agent::{AgentInfo, AgentPlugin, ChatRequest};
use crate::config::ClaudeConfig;
use crate::project_config::ProjectSettings;
use std::path::PathBuf;

pub struct JishuSelfAgent;

impl JishuSelfAgent {
    pub fn new() -> Self {
        Self
    }
}

/// Normalize a stream event from the jishu agent-bridge subprocess.
/// The agent-bridge protocol speaks NormalizedEvent directly.
pub fn normalize_stream_event(event: &serde_json::Value) -> Vec<crate::agent::normalized::NormalizedEvent> {
    if let Ok(ne) = serde_json::from_value::<crate::agent::normalized::NormalizedEvent>(event.clone()) {
        vec![ne]
    } else {
        vec![crate::agent::normalized::NormalizedEvent::Raw {
            agent: "jishu-self".to_string(),
            raw: event.clone(),
        }]
    }
}

impl AgentPlugin for JishuSelfAgent {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "jishu-self".to_string(),
            display_name: "Jishu".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            icon: "sparkles".to_string(),
            enabled: true,
        }
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::STREAM_TEXT_DELTA
            | AgentCapabilities::RESUME_BY_ID
            | AgentCapabilities::ABORT
    }

    fn probe_sync(&self) -> crate::agent::capability::AgentHealth {
        probe::probe_self()
    }

    fn scan_projects(&self) -> Vec<crate::project::Project> {
        Vec::new()
    }

    fn add_project(&self, _path: &str) -> Option<crate::project::Project> {
        None
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
        Ok(Vec::new())
    }

    fn get_session_messages(
        &self,
        _session_id: &str,
        _encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String> {
        Ok(Vec::new())
    }

    fn load_config(&self) -> Result<ClaudeConfig, String> {
        crate::config::load_config().map_err(|e| e.to_string())
    }

    fn save_config(&self, config: &ClaudeConfig) -> Result<(), String> {
        crate::config::save_config(config).map_err(|e| e.to_string())
    }

    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        Vec::new()
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

    fn import_config(&self, path: &str) -> Result<ClaudeConfig, String> {
        crate::config::import_config(path).map_err(|e| e.to_string())
    }

    fn load_project_settings(&self, path: &str) -> Result<ProjectSettings, String> {
        crate::project_config::load_project_settings(path).map_err(|e| e.to_string())
    }

    fn load_project_settings_local(&self, path: &str) -> Result<ProjectSettings, String> {
        crate::project_config::load_project_settings_local(path).map_err(|e| e.to_string())
    }

    fn save_project_settings(
        &self,
        path: &str,
        settings: &ProjectSettings,
    ) -> Result<(), String> {
        crate::project_config::save_project_settings(path, settings).map_err(|e| e.to_string())
    }

    fn save_project_settings_local(
        &self,
        path: &str,
        settings: &ProjectSettings,
    ) -> Result<(), String> {
        crate::project_config::save_project_settings_local(path, settings).map_err(|e| e.to_string())
    }

    fn load_claude_md(&self, path: &str) -> Result<Option<String>, String> {
        crate::project_config::load_claude_md(path).map_err(|e| e.to_string())
    }

    fn build_chat_command(&self, req: ChatRequest) -> tokio::process::Command {
        let exe = std::env::current_exe()
            .expect("Cannot determine current exe")
            .parent()
            .expect("No parent dir")
            .to_path_buf();

        #[cfg(target_os = "windows")]
        let bin = exe.join("jishu.exe");

        #[cfg(not(target_os = "windows"))]
        let bin = exe.join("jishu");

        let mut cmd = tokio::process::Command::new(&bin);
        cmd.arg("agent-bridge")
            .arg("start")
            .arg("--agent")
            .arg("jishu-self");

        if let Some(sid) = &req.session_id {
            cmd.arg("--session").arg(sid);
        }

        cmd.arg("--").arg(&req.project_path);
        cmd.current_dir(&req.project_path);

        crate::process_command::tokio_no_window(&mut cmd);

        cmd
    }

    fn pipe_chat_stdin(&self) -> bool {
        true
    }

    fn build_resume_command(&self, session_id: &str) -> String {
        let exe = std::env::current_exe()
            .map(|e| {
                e.parent()
                    .unwrap()
                    .to_path_buf()
                    .to_string_lossy()
                    .to_string()
            })
            .unwrap_or_else(|_| ".".to_string());

        #[cfg(target_os = "windows")]
        let bin = format!("{exe}\\jishu.exe");

        #[cfg(not(target_os = "windows"))]
        let bin = format!("{exe}/jishu");

        format!("{bin} agent-bridge start --session {session_id}")
    }

    fn parse_stream_event(&self, event: &serde_json::Value) -> String {
        // Try to extract the event_type from the NormalizedEvent variant name
        if let Some(obj) = event.as_object() {
            if let Some(kind) = obj.keys().next() {
                // serde(tag) format: {"TextDelta":{"delta":"..."}} -> key is the variant
                return match kind.as_str() {
                    "TextDelta" => "text_delta",
                    "Message" => "message",
                    "ToolUseStart" => "tool_use_start",
                    "ToolUseResult" => "tool_use_result",
                    "Thinking" => "thinking",
                    "ApprovalRequest" => "approval_request",
                    "SessionResolved" => "session_resolved",
                    "TurnComplete" => "turn_complete",
                    "Error" => "error",
                    "TaskStep" => "task_step",
                    "SubAgentDispatch" => "sub_agent_dispatch",
                    "SubAgentEvent" => "sub_agent_event",
                    "Raw" => "raw",
                    other => other,
                }
                .to_string();
            }
        }
        "unknown".to_string()
    }

    fn load_history(&self) -> Vec<crate::history::HistoryEntry> {
        Vec::new()
    }

    fn open_in_terminal(
        &self,
        _project_path: &str,
        _resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        Err("JishuSelfAgent does not support terminal launch".into())
    }

    fn open_in_terminal_with_command(
        &self,
        _project_path: &str,
        _command: &str,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        Err("JishuSelfAgent does not support terminal launch".into())
    }

    fn init_project(&self, project_path: &str) -> Result<bool, String> {
        let md_path = PathBuf::from(project_path).join("CLAUDE.md");
        if md_path.exists() {
            Ok(false)
        } else {
            std::fs::write(&md_path, "# Project Instructions\n\n").map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_returns_jishu_self_id() {
        let agent = JishuSelfAgent::new();
        let info = agent.info();
        assert_eq!(info.id, "jishu-self");
        assert!(!info.display_name.is_empty());
        assert!(!info.version.is_empty());
    }

    #[test]
    fn capabilities_include_stream_and_abort() {
        let agent = JishuSelfAgent::new();
        let caps = agent.capabilities();
        assert!(caps.contains(AgentCapabilities::STREAM_TEXT_DELTA));
        assert!(caps.contains(AgentCapabilities::RESUME_BY_ID));
        assert!(caps.contains(AgentCapabilities::ABORT));
    }

    #[test]
    fn scan_projects_returns_empty() {
        let agent = JishuSelfAgent::new();
        assert!(agent.scan_projects().is_empty());
    }

    #[test]
    fn list_sessions_returns_empty() {
        let agent = JishuSelfAgent::new();
        assert!(agent.list_sessions("test").unwrap().is_empty());
    }

    #[test]
    fn get_session_messages_returns_empty() {
        let agent = JishuSelfAgent::new();
        assert!(agent.get_session_messages("sid", "test").unwrap().is_empty());
    }

    #[test]
    fn load_history_returns_empty() {
        let agent = JishuSelfAgent::new();
        assert!(agent.load_history().is_empty());
    }

    #[test]
    fn parse_stream_event_extracts_type() {
        let agent = JishuSelfAgent::new();
        let event = serde_json::json!({"TextDelta": {"delta": "hi"}});
        assert_eq!(agent.parse_stream_event(&event), "text_delta");
    }

    #[test]
    fn build_resume_command_contains_session_id() {
        let agent = JishuSelfAgent::new();
        let cmd = agent.build_resume_command("abc123");
        assert!(cmd.contains("abc123"));
        assert!(cmd.contains("agent-bridge"));
    }
}
