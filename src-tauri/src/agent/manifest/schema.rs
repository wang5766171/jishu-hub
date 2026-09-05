//! Manifest schema（schema = 1）的 serde 类型与校验。
//!
//! 校验全部在加载期完成（fail loud 但局部——单文件拒绝不拖垮启动），
//! 运行期零 panic。字段与 `docs/v0.8.1/需求1-微内核架构二期/02` §2.1 一一对应。

use serde::{Deserialize, Serialize};

/// manifest 格式版本；不认识的版本整文件拒绝（misconfiguration fails loud）。
pub const SCHEMA_VERSION: i64 = 1;

/// chat_command / cwd 模板中允许的全部变量。
pub const TEMPLATE_VARS: [&str; 3] = ["{prompt}", "{cwd}", "{session_id}"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentManifestFile {
    pub schema: i64,
    /// 插件类型（v0.8.1 需求7）：agent = 智能体插件（缺省，向后兼容——
    /// 既有 manifest 无此字段）；tool = 工具插件（CLI 能力单元，[tool] 段声明
    /// 用法，经会话 + 菜单注入智能体上下文，不进 AgentRegistry）。
    #[serde(default)]
    pub kind: ManifestKind,
    pub info: InfoSection,
    pub probe: Option<ProbeSection>,
    #[serde(default)]
    pub transport: Option<TransportSection>,
    #[serde(default)]
    pub config: Option<ConfigSection>,
    #[serde(default)]
    pub session: Option<SessionSection>,
    #[serde(default)]
    pub capabilities: Option<CapabilitiesSection>,
    /// kind = "tool" 时必填（描述/用法/示例/注意）。
    #[serde(default)]
    pub tool: Option<ToolSection>,
    /// 自适应插件的 pi 扩展形态声明（v0.8.1 需求10）。
    #[serde(default)]
    pub pi_extension: Option<PiExtensionSection>,
    /// MCP server 声明（v0.9.0 需求1 P2）：插件声明一个外部 MCP stdio
    /// server，hub 聚合 server（jishu-cli mcp serve）spawn 并转发其工具，
    /// 四家智能体经单条 jishu-hub 条目获得（结构化通道，区别于 [tool] 的
    /// prompt 注入；两者可并存）。
    #[serde(default)]
    pub mcp: Option<McpSection>,
    /// 声明式面板（v0.9.0 需求8）。
    #[serde(default)]
    pub panel: Option<PanelSection>,
    /// Skill 声明（v0.9.0 需求20）：插件声明一个 SKILL.md 能力，hub 分发器
    /// 部署到各 agent 的 skill 目录（启停即分发/回收，对标 [mcp] 总控模式）。
    #[serde(default)]
    pub skill: Option<SkillSection>,
}

/// 声明式面板（v0.9.0 需求8：kind = "tool" 专属段）——插件贡献自己的管理
/// 页：受限 list 模板（title + 只读命令行），hub 渲染并按需执行展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PanelSection {
    pub title: String,
    #[serde(default)]
    pub items: Vec<PanelItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PanelItem {
    pub label: String,
    /// 展示时执行的只读命令（与 [tool].usage 同级信任：用户安装插件即信任）。
    pub command: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManifestKind {
    #[default]
    Agent,
    Tool,
}

/// 工具插件的能力声明（kind = "tool" 专属段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolSection {
    pub description: String,
    pub usage: String,
    #[serde(default)]
    pub example: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// pi 扩展形态声明（v0.8.1 需求10 自适应插件）：
/// 与 [tool] 段并存——同一插件在 jishu-self 上以 pi ExtensionAPI 代码运行
/// （深度形态：状态机/确认卡），在其他 agent 上经 [tool] 段 prompt 注入
/// CLI 命令（通用形态）。管理面统一为一个插件实体，形态是内部实现细节。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PiExtensionSection {
    /// pi 扩展入口文件名（相对于插件目录，如 "discuss.ts"）。
    pub entry: String,
    /// 部署目标 agent id（v1 仅 "jishu-self"）。
    #[serde(default = "default_pi_target")]
    pub target_agent: String,
}

fn default_pi_target() -> String {
    "jishu-self".to_string()
}

/// MCP server 传输类型（v0.9.0 需求1 二期）：缺省 stdio——既有 toml 无
/// type 字段无损兼容。http = Streamable HTTP（POST JSON-RPC）；sse = 旧式
/// HTTP+SSE（GET 流 + endpoint 事件 + POST）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransportKind {
    #[default]
    Stdio,
    Http,
    Sse,
}

/// MCP server 声明（v0.9.0 需求1 P2/二期，kind = "tool" 专属段）：
/// stdio 传输带 command/args/env（聚合 server spawn 子进程代理）；http/sse
/// 传输带 url/headers（聚合 server 建远程连接代理）。工具名以插件 id 命名
/// 空间隔离。仅 [mcp] 无 [tool] 合法（纯结构化工具插件，不参与 prompt 注入）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpSection {
    #[serde(default, rename = "type")]
    pub transport: McpTransportKind,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

/// Skill 声明（v0.9.0 需求20，kind = "tool" 专属段）：
/// description = SKILL.md frontmatter 描述（Agent Skills 规范必填，≤1024）；
/// body = SKILL.md 正文指令。skill 名 = 插件 id（分发目录名即命名空间）。
/// 仅 [skill] 无 [tool] 合法（纯 skill 插件，不参与 prompt 注入）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillSection {
    pub description: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InfoSection {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub install_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeSection {
    pub command: String,
    #[serde(default)]
    pub version_args: Option<Vec<String>>,
    #[serde(default)]
    pub version_regex: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    Cli,
    Acp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransportSection {
    pub kind: TransportKind,
    #[serde(default)]
    pub chat_command: Option<Vec<String>>,
    #[serde(default)]
    pub acp_command: Option<Vec<String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub pipe_stdin: bool,
    #[serde(default)]
    pub abort_bytes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigSection {
    pub surface: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub format: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStoreKind {
    /// hub 侧 JSONL 存储（~/.jishu-hub/agent-sessions/...）：历史可回放、
    /// 会话列表可见（v0.8.1 需求1 01 §1 修正：hub 侧此前并无会话存储，
    /// store="none" 的「历史只存 hub 侧」假设不成立，故 hub 为缺省）。
    Hub,
    /// 无会话存储：当次可见（前端内存缓存），重启即失——诚实降级。
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSection {
    #[serde(default = "default_session_store")]
    pub store: SessionStoreKind,
}

fn default_session_store() -> SessionStoreKind {
    SessionStoreKind::Hub
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilitiesSection {
    #[serde(default = "default_true")]
    pub abort: bool,
    #[serde(default)]
    pub image_input: bool,
    #[serde(default)]
    pub stream_text: bool,
}

impl Default for CapabilitiesSection {
    fn default() -> Self {
        Self {
            abort: true,
            image_input: false,
            stream_text: false,
        }
    }
}

fn default_true() -> bool {
    true
}

impl AgentManifestFile {
    /// 加载期校验：全部规则纯函数，返回 Err(原因) 时整文件拒绝。
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SCHEMA_VERSION {
            return Err(format!(
                "unsupported schema version {} (expected {})",
                self.schema, SCHEMA_VERSION
            ));
        }
        if self.info.id.trim().is_empty() {
            return Err("info.id must not be empty".to_string());
        }
        if self.info.display_name.trim().is_empty() {
            return Err("info.display_name must not be empty".to_string());
        }
        match self.kind {
            ManifestKind::Agent => self.validate_agent()?,
            ManifestKind::Tool => self.validate_tool()?,
        }
        if let Some(probe) = &self.probe {
            if probe.command.trim().is_empty() {
                return Err("probe.command must not be empty".to_string());
            }
            if let Some(re) = &probe.version_regex {
                regex::Regex::new(re)
                    .map_err(|e| format!("probe.version_regex is invalid: {e}"))?;
            }
        }
        Ok(())
    }

    /// kind = "tool"：[tool] 必填；agent 专属段（transport/session/
    /// capabilities/config）全部禁止；[pi_extension] 允许并存（自适应插件）。
    fn validate_tool(&self) -> Result<(), String> {
        if self.transport.is_some() {
            return Err("[transport] is only allowed for agent plugins".to_string());
        }
        if self.session.is_some() {
            return Err("[session] is only allowed for agent plugins".to_string());
        }
        if self.capabilities.is_some() {
            return Err("[capabilities] is only allowed for agent plugins".to_string());
        }
        if self.config.is_some() {
            return Err("[config] is only allowed for agent plugins".to_string());
        }
        // v0.8.1 需求10：[pi_extension] 与 [tool] 并存 = 自适应插件（合法）。
        if let Some(pi_ext) = &self.pi_extension {
            if pi_ext.entry.trim().is_empty() {
                return Err("pi_extension.entry must not be empty".to_string());
            }
        }
        // v0.9.0 需求1 P2/二期：[mcp] 段校验——按传输类型必填项检查
        //（stdio → command；http/sse → url 且 http(s) 前缀）。
        if let Some(mcp) = &self.mcp {
            match mcp.transport {
                McpTransportKind::Stdio => {
                    if mcp.command.as_deref().map(str::trim).unwrap_or("").is_empty() {
                        return Err("mcp.command must not be empty for stdio transport".to_string());
                    }
                }
                McpTransportKind::Http | McpTransportKind::Sse => {
                    let url = mcp.url.as_deref().map(str::trim).unwrap_or("");
                    if url.is_empty() {
                        return Err(format!(
                            "mcp.url must not be empty for {:?} transport",
                            mcp.transport
                        ));
                    }
                    if !url.starts_with("http://") && !url.starts_with("https://") {
                        return Err("mcp.url must start with http:// or https://".to_string());
                    }
                }
            }
        }
        // v0.9.0 需求20：[skill] 段校验（description/body 非空）。
        if let Some(skill) = &self.skill {
            if skill.description.trim().is_empty() {
                return Err("skill.description must not be empty".to_string());
            }
            if skill.body.trim().is_empty() {
                return Err("skill.body must not be empty".to_string());
            }
        }
        // v0.9.0 需求8：[panel] 段校验。
        if let Some(panel) = &self.panel {
            if panel.title.trim().is_empty() {
                return Err("panel.title must not be empty".to_string());
            }
            for (i, item) in panel.items.iter().enumerate() {
                if item.label.trim().is_empty() {
                    return Err(format!("panel.items[{i}].label must not be empty"));
                }
                if item.command.trim().is_empty() {
                    return Err(format!("panel.items[{i}].command must not be empty"));
                }
            }
        }
        let tool = match self.tool.as_ref() {
            Some(tool) => tool,
            // 仅 [pi_extension]/[mcp]/[panel]/[skill] 无 [tool]：合法（深度
            // 形态 / 纯结构化工具 / 纯面板 / 纯 skill 插件）。
            None
            if self.pi_extension.is_some()
                || self.mcp.is_some()
                || self.panel.is_some()
                || self.skill.is_some() =>
            {
                return Ok(());
            }
            None => return Err("kind = \"tool\" requires a [tool] section".to_string()),
        };
        if tool.description.trim().is_empty() {
            return Err("tool.description must not be empty".to_string());
        }
        if tool.usage.trim().is_empty() {
            return Err("tool.usage must not be empty".to_string());
        }
        Ok(())
    }

    /// kind = "agent"（缺省）：[tool] 禁止；transport 必填并按形态校验。
    fn validate_agent(&self) -> Result<(), String> {
        if self.tool.is_some() {
            return Err("[tool] is only allowed for tool plugins (kind = \"tool\")".to_string());
        }
        if self.mcp.is_some() {
            return Err("[mcp] is only allowed for tool plugins (kind = \"tool\")".to_string());
        }
        if self.panel.is_some() {
            return Err("[panel] is only allowed for tool plugins (kind = \"tool\")".to_string());
        }
        if self.skill.is_some() {
            return Err("[skill] is only allowed for tool plugins (kind = \"tool\")".to_string());
        }
        let transport = self
            .transport
            .as_ref()
            .ok_or("agent plugins require a [transport] section".to_string())?;
        match transport.kind {
            TransportKind::Cli => {
                let cmd = transport.chat_command.as_ref().ok_or(
                    "transport.kind = \"cli\" requires transport.chat_command".to_string(),
                )?;
                if cmd.is_empty() {
                    return Err("transport.chat_command must not be empty".to_string());
                }
                if transport.acp_command.is_some() {
                    return Err(
                        "transport.acp_command is only allowed when transport.kind = \"acp\""
                            .to_string(),
                    );
                }
                if transport.pipe_stdin {
                    if cmd.iter().any(|s| s.contains("{prompt}")) {
                        return Err(
                            "transport.pipe_stdin = true but chat_command contains {prompt} \
                             (prompt travels via stdin, remove it from the command)"
                                .to_string(),
                        );
                    }
                }
                for seg in cmd {
                    check_template_vars(seg)?;
                }
            }
            TransportKind::Acp => {
                let cmd = transport
                    .acp_command
                    .as_ref()
                    .ok_or("transport.kind = \"acp\" requires transport.acp_command".to_string())?;
                if cmd.is_empty() {
                    return Err("transport.acp_command must not be empty".to_string());
                }
                if transport.chat_command.is_some() {
                    return Err(
                        "transport.chat_command is only allowed when transport.kind = \"cli\""
                            .to_string(),
                    );
                }
                // ACP 会话由 runtime 全权管理（session/new、prompt、cancel），
                // 启动命令必须是静态 argv，不接受模板变量。
                for seg in cmd {
                    if TEMPLATE_VARS.iter().any(|v| seg.contains(v)) {
                        return Err(format!(
                            "transport.acp_command must not contain template variables (found in {seg:?})"
                        ));
                    }
                }
            }
        }
        if let Some(cwd) = &transport.cwd {
            check_template_vars(cwd)?;
        }
        if let Some(cfg) = &self.config {
            if cfg.surface != "raw" {
                return Err(format!(
                    "config.surface {:?} is not supported (v1 only \"raw\")",
                    cfg.surface
                ));
            }
            let path = cfg
                .path
                .as_ref()
                .ok_or("config.surface = \"raw\" requires config.path".to_string())?;
            if path.trim().is_empty() {
                return Err("config.path must not be empty".to_string());
            }
            if cfg.format != "json" && cfg.format != "toml" {
                return Err(format!(
                    "config.format {:?} is not supported (json | toml)",
                    cfg.format
                ));
            }
        }
        if let Some(abort) = &transport.abort_bytes {
            parse_abort_bytes(abort)?;
        }
        Ok(())
    }
}

/// 模板变量白名单：段内出现的 `{...}` 必须是已知变量。
fn check_template_vars(segment: &str) -> Result<(), String> {
    let mut rest = segment;
    while let Some(start) = rest.find('{') {
        let end = rest[start..]
            .find('}')
            .map(|i| start + i)
            .ok_or_else(|| format!("unbalanced '{{' in template segment {segment:?}"))?;
        let var = &rest[start..=end];
        if !TEMPLATE_VARS.contains(&var) {
            return Err(format!(
                "unknown template variable {var} in {segment:?} (allowed: {TEMPLATE_VARS:?})"
            ));
        }
        rest = &rest[end + 1..];
    }
    Ok(())
}

/// hex 字节串（如 "0x03"）解析为中止序列。
pub fn parse_abort_bytes(s: &str) -> Result<Vec<u8>, String> {
    let hex = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .ok_or_else(|| format!("abort_bytes {s:?} must be a hex string like \"0x03\""))?;
    if hex.is_empty() || hex.len() % 2 != 0 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("abort_bytes {s:?} is not a valid hex byte string"));
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// `~` 展开为用户主目录（manifest 的 config.path / cwd 支持）。
pub fn expand_tilde(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path
        .strip_prefix("~/")
        .or_else(|| if path == "~" { Some("") } else { None })
    {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_manifest() -> AgentManifestFile {
        AgentManifestFile {
            schema: 1,
            kind: Default::default(),
            info: InfoSection {
                id: "demo".to_string(),
                display_name: "Demo".to_string(),
                icon: String::new(),
                install_hint: None,
            },
            probe: None,
            transport: Some(TransportSection {
                kind: TransportKind::Cli,
                chat_command: Some(vec!["demo".to_string(), "{prompt}".to_string()]),
                acp_command: None,
                cwd: None,
                pipe_stdin: false,
                abort_bytes: None,
            }),
            config: None,
            session: None,
            capabilities: None,
            pi_extension: None,
            mcp: None,
            panel: None,
            skill: None,
            tool: None,
        }
    }

    #[test]
    fn valid_manifest_passes() {
        assert!(base_manifest().validate().is_ok());
    }

    #[test]
    fn schema_version_mismatch_rejected() {
        let mut m = base_manifest();
        m.schema = 2;
        assert!(m.validate().unwrap_err().contains("schema version"));
    }

    #[test]
    fn empty_id_rejected() {
        let mut m = base_manifest();
        m.info.id = "  ".to_string();
        assert!(m.validate().unwrap_err().contains("info.id"));
    }

    #[test]
    fn cli_without_chat_command_rejected() {
        let mut m = base_manifest();
        m.transport.as_mut().unwrap().chat_command = None;
        assert!(m
            .validate()
            .unwrap_err()
            .contains("requires transport.chat_command"));
    }

    #[test]
    fn acp_with_chat_command_rejected() {
        let mut m = base_manifest();
        m.transport.as_mut().unwrap().kind = TransportKind::Acp;
        m.transport.as_mut().unwrap().acp_command = Some(vec!["x".to_string()]);
        assert!(m
            .validate()
            .unwrap_err()
            .contains("only allowed when transport.kind"));
    }

    #[test]
    fn acp_command_with_template_var_rejected() {
        let mut m = base_manifest();
        m.transport.as_mut().unwrap().kind = TransportKind::Acp;
        m.transport.as_mut().unwrap().chat_command = None;
        m.transport.as_mut().unwrap().acp_command =
            Some(vec!["x".to_string(), "{prompt}".to_string()]);
        assert!(m.validate().unwrap_err().contains("template variables"));
    }

    #[test]
    fn pipe_stdin_with_prompt_var_rejected() {
        let mut m = base_manifest();
        m.transport.as_mut().unwrap().pipe_stdin = true;
        assert!(m.validate().unwrap_err().contains("pipe_stdin"));
    }

    #[test]
    fn unknown_template_var_rejected() {
        let mut m = base_manifest();
        m.transport.as_mut().unwrap().chat_command =
            Some(vec!["demo".to_string(), "{model}".to_string()]);
        assert!(m
            .validate()
            .unwrap_err()
            .contains("unknown template variable"));
    }

    #[test]
    fn raw_config_without_path_rejected() {
        let mut m = base_manifest();
        m.config = Some(ConfigSection {
            surface: "raw".to_string(),
            path: None,
            format: "json".to_string(),
        });
        assert!(m.validate().unwrap_err().contains("requires config.path"));
    }

    #[test]
    fn bad_config_format_rejected() {
        let mut m = base_manifest();
        m.config = Some(ConfigSection {
            surface: "raw".to_string(),
            path: Some("~/x.yaml".to_string()),
            format: "yaml".to_string(),
        });
        assert!(m.validate().unwrap_err().contains("config.format"));
    }

    #[test]
    fn bad_version_regex_rejected() {
        let mut m = base_manifest();
        m.probe = Some(ProbeSection {
            command: "demo".to_string(),
            version_args: None,
            version_regex: Some("([".to_string()),
        });
        assert!(m.validate().unwrap_err().contains("version_regex"));
    }

    #[test]
    fn bad_abort_bytes_rejected() {
        let mut m = base_manifest();
        m.transport.as_mut().unwrap().abort_bytes = Some("0x3".to_string());
        assert!(m.validate().unwrap_err().contains("abort_bytes"));
    }

    #[test]
    fn abort_bytes_parses() {
        assert_eq!(parse_abort_bytes("0x03").unwrap(), vec![0x03]);
        assert_eq!(parse_abort_bytes("0x1b0d").unwrap(), vec![0x1b, 0x0d]);
        assert!(parse_abort_bytes("03").is_err());
        assert!(parse_abort_bytes("0x0g").is_err());
    }

    #[test]
    fn tilde_expands() {
        let p = expand_tilde("~/x.json");
        assert!(p.to_string_lossy().contains("x.json"));
        assert!(!p.to_string_lossy().starts_with("~"));
        assert_eq!(expand_tilde("/abs/x"), std::path::PathBuf::from("/abs/x"));
    }

    #[test]
    fn toml_parsing_roundtrip() {
        let src = r#"
schema = 1
[info]
id = "gemini-cli"
display_name = "Gemini CLI"
[transport]
kind = "cli"
chat_command = ["gemini", "--prompt", "{prompt}"]
pipe_stdin = false
[config]
surface = "raw"
path = "~/.gemini/settings.json"
format = "json"
[session]
store = "hub"
[capabilities]
abort = true
stream_text = false
"#;
        let m: AgentManifestFile = toml::from_str(src).unwrap();
        assert!(m.validate().is_ok());
        assert_eq!(m.info.id, "gemini-cli");
        assert_eq!(m.transport.as_ref().unwrap().kind, TransportKind::Cli);
        // session 段缺省 = hub
        let m2: AgentManifestFile = toml::from_str(
            r#"
schema = 1
[info]
id = "x"
display_name = "X"
[transport]
kind = "cli"
chat_command = ["x", "{prompt}"]
"#,
        )
        .unwrap();
        assert!(m2.session.is_none());
    }

    #[test]
    fn unknown_field_rejected_by_serde() {
        let src = r#"
schema = 1
[info]
id = "x"
display_name = "X"
unknown_field = true
[transport]
kind = "cli"
chat_command = ["x", "{prompt}"]
"#;
        assert!(toml::from_str::<AgentManifestFile>(src).is_err());
    }

    #[test]
    fn tool_panel_section_validates() {
        // v0.9.0 需求8：[panel] 解析与校验（合法/空 command 拒绝/agent 禁止/panel-only 合法）。
        let mut m = base_manifest();
        m.kind = crate::agent::manifest::schema::ManifestKind::Tool;
        m.transport = None;
        m.tool = None;
        m.panel = Some(crate::agent::manifest::schema::PanelSection {
            title: "状态".to_string(),
            items: vec![crate::agent::manifest::schema::PanelItem {
                label: "版本".to_string(),
                command: "gh --version".to_string(),
            }],
        });
        assert!(m.validate().is_ok()); // panel-only 合法
        m.panel.as_mut().unwrap().items[0].command = "  ".to_string();
        assert!(m.validate().is_err());
        let mut agent_m = base_manifest();
        agent_m.panel = Some(crate::agent::manifest::schema::PanelSection {
            title: "x".to_string(),
            items: vec![],
        });
        assert!(agent_m.validate().is_err()); // agent 插件禁止 [panel]
    }

    fn mcp_tool_manifest(mcp_toml: &str) -> Result<AgentManifestFile, String> {
        let src = format!(
            r#"
schema = 1
kind = "tool"
[info]
id = "x"
display_name = "X"
{mcp_toml}
"#
        );
        let m: AgentManifestFile = toml::from_str(&src).map_err(|e| e.to_string())?;
        m.validate().map_err(|e| e.to_string()).map(|_| m)
    }

    #[test]
    fn skill_section_parse_and_validate() {
        // v0.9.0 需求20：[skill] 解析/校验（skill-only 合法；空 description/body 拒绝；agent 禁止）。
        let src = r#"
schema = 1
kind = "tool"
[info]
id = "code-review"
display_name = "Code Review"
[skill]
description = "提交前代码自查清单"
body = "逐文件检查错误处理与测试覆盖。"
"#;
        let m: AgentManifestFile = toml::from_str(src).unwrap();
        assert!(m.validate().is_ok());
        assert_eq!(m.skill.as_ref().unwrap().description, "提交前代码自查清单");

        // 空 description / 空 body → 拒绝。
        let bad = src.replace("提交前代码自查清单", "  ");
        let m: AgentManifestFile = toml::from_str(&bad).unwrap();
        assert!(m.validate().unwrap_err().contains("skill.description"));
        let bad2 = src.replace("逐文件检查错误处理与测试覆盖。", "");
        let m: AgentManifestFile = toml::from_str(&bad2).unwrap();
        assert!(m.validate().unwrap_err().contains("skill.body"));

        // agent 插件带 [skill] → 拒绝。
        let mut agent_m = base_manifest();
        agent_m.skill = Some(SkillSection {
            description: "d".into(),
            body: "b".into(),
        });
        assert!(agent_m.validate().unwrap_err().contains("[skill]"));
    }

    #[test]
    fn mcp_transport_types_parse_and_validate() {
        // v0.9.0 需求1 二期：三传输解析/校验。
        // 缺省 type = stdio（既有 toml 无损）。
        let m = mcp_tool_manifest(r#"[mcp]
command = "npx"
args = ["-y", "pkg"]
"#)
        .expect("stdio default ok");
        assert_eq!(m.mcp.as_ref().unwrap().transport, McpTransportKind::Stdio);
        // 显式 stdio。
        assert!(mcp_tool_manifest("[mcp]\ntype = \"stdio\"\ncommand = \"npx\"\n").is_ok());
        // http：url 必填 + http(s) 前缀 + headers。
        let m = mcp_tool_manifest(
            "[mcp]\ntype = \"http\"\nurl = \"https://mcp.example.com/mcp\"\nheaders = { Authorization = \"Bearer x\" }\n",
        )
        .expect("http ok");
        assert_eq!(m.mcp.as_ref().unwrap().transport, McpTransportKind::Http);
        assert!(mcp_tool_manifest("[mcp]\ntype = \"sse\"\nurl = \"http://x/sse\"\n").is_ok());
        // stdio 缺 command → 拒绝。
        assert!(mcp_tool_manifest("[mcp]\n").unwrap_err().contains("mcp.command"));
        // http 缺 url → 拒绝。
        assert!(mcp_tool_manifest("[mcp]\ntype = \"http\"\n")
            .unwrap_err()
            .contains("mcp.url"));
        // 非 http(s) 前缀 → 拒绝。
        assert!(mcp_tool_manifest("[mcp]\ntype = \"sse\"\nurl = \"ftp://x\"\n")
            .unwrap_err()
            .contains("http://"));
    }
}
