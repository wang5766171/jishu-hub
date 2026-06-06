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
pub mod jishu_self;
pub mod normalized;
pub mod traits;

pub use capability::{AgentCapabilities, AgentHealth};
pub use claude_code::ClaudeCodeAgent;
pub use normalized::NormalizedEvent;
pub use traits::*;

pub type StreamEventNormalizer = fn(&serde_json::Value) -> Vec<NormalizedEvent>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub icon: String,
    pub enabled: bool,
}

/// Extended agent info with capability and health data for the platform API
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatus {
    pub id: String,
    pub display_name: String,
    pub icon: String,
    pub capabilities: String,
    pub health: AgentHealth,
    pub install_hint: Option<String>,
    pub native_install_command: Option<String>,
    pub install_package_manager: Option<String>,
    pub auto_installed: bool,
    pub config_surface: ConfigSurface,
    pub project_settings_surface: ProjectSettingsSurface,
    pub terminal_surface: TerminalSurface,
    pub transport: TransportSurface,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConfigSurface {
    Structured { schema_id: String },
    Raw { format: String },
    ModelStore { provider: String, supports_picker: bool },
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
    Cli,
    Embedded,
}

pub struct AgentRegistry {
    agents: HashMap<String, Box<dyn AgentPlugin + Send + Sync>>,
    active_id: String,
    health_cache: Arc<Mutex<HashMap<String, AgentHealth>>>,
}

const HEALTH_CACHE_TTL_MS: i64 = 60_000;

impl AgentRegistry {
    pub fn new() -> Self {
        let mut agents: HashMap<String, Box<dyn AgentPlugin + Send + Sync>> = HashMap::new();
        let claude_code = ClaudeCodeAgent::new();
        let id = claude_code.info().id.clone();
        agents.insert(id.clone(), Box::new(claude_code));

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
            active_id: id,
            health_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn active(&self) -> &dyn AgentPlugin {
        self.agents
            .get(&self.active_id)
            .map(|a| a.as_ref())
            .expect("AgentRegistry: active_id references a non-existent agent — this is a bug")
    }

    pub fn active_id(&self) -> &str {
        &self.active_id
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
                AgentStatus {
                    id: info.id.clone(),
                    display_name: info.display_name.clone(),
                    icon: info.icon.clone(),
                    capabilities: caps.bits().to_string(),
                    health,
                    install_hint: a.install_hint(),
                    native_install_command: a.native_install_command(),
                    install_package_manager: a.install_package_manager(),
                    auto_installed: a.auto_installed(),
                    config_surface: a.config_surface(),
                    project_settings_surface: a.project_settings_surface(),
                    terminal_surface: a.terminal_surface(),
                    transport: a.transport_surface(),
                }
            })
            .collect()
    }

    pub fn set_active(&mut self, id: &str) -> Result<(), String> {
        if self.agents.contains_key(id) {
            self.active_id = id.to_string();
            Ok(())
        } else {
            Err(format!("Agent not found: {}", id))
        }
    }

    pub fn get(&self, id: &str) -> Option<&(dyn AgentPlugin + Send + Sync)> {
        self.agents.get(id).map(|a| a.as_ref())
    }

    /// Probe all agents and update health cache
    /// This method must NOT be called while holding an external MutexGuard over self,
    /// since it internally borrows self across .await points.
    pub async fn refresh_health(&self) {
        let results: Vec<(String, AgentHealth)> = {
            let agents: Vec<_> = self.agents.iter().collect();
            let mut health_results = Vec::new();
            for (id, agent) in agents {
                let health = agent.probe().await;
                health_results.push((id.clone(), health));
            }
            health_results
        };

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
        let mut projects = Vec::new();
        for (id, agent) in self.agents_info() {
            if agent.requires_installation_for_project_scan()
                && !self.agent_installed_cached(&id, agent)
            {
                continue;
            }
            projects.extend(agent.scan_projects());
        }
        crate::project::merge_projects(projects)
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
    fn agent_status_serializes_capabilities_as_decimal_string() {
        let status = AgentStatus {
            id: "codex".to_string(),
            display_name: "Codex".to_string(),
            icon: "bot".to_string(),
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
            install_package_manager: None,
            auto_installed: false,
            config_surface: ConfigSurface::Raw {
                format: "toml".to_string(),
            },
            project_settings_surface: ProjectSettingsSurface::Unsupported { reason: None },
            terminal_surface: TerminalSurface::Supported,
            transport: TransportSurface::Cli,
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
            }
        );
        assert_eq!(jishu.terminal_surface, TerminalSurface::Supported);
        assert_eq!(jishu.transport, TransportSurface::AcpPreferred);

        let codex = statuses
            .iter()
            .find(|status| status.id == "codex")
            .expect("codex status should exist");
        assert_eq!(
            codex.config_surface,
            ConfigSurface::Raw {
                format: "toml".to_string()
            }
        );

        let opencode = statuses
            .iter()
            .find(|status| status.id == "opencode")
            .expect("opencode status should exist");
        assert_eq!(opencode.transport, TransportSurface::AcpPreferred);

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
    }
}
