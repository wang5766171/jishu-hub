mod config;
pub(crate) mod jishu_settings;
pub(crate) mod pi_model;
pub(crate) mod pi_models_config;
pub(crate) mod pi_runtime;
pub(crate) mod pi_session;
mod probe;
mod store;

use crate::agent::capability::AgentCapabilities;
use crate::agent::{AgentInfo, AgentPlugin, ChatRequest};
use crate::project_config::ProjectSettings;
use std::path::PathBuf;

pub struct JishuSelfAgent;

impl JishuSelfAgent {
    pub fn new() -> Self {
        Self
    }
}

pub(crate) fn pi_agent_dir() -> Option<String> {
    let home = dirs::home_dir()?;
    Some(home.join(".jishu-agent").to_string_lossy().to_string())
}

pub(crate) const JISHU_AGENT_IDENTITY_PROMPT: &str =
    "You are jishu agent, the built-in assistant inside Jishu Hub. \
You are not Pi. Use Pi's runtime, tools, and session engine invisibly, \
but present yourself as jishu agent. Reply naturally in the user's language.";

pub(crate) fn resolve_jishu_cli_binary() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("JISHU_CLI_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let exe = std::env::current_exe().map_err(|e| format!("Cannot determine current exe: {e}"))?;
    let parent = exe
        .parent()
        .ok_or_else(|| "No parent directory for current exe".to_string())?;

    #[cfg(target_os = "windows")]
    let binary_name = "jishu.exe";

    #[cfg(not(target_os = "windows"))]
    let binary_name = "jishu";

    let candidates = [
        parent.join(binary_name),
        parent.join("resources").join(binary_name),
        parent.join("..").join("resources").join(binary_name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("release")
            .join(binary_name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
            .join(binary_name),
    ];

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("jishu CLI binary not found: {binary_name}"))
}

use crate::agent::traits::{
    AgentManifest, ConfigAdapter, EventNormalizer, ProjectAdapter, SessionAdapter, TerminalAdapter,
    TransportAdapter,
};
impl AgentManifest for JishuSelfAgent {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "jishu-self".to_string(),
            display_name: "Jishu Agent".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            icon: "jishu".to_string(),
            logo_path: Some("jishu.svg".to_string()),
            enabled: true,
        }
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::STREAM_TEXT_DELTA
            | AgentCapabilities::STREAM_TOOL_CALLS
            | AgentCapabilities::STDIN_PROMPT
            | AgentCapabilities::RESUME_BY_ID
            | AgentCapabilities::ABORT
            | AgentCapabilities::APPROVAL_REQUEST
            | AgentCapabilities::CONFIG_GLOBAL
            | AgentCapabilities::CONFIG_PROJECT
    }

    fn probe_sync(&self) -> crate::agent::capability::AgentHealth {
        probe::probe_self()
    }

    fn auto_installed(&self) -> bool {
        true
    }
}

impl ProjectAdapter for JishuSelfAgent {
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

    fn load_project_settings(&self, path: &str) -> Result<ProjectSettings, String> {
        crate::project_config::load_project_settings(path).map_err(|e| e.to_string())
    }

    fn load_project_settings_local(&self, path: &str) -> Result<ProjectSettings, String> {
        crate::project_config::load_project_settings_local(path).map_err(|e| e.to_string())
    }

    fn save_project_settings(&self, path: &str, settings: &ProjectSettings) -> Result<(), String> {
        crate::project_config::save_project_settings(path, settings).map_err(|e| e.to_string())
    }

    fn save_project_settings_local(
        &self,
        path: &str,
        settings: &ProjectSettings,
    ) -> Result<(), String> {
        crate::project_config::save_project_settings_local(path, settings)
            .map_err(|e| e.to_string())
    }

    fn load_claude_md(&self, path: &str) -> Result<Option<String>, String> {
        crate::project_config::load_claude_md(path).map_err(|e| e.to_string())
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

    // test removed
}

impl SessionAdapter for JishuSelfAgent {
    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<crate::session::Session>, String> {
        pi_session::list_pi_sessions(encoded_name)
    }

    fn get_session_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String> {
        pi_session::load_pi_session_messages(session_id, encoded_name)
    }

    fn load_history(&self) -> Vec<crate::history::HistoryEntry> {
        Vec::new()
    }
}

impl ConfigAdapter for JishuSelfAgent {
    fn config_surface(&self) -> crate::agent::ConfigSurface {
        crate::agent::ConfigSurface::ModelStore {
            provider: "pi".to_string(),
            supports_picker: true,
        }
    }

    fn load_config(&self) -> Result<serde_json::Value, String> {
        config::load_jishu_config().map_err(|e| e.to_string())
    }

    fn save_config(&self, value: &serde_json::Value) -> Result<(), String> {
        config::save_jishu_config(value).map_err(|e| e.to_string())
    }

    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        Vec::new()
    }

    fn config_format(&self) -> Option<String> {
        Some("json".to_string())
    }

    fn load_raw_config(&self) -> Result<String, String> {
        config::load_raw_jishu_config().map_err(|e| e.to_string())
    }

    fn save_raw_config(&self, content: &str) -> Result<(), String> {
        config::save_raw_jishu_config(content).map_err(|e| e.to_string())
    }

    fn list_backups(&self) -> Result<Vec<crate::config::BackupEntry>, String> {
        config::list_jishu_backups().map_err(|e| e.to_string())
    }

    fn restore_backup(&self, path: &str) -> Result<(), String> {
        config::restore_jishu_backup(path).map_err(|e| e.to_string())
    }

    fn export_config(&self, path: &str) -> Result<(), String> {
        config::export_jishu_config(path).map_err(|e| e.to_string())
    }

    fn import_config(&self, path: &str) -> Result<serde_json::Value, String> {
        config::import_jishu_config(path).map_err(|e| e.to_string())
    }

    fn load_model_store(&self) -> Result<serde_json::Value, String> {
        let config = pi_models_config::load()?;
        serde_json::to_value(&config).map_err(|e| format!("Cannot serialize models config: {e}"))
    }

    fn save_model_store(&self, config: &serde_json::Value) -> Result<(), String> {
        let parsed: pi_models_config::PiModelsConfig = serde_json::from_value(config.clone())
            .map_err(|e| format!("Invalid models config payload: {e}"))?;
        pi_models_config::save(&parsed)
    }

    fn get_active_model(&self) -> Result<Option<serde_json::Value>, String> {
        let active = jishu_settings::get_active()?;
        Ok(active.map(|a| serde_json::to_value(a).unwrap_or_default()))
    }

    fn set_active_model(&self, active: Option<&serde_json::Value>) -> Result<(), String> {
        let parsed: Option<jishu_settings::ActiveModel> = active
            .map(|v| {
                serde_json::from_value(v.clone()).map_err(|e| format!("Invalid active model: {e}"))
            })
            .transpose()?;
        jishu_settings::set_active(parsed)
    }
}

impl TransportAdapter for JishuSelfAgent {
    fn transport_surface(&self) -> crate::agent::TransportSurface {
        crate::agent::TransportSurface::AcpPreferred
    }

    fn build_chat_command(&self, req: ChatRequest) -> tokio::process::Command {
        let spec = self
            .build_acp_command(&req)
            .unwrap_or_else(|_| crate::agent::AcpCommandSpec {
                program: "pi".to_string(),
                args: vec!["--acp".to_string()],
                envs: Vec::new(),
            });
        let mut cmd = tokio::process::Command::new(&spec.program);
        cmd.args(&spec.args).current_dir(&req.project_path);
        for (key, value) in spec.envs {
            cmd.env(key, value);
        }
        crate::process_command::tokio_no_window(&mut cmd);
        cmd
    }

    fn build_acp_command(
        &self,
        _req: &ChatRequest,
    ) -> Result<crate::agent::AcpCommandSpec, String> {
        let runtime = pi_runtime::resolve_pi_runtime()?;
        let mut args = runtime.base_args;
        args.push("--acp".to_string());
        args.push("--append-system-prompt".to_string());
        args.push(JISHU_AGENT_IDENTITY_PROMPT.to_string());
        args.extend(pi_model::build_pi_model_args_from_active()?);

        let mut envs = Vec::new();
        if let Some(dir) = pi_agent_dir() {
            envs.push(("PI_CODING_AGENT_DIR".to_string(), dir));
        }

        Ok(crate::agent::AcpCommandSpec {
            program: runtime.program.to_string_lossy().to_string(),
            args,
            envs,
        })
    }

    fn pipe_chat_stdin(&self) -> bool {
        false
    }

    fn consumes_stdin_message(&self) -> bool {
        false
    }
}

impl EventNormalizer for JishuSelfAgent {
    fn stream_event_normalizer(&self) -> crate::agent::StreamEventNormalizer {
        crate::agent::default_stream_event_normalizer
    }

    fn parse_stream_event(&self, event: &serde_json::Value) -> String {
        if let Some(kind) = event.get("kind").and_then(|v| v.as_str()) {
            return kind.to_string();
        }
        "unknown".to_string()
    }
}

impl TerminalAdapter for JishuSelfAgent {
    fn open_in_terminal(
        &self,
        project_path: &str,
        resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        let command = resume_session_id
            .map(|sid| self.build_resume_command(sid))
            .unwrap_or_else(|| self.build_launch_command());
        let window_id = resume_session_id
            .map(|sid| crate::agent::command_config::terminal_window_id("jishu-self", sid));
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
        format!("jishu chat resume {session_id}")
    }

    fn build_launch_command(&self) -> String {
        "jishu chat start --agent jishu-self --project .".to_string()
    }

    fn build_init_command(&self) -> String {
        let prompt = "Please initialize this project and tell me when it's done.";
        format!("jishu run \"{prompt}\"")
    }

    fn built_in_commands(&self) -> Vec<crate::agent::command_config::AgentCommandPreset> {
        use crate::agent::command_config::AgentCommandPreset;
        vec![
            AgentCommandPreset {
                name: "jishu --version".into(),
                command: "jishu --version".into(),
            },
            AgentCommandPreset {
                name: "jishu agents list".into(),
                command: "jishu agents list".into(),
            },
            AgentCommandPreset {
                name: "jishu model list".into(),
                command: "jishu model list".into(),
            },
            AgentCommandPreset {
                name: "jishu doctor".into(),
                command: "jishu doctor".into(),
            },
        ]
    }
}
