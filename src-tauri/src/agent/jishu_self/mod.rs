pub(crate) mod config;
pub(crate) mod jishu_settings;
pub mod model_picker;
pub(crate) mod paths;
pub(crate) mod pi_model;
pub(crate) mod pi_models_config;
pub(crate) mod pi_runtime;
pub(crate) mod pi_session;
mod probe;
pub(crate) mod session_title;

use crate::agent::capability::AgentCapabilities;
use crate::agent::{AgentInfo, ChatRequest, ResolvedSessionPromptInjection};
use crate::project_config::ProjectSettings;
use std::path::PathBuf;

pub struct JishuSelfAgent;

impl JishuSelfAgent {
    pub fn new() -> Self {
        Self
    }

    /// Standalone async MCP ensure — does not borrow &self, so it can be
    /// awaited without holding the AgentRegistry MutexGuard.
    /// v0.9.5 需求11（pi 1.1.0）：pi 原生 MCP client 落地，pi-mcp-adapter
    /// 扩展退役（D0 开源优先：上游原生覆盖桥接层）——本方法改为「确保
    /// pi 用户级 mcp.json 的 jishu-hub 条目 + 清理 adapter 残留」。
    pub async fn install_mcp_standalone() -> Result<String, String> {
        Self::ensure_native_mcp_entry().await
    }

    /// pi-mcp-adapter（已退役）安装位置残留检测——pi install npm:pkg 落
    /// `<config_dir>/npm/node_modules/<pkg>`，与 check_mcp 的
    /// adapter_residual 同口径（存在即需 cleanup_retired_adapter 清理）。
    pub(crate) fn mcp_adapter_dir() -> Option<std::path::PathBuf> {
        pi_config_dir().map(|dir| {
            std::path::Path::new(&dir)
                .join("npm")
                .join("node_modules")
                .join("pi-mcp-adapter")
        })
    }

    /// v0.9.5 需求11：pi 原生 MCP 接入自愈（幂等）——hub 安装期/启动后台
    /// 共用：①确保 `~/.jishu-agent/agent/mcp.json`（pi 原生用户级位，
    /// configDir 下）有 jishu-hub 条目（command=jishu-cli, args=[mcp,serve]，
    /// 与其他三家同构）；②清理退役 adapter 残留（settings.json packages
    /// 条目 + npm/node_modules 目录）——残留的 `/mcp` 命令会压制 pi 内置
    /// builtin:mcp 扩展（实测 pi 1.1.0 警告二选一）。纯文件操作，离线可用。
    /// 返回描述性消息（changed=true 表示本次有变更）。
    pub async fn ensure_native_mcp_entry() -> Result<String, String> {
        let mut changed = false;
        // ① mcp.json 条目（键级，不动用户其它 server 条目）
        match Self::upsert_native_hub_entry() {
            Ok(c) => changed |= c,
            Err(e) => return Err(format!("ensure mcp.json entry failed: {e}")),
        }
        // ② adapter 残留清理
        match Self::cleanup_retired_adapter() {
            Ok(c) => changed |= c,
            Err(e) => log::warn!("[mcp-native] adapter cleanup deferred: {e}"),
        }
        Ok(if changed {
            "pi 原生 MCP 接入已就绪（jishu-hub 条目写入 + adapter 残留清理）".to_string()
        } else {
            "pi 原生 MCP 接入已就绪（无需变更）".to_string()
        })
    }

    /// mcp.json 键级 upsert jishu-hub 条目；返回是否有变更。
    fn upsert_native_hub_entry() -> Result<bool, String> {
        use serde_json::json;
        let path = crate::agent::jishu_self::paths::mcp_json_path().map_err(|e| e.to_string())?;
        let cli = crate::agent::jishu_self::resolve_jishu_cli_binary()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let desired = json!({
            "command": cli,
            "args": ["mcp", "serve"],
            // 需求11 追加四：pi 1.1.0 原生 MCP 默认 exposure=codemode（工具
            // 不进模型 schema——识图话术的 hub_mcp_list 无调用入口，P0 切换
            // 时漏验的可见性盲区）。toolExposure 放行两个代理工具为 direct：
            // hub_mcp_list（发现）/ hub_mcp_call（代理调用）进 schema，其余
            // 工具维持 codemode（不全量注入，context 增量最小）。
            "toolExposure": {
                "hub_mcp_list": "direct",
                "hub_mcp_call": "direct",
            },
        });
        let mut root: serde_json::Value = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|c| serde_json::from_str(&c).ok())
                .unwrap_or_else(|| json!({"mcpServers": {}}))
        } else {
            json!({"mcpServers": {}})
        };
        if !root
            .get("mcpServers")
            .map(|v| v.is_object())
            .unwrap_or(false)
        {
            root["mcpServers"] = json!({});
        }
        let existing = root
            .get("mcpServers")
            .and_then(|s| s.get(crate::agent::mcp_server::HUB_MCP_ENTRY_NAME));
        // 需求11 追加四：就绪判定含 toolExposure——旧条目（无 direct 放行）
        // 须重写补齐（识图路径修复的存量迁移）；command 路径随安装位置变化
        // 不作比对（args 形态一致 + command 存在 + toolExposure 含两工具即就绪）。
        let tool_exposure_ok = existing
            .and_then(|e| e.get("toolExposure"))
            .and_then(|t| {
                Some(
                    t.get("hub_mcp_list").and_then(|v| v.as_str()) == Some("direct")
                        && t.get("hub_mcp_call").and_then(|v| v.as_str()) == Some("direct"),
                )
            })
            .unwrap_or(false);
        let matches = existing
            .and_then(|e| e.get("args"))
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>() == ["mcp", "serve"]
                    && existing
                        .and_then(|e| e.get("command"))
                        .and_then(|c| c.as_str())
                        .is_some_and(|c| !c.is_empty())
                    && tool_exposure_ok
            })
            .unwrap_or(false);
        if matches {
            return Ok(false);
        }
        root["mcpServers"][crate::agent::mcp_server::HUB_MCP_ENTRY_NAME] = desired;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        crate::util::atomic_write(
            &path,
            serde_json::to_string_pretty(&root).unwrap().as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        log::info!(
            "[mcp-native] upserted jishu-hub entry in {}",
            path.display()
        );
        Ok(true)
    }

    /// 退役 adapter 残留清理：settings.json packages 数组摘 npm:pi-mcp-adapter*
    /// 条目 + 删 npm/node_modules/pi-mcp-adapter 目录。返回是否有变更。
    fn cleanup_retired_adapter() -> Result<bool, String> {
        let mut changed = false;
        let Some(agent_dir) = crate::agent::jishu_self::paths::agent_dir().ok() else {
            return Err("cannot resolve agent dir".to_string());
        };
        let settings_path = agent_dir.join("settings.json");
        if let Ok(content) = std::fs::read_to_string(&settings_path) {
            if let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(pkgs) = settings.get_mut("packages").and_then(|v| v.as_array_mut()) {
                    let before = pkgs.len();
                    pkgs.retain(|v| {
                        !v.as_str()
                            .map(|s| {
                                s == "npm:pi-mcp-adapter" || s.starts_with("npm:pi-mcp-adapter@")
                            })
                            .unwrap_or(false)
                    });
                    if pkgs.len() != before {
                        crate::util::atomic_write(
                            &settings_path,
                            serde_json::to_string_pretty(&settings)
                                .unwrap_or_default()
                                .as_bytes(),
                        )
                        .map_err(|e| e.to_string())?;
                        changed = true;
                        log::info!("[mcp-native] removed retired adapter from settings packages");
                    }
                }
            }
        }
        let npm_dir = agent_dir
            .join("npm")
            .join("node_modules")
            .join("pi-mcp-adapter");
        if npm_dir.is_dir() {
            std::fs::remove_dir_all(&npm_dir).map_err(|e| format!("remove adapter dir: {e}"))?;
            changed = true;
            log::info!(
                "[mcp-native] removed retired adapter dir {}",
                npm_dir.display()
            );
        }
        Ok(changed)
    }

    async fn run_pi_package_command(action: &str, source: &str) -> Result<String, String> {
        let runtime = pi_runtime::resolve_pi_runtime()
            .map_err(|e| format!("Failed to resolve Pi runtime: {e}"))?;

        let args = pi_package_args(&runtime.base_args, action, source);

        let mut cmd =
            crate::os_adapter::shell::shell_command(&runtime.program.to_string_lossy(), args);
        cmd.current_dir(std::env::current_dir().unwrap_or_default());

        #[cfg(target_os = "windows")]
        crate::process_command::tokio_no_window(&mut cmd);

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run pi {action} {source}: {e}"))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(format!(
                "pi {action} {source} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    /// v0.9.5 需求5：4 个 pi 扩展包逐个幂等安装（缺哪个装哪个；单包失败
    /// 记 warn 继续下一个，Err 汇总失败清单——启动自愈下轮重试，不阻断
    /// hub 启动）。探测与 mcp 同口径（node_modules 目录名含 scoped 包的
    /// @scope/ 层级）且**校验版本**：pi resolve 对「已注册但版本不匹配」
    /// 的包判 needsInstall，PI_OFFLINE 下静默跳过 → 扩展整个不装载——故
    /// 装了旧版本也必须重装到钉定版本。
    pub async fn ensure_pi_extensions_installed() -> Result<Vec<&'static str>, String> {
        let Some(base) = pi_config_dir() else {
            return Err("cannot resolve ~/.jishu-agent/agent directory".to_string());
        };
        let root = std::path::Path::new(&base).join("npm").join("node_modules");
        let mut installed: Vec<&'static str> = Vec::new();
        let mut failed: Vec<String> = Vec::new();
        for (source, dir_name) in PI_EXTENSION_PACKAGES {
            let target = root.join(dir_name);
            let pinned_ver = source.rsplit_once('@').map(|(_, v)| v).unwrap_or_default();
            let up_to_date = target.exists()
                && std::fs::read_to_string(target.join("package.json"))
                    .ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .and_then(|p| {
                        p.get("version")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                    })
                    .is_some_and(|v| v == pinned_ver);
            if up_to_date {
                continue;
            }
            match Self::run_pi_package_command("install", source).await {
                Ok(_) => {
                    log::info!("[pi-ext] installed {source}");
                    installed.push(source);
                }
                Err(e) => {
                    log::warn!("[pi-ext] install {source} deferred: {e}");
                    failed.push(format!("{source}: {e}"));
                }
            }
        }
        if failed.is_empty() {
            Ok(installed)
        } else {
            Err(failed.join("; "))
        }
    }

    /// v0.9.5 需求5：npm 包名 → 钉定安装源——packages
    /// 注册同步（plugin::sync_pi_packages_with_plugins）复用同一真源。
    /// v0.9.5 需求11：pi-mcp-adapter 已退役（pi 1.1.0 原生 MCP），不再安装。
    pub(crate) fn pinned_source_for_package(name: &str) -> Option<&'static str> {
        PI_EXTENSION_PACKAGES
            .iter()
            .find(|(_, dir)| *dir == name)
            .map(|(source, _)| *source)
    }
}

pub(crate) fn pi_agent_dir() -> Option<String> {
    paths::agent_root()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

/// pi 运行数据目录（models.json/settings.json/sessions/extensions 等）。
/// pi 原生 getAgentDir() = ~/{piConfig.configDir}/agent = ~/.jishu-agent/agent。
/// hub 端读写 pi 数据必须用此路径与 pi 对齐（agent 本体仍用 pi_agent_dir）。
pub(crate) fn pi_config_dir() -> Option<String> {
    paths::agent_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

pub(crate) const JISHU_AGENT_IDENTITY_PROMPT: &str =
    "You are jishu agent, the built-in assistant inside Jishu Hub. \
You are not Pi. Use Pi's runtime, tools, and session engine invisibly, \
but present yourself as jishu agent. Reply naturally in the user's language. \
When replying in Chinese, your name is 「机枢 agent」(机枢); \
never transliterate jishu as 「极数」 or anything else. Before delegating via the subagent tool, always call it first with {\"action\":\"list\",\"capabilities\":true} and pick the agent strictly from the returned list — never guess agent names from prior habits. When you track work with the todo tool and multiple independent todos (no blockedBy between them) are pending, you may dispatch several subagent calls in the same turn to work on them in parallel instead of finishing them one by one. \
\
CAPABILITY DISCOVERY: When a user asks you to do something you cannot fulfill \
with your current tools alone, do NOT simply reply \"I can't\". Instead, follow \
this progressive discovery: \
(1) Check if an existing plugin already provides this capability (read \
jishu-hub-capabilities SKILL.md for the capability map). \
(2) If no existing capability matches, consider: can a PLUGIN be created to \
fulfill this? Jishu Hub's entire client is plugin-based — themes, chart \
renderers, panels, agents, tools, workflows are ALL plugins. Read \
jishu-plugin-authoring SKILL.md to understand what plugin forms exist and \
which template to use. \
(3) Create the plugin (copy the template, fill in specifics), install it via \
jishu-cli plugins add/add-hybrid, and tell the user to confirm in the hub GUI. \
This applies to ANY unfulfillable request: making PPTs, sending DingTalk \
requests, custom themes, new chart types, connecting new AI agents, building \
dashboards — if you can describe it, you can probably build it as a plugin.";

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
pub const PI_AGENT_VERSION: &str = "1.1.0-13";
// JISHU_AGENT_VERSION_END

impl AgentManifest for JishuSelfAgent {
    fn config_dir(&self) -> Option<std::path::PathBuf> {
        crate::agent::jishu_self::paths::agent_dir().ok()
    }

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
            // v0.7.4 需求1 B4：常规会话删除（Pi 会话 JSONL + 交互 sidecar）。
            | AgentCapabilities::SESSION_DELETE
            // v0.8.0 需求1 A5：会话分支（Pi 原生 clone RPC，从当前末尾复制整棵
            // 会话树；runtime 侧 AcpCommand::ForkSession 实现）。
            | AgentCapabilities::SESSION_FORK
            // v0.7.4 需求1 A3：手动 + 自动上下文压缩（Pi 原生 compact RPC）。
            | AgentCapabilities::CONTEXT_COMPACT
            // v0.7.4 需求3 M2：任务工作模式（任务图编排会话）。
            | AgentCapabilities::TASK_MODE
            // v0.8.0 需求1 P-2：逐次工具审批——fork 内置 jishu-tool-approval
            // 扩展经 beforeToolCall 阻塞/放行（APPROVAL_REQUEST 声明审批事件
            // 通道；PRE_EXECUTION_INTERCEPTION 自 v0.7.x 定义以来首次被真实
            // 声明）。
            | AgentCapabilities::APPROVAL_REQUEST
            | AgentCapabilities::PRE_EXECUTION_INTERCEPTION
    }

    fn is_builtin(&self) -> bool {
        // v0.7.4 需求3 M1：内建 agent——随 hub 分发/升级，环境检测置顶展示，
        // 并作为任务模式引擎。共享层按此标志分支，不写死 agent id。
        true
    }

    fn thinking_levels(&self) -> Vec<String> {
        // Pi 全集七档（EXTENDED_THINKING_LEVELS）；Pi 按当前模型 clamp 并
        // 经 thinking_level_changed 事件回传生效值（v0.7.4 需求1 A7）。
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
            .into_iter()
            .map(str::to_string)
            .collect()
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

    fn available_version(&self) -> Option<String> {
        Some(PI_AGENT_VERSION.to_string())
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

    fn project_settings_surface(&self) -> crate::agent::ProjectSettingsSurface {
        // v0.7.4 项目配置适配 + v0.7.5 路径修正：Pi 原生项目级设置
        // <project>/.jishu-agent/settings.json（fork configDir；深合并覆盖全局）。
        // 真实字段为 defaultModel / defaultThinkingLevel / compaction；
        // permissions/env/hooks 不在 Pi Settings schema 中（不声明即不渲染）。
        crate::agent::ProjectSettingsSurface::Supported {
            scopes: vec![crate::agent::ProjectSettingsScope::Shared],
            access_modes: Vec::new(),
            fields: vec![
                "model".to_string(),
                "thinking_level".to_string(),
                "compaction".to_string(),
            ],
        }
    }

    fn load_project_settings(&self, path: &str) -> Result<ProjectSettings, String> {
        // Pi 原生项目设置 .jishu-agent/settings.json（v0.7.4 项目配置适配：
        // 此前误用 claude 的 .claude/settings.json 读写；v0.7.5 修正目录名
        // ——fork configDir 为 .jishu-agent 而非上游 .pi，不留兼容）。
        // 仅映射真实存在的字段：
        // defaultModel → model、defaultThinkingLevel → thinkingLevel。
        let raw = config::load_pi_project_settings_raw(path).map_err(|e| e.to_string())?;
        // Pi 按 (defaultProvider, defaultModel) 二元组解析——拼回 "provider/model"。
        let model = match (
            raw.get("defaultProvider").and_then(|v| v.as_str()),
            raw.get("defaultModel").and_then(|v| v.as_str()),
        ) {
            (Some(p), Some(m)) if !m.is_empty() => Some(format!("{p}/{m}")),
            _ => None,
        };
        let compaction = raw
            .get("compaction")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        Ok(ProjectSettings {
            permissions: None,
            hooks: None,
            env: None,
            model,
            thinking_level: raw
                .get("defaultThinkingLevel")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            compaction,
        })
    }

    fn load_project_settings_local(&self, _path: &str) -> Result<ProjectSettings, String> {
        // Pi 项目设置只有 shared 一档（无 settings.local.json）。
        Err(
            "Pi project settings support only the shared scope (.jishu-agent/settings.json)"
                .to_string(),
        )
    }

    fn save_project_settings(&self, path: &str, settings: &ProjectSettings) -> Result<(), String> {
        config::save_pi_project_settings_fields(
            path,
            settings.model.as_deref(),
            settings.thinking_level.as_deref(),
            settings.compaction.as_ref(),
        )
        .map_err(|e| e.to_string())
    }

    fn save_project_settings_local(
        &self,
        _path: &str,
        _settings: &ProjectSettings,
    ) -> Result<(), String> {
        Err(
            "Pi project settings support only the shared scope (.jishu-agent/settings.json)"
                .to_string(),
        )
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
    fn jishu_agent_disables_user_message_session_injection() {
        // session_id 改由 session-context 扩展注入 system prompt，user message 注入下线。
        assert!(JishuSelfAgent::new()
            .resolved_session_prompt_injection()
            .is_none());
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

    fn persist_interaction_blocks(
        &self,
        _session_path: Option<&str>,
        session_id: Option<&str>,
        _encoded_name: Option<&str>,
        interactions: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        let session_id = session_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Pi interaction persistence requires a session id".to_string())?;
        pi_session::persist_pi_interaction_blocks(session_id, interactions)
    }

    fn load_history(&self) -> Vec<crate::history::HistoryEntry> {
        Vec::new()
    }

    fn delete_session(&self, session_id: &str, encoded_name: &str) -> Result<(), String> {
        pi_session::delete_pi_session(session_id, encoded_name)
    }
}

impl ConfigAdapter for JishuSelfAgent {
    fn permission_modes(&self) -> Option<(Vec<String>, crate::agent::PermissionModeProvider)> {
        // P-1：工具模式由 Hub 全局管理；readonly 在 PiRpc spawn 时落 --tools 白名单
        // （read,grep,find,ls —— pi 内置工具全集去掉 bash/edit/write）。
        // v0.8.0 需求1 P-2 收尾（用户裁决融入会话工具模式）：新增 full-approve
        // 档 = full 工具集 + 逐次审批（toolApproval=smart 写 Pi settings），
        // 与完整/只读同列选择；full 档写 toolApproval=off（原行为）。
        Some((
            vec![
                "full".to_string(),
                "full-approve".to_string(),
                "smart-approve".to_string(),
                "readonly".to_string(),
            ],
            crate::agent::PermissionModeProvider::HubToolMode,
        ))
    }

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
        // v0.7.5 需求6：模版按使用场景区分（模型 + 行为与权限全量），全部
        // requires_fill + model_store_patch——应用时选服务商预设/填密钥/勾模型，
        // 渠道合并写 models.json（现有渠道保留），行为字段写 settings.json。
        // 旧的三个纯思考档位模版（R15 产物，单键无法形成可用配置）已移除。
        vec![
            crate::hub::ConfigTemplate {
                requires_fill: true,
                id: "jishu-daily-dev".into(),
                name: "日常开发".into(),
                description: "日常编码与迭代的均衡配置：高档思考、默认工具集（读写/终端/编辑）、\
                              标准自动重试、常规上下文压缩。适合大多数开发任务，速度与质量平衡。"
                    .into(),
                config: serde_json::json!({
                    "defaultThinkingLevel": "high",
                    "compaction": { "enabled": true, "thresholdPercent": 95, "keepRecentTokens": 20000 },
                    "defaultTools": template_default_tools(&[]),
                    "retry": { "enabled": true, "maxRetries": 10, "baseDelayMs": 2000 }
                }),
                model_store_patch: Some(serde_json::json!({ "providers": {} })),
            },
            crate::hub::ConfigTemplate {
                requires_fill: true,
                id: "jishu-deep-dive".into(),
                name: "深度攻坚".into(),
                description:
                    "疑难问题与大型重构：最大档思考、全部内置工具（含内容搜索/文件查找/列目录）、\
                              更强重试与更大上下文保留，长会话不丢关键信息。耗时与 token 消耗最高。"
                        .into(),
                config: serde_json::json!({
                    "defaultThinkingLevel": "max",
                    "compaction": { "enabled": true, "thresholdPercent": 95, "keepRecentTokens": 40000 },
                    "defaultTools": template_default_tools(&["grep", "find", "ls"]),
                    "retry": { "enabled": true, "maxRetries": 10, "baseDelayMs": 2000 }
                }),
                model_store_patch: Some(serde_json::json!({ "providers": {} })),
            },
            crate::hub::ConfigTemplate {
                requires_fill: true,
                id: "jishu-quick-qa".into(),
                name: "快速问答".into(),
                description: "简单问题与轻量任务：低档思考几乎即问即答、默认工具集、标准重试。\
                              响应最快、消耗最低，适合答疑、查询、小改动确认。"
                    .into(),
                config: serde_json::json!({
                    "defaultThinkingLevel": "low",
                    "compaction": { "enabled": true, "thresholdPercent": 95, "keepRecentTokens": 20000 },
                    "defaultTools": template_default_tools(&[]),
                    "retry": { "enabled": true, "maxRetries": 10, "baseDelayMs": 2000 }
                }),
                model_store_patch: Some(serde_json::json!({ "providers": {} })),
            },
        ]
    }
    fn as_raw_config(&self) -> Option<&dyn crate::agent::config_roles::RawConfigStore> {
        Some(self)
    }

    fn as_backup_store(&self) -> Option<&dyn crate::agent::config_roles::ConfigBackupStore> {
        Some(self)
    }

    fn as_model_store(&self) -> Option<&dyn crate::agent::config_roles::ModelStore> {
        Some(self)
    }

    fn as_mcp(&self) -> Option<&dyn crate::agent::config_roles::McpIntegration> {
        Some(self)
    }
}

impl crate::agent::config_roles::RawConfigStore for JishuSelfAgent {
    fn config_format(&self) -> Option<String> {
        Some("json".to_string())
    }

    fn load_raw_config(&self) -> Result<String, String> {
        config::load_raw_jishu_config().map_err(|e| e.to_string())
    }

    fn save_raw_config(&self, content: &str) -> Result<(), String> {
        config::save_raw_jishu_config(content).map_err(|e| e.to_string())
    }
}

impl crate::agent::config_roles::ConfigBackupStore for JishuSelfAgent {
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
}

impl crate::agent::config_roles::ModelStore for JishuSelfAgent {
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
}

impl crate::agent::config_roles::McpIntegration for JishuSelfAgent {
    fn check_mcp(&self) -> Result<serde_json::Value, String> {
        // v0.9.5 需求11（pi 1.1.0）：adapter 退役后检查 = pi 原生 mcp.json 的
        // jishu-hub 条目 + adapter 残留状态（残留会压制 builtin:mcp，须清理）。
        let entry_ok = crate::agent::jishu_self::paths::mcp_json_path()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|root| {
                root.get("mcpServers")?
                    .get(crate::agent::mcp_server::HUB_MCP_ENTRY_NAME)?
                    .get("args")?
                    .as_array()
                    .map(|a| {
                        a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>() == ["mcp", "serve"]
                    })
            })
            .unwrap_or(false);
        let adapter_residual = Self::mcp_adapter_dir().map(|d| d.exists()).unwrap_or(false);
        Ok(serde_json::json!({
            "native": entry_ok,
            "adapter_residual": adapter_residual,
            // 兼容旧 UI 字段：installed 语义 = 原生接入就绪
            "installed": entry_ok && !adapter_residual,
            "version": null,
        }))
    }

    fn install_mcp(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
    {
        Box::pin(async { Self::install_mcp_standalone().await })
    }

    fn update_mcp(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
    {
        // v0.9.5 需求11：adapter 退役后无包可更新——update 复用 ensure 幂等
        // （条目/残留状态归位）。
        Box::pin(async { Self::ensure_native_mcp_entry().await })
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

/// v0.9.1 需求3 #3：配置模板的 defaultTools 集合——基础集 + 场景附加项，
/// Windows 下追加 pi 可选原生 powershell 工具（与 bash 并存，pi
/// docs/windows.md 的对比用法；`!`/`!!` 编辑器命令仍走 bash）。编译期平台
/// 隔离，非 Windows 产物不含该工具名。
fn template_default_tools(extra: &[&'static str]) -> Vec<&'static str> {
    let mut tools: Vec<&'static str> = vec!["read", "bash", "edit", "write"];
    tools.extend_from_slice(extra);
    if cfg!(windows) {
        tools.push("powershell");
    }
    tools
}

/// v0.9.1 需求13：settings 未配置 defaultTools 时向 spawn 参数追加
/// `--tools <全集>`（Windows 含 powershell）。纯函数可单测。
fn ensure_default_tools_arg(
    args: &mut Vec<String>,
    cfg: &Result<serde_json::Value, Box<dyn std::error::Error>>,
    pi_extension_tools: &[String],
) {
    // v0.9.2 需求7：扩展工具按"插件已启用"聚合注入（热插拔闸门，见
    // plugin::enabled_pi_extension_tools）。pi 的 --tools 是硬白名单——不在
    // 名单的扩展工具连 conductor 阶段 setActiveTools 也救不回（测试期实证），
    // 故必须显式进名单。
    let unset = cfg
        .as_ref()
        .ok()
        .map(|c| c.get("defaultTools").is_none())
        .unwrap_or(true);
    if unset {
        let mut tools: Vec<String> = template_default_tools(&[])
            .iter()
            .map(|s| s.to_string())
            .collect();
        tools.extend_from_slice(pi_extension_tools);
        // 需求11 追加四三轮：追加 MCP 通配模式——pi 1.1.0 的 --tools 绝对
        // 名单会把 direct 暴露的 MCP 工具滤出 schema（实测复现：名单无此
        // 模式时模型无 mcp__ 工具）；mcp__* 通配只放行已 direct 的工具
        //（codemode 的不进 schema），随 toolExposure 配置自适应。
        tools.push("mcp__*".to_string());
        args.push("--tools".to_string());
        args.push(tools.join(","));
        return;
    }
    // 已配置 defaultTools 的用户：配置清单原样生效，仅追加已启用扩展工具。
    if let Some(list) = cfg
        .as_ref()
        .ok()
        .and_then(|c| c.get("defaultTools"))
        .and_then(|v| v.as_array())
    {
        let mut names: Vec<String> = list
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        for tool in pi_extension_tools {
            if !names.iter().any(|n| n == tool) {
                names.push(tool.to_string());
            }
        }
        // 同上（需求11 追加四三轮）：已配置清单同样追加 MCP 通配。
        if !names.iter().any(|n| n == "mcp__*") {
            names.push("mcp__*".to_string());
        }
        args.push("--tools".to_string());
        args.push(names.join(","));
    }
}

/// （v0.9.5 需求11 退役留痕）pi-mcp-adapter 最后钉定源——pi 1.1.0 原生
/// MCP client 落地后 adapter 扩展退役（D0 开源优先：上游原生覆盖桥接层；
/// 其 /mcp 命令会压制 pi 内置 builtin:mcp）。仅存留作历史参考与测试
/// 断言素材，不再用于安装/更新；残留清理见 ensure_native_mcp_entry。
#[allow(dead_code)] // 仅测试模块引用（退役留痕，非生产路径）
pub(crate) const MCP_ADAPTER_SOURCE: &str = "npm:pi-mcp-adapter@2.32.1";

/// v0.9.5 需求5：随包初始化安装的 pi 扩展（钉定版本，与 mcp 同策略——
/// 可预测、离线可复现；peer 面已核 fork 0.87.1-13 全覆盖）。元素 =
/// (npm 安装源, node_modules 目录名——scoped 包含 @scope/ 层级)。
/// 版本依据 2026-09-27 npm 元数据；升级走此处改钉 + update 命令。
pub(crate) const PI_EXTENSION_PACKAGES: &[(&str, &str)] = &[
    // 子代理委派（subagent/bg_wait 工具；替换自研 jishu-subagent.ts）
    ("npm:pi-subagents@0.72.0", "pi-subagents"),
    // 选项式提问（ask_user_question 工具；替换自研 request-user-input.ts）
    (
        "npm:@juicesharp/rpiv-ask-user-question@2.11.0",
        "@juicesharp/rpiv-ask-user-question",
    ),
    // 待办清单（todo 工具）
    ("npm:@juicesharp/rpiv-todo@2.11.0", "@juicesharp/rpiv-todo"),
    // 写后诊断（lens_diagnostics/ast_grep_*/lsp_navigation 等 13 工具）
    ("npm:pi-lens@4.3.0", "pi-lens"),
    // Web 搜索/抓取（web_enable 装载器 + web_search/fetch_content 等 4 件，
    // 亦补齐 pi-subagents 内置 researcher 角色的工具依赖——T7 诊断后用户
    // 裁决默认安装，2026-09-27）
    ("npm:pi-web-access@0.32.0", "pi-web-access"),
];

/// pi 包管理命令行参数（install/update <source>）——mcp 与 4 扩展共用。
fn pi_package_args(base_args: &[String], action: &str, source: &str) -> Vec<String> {
    let mut args = base_args.to_vec();
    args.push(action.to_string());
    args.push(source.to_string());
    args
}

/// v0.9.1 需求12 补充：从 settings.json Value 提取 hubSpawnEnv 环境变量
/// 覆盖（键值均须字符串；空值合法——如 PI_OFFLINE="" 置空关闭）。纯函数
/// 可单测。
fn spawn_env_overrides(
    cfg: &Result<serde_json::Value, Box<dyn std::error::Error>>,
) -> Vec<(String, String)> {
    let Ok(v) = cfg else {
        return Vec::new();
    };
    v.get("hubSpawnEnv")
        .and_then(|m| m.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod mcp_tests {
    use super::{pi_package_args, PI_EXTENSION_PACKAGES};

    /// v0.9.1 需求13：未配置 defaultTools → 追加 --tools 全集；已配置 → 不动。
    #[test]
    fn default_tools_spawn_arg_only_when_unset() {
        use serde_json::json;
        let mut args = vec!["--mode".to_string(), "rpc".to_string()];
        let ext = vec![
            "request_user_input".to_string(),
            "lock_requirement".to_string(),
        ];
        super::ensure_default_tools_arg(&mut args, &Ok(json!({})), &ext);
        assert_eq!(args[2], "--tools");
        assert!(args[3].starts_with("read,bash,edit,write"));
        // v0.9.2 需求7：聚合的扩展工具随默认集注入（热插拔闸门的下游）
        for tool in &ext {
            assert!(args[3].split(',').any(|t| t == tool), "missing {tool}");
        }

        let mut args2 = vec!["--mode".to_string(), "rpc".to_string()];
        super::ensure_default_tools_arg(&mut args2, &Ok(json!({"defaultTools": ["read"]})), &ext);
        // 已配置清单照常生效，追加已启用扩展工具 + MCP 通配（需求11 三轮）
        assert_eq!(args2[2], "--tools");
        assert_eq!(args2[3], "read,request_user_input,lock_requirement,mcp__*");

        let mut args3 = vec![];
        super::ensure_default_tools_arg(&mut args3, &Err("io".into()), &ext);
        assert_eq!(args3.len(), 2, "读失败按未配置处理");
    }

    /// v0.9.1 需求12 补充：hubSpawnEnv 提取——字符串键值对；非字符串值跳过；
    /// 空值合法（置空覆盖）；缺键/读失败 → 空。
    #[test]
    fn spawn_env_overrides_extracts_string_pairs() {
        use serde_json::json;
        let cfg = Ok(json!({
            "defaultThinkingLevel": "high",
            "hubSpawnEnv": {
                "HTTP_PROXY": "http://127.0.0.1:7890",
                "PI_OFFLINE": "",
                "BAD": 123,
            }
        }));
        let mut envs = super::spawn_env_overrides(&cfg);
        envs.sort();
        assert_eq!(
            envs,
            vec![
                (
                    "HTTP_PROXY".to_string(),
                    "http://127.0.0.1:7890".to_string()
                ),
                ("PI_OFFLINE".to_string(), String::new()),
            ]
        );
        // 无键 / Err → 空。
        assert!(super::spawn_env_overrides(&Ok(json!({}))).is_empty());
        assert!(super::spawn_env_overrides(&Err("io".into())).is_empty());
    }

    #[test]
    fn mcp_update_uses_pi_single_package_update_command() {
        // （历史断言保留）退役前 adapter 包命令构造；退役后此参数构造仍被
        // 其余 4 个 pi 扩展包的 update 路径复用（ensure_pi_extensions_installed）。
        assert_eq!(
            pi_package_args(&["cli.js".to_string()], "update", super::MCP_ADAPTER_SOURCE),
            vec!["cli.js", "update", "npm:pi-mcp-adapter@2.32.1"]
        );
    }

    /// v0.9.5 需求5：4 扩展钉定源与目录名对齐（安装探测落点 = node_modules/
    /// <目录名>；scoped 包目录名含 @scope/ 层级），且源均为 npm: 带精确版本。
    #[test]
    fn pi_extension_packages_pinned_and_scoped_dirs() {
        assert_eq!(PI_EXTENSION_PACKAGES.len(), 5);
        for (source, dir) in PI_EXTENSION_PACKAGES {
            assert!(source.starts_with("npm:"), "{source} 非 npm 源");
            let name = source
                .strip_prefix("npm:")
                .and_then(|s| s.rsplit_once('@'))
                .map(|(n, ver)| {
                    assert!(
                        ver.chars().all(|c| c.is_ascii_digit() || c == '.'),
                        "{source} 版本非精确钉定"
                    );
                    n
                })
                .unwrap();
            assert_eq!(name, *dir, "{source} 与目录名 {dir} 不一致");
        }
        // 包名 → 钉定源反查（packages 同步真源）：4 扩展 + web 共 5 项
        //（pi-mcp-adapter 已随 pi 1.1.0 原生 MCP 退役——需求11，不再安装）。
        for name in [
            "pi-subagents",
            "@juicesharp/rpiv-ask-user-question",
            "@juicesharp/rpiv-todo",
            "pi-lens",
            "pi-web-access",
        ] {
            assert!(
                super::JishuSelfAgent::pinned_source_for_package(name).is_some(),
                "{name} 无钉定源"
            );
        }
        assert!(
            super::JishuSelfAgent::pinned_source_for_package("pi-mcp-adapter").is_none(),
            "退役包不得再有钉定源"
        );
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
        // P-1（需求2）：只读工具模式 —— Hub 全局设置为 readonly 时追加 Pi 的
        // --tools 白名单（内置全集 read/bash/edit/write/grep/find/ls 去掉
        // bash/edit/write）。工具名与语义是 Pi 私有知识，属于 adapter 职责；
        // 对此后新 spawn 的进程生效（Pi 每条消息一个进程）。
        // v0.9.2 需求7：扩展工具按启用插件聚合（热插拔）。
        let pi_extension_tools = crate::agent::plugin::enabled_pi_extension_tools();
        if let Some("readonly") = crate::hub::load_agent_tool_mode("jishu-self").as_deref() {
            // 只读模式保留交互与任务提交类扩展工具（问答纯交互；
            // lock/commit 为工作流操作，任务流须可用）。
            let mut tools: Vec<String> = ["read", "grep", "find", "ls"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            tools.extend_from_slice(&pi_extension_tools);
            args.push("--tools".to_string());
            args.push(tools.join(","));
            // v0.9.5 需求11：pi 1.0.4 起 --tools 白名单不再滤出 MCP 工具
            //（04b97ef00）——只读档需显式 --no-mcp 保持「无外部工具」原语义
            //（MCP 工具良菱不齐，变更类工具不应进只读会话）。
            args.push("--no-mcp".to_string());
        }
        // full-approve 与 full 工具集相同，差异只在 toolApproval 审批
        // 开关（set_agent_tool_mode 已联动写入 Pi settings）。
        // v0.9.1 需求13：初始工具集默认=全部工具集——settings 未配置
        // defaultTools 时 spawn 显式传全集（Windows 含 powershell），消除
        // pi 回退仅四件的歧义（存量未配置用户无需改配置即生效）；已配置
        // 任何清单按配置生效。
        ensure_default_tools_arg(&mut args, &config::load_jishu_config(), &pi_extension_tools);
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
        // v0.9.5 需求2：节点/委派模型覆盖（ChatRequest.model_override）——
        // 优先于全局 active；签名机制天然区分（不同模型=独立进程）。
        args.extend(pi_model::build_pi_model_args_with_override(
            req.model_override.as_ref(),
        )?);

        let mut envs = Vec::new();
        envs.push(("PI_SKIP_VERSION_CHECK".to_string(), "1".to_string()));
        // v0.9.1 需求3 #6：关闭 pi 启动期网络操作（版本检查/包管理器/模型目录
        // 网络刷新——model-runtime 的 modelNetworkEnabled）。hub 自管模型库与
        // 版本分发，这些网络操作纯浪费且离线时拖慢 spawn；该 flag 不门控对话
        // 期的 provider HTTP 请求。
        envs.push(("PI_OFFLINE".to_string(), "1".to_string()));

        // Always resolve the CLI explicitly for spawned Pi processes. Debug
        // resolves to target/debug/jishu-cli(.exe); installed builds resolve
        // to the packaged production CLI next to the app/resources.
        match resolve_jishu_cli_binary() {
            Ok(cli) => {
                log::info!("[task-plan-runtime] cli={}", cli.display());
                envs.push((
                    "JISHU_CLI_BIN".to_string(),
                    cli.to_string_lossy().to_string(),
                ));
            }
            Err(err) => {
                log::warn!("[task-plan-runtime] failed to resolve jishu-cli: {err}");
            }
        }
        // v0.9.1 需求12 补充：会话环境变量（配置页高级设置）——settings.json
        // 的 hubSpawnEnv（hub 专属键；pi 读写走全量 spread，未知键无损保留）
        // 逐项附加注入 pi 会话进程。置于内置默认之后，用户可覆盖（如
        // PI_OFFLINE="" 关闭离线刷新、HTTP(S)_PROXY 走代理）。
        envs.extend(spawn_env_overrides(&config::load_jishu_config()));
        // v0.9.4 需求9 P3：MCP 指纹进 spawn 签名（仅总开关）。pi 不重读
        // mcp.json（pi-mcp-adapter 无 config watch），会话中途首次启用/关闭
        // 解析器时，运行中进程的册子上连解析器入口工具都没有——唯一必须
        // 换进程的场景。指纹进入 acp_turn_signature → 下一次空闲发送时
        // 漂移回收重拉（resume 同一会话，历史不丢）。插件明细**不进**指纹：
        // 热插拔由 hub_mcp_list/hub_mcp_call 动态发现承担，换进程反而打断
        //（02 §二 P3）。
        envs.push((
            "JISHU_MCP_REV".to_string(),
            format!(
                "resolver:{}",
                if crate::agent::plugin::is_mcp_resolver_enabled() {
                    "on"
                } else {
                    "off"
                }
            ),
        ));

        Ok(crate::agent::AcpCommandSpec {
            program: runtime.program.to_string_lossy().to_string(),
            args,
            envs,
        })
    }

    fn resolved_session_prompt_injection(&self) -> Option<ResolvedSessionPromptInjection> {
        // session_id 改由 session-context 扩展注入 system prompt（before_agent_start），
        // 不再往 user message 拼提示词（避免污染会话列表名/内容/搜索）。返回 None 下线注入。
        None
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
