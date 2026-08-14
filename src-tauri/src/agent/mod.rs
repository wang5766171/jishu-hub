use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod adapters;
pub mod capability;
pub mod classify;
pub mod claude_code;
pub mod command_config;
pub mod discovery;
pub mod interaction;
pub mod jishu_self;
pub mod normalized;
pub mod traits;

pub use capability::{AgentCapabilities, AgentHealth};
pub use claude_code::ClaudeCodeAgent;
pub use normalized::NormalizedEvent;
pub use traits::*;

pub type StreamEventNormalizer = fn(&serde_json::Value) -> Vec<NormalizedEvent>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSessionPromptInjection {
    pub open_tag: String,
    pub close_tag: String,
    pub session_id_field: String,
    pub guidance: String,
}

impl ResolvedSessionPromptInjection {
    pub fn apply(&self, message: &str, session_id: &str) -> String {
        // Slash commands must start with '/' as the very first character for
        // Pi's command dispatcher to recognize them. Injecting runtime context
        // before a '/' breaks command detection — bypass for slash commands.
        if message.trim_start().starts_with('/') {
            return message.to_string();
        }
        let mut lines = vec![
            self.open_tag.clone(),
            format!("{}: {}", self.session_id_field, session_id),
        ];
        if !self.guidance.trim().is_empty() {
            lines.push(self.guidance.clone());
        }
        lines.push(self.close_tag.clone());
        lines.push(String::new());
        lines.push(message.to_string());
        lines.join("\n")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub icon: String,
    pub logo_path: Option<String>,
    pub enabled: bool,
}

/// Extended agent info with capability and health data for the platform API
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatus {
    pub id: String,
    pub display_name: String,
    pub icon: String,
    pub logo_path: Option<String>,
    pub capabilities: String,
    pub health: AgentHealth,
    pub install_hint: Option<String>,
    pub native_install_command: Option<String>,
    pub available_version: Option<String>,
    pub install_package_manager: Option<String>,
    pub auto_installed: bool,
    pub config_surface: ConfigSurface,
    pub project_settings_surface: ProjectSettingsSurface,
    pub terminal_surface: TerminalSurface,
    pub transport: TransportSurface,
    /// MCP adapter installation status (only populated when config_surface declares supports_mcp).
    pub mcp_installed: bool,
    pub mcp_version: Option<String>,
    /// Transport-bridge dependency status (only populated when the agent
    /// declares supports_transport_bridge — e.g. claude_code's claude-agent-acp).
    pub transport_bridge: TransportBridgeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConfigSurface {
    Structured {
        schema_id: String,
        supports_model_picker: bool,
        supports_small_model: bool,
        supports_large_model: bool,
        supports_api_provider: bool,
    },
    Raw {
        format: String,
    },
    ModelStore {
        provider: String,
        supports_picker: bool,
        #[serde(default)]
        supports_mcp: bool,
    },
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectSettingsSurface {
    Supported {
        scopes: Vec<ProjectSettingsScope>,
        access_modes: Vec<String>,
    },
    Unsupported {
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSettingsScope {
    Shared,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalSurface {
    Supported,
    Unsupported { reason: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransportSurface {
    AcpPreferred,
    /// Pi's native --mode rpc protocol (JSON-line, distinct from ACP JSON-RPC 2.0).
    PiRpc,
    Cli,
    Embedded,
    /// codex's JSON-RPC 2.0 app-server protocol (thread/turn model). Added for
    /// v0.6.0 interaction generalization — codex answers structured business
    /// questions via EXPERIMENTAL `item/tool/requestUserInput`. See
    /// `交互模式通用化设计_20260616.md` (§7.2).
    CodexAppServer,
}

impl TransportSurface {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AcpPreferred => "ACP",
            Self::PiRpc => "PiRPC",
            Self::Cli => "CLI",
            Self::Embedded => "Embedded",
            Self::CodexAppServer => "CodexAppServer",
        }
    }
}

/// Transport-bridge dependency status. Only meaningful when
/// `ConfigAdapter::supports_transport_bridge` is true — i.e. the agent's
/// effective transport depends on an external binary not bundled with its CLI
/// (claude_code needs `claude-agent-acp` to reach AcpPreferred; absent → Cli).
/// Surfaced to the env-check page the same way MCP adapter status is.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TransportBridgeStatus {
    /// Whether this agent declares a transport-bridge dependency at all.
    pub supported: bool,
    /// Whether the bridge binary is currently resolvable on PATH.
    pub installed: bool,
    pub version: Option<String>,
    /// Human-facing bridge binary label (e.g. `claude-agent-acp`).
    pub name: Option<String>,
}

pub struct AgentRegistry {
    agents: HashMap<String, Box<dyn AgentPlugin + Send + Sync>>,
    health_cache: Arc<Mutex<HashMap<String, AgentHealth>>>,
}

const HEALTH_CACHE_TTL_MS: i64 = 60_000;

/// 内置 jishu agent 的权威 id（registry key、DB 字段、协议 payload 统一用它）。
///
/// 命名分层（2026-07-25 确立）：
/// - 用户可见：`Jishu Agent`（走 `AgentInfo::display_name` / i18n，**禁止**在 UI 直出本常量）
/// - 内部标识：本常量
/// - 命令行：`jishu-hub`(CLI) / `jishu agent`(TUI)
pub const JISHU_SELF_AGENT_ID: &str = "jishu-self";

/// `TaskInstance.planner_agent_id` 的历史遗留别名（下划线）。
///
/// 该字段的 SQL 列默认值长期是 `'jishu_agent'`（`task_launch.rs`），与 registry 的
/// `jishu-self` 不相等。既有数据库里已存在带此值的行，**仅改默认字面量无法回填旧行**，
/// 故必须在解析层归一化，见 [`normalize_agent_id`]。
pub const LEGACY_JISHU_AGENT_ALIAS: &str = "jishu_agent";

/// 把可能来自历史数据/外部输入的 agent id 归一为 registry 可查的权威 id。
///
/// 目前只处理 `jishu_agent` → `jishu-self` 这一个别名；未知值原样返回，
/// 由调用方按"查不到"处理。
pub fn normalize_agent_id(raw: &str) -> &str {
    if raw == LEGACY_JISHU_AGENT_ALIAS {
        JISHU_SELF_AGENT_ID
    } else {
        raw
    }
}

impl AgentRegistry {
    pub fn new() -> Self {
        let mut agents: HashMap<String, Box<dyn AgentPlugin + Send + Sync>> = HashMap::new();
        let claude_code = ClaudeCodeAgent::new();
        let claude_code_id = claude_code.info().id.clone();
        agents.insert(claude_code_id, Box::new(claude_code));

        let codex = adapters::codex::CodexAdapter::new();
        let codex_id = codex.info().id.clone();
        agents.insert(codex_id, Box::new(codex));

        let opencode = adapters::opencode::OpencodeAdapter::new();
        let opencode_id = opencode.info().id.clone();
        agents.insert(opencode_id, Box::new(opencode));

        let jishu_self = jishu_self::JishuSelfAgent::new();
        let jishu_self_id = jishu_self.info().id.clone();
        agents.insert(jishu_self_id, Box::new(jishu_self));

        Self {
            agents,
            health_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// v0.7.0：全局 active agent 概念已移除（需求一：智能体切换去全局化）。
    /// 各模块（会话/管理）按自身作用域选择 agent，通过 agent_id 入参显式指定；
    /// 会话与智能体在 Session 层绑定。本 registry 仅负责插件解析，不再持有"当前选中"态。
    pub fn require_agent(
        &self,
        agent_id: &str,
    ) -> Result<&(dyn AgentPlugin + Send + Sync), String> {
        self.agents
            .get(agent_id)
            .map(|a| a.as_ref())
            .ok_or_else(|| format!("Unknown agent id: {}", agent_id))
    }

    pub fn list_agents(&self) -> Vec<AgentInfo> {
        self.agents.values().map(|a| a.info()).collect()
    }

    /// List all agents with health and capability status (platform API)
    pub fn list_agent_statuses(&self) -> Vec<AgentStatus> {
        let health_cache = self.health_cache.lock().unwrap_or_else(|e| e.into_inner());
        self.agents
            .values()
            .map(|a| {
                let info = a.info();
                let caps = a.capabilities();
                let health = health_cache
                    .get(&info.id)
                    .cloned()
                    .unwrap_or_else(|| AgentHealth {
                        installed: false,
                        version: None,
                        error: Some("Not probed yet".to_string()),
                        binary_path: None,
                        last_checked_at: 0,
                    });
                let (mcp_installed, mcp_version) = if a.supports_mcp() {
                    // Auto-migrate on first status check.
                    a.migrate_mcp_if_needed();
                    match a.check_mcp() {
                        Ok(v) => (
                            v.get("installed")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                            v.get("version").and_then(|v| v.as_str()).map(String::from),
                        ),
                        Err(_) => (false, None),
                    }
                } else {
                    (false, None)
                };
                let transport_bridge = if a.supports_transport_bridge() {
                    match a.check_transport_bridge() {
                        Ok(v) => TransportBridgeStatus {
                            supported: true,
                            installed: v
                                .get("installed")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                            version: v.get("version").and_then(|v| v.as_str()).map(String::from),
                            name: v.get("name").and_then(|v| v.as_str()).map(String::from),
                        },
                        Err(_) => TransportBridgeStatus {
                            supported: true,
                            ..Default::default()
                        },
                    }
                } else {
                    TransportBridgeStatus::default()
                };
                AgentStatus {
                    id: info.id.clone(),
                    display_name: info.display_name.clone(),
                    icon: info.icon.clone(),
                    logo_path: info.logo_path.clone(),
                    capabilities: caps.bits().to_string(),
                    health,
                    install_hint: a.install_hint(),
                    native_install_command: a.native_install_command(),
                    available_version: a.available_version(),
                    install_package_manager: a.install_package_manager(),
                    auto_installed: a.auto_installed(),
                    config_surface: a.config_surface(),
                    project_settings_surface: a.project_settings_surface(),
                    terminal_surface: a.terminal_surface(),
                    transport: a.resolve_transport(),
                    mcp_installed,
                    mcp_version,
                    transport_bridge,
                }
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&(dyn AgentPlugin + Send + Sync)> {
        self.agents.get(id).map(|a| a.as_ref())
    }

    /// Probe all agents and update health cache
    /// This method must NOT be called while holding an external MutexGuard over self,
    /// since it internally borrows self across .await points.
    pub async fn refresh_health(&self) {
        // Probe every agent concurrently. `probe()` is awaited per agent (its
        // default impl wraps `probe_sync` in an async block), so serialising
        // the loop made first-load latency grow linearly with agent count.
        let results: Vec<(String, AgentHealth)> = {
            let agents: Vec<_> = self.agents.iter().collect();
            futures_util::future::join_all(
                agents
                    .into_iter()
                    .map(|(id, agent)| async move { (id.clone(), agent.probe().await) }),
            )
            .await
        };

        let mut cache = self.health_cache.lock().unwrap_or_else(|e| e.into_inner());
        for (id, health) in results {
            cache.insert(id, health);
        }
    }

    /// 同步并发探测所有 agent 健康状态并更新缓存（v0.7.2 需求 1 / M2.3）。
    ///
    /// 用 scoped threads 并发跑 `probe_sync`（每个 agent 一个线程），把 N 个 agent
    /// 的探测耗时从"顺序之和"降到"最慢单项"。设计为同步方法，供命令层用
    /// `spawn_blocking` 调用以免阻塞 tokio worker。
    pub fn refresh_health_blocking(&self) {
        let agents: Vec<(String, &(dyn AgentPlugin + Send + Sync))> = self
            .agents
            .iter()
            .map(|(id, p)| (id.clone(), p.as_ref()))
            .collect();
        let results: Vec<(String, AgentHealth)> = std::thread::scope(|scope| {
            let handles: Vec<_> = agents
                .into_iter()
                .map(|(id, agent)| scope.spawn(move || (id, agent.probe_sync())))
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        let mut cache = self.health_cache.lock().unwrap_or_else(|e| e.into_inner());
        for (id, health) in results {
            cache.insert(id, health);
        }
    }

    /// Collect (id, &(dyn AgentPlugin + Send + Sync)) pairs for synchronous probing
    pub fn agents_info(&self) -> Vec<(String, &(dyn AgentPlugin + Send + Sync))> {
        self.agents
            .iter()
            .map(|(id, plugin)| (id.clone(), plugin.as_ref()))
            .collect()
    }

    pub fn scan_projects(&self) -> Vec<crate::project::Project> {
        // v0.7.2 需求 1 / M2.1：每个 agent 一个 scoped thread，把「installed 检查 +
        // 探测 + 扫描」整体并发。此前 filter 在主线程顺序 probe_sync 全部 agent，冷启动
        // 耗时为各项之和（实测 ~20s，Node CLI --version 各 3-5s）；改为并发后降为最慢单项。
        let per_agent: Vec<Vec<crate::project::Project>> = std::thread::scope(|scope| {
            let handles: Vec<_> = self
                .agents
                .iter()
                .map(|(id, agent)| {
                    scope.spawn(move || {
                        if agent.requires_installation_for_project_scan() {
                            let now = now_ms();
                            let cached_installed = self
                                .health_cache
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .get(id)
                                .map(|h| {
                                    now.saturating_sub(h.last_checked_at) < HEALTH_CACHE_TTL_MS
                                        && h.installed
                                })
                                .unwrap_or(false);
                            if !cached_installed {
                                // miss：探测在锁外执行，不阻塞其它 agent 线程
                                let health = agent.probe_sync();
                                let installed = health.installed;
                                self.health_cache
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .insert(id.to_string(), health);
                                if !installed {
                                    return Vec::new();
                                }
                            }
                        }
                        agent.scan_projects()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_default())
                .collect()
        });

        crate::project::merge_projects(per_agent.into_iter().flatten().collect())
    }

    fn agent_installed_cached(&self, id: &str, agent: &(dyn AgentPlugin + Send + Sync)) -> bool {
        let now = now_ms();
        if let Some(health) = self
            .health_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
        {
            if now.saturating_sub(health.last_checked_at) < HEALTH_CACHE_TTL_MS {
                return health.installed;
            }
        }

        let health = agent.probe_sync();
        let installed = health.installed;
        self.health_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), health);
        installed
    }

    /// Update health cache with pre-computed results
    pub fn update_health_cache(&self, results: Vec<(String, AgentHealth)>) {
        let mut cache = self.health_cache.lock().unwrap_or_else(|e| e.into_inner());
        for (id, health) in results {
            cache.insert(id, health);
        }
    }
}

fn now_ms() -> i64 {
    crate::util::now_ms()
}

fn default_stream_event_normalizer(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    vec![NormalizedEvent::Raw {
        agent: "unknown".to_string(),
        raw: event.clone(),
    }]
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub project_path: String,
    pub session_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpCommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_agent_resolves_registered_plugin() {
        let registry = AgentRegistry::new();

        // 已注册的 agent 能解析
        let plugin = registry
            .require_agent("codex")
            .expect("codex should be registered");
        assert_eq!(plugin.info().id, "codex");

        // 未注册的 agent 返回错误
        assert!(registry.require_agent("no-such-agent").is_err());
    }

    #[test]
    fn agent_status_serializes_capabilities_as_decimal_string() {
        let status = AgentStatus {
            id: "codex".to_string(),
            display_name: "Codex".to_string(),
            icon: "bot".to_string(),
            logo_path: None,
            capabilities: (AgentCapabilities::RPC_BIDIRECTIONAL
                | AgentCapabilities::APPROVAL_REQUEST)
                .bits()
                .to_string(),
            health: AgentHealth {
                installed: true,
                version: Some("1.0.0".to_string()),
                error: None,
                binary_path: Some("codex".to_string()),
                last_checked_at: 1,
            },
            install_hint: None,
            native_install_command: None,
            available_version: None,
            install_package_manager: None,
            auto_installed: false,
            config_surface: ConfigSurface::Raw {
                format: "toml".to_string(),
            },
            project_settings_surface: ProjectSettingsSurface::Unsupported { reason: None },
            terminal_surface: TerminalSurface::Supported,
            transport: TransportSurface::Cli,
            mcp_installed: false,
            mcp_version: None,
            transport_bridge: TransportBridgeStatus::default(),
        };

        let value = serde_json::to_value(status).unwrap();
        assert_eq!(
            value["capabilities"],
            serde_json::Value::String("1152921506754330624".to_string())
        );
    }

    #[test]
    fn registry_exposes_adapter_surfaces_without_agent_id_branching() {
        let registry = AgentRegistry::new();
        let statuses = registry.list_agent_statuses();

        let jishu = statuses
            .iter()
            .find(|status| status.id == "jishu-self")
            .expect("jishu-self status should exist");
        assert_eq!(
            jishu.config_surface,
            ConfigSurface::ModelStore {
                provider: "pi".to_string(),
                supports_picker: true,
                supports_mcp: true,
            }
        );
        assert_eq!(jishu.terminal_surface, TerminalSurface::Supported);
        assert_eq!(jishu.transport, TransportSurface::PiRpc);
        assert_eq!(
            jishu.available_version.as_deref(),
            Some(crate::agent::jishu_self::PI_AGENT_VERSION)
        );

        let codex = statuses
            .iter()
            .find(|status| status.id == "codex")
            .expect("codex status should exist");
        assert_eq!(
            codex.config_surface,
            ConfigSurface::Structured {
                schema_id: "codex-config".to_string(),
                supports_model_picker: false,
                supports_small_model: false,
                supports_large_model: false,
                supports_api_provider: false,
            }
        );

        let opencode = statuses
            .iter()
            .find(|status| status.id == "opencode")
            .expect("opencode status should exist");
        assert_eq!(opencode.transport, TransportSurface::AcpPreferred);

        // MCP: only jishu-self declares supports_mcp; others should have defaults.
        assert!(!codex.mcp_installed);
        assert!(codex.mcp_version.is_none());
        assert!(!opencode.mcp_installed);
        assert!(opencode.mcp_version.is_none());

        let claude = statuses
            .iter()
            .find(|status| status.id == "claude-code")
            .expect("claude-code status should exist");
        assert_eq!(
            claude.project_settings_surface,
            ProjectSettingsSurface::Supported {
                scopes: vec![ProjectSettingsScope::Shared, ProjectSettingsScope::Local],
                access_modes: vec![
                    "default".to_string(),
                    "bypassPermissions".to_string(),
                    "plan".to_string()
                ],
            }
        );

        // Transport bridge: claude_code declares a claude-agent-acp dependency
        // (others default to unsupported). `installed`/`version` depend on the
        // host PATH, so only the supported flag + name contract are asserted.
        assert!(claude.transport_bridge.supported);
        assert_eq!(
            claude.transport_bridge.name.as_deref(),
            Some("claude-agent-acp")
        );
        assert!(!codex.transport_bridge.supported);
        assert!(!opencode.transport_bridge.supported);
    }
}
