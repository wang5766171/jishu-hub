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
    /// 智能体的配置目录（v0.9.0 需求21：CLI 未安装但目录存在——桌面端形态
    /// ——也应能进入设置页配置；None = 无固定目录概念）。
    fn config_dir(&self) -> Option<std::path::PathBuf> {
        None
    }

    /// 本应用内建管理的 agent（随 hub 分发/升级；环境检测置顶展示、
    /// 承担任务模式引擎等核心职责）。v0.7.4 需求3：共享层按此标志分支，
    /// 不得写死 agent id（DEVELOP_READ §7）。
    fn is_builtin(&self) -> bool {
        false
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
    /// 官方直连认证状态（v0.7.6 需求3）。None = 该 agent 无官方渠道认证
    /// 概念（UI 不渲染认证卡）；Some 时前端按状态渲染徽标并提供「前往
    /// 认证」（run_in_terminal 跑 login_command）。
    fn official_auth(&self) -> Option<super::OfficialAuthStatus> {
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

pub trait ConfigAdapter: Send + Sync {
    fn config_surface(&self) -> ConfigSurface {
        ConfigSurface::Unsupported
    }
    fn load_config(&self) -> Result<Value, String>;
    fn save_config(&self, config: &Value) -> Result<(), String>;
    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        vec![]
    }
    /// 权限档位声明（surface 性质声明）：可选档位列表 + 读写提供方。
    /// get/set 才是角色方法（PermissionModeConfig）。
    fn permission_modes(&self) -> Option<(Vec<String>, crate::agent::PermissionModeProvider)> {
        None
    }

    // ---- 角色访问器（v0.8.1 M1）：能力即接口，默认 None ----
    fn as_raw_config(&self) -> Option<&dyn crate::agent::config_roles::RawConfigStore> {
        None
    }
    fn as_backup_store(&self) -> Option<&dyn crate::agent::config_roles::ConfigBackupStore> {
        None
    }
    fn as_model_store(&self) -> Option<&dyn crate::agent::config_roles::ModelStore> {
        None
    }
    fn as_mcp(&self) -> Option<&dyn crate::agent::config_roles::McpIntegration> {
        None
    }
    fn as_transport_bridge(&self) -> Option<&dyn crate::agent::config_roles::TransportBridgeDependency> {
        None
    }
    fn as_permission_mode_config(&self) -> Option<&dyn crate::agent::config_roles::PermissionModeConfig> {
        None
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
    /// Persist a completed turn's messages for hub-session agents
    /// (HUB_SESSION_PERSIST capability, v0.8.1 需求1 M2). Builtin adapters
    /// no-op — their native store is written by the CLI process itself.
    fn persist_turn_messages(
        &self,
        _session_id: &str,
        _encoded_name: &str,
        _messages: &[Message],
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
