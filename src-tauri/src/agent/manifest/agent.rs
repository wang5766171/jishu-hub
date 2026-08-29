//! ManifestAgent（v0.8.1 需求1 M2）：manifest 声明式 agent 的 7-trait 实现。
//!
//! 纯声明驱动——零 agentId 分支，一切行为来自 TOML 段：
//! - `[info]` → AgentManifest.info()
//! - `[probe]` → probe_sync()（复用 discovery::probe_binary_sync + 可选
//!   version_args/regex，regex 第 1 捕获组优先）
//! - `[transport]` → CLI/ACP 命令构造（模板替换后逐段 `Command::arg`，
//!   零 shell 拼接，注入面为零）
//! - `[config]` → Raw surface + as_raw_config() = Some(self)
//! - `[session]` store = hub/none → hub 侧 JSONL 存储或诚实空实现
//! - `[capabilities]` → stream_text/abort/image_input 能力位

use super::schema::{self, AgentManifestFile, SessionStoreKind, TransportKind};
use super::store;
use crate::agent::traits::*;
use crate::agent::{
    AgentCapabilities, AgentInfo, AcpCommandSpec, ChatRequest, NormalizedEvent,
    StreamEventNormalizer, TransportSurface,
};
use crate::agent::capability::AgentHealth;
use crate::session::{Message, Session};
use serde_json::Value;
use std::sync::Arc;

pub struct ManifestAgent {
    file: Arc<AgentManifestFile>,
    /// abort_bytes 预解析（hex → 字节串，leak 成 'static——manifest 数量
    /// 个位数、进程生命周期，泄漏量可忽略）。
    abort_bytes: Option<&'static [u8]>,
}

impl ManifestAgent {
    pub fn new(file: Arc<AgentManifestFile>) -> Self {
        let abort_bytes = file
            .transport
            .as_ref()
            .and_then(|t| t.abort_bytes.as_deref())
            .and_then(|hex| schema::parse_abort_bytes(hex).ok())
            .map(|bytes| Box::leak(bytes.into_boxed_slice()) as &'static [u8]);
        Self { file, abort_bytes }
    }

    /// 模板替换：{prompt}/{cwd}/{session_id}（argv 直传——值里的任何字符
    /// 都不参与命令构造，替换结果仅作为单个 argv 段）。
    fn expand_template(
        &self,
        arg: &str,
        args: &ChatRequest,
    ) -> String {
        let session_id = args.session_id.as_deref().unwrap_or("");
        arg.replace("{prompt}", &args.message)
            .replace("{cwd}", &args.project_path)
            .replace("{session_id}", session_id)
    }

    fn transport(&self) -> Option<&schema::TransportSection> {
        self.file.transport.as_ref()
    }

    fn store_kind(&self) -> SessionStoreKind {
        self.file
            .session
            .map(|s| s.store)
            .unwrap_or(SessionStoreKind::Hub)
    }
}

impl AgentManifest for ManifestAgent {
    fn info(&self) -> AgentInfo {
        let info = &self.file.info;
        AgentInfo {
            id: info.id.clone(),
            display_name: info.display_name.clone(),
            version: "?".to_string(),
            icon: if info.icon.is_empty() {
                "bot".to_string()
            } else {
                info.icon.clone()
            },
            logo_path: None,
            enabled: true,
        }
    }

    fn capabilities(&self) -> AgentCapabilities {
        let caps = self.file.capabilities.unwrap_or_default();
        let mut bits = AgentCapabilities::empty();
        if caps.abort {
            bits |= AgentCapabilities::ABORT;
        }
        if caps.image_input {
            bits |= AgentCapabilities::IMAGE_INPUT;
        }
        if caps.stream_text {
            bits |= AgentCapabilities::STREAM_TEXT_DELTA;
        }
        if self.store_kind() == SessionStoreKind::Hub {
            bits |= AgentCapabilities::HUB_SESSION_PERSIST;
        }
        bits
    }

    fn install_hint(&self) -> Option<String> {
        self.file.info.install_hint.clone()
    }

    fn probe_sync(&self) -> AgentHealth {
        let Some(probe) = self.file.probe.as_ref() else {
            return AgentHealth {
                installed: false,
                version: None,
                error: None,
                binary_path: None,
                last_checked_at: crate::util::now_ms(),
            };
        };
        let name = probe.command.as_str();
        match crate::agent::discovery::probe_binary_sync(name, &[name]) {
            Some(path) => {
                let version = probe.version_args.as_ref().and_then(|args| {
                    probe_version_with_args(&path, args, probe.version_regex.as_deref())
                });
                AgentHealth {
                    installed: true,
                    version,
                    error: None,
                    binary_path: Some(path.to_string_lossy().to_string()),
                    last_checked_at: crate::util::now_ms(),
                }
            }
            None => AgentHealth {
                installed: false,
                version: None,
                error: None,
                binary_path: None,
                last_checked_at: crate::util::now_ms(),
            },
        }
    }
}

/// 跑 `command version_args` 取版本（regex 第 1 捕获组优先，否则整行 trim）。
/// 供 ManifestAgent 与 ToolPlugin 共用（同源安装探测）。
pub fn probe_version_with_args(
    path: &std::path::Path,
    args: &[String],
    regex: Option<&str>,
) -> Option<String> {
    let output = std::process::Command::new(path)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    if let Some(pattern) = regex {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(captures) = re.captures(&text) {
                // 第 1 捕获组优先；无捕获组时取整体匹配。
                return Some(
                    captures
                        .get(1)
                        .or_else(|| captures.get(0))
                        .map(|m| m.as_str().to_string())
                        .unwrap_or_default(),
                );
            }
            return None;
        }
    }
    let first_line = text.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        None
    } else {
        Some(first_line.to_string())
    }
}

impl TransportAdapter for ManifestAgent {
    fn transport_surface(&self) -> TransportSurface {
        match self.transport().map(|t| t.kind) {
            Some(TransportKind::Acp) => TransportSurface::AcpPreferred,
            _ => TransportSurface::Cli,
        }
    }

    fn build_chat_command(&self, args: ChatRequest) -> tokio::process::Command {
        let transport = self.transport();
        let argv: Vec<String> = transport
            .and_then(|t| t.chat_command.clone())
            .unwrap_or_default()
            .into_iter()
            .map(|seg| self.expand_template(&seg, &args))
            .collect();
        let mut command = tokio::process::Command::new(
            argv.first().cloned().unwrap_or_else(|| "echo".to_string()),
        );
        command.args(&argv[1..]);
        if let Some(cwd) = transport.and_then(|t| t.cwd.as_deref()) {
            command.current_dir(schema::expand_tilde(cwd));
        }
        command
    }

    fn build_acp_command(&self, _args: &ChatRequest) -> Result<AcpCommandSpec, String> {
        let transport = self.transport().ok_or("manifest has no [transport] section")?;
        let argv = transport
            .acp_command
            .clone()
            .ok_or("manifest declares acp transport but has no acp_command")?;
        if argv.is_empty() {
            return Err("acp_command must not be empty".to_string());
        }
        Ok(AcpCommandSpec {
            program: argv[0].clone(),
            args: argv[1..].to_vec(),
            envs: vec![],
        })
    }

    fn pipe_chat_stdin(&self) -> bool {
        self.transport().map(|t| t.pipe_stdin).unwrap_or(false)
    }

    fn abort_chat_sequence(&self) -> Option<&'static [u8]> {
        self.abort_bytes
    }

    /// CLI 进程输出后 EOF = 回合完成（01 §5：否则每回合以 Error 收场）。
    fn treat_eof_as_complete_after_output(&self) -> bool {
        true
    }
}

impl ConfigAdapter for ManifestAgent {
    fn config_surface(&self) -> crate::agent::ConfigSurface {
        match self.file.config.as_ref() {
            Some(section) => crate::agent::ConfigSurface::Raw {
                format: section.format.clone(),
            },
            None => crate::agent::ConfigSurface::Unsupported,
        }
    }

    fn load_config(&self) -> Result<Value, String> {
        let raw = crate::agent::config_roles::RawConfigStore::load_raw_config(self)?;
        let section = self.file.config.as_ref().expect("raw implies config");
        match section.format.as_str() {
            "toml" => {
                let parsed: toml::Value =
                    toml::from_str(&raw).map_err(|e| format!("parse TOML: {e}"))?;
                serde_json::to_value(parsed).map_err(|e| format!("convert TOML: {e}"))
            }
            _ => serde_json::from_str(&raw).map_err(|e| format!("parse JSON: {e}")),
        }
    }

    fn save_config(&self, config: &Value) -> Result<(), String> {
        let section = self
            .file
            .config
            .as_ref()
            .ok_or("manifest has no [config] section")?;
        let content = match section.format.as_str() {
            "toml" => toml::to_string_pretty(config).map_err(|e| format!("serialize TOML: {e}"))?,
            _ => serde_json::to_string_pretty(config).map_err(|e| format!("serialize JSON: {e}"))?,
        };
        crate::agent::config_roles::RawConfigStore::save_raw_config(self, &content)
    }

    fn as_raw_config(&self) -> Option<&dyn crate::agent::config_roles::RawConfigStore> {
        Some(self)
    }
}

impl crate::agent::config_roles::RawConfigStore for ManifestAgent {
    fn load_raw_config(&self) -> Result<String, String> {
        let section = self
            .file
            .config
            .as_ref()
            .ok_or("manifest has no [config] section")?;
        let path = section
            .path
            .as_deref()
            .ok_or("manifest [config] has no path")?;
        std::fs::read_to_string(schema::expand_tilde(path))
            .map_err(|e| format!("read config: {e}"))
    }

    fn save_raw_config(&self, content: &str) -> Result<(), String> {
        let section = self
            .file
            .config
            .as_ref()
            .ok_or("manifest has no [config] section")?;
        let path = section
            .path
            .as_deref()
            .ok_or("manifest [config] has no path")?;
        let path = schema::expand_tilde(path);
        // save 前语法校验（fail loud：坏内容不落盘）。
        match section.format.as_str() {
            "toml" => {
                let _parsed: toml::Value =
                    toml::from_str(content).map_err(|e| format!("invalid TOML: {e}"))?;
            }
            _ => {
                let _parsed: Value =
                    serde_json::from_str(content).map_err(|e| format!("invalid JSON: {e}"))?;
            }
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&path, content).map_err(|e| format!("write config: {e}"))
    }

    fn config_format(&self) -> Option<String> {
        self.file.config.as_ref().map(|s| s.format.clone())
    }
}

impl SessionAdapter for ManifestAgent {
    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<Session>, String> {
        match self.store_kind() {
            SessionStoreKind::Hub => Ok(store::list_sessions(&self.file.info.id, encoded_name)),
            SessionStoreKind::None => Ok(Vec::new()),
        }
    }

    fn get_session_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
    ) -> Result<Vec<Message>, String> {
        match self.store_kind() {
            SessionStoreKind::Hub => {
                store::read_messages(&self.file.info.id, encoded_name, session_id)
            }
            SessionStoreKind::None => Ok(Vec::new()),
        }
    }

    fn persist_turn_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
        messages: &[Message],
    ) -> Result<(), String> {
        match self.store_kind() {
            SessionStoreKind::Hub => {
                store::persist_turn(&self.file.info.id, encoded_name, session_id, messages)
            }
            SessionStoreKind::None => Ok(()),
        }
    }

    fn delete_session(&self, session_id: &str, encoded_name: &str) -> Result<(), String> {
        match self.store_kind() {
            SessionStoreKind::Hub => {
                store::delete_session(&self.file.info.id, encoded_name, session_id)
            }
            SessionStoreKind::None => Err("Session deletion is not supported by this agent adapter".to_string()),
        }
    }
}

impl TerminalAdapter for ManifestAgent {
    fn open_in_terminal(
        &self,
        _project_path: &str,
        _resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        Err("terminal launch not supported".into())
    }

    fn open_in_terminal_with_command(
        &self,
        _project_path: &str,
        _command: &str,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        Err("terminal launch not supported".into())
    }

    fn build_resume_command(&self, _session_id: &str) -> String {
        self.build_launch_command()
    }

    /// 启动命令 = chat_command 去掉含 {prompt} 的段（及其紧邻的 flag 段，
    /// 如 `--prompt {prompt}` 两段一起去）拼接（终端里提示词由用户自己敲）。
    fn build_launch_command(&self) -> String {
        let argv: Vec<String> = self
            .transport()
            .and_then(|t| t.chat_command.clone())
            .unwrap_or_default();
        let mut drop_flags: Vec<usize> = Vec::new();
        for (idx, seg) in argv.iter().enumerate() {
            if seg.contains("{prompt}") {
                drop_flags.push(idx);
                // 前一段若是 flag（--xxx/-x），一并去掉。
                if idx > 0 && (argv[idx - 1].starts_with('-')) {
                    drop_flags.push(idx - 1);
                }
            }
        }
        argv.into_iter()
            .enumerate()
            .filter(|(idx, _)| !drop_flags.contains(idx))
            .map(|(_, seg)| {
                // 终端命令是 shell 语义：含空白的段加引号防拆分。
                if seg.contains(char::is_whitespace) {
                    format!("\"{seg}\"")
                } else {
                    seg
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

impl ProjectAdapter for ManifestAgent {
    fn scan_projects(&self) -> Vec<crate::project::Project> {
        Vec::new()
    }
    fn add_project(&self, _path: &str) -> Option<crate::project::Project> {
        None
    }
    fn decode_project_path(&self, encoded: &str) -> String {
        encoded.to_string()
    }
    fn encode_project_path(&self, path: &str) -> String {
        path.to_string()
    }
    fn get_level1_dir(&self, _path: &str) -> Option<String> {
        None
    }
    fn init_project(&self, _project_path: &str) -> Result<bool, String> {
        Ok(false)
    }
    fn load_project_settings(&self, _path: &str) -> Result<crate::project_config::ProjectSettings, String> {
        Err("Not supported".to_string())
    }
    fn load_project_settings_local(&self, _path: &str) -> Result<crate::project_config::ProjectSettings, String> {
        Err("Not supported".to_string())
    }
    fn save_project_settings(&self, _path: &str, _settings: &crate::project_config::ProjectSettings) -> Result<(), String> {
        Err("Not supported".to_string())
    }
    fn save_project_settings_local(
        &self,
        _path: &str,
        _settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String> {
        Err("Not supported".to_string())
    }
}

/// 行级文本 normalizer（fn 指针约束要求具名函数）：非空行 → TextDelta。
fn line_text_normalizer(event: &Value) -> Vec<NormalizedEvent> {
    let agent = "manifest".to_string();
    let _ = &agent;
    match event.as_str() {
        Some(line) if !line.trim().is_empty() => vec![NormalizedEvent::TextDelta {
            delta: line.to_string(),
        }],
        _ => Vec::new(),
    }
}

impl EventNormalizer for ManifestAgent {
    fn stream_event_normalizer(&self) -> StreamEventNormalizer {
        match self.file.capabilities.map(|c| c.stream_text) {
            Some(true) => line_text_normalizer,
            _ => crate::agent::default_stream_event_normalizer,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(toml_src: &str) -> Arc<AgentManifestFile> {
        Arc::new(toml::from_str(toml_src).expect("parse manifest"))
    }

    #[test]
    fn info_maps_and_version_placeholder() {
        let file = manifest(
            r#"
schema = 1
[info]
id = "gemini-cli"
display_name = "Gemini CLI"
[transport]
kind = "cli"
chat_command = ["gemini", "{prompt}"]
"#,
        );
        let agent = ManifestAgent::new(file);
        let info = agent.info();
        assert_eq!(info.id, "gemini-cli");
        assert_eq!(info.version, "?");
        assert_eq!(info.icon, "bot");
    }

    #[test]
    fn chat_command_expands_templates_per_argv() {
        let file = manifest(
            r#"
schema = 1
[info]
id = "x"
display_name = "X"
[transport]
kind = "cli"
chat_command = ["x", "--prompt", "{prompt}", "--cwd", "{cwd}"]
"#,
        );
        let agent = ManifestAgent::new(file);
        let request = ChatRequest {
            project_path: "D:\\proj".to_string(),
            session_id: Some("s1".to_string()),
            message: "hi there; rm -rf /".to_string(),
        };
        // build_chat_command 返回 Command（无法检视 argv）——经 expand_template
        // 间接验证：值里的 shell 元字符只作为单个 argv 段传递。
        let expanded: Vec<String> = ["x", "--prompt", "{prompt}", "--cwd", "{cwd}"]
            .into_iter()
            .map(|seg| agent.expand_template(seg, &request))
            .collect();
        assert_eq!(expanded[2], "hi there; rm -rf /");
        assert_eq!(expanded[4], "D:\\proj");
        let _ = agent.build_chat_command(request);
    }

    #[test]
    fn launch_command_strips_prompt_segments() {
        let file = manifest(
            r#"
schema = 1
[info]
id = "x"
display_name = "X"
[transport]
kind = "cli"
chat_command = ["my-agent", "--session", "{session_id}", "--prompt", "{prompt}"]
"#,
        );
        let agent = ManifestAgent::new(file);
        let cmd = agent.build_launch_command();
        assert!(cmd.starts_with("my-agent --session"));
        assert!(!cmd.contains("--prompt"));
    }

    #[test]
    fn store_none_yields_empty_sessions() {
        let file = manifest(
            r#"
schema = 1
[info]
id = "x"
display_name = "X"
[session]
store = "none"
"#,
        );
        let agent = ManifestAgent::new(file);
        assert!(agent.list_sessions("proj").unwrap().is_empty());
        assert!(agent.get_session_messages("s1", "proj").unwrap().is_empty());
    }
}
