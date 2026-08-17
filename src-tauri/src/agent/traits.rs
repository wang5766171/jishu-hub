use serde_json::Value;

use super::command_config::AgentCommandPreset;
use super::{
    AcpCommandSpec, AgentCapabilities, AgentHealth, AgentInfo, ChatRequest, ConfigSurface,
    NormalizedEvent, ProjectSettingsSurface, ResolvedSessionPromptInjection, StreamEventNormalizer,
    TerminalSurface, TransportSurface,
};
use crate::history::HistoryEntry;
use crate::project::Project;
use crate::project_config::ProjectSettings;
use crate::session::{Message, Session};

pub trait AgentManifest {
    fn info(&self) -> AgentInfo;
    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::empty()
    }
    /// Selectable thinking levels (v0.7.4 需求1 A7). Empty = the agent has no
    /// thinking-level control (UI hides the selector). Values are the agent's
    /// own level ids (pi: off/minimal/low/medium/high/xhigh/max); the agent
    /// clamps per-model and reports the effective level back via events.
    fn thinking_levels(&self) -> Vec<String> {
        Vec::new()
    }
    fn install_hint(&self) -> Option<String> {
        None
    }
    fn native_install_command(&self) -> Option<String> {
        None
    }
    /// Version bundled or otherwise managed by the application itself.
    fn available_version(&self) -> Option<String> {
        None
    }
    /// Package manager used for native install (e.g. "winget", "choco").
    fn install_package_manager(&self) -> Option<String> {
        None
    }
    /// Whether this agent is installed automatically with the application.
    fn auto_installed(&self) -> bool {
        false
    }
    fn requires_installation_for_project_scan(&self) -> bool {
        true
    }
    fn probe_sync(&self) -> AgentHealth {
        AgentHealth {
            installed: false,
            version: None,
            error: None,
            binary_path: None,
            last_checked_at: 0,
        }
    }
    fn probe(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AgentHealth> + Send + '_>> {
        let health = self.probe_sync();
        Box::pin(async move { health })
    }
}

pub trait TransportAdapter {
    fn transport_surface(&self) -> TransportSurface;
    /// The effective transport to dispatch this turn on. Defaults to the
    /// declarative `transport_surface()`. An adapter whose ACP backend is an
    /// external bridge that may or may not be installed (claude_code →
    /// claude-agent-acp) overrides this to probe the bridge binary and fall
    /// back to `Cli` when it is absent — so chat keeps working (design R4:
    /// "失败降级") instead of breaking on a missing dependency. Callers that
    /// decide Acp-vs-Cli dispatch must use this, not `transport_surface()`.
    fn resolve_transport(&self) -> TransportSurface {
        self.transport_surface()
    }
    fn build_chat_command(&self, args: ChatRequest) -> tokio::process::Command;
    fn build_acp_command(&self, _args: &ChatRequest) -> Result<AcpCommandSpec, String> {
        Err("ACP transport is not supported by this agent".to_string())
    }
    fn resolved_session_prompt_injection(&self) -> Option<ResolvedSessionPromptInjection> {
        None
    }
    fn pipe_chat_stdin(&self) -> bool {
        self.abort_chat_sequence().is_some()
    }
    fn consumes_stdin_message(&self) -> bool {
        false
    }
    fn abort_chat_sequence(&self) -> Option<&'static [u8]> {
        None
    }
    fn abort_chat_grace_period(&self) -> std::time::Duration {
        std::time::Duration::from_millis(1200)
    }
    fn abort_chat_process(&self, process_id: u32) -> Result<(), String> {
        crate::process_control::terminate_process_tree(process_id)
    }
    /// Whether stderr lines should be relayed as NormalizedEvent::Error.
    fn stderr_relay_as_events(&self) -> bool {
        false
    }
    /// Whether to treat EOF as TurnComplete after seeing agent output.
    fn treat_eof_as_complete_after_output(&self) -> bool {
        false
    }
}

pub trait ConfigAdapter {
    fn config_surface(&self) -> ConfigSurface {
        ConfigSurface::Unsupported
    }
    fn load_config(&self) -> Result<Value, String>;
    fn save_config(&self, config: &Value) -> Result<(), String>;
    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        vec![]
    }
    fn config_format(&self) -> Option<String> {
        None
    }
    fn load_raw_config(&self) -> Result<String, String> {
        Err("Raw config not supported".to_string())
    }
    fn save_raw_config(&self, _content: &str) -> Result<(), String> {
        Err("Raw config not supported".to_string())
    }
    fn list_backups(&self) -> Result<Vec<crate::config::BackupEntry>, String> {
        Err("Not supported".to_string())
    }
    fn restore_backup(&self, _path: &str) -> Result<(), String> {
        Err("Not supported".to_string())
    }
    fn export_config(&self, _path: &str) -> Result<(), String> {
        Err("Not supported".to_string())
    }
    fn import_config(&self, _path: &str) -> Result<Value, String> {
        Err("Not supported".to_string())
    }

    // Model store methods — only meaningful when config_surface is ModelStore.
    fn load_model_store(&self) -> Result<Value, String> {
        Err("Model store not supported".to_string())
    }
    fn save_model_store(&self, _config: &Value) -> Result<(), String> {
        Err("Model store not supported".to_string())
    }
    fn get_active_model(&self) -> Result<Option<Value>, String> {
        Err("Active model not supported".to_string())
    }
    fn set_active_model(&self, _active: Option<&Value>) -> Result<(), String> {
        Err("Active model not supported".to_string())
    }

    // MCP adapter methods — only meaningful when config_surface is ModelStore
    // with supports_mcp = true.

    // 权限模式（v0.7.3 需求2 P-3）：agent 声明可切换的权限模式与读写提供方。
    // 提供方决定 GUI 的读写路径：ProjectSettings（agent 项目设置）、
    // HubToolMode（Hub 全局工具模式，PiRpc 落 --tools 白名单）、
    // AgentConfig（agent 自己的配置文件，需实现下面两个方法）。
    fn permission_modes(&self) -> Option<(Vec<String>, crate::agent::PermissionModeProvider)> {
        None
    }
    /// 读取当前权限模式（仅 AgentConfig 提供方需要实现）。
    fn get_permission_mode(&self) -> Result<Option<String>, String> {
        Ok(None)
    }
    /// 设置权限模式（仅 AgentConfig 提供方需要实现）。
    fn set_permission_mode(&self, _mode: &str) -> Result<(), String> {
        Err("Permission mode not backed by agent config".to_string())
    }

    /// Whether this agent supports MCP tool integration.
    fn supports_mcp(&self) -> bool {
        false
    }
    /// Check MCP adapter installation status.
    fn check_mcp(&self) -> Result<Value, String> {
        Ok(serde_json::json!({"installed": false, "version": null}))
    }
    /// Install the MCP adapter for this agent.
    fn install_mcp(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
    {
        Box::pin(async { Err("MCP not supported".to_string()) })
    }
    /// Update the installed MCP adapter for this agent.
    fn update_mcp(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
    {
        Box::pin(async { Err("MCP update not supported".to_string()) })
    }
    /// Run one-time migration of MCP config if needed (idempotent).
    fn migrate_mcp_if_needed(&self) {}

    // Transport-bridge methods — meaningful only for agents whose EFFECTIVE
    // transport depends on an external binary that is NOT bundled with the
    // agent CLI. E.g. claude_code reaches `AcpPreferred` (mid-turn
    // `elicitation/create` business questions) only when the `claude-agent-acp`
    // npm bridge is installed; when it is absent `resolve_transport()` falls
    // back to `Cli`. The env-check page detects + installs it the same way the
    // MCP adapter is handled. Mirrors the MCP adapter methods' shape.

    /// Whether this agent depends on an external transport bridge binary.
    fn supports_transport_bridge(&self) -> bool {
        false
    }
    /// Check transport-bridge installation status.
    /// Returns `{ installed, version, name }` (`name` is the human-facing
    /// binary label, e.g. `claude-agent-acp`).
    fn check_transport_bridge(&self) -> Result<Value, String> {
        Ok(serde_json::json!({"installed": false, "version": null, "name": null}))
    }
    /// Install the transport bridge for this agent.
    fn install_transport_bridge(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
    {
        Box::pin(async { Err("Transport bridge not supported".to_string()) })
    }
}

pub trait SessionAdapter {
    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<Session>, String>;
    fn get_session_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
    ) -> Result<Vec<Message>, String>;
    fn persist_interaction_blocks(
        &self,
        _session_path: Option<&str>,
        _session_id: Option<&str>,
        _encoded_name: Option<&str>,
        _interactions: Vec<Value>,
    ) -> Result<(), String> {
        Err("Interaction persistence is not supported by this agent adapter".to_string())
    }
    /// Persist the in-progress assistant text/thinking that the agent's own
    /// store would otherwise lose when a turn is cancelled mid-stream. Only
    /// Claude Code needs this (its transcript is owned by the external `claude`
    /// process, which abandons an interrupted message); agents that durably
    /// persist incrementally (opencode's SQLite, pi's session log) no-op.
    fn persist_partial_assistant(
        &self,
        _session_path: Option<&str>,
        _session_id: Option<&str>,
        _encoded_name: Option<&str>,
        _text: &str,
        _thinking: &str,
    ) -> Result<(), String> {
        Ok(())
    }
    fn load_history(&self) -> Vec<HistoryEntry> {
        vec![]
    }
    /// Delete a native session (v0.7.4 需求1 B4). Adapters that declare the
    /// SESSION_DELETE capability must implement this; the default returns a
    /// structured "not supported" error so the IPC layer can surface it.
    fn delete_session(&self, _session_id: &str, _encoded_name: &str) -> Result<(), String> {
        Err("Session deletion is not supported by this agent adapter".to_string())
    }
}

pub trait TerminalAdapter {
    fn terminal_surface(&self) -> TerminalSurface {
        TerminalSurface::Supported
    }
    fn open_in_terminal(
        &self,
        project_path: &str,
        resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>>;
    fn open_in_terminal_with_command(
        &self,
        project_path: &str,
        command: &str,
    ) -> Result<u32, Box<dyn std::error::Error>>;
    fn build_resume_command(&self, session_id: &str) -> String;

    /// The command to launch this agent for a new session.
    /// Default: empty string — adapters must override.
    fn build_launch_command(&self) -> String {
        String::new()
    }

    /// The command to initialize a project with this agent.
    fn build_init_command(&self) -> String {
        let prompt = "Please initialize this project and tell me when it's done.";
        format!("{} \"{prompt}\"", self.build_launch_command())
    }

    /// Built-in command presets for this agent (shown in the Commands page).
    /// Default: empty — adapters must override.
    fn built_in_commands(&self) -> Vec<AgentCommandPreset> {
        vec![]
    }
}

pub trait ProjectAdapter {
    fn project_settings_surface(&self) -> ProjectSettingsSurface {
        ProjectSettingsSurface::Unsupported { reason: None }
    }
    fn scan_projects(&self) -> Vec<Project>;
    fn add_project(&self, path: &str) -> Option<Project>;
    fn decode_project_path(&self, encoded: &str) -> String;
    fn encode_project_path(&self, path: &str) -> String;
    fn get_level1_dir(&self, path: &str) -> Option<String>;
    fn init_project(&self, project_path: &str) -> Result<bool, String>;
    fn load_project_settings(&self, path: &str) -> Result<ProjectSettings, String>;
    fn load_project_settings_local(&self, path: &str) -> Result<ProjectSettings, String>;
    fn save_project_settings(&self, path: &str, settings: &ProjectSettings) -> Result<(), String>;
    fn save_project_settings_local(
        &self,
        path: &str,
        settings: &ProjectSettings,
    ) -> Result<(), String>;
    fn load_claude_md(&self, _path: &str) -> Result<Option<String>, String> {
        Err("Not supported".to_string())
    }
}

pub trait EventNormalizer {
    fn stream_event_normalizer(&self) -> StreamEventNormalizer {
        crate::agent::default_stream_event_normalizer
    }
    fn normalize_stream_event(&self, event: &Value) -> Vec<NormalizedEvent> {
        vec![NormalizedEvent::Raw {
            agent: "unknown".to_string(),
            raw: event.clone(),
        }]
    }
    fn parse_stream_event(&self, _event: &Value) -> String {
        "unknown".to_string()
    }
}

pub trait AgentPlugin:
    AgentManifest
    + TransportAdapter
    + ConfigAdapter
    + SessionAdapter
    + TerminalAdapter
    + ProjectAdapter
    + EventNormalizer
    + Send
    + Sync
{
}

impl<T> AgentPlugin for T where
    T: AgentManifest
        + TransportAdapter
        + ConfigAdapter
        + SessionAdapter
        + TerminalAdapter
        + ProjectAdapter
        + EventNormalizer
        + Send
        + Sync
{
}
