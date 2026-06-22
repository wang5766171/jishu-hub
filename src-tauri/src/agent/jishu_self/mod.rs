pub(crate) mod config;
pub(crate) mod jishu_settings;
pub(crate) mod pi_model;
pub(crate) mod pi_models_config;
pub(crate) mod pi_runtime;
pub(crate) mod pi_session;
mod probe;
mod store;

use crate::agent::capability::AgentCapabilities;
use crate::agent::{AgentInfo, AgentPlugin, ChatRequest, ResolvedSessionPromptInjection};
use crate::project_config::ProjectSettings;
use std::path::PathBuf;

pub struct JishuSelfAgent;

impl JishuSelfAgent {
    pub fn new() -> Self {
        Self
    }

    /// Standalone async MCP install — does not borrow &self, so it can be
    /// awaited without holding the AgentRegistry MutexGuard.
    pub async fn install_mcp_standalone() -> Result<String, String> {
        let runtime = pi_runtime::resolve_pi_runtime()
            .map_err(|e| format!("Failed to resolve Pi runtime: {e}"))?;

        let mut args = runtime.base_args.clone();
        args.push("install".to_string());
        args.push("npm:pi-mcp-adapter".to_string());

        let mut cmd =
            crate::os_adapter::shell::shell_command(&runtime.program.to_string_lossy(), args);
        cmd.current_dir(std::env::current_dir().unwrap_or_default());

        #[cfg(target_os = "windows")]
        crate::process_command::tokio_no_window(&mut cmd);

        if let Some(dir) = pi_agent_dir() {
            cmd.env("PI_CODING_AGENT_DIR", &dir);
        }

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run pi install: {e}"))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(format!(
                "pi install failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
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
    let binary_name = "jishu-cli.exe";

    #[cfg(not(target_os = "windows"))]
    let binary_name = "jishu-cli";

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
        .ok_or_else(|| format!("jishu-cli binary not found: {binary_name}"))
}

use crate::agent::traits::{
    AgentManifest, ConfigAdapter, EventNormalizer, ProjectAdapter, SessionAdapter, TerminalAdapter,
    TransportAdapter,
};
// JISHU_AGENT_VERSION_START (auto-updated by upgrade-version.mjs)
pub const PI_AGENT_VERSION: &str = "0.79.1-7";
// JISHU_AGENT_VERSION_END

impl AgentManifest for JishuSelfAgent {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "jishu-self".to_string(),
            display_name: "Jishu Agent".to_string(),
            version: PI_AGENT_VERSION.to_string(),
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
            | AgentCapabilities::IMAGE_INPUT
            | AgentCapabilities::FILE_INPUT
            | AgentCapabilities::TASK_PLANNING
            | AgentCapabilities::TASK_SUPERVISION
    }

    fn probe_sync(&self) -> crate::agent::capability::AgentHealth {
        probe::probe_self()
    }

    fn auto_installed(&self) -> bool {
        false
    }

    fn native_install_command(&self) -> Option<String> {
        Some("jishu-hub-internal-install".to_string())
    }

    fn install_package_manager(&self) -> Option<String> {
        Some("Jishu Hub 内置 Node 环境".to_string())
    }
}

impl ProjectAdapter for JishuSelfAgent {
    fn scan_projects(&self) -> Vec<crate::project::Project> {
        pi_session::scan_pi_projects()
    }

    fn add_project(&self, path: &str) -> Option<crate::project::Project> {
        let project_path = std::path::Path::new(path);
        if !project_path.is_dir() {
            return None;
        }
        // Ensure the session directory exists to "register" the project
        if let Ok(session_dir) = pi_session::pi_session_dir(path) {
            let _ = std::fs::create_dir_all(&session_dir);
        }
        crate::project::project_from_agent_path(path, "jishu-self", 0, None)
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

    #[test]
    fn jishu_agent_declares_resolved_session_prompt_injection() {
        let injection = JishuSelfAgent::new()
            .resolved_session_prompt_injection()
            .expect("jishu agent should receive Hub-injected session context");

        assert_eq!(injection.open_tag, "<jishu-runtime-context>");
        assert_eq!(injection.session_id_field, "session_id");
        assert!(injection.guidance.contains("get_state"));
        assert!(injection
            .apply("hello", "sid-real")
            .contains("session_id: sid-real"));
    }
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
            supports_mcp: true,
        }
    }

    fn load_config(&self) -> Result<serde_json::Value, String> {
        config::load_jishu_config().map_err(|e| e.to_string())
    }

    fn save_config(&self, value: &serde_json::Value) -> Result<(), String> {
        config::save_jishu_config(value).map_err(|e| e.to_string())
    }

    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        vec![
            crate::hub::ConfigTemplate {
                id: "jishu-default".into(),
                name: "默认配置 (Default)".into(),
                description: "标准配置：开启思考模式，默认 token 限制。".into(),
                config: serde_json::json!({
                    "activeModel": null,
                    "temperature": 0.7,
                    "maxTokens": 8192,
                    "thinkingEnabled": true,
                    "permissions": {
                        "allow": ["Read", "Bash", "Edit", "Write", "Grep", "Find"],
                        "deny": [],
                        "defaultMode": "acceptEdits"
                    }
                }),
            },
            crate::hub::ConfigTemplate {
                id: "jishu-safe".into(),
                name: "安全模式 (Safe)".into(),
                description: "限制危险操作，每次修改需确认。适合新手或不熟悉的代码库。".into(),
                config: serde_json::json!({
                    "activeModel": null,
                    "temperature": 0.5,
                    "maxTokens": 4096,
                    "thinkingEnabled": true,
                    "permissions": {
                        "allow": ["Read", "Grep", "Find"],
                        "deny": ["Bash"],
                        "defaultMode": "default"
                    },
                    "skipDangerous": true
                }),
            },
            crate::hub::ConfigTemplate {
                id: "jishu-power".into(),
                name: "高效模式 (Power)".into(),
                description: "宽松权限，跳过确认，适合快速迭代。".into(),
                config: serde_json::json!({
                    "activeModel": null,
                    "temperature": 0.7,
                    "maxTokens": 16384,
                    "thinkingEnabled": true,
                    "permissions": {
                        "allow": ["Read", "Bash", "Edit", "Write", "Grep", "Find"],
                        "deny": [],
                        "defaultMode": "bypassPermissions"
                    },
                    "skipDangerous": false
                }),
            },
        ]
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

    // ── MCP adapter methods ──

    fn supports_mcp(&self) -> bool {
        true
    }

    fn check_mcp(&self) -> Result<serde_json::Value, String> {
        // Auto-migrate on check (idempotent).
        self.migrate_mcp_if_needed();

        let agent_dir =
            pi_agent_dir().ok_or_else(|| "Cannot resolve ~/.jishu-agent directory".to_string())?;
        // pi install <npm:pkg> stores the package in
        // <PI_CODING_AGENT_DIR>/npm/node_modules/<pkg>, not under packages/.
        let adapter_dir = std::path::Path::new(&agent_dir)
            .join("npm")
            .join("node_modules")
            .join("pi-mcp-adapter");

        if !adapter_dir.exists() {
            return Ok(serde_json::json!({"installed": false, "version": null}));
        }

        // Try reading version from package.json
        let pkg_json = adapter_dir.join("package.json");
        let version = if pkg_json.exists() {
            std::fs::read_to_string(&pkg_json)
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .and_then(|v| {
                    v.get("version")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
        } else {
            None
        };

        Ok(serde_json::json!({"installed": true, "version": version}))
    }

    fn install_mcp(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
    {
        Box::pin(async {
            let runtime = pi_runtime::resolve_pi_runtime()
                .map_err(|e| format!("Failed to resolve Pi runtime: {e}"))?;

            let mut args = runtime.base_args.clone();
            args.push("install".to_string());
            args.push("npm:pi-mcp-adapter".to_string());

            let mut cmd =
                crate::os_adapter::shell::shell_command(&runtime.program.to_string_lossy(), args);
            cmd.current_dir(std::env::current_dir().unwrap_or_default());

            #[cfg(target_os = "windows")]
            crate::process_command::tokio_no_window(&mut cmd);

            // Set PI_CODING_AGENT_DIR so pi writes to ~/.jishu-agent
            if let Some(dir) = pi_agent_dir() {
                cmd.env("PI_CODING_AGENT_DIR", &dir);
            }

            let output = cmd
                .output()
                .await
                .map_err(|e| format!("Failed to run pi install: {e}"))?;

            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                Ok(stdout)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                Err(format!("pi install failed: {stderr}"))
            }
        })
    }

    fn migrate_mcp_if_needed(&self) {
        let Ok(value) = config::load_jishu_config() else {
            return;
        };
        let Ok(typed) = serde_json::from_value::<config::JishuConfig>(value) else {
            return;
        };
        let _ = config::sync_mcp_json(&typed);
    }
}

impl TransportAdapter for JishuSelfAgent {
    fn transport_surface(&self) -> crate::agent::TransportSurface {
        crate::agent::TransportSurface::PiRpc
    }

    fn build_chat_command(&self, req: ChatRequest) -> tokio::process::Command {
        let spec = self
            .build_acp_command(&req)
            .unwrap_or_else(|_| crate::agent::AcpCommandSpec {
                program: "pi".to_string(),
                args: vec!["--mode".to_string(), "rpc".to_string()],
                envs: Vec::new(),
            });
        let mut cmd = crate::os_adapter::shell::shell_command(&spec.program, spec.args);
        cmd.current_dir(&req.project_path);
        for (key, value) in spec.envs {
            cmd.env(key, value);
        }
        crate::process_command::tokio_no_window(&mut cmd);
        cmd
    }

    fn build_acp_command(&self, req: &ChatRequest) -> Result<crate::agent::AcpCommandSpec, String> {
        let runtime = pi_runtime::resolve_pi_runtime()?;
        let mut args = runtime.base_args;
        // Use Pi's native --mode rpc (JSON-line protocol) instead of the
        // non-existent --acp flag. The Pi RPC runtime module handles the
        // protocol translation (prompt/abort commands, AgentEvent normalization).
        args.push("--mode".to_string());
        args.push("rpc".to_string());
        // Resume an existing Pi session when a real (non-transient) session id
        // is provided. Without this, Pi creates a fresh session on every process
        // spawn, losing all conversation history (the root cause of "agent
        // doesn't remember previous turns after restart"). Pi's --session-id
        // accepts an exact project session id and resumes it if it exists,
        // creating it if missing.
        if let Some(session_id) = req.session_id.as_ref().filter(|id| !id.is_empty()) {
            args.push("--session-id".to_string());
            args.push(session_id.clone());
        }
        args.push("--append-system-prompt".to_string());
        args.push(JISHU_AGENT_IDENTITY_PROMPT.to_string());
        args.extend(pi_model::build_pi_model_args_from_active()?);

        let mut envs = Vec::new();
        if let Some(dir) = pi_agent_dir() {
            envs.push(("PI_CODING_AGENT_DIR".to_string(), dir));
        }
        // In debug builds, point JISHU_CLI_BIN to the locally built cli so the
        // task planning skill (advance_phase.mjs) uses the dev version instead
        // of the installed one from PATH. Release builds omit this (falls back
        // to PATH).
        #[cfg(debug_assertions)]
        {
            let dev_cli = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("debug")
                .join(if cfg!(windows) {
                    "jishu-cli.exe"
                } else {
                    "jishu-cli"
                });
            if dev_cli.exists() {
                envs.push((
                    "JISHU_CLI_BIN".to_string(),
                    dev_cli.to_string_lossy().to_string(),
                ));
            }
        }

        Ok(crate::agent::AcpCommandSpec {
            program: runtime.program.to_string_lossy().to_string(),
            args,
            envs,
        })
    }

    fn resolved_session_prompt_injection(&self) -> Option<ResolvedSessionPromptInjection> {
        Some(ResolvedSessionPromptInjection {
            open_tag: "<jishu-runtime-context>".to_string(),
            close_tag: "</jishu-runtime-context>".to_string(),
            session_id_field: "session_id".to_string(),
            guidance: "该 session_id 由 Hub 在 Pi RPC get_state 后注入；阶段推进脚本需要当前会话时直接使用这个值，不要扫描 sessions 目录、猜测最新文件或自行推断。".to_string(),
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
        format!("jishu-cli chat resume {session_id}")
    }

    fn build_launch_command(&self) -> String {
        "jishu-cli chat start --agent jishu-self --project .".to_string()
    }

    fn build_init_command(&self) -> String {
        let prompt = "Please initialize this project and tell me when it's done.";
        format!("jishu-cli run \"{prompt}\"")
    }

    fn built_in_commands(&self) -> Vec<crate::agent::command_config::AgentCommandPreset> {
        use crate::agent::command_config::AgentCommandPreset;
        vec![
            AgentCommandPreset {
                name: "jishu-cli --version".into(),
                command: "jishu-cli --version".into(),
            },
            AgentCommandPreset {
                name: "jishu-cli agents list".into(),
                command: "jishu-cli agents list".into(),
            },
            AgentCommandPreset {
                name: "jishu-cli model list".into(),
                command: "jishu-cli model list".into(),
            },
            AgentCommandPreset {
                name: "jishu-cli doctor".into(),
                command: "jishu-cli doctor".into(),
            },
        ]
    }
}
