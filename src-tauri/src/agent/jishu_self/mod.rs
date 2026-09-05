pub(crate) mod config;
pub(crate) mod jishu_settings;
pub(crate) mod paths;
pub(crate) mod pi_model;
pub(crate) mod pi_models_config;
pub(crate) mod pi_runtime;
pub(crate) mod pi_session;
pub mod model_picker;
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
        Self::run_mcp_package_command("install").await
    }

    pub async fn update_mcp_standalone() -> Result<String, String> {
        Self::run_mcp_package_command("update").await
    }

    async fn run_mcp_package_command(action: &str) -> Result<String, String> {
        let runtime = pi_runtime::resolve_pi_runtime()
            .map_err(|e| format!("Failed to resolve Pi runtime: {e}"))?;

        let args = mcp_package_args(&runtime.base_args, action);

        let mut cmd =
            crate::os_adapter::shell::shell_command(&runtime.program.to_string_lossy(), args);
        cmd.current_dir(std::env::current_dir().unwrap_or_default());

        #[cfg(target_os = "windows")]
        crate::process_command::tokio_no_window(&mut cmd);

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run pi {action}: {e}"))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(format!(
                "pi {action} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
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
never transliterate jishu as 「极数」 or anything else.";

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
pub const PI_AGENT_VERSION: &str = "0.84.2-9";
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
                    "compaction": { "enabled": true, "thresholdPercent": 90, "keepRecentTokens": 20000 },
                    "defaultTools": ["read", "bash", "edit", "write"],
                    "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 2000 }
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
                    "compaction": { "enabled": true, "thresholdPercent": 85, "keepRecentTokens": 40000 },
                    "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
                    "retry": { "enabled": true, "maxRetries": 5, "baseDelayMs": 2000 }
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
                    "compaction": { "enabled": true, "thresholdPercent": 90, "keepRecentTokens": 20000 },
                    "defaultTools": ["read", "bash", "edit", "write"],
                    "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 2000 }
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
        // Auto-migrate on check (idempotent).
        self.migrate_mcp_if_needed();

        let agent_dir = pi_config_dir()
            .ok_or_else(|| "Cannot resolve ~/.jishu-agent/agent directory".to_string())?;
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
        Box::pin(async { Self::install_mcp_standalone().await })
    }

    fn update_mcp(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
    {
        Box::pin(async { Self::update_mcp_standalone().await })
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

fn mcp_package_args(base_args: &[String], action: &str) -> Vec<String> {
    let mut args = base_args.to_vec();
    args.push(action.to_string());
    args.push("npm:pi-mcp-adapter".to_string());
    args
}

#[cfg(test)]
mod mcp_tests {
    use super::mcp_package_args;

    #[test]
    fn mcp_update_uses_pi_single_package_update_command() {
        assert_eq!(
            mcp_package_args(&["cli.js".to_string()], "update"),
            vec!["cli.js", "update", "npm:pi-mcp-adapter"]
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
        match crate::hub::load_agent_tool_mode("jishu-self").as_deref() {
            Some("readonly") => {
                args.push("--tools".to_string());
                args.push("read,grep,find,ls".to_string());
            }
            // full-approve 与 full 工具集相同，差异只在 toolApproval 审批
            // 开关（set_agent_tool_mode 已联动写入 Pi settings）。
            _ => {}
        }
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
        envs.push(("PI_SKIP_VERSION_CHECK".to_string(), "1".to_string()));

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
