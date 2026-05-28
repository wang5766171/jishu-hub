use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub mod adapters;
pub mod capability;
pub mod classify;
pub mod claude_code;
pub mod command_config;
pub mod discovery;
pub mod normalized;

pub use capability::{AgentCapabilities, AgentHealth};
pub use claude_code::ClaudeCodeAgent;
pub use normalized::NormalizedEvent;

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
}

pub struct AgentRegistry {
    agents: HashMap<String, Box<dyn AgentPlugin + Send + Sync>>,
    active_id: String,
    health_cache: Arc<Mutex<HashMap<String, AgentHealth>>>,
}

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
            .unwrap()
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
            if id != "claude-code" && !agent.probe_sync().installed {
                continue;
            }
            projects.extend(agent.scan_projects());
        }
        crate::project::merge_projects(projects)
    }

    /// Update health cache with pre-computed results
    pub fn update_health_cache(&self, results: Vec<(String, AgentHealth)>) {
        let mut cache = self.health_cache.lock().unwrap_or_else(|e| e.into_inner());
        for (id, health) in results {
            cache.insert(id, health);
        }
    }
}

pub trait AgentPlugin {
    fn info(&self) -> AgentInfo;
    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::empty()
    }
    fn install_hint(&self) -> Option<String> {
        None
    }
    fn native_install_command(&self) -> Option<String> {
        None
    }

    /// Probe agent health (binary detection, version check)
    fn probe_sync(&self) -> AgentHealth {
        AgentHealth {
            installed: false,
            version: None,
            error: None,
            binary_path: None,
            last_checked_at: 0,
        }
    }

    /// Async probe (default delegates to sync)
    fn probe(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AgentHealth> + Send + '_>> {
        let health = self.probe_sync();
        Box::pin(async move { health })
    }

    // Project management
    fn scan_projects(&self) -> Vec<crate::project::Project>;
    fn add_project(&self, path: &str) -> Option<crate::project::Project>;
    fn decode_project_path(&self, encoded: &str) -> String;
    fn encode_project_path(&self, path: &str) -> String;
    fn get_level1_dir(&self, path: &str) -> Option<String>;

    // Session management
    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<crate::session::Session>, String>;
    fn get_session_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String>;

    // Config management
    fn load_config(&self) -> Result<crate::config::ClaudeConfig, String>;
    fn save_config(&self, config: &crate::config::ClaudeConfig) -> Result<(), String>;
    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate>;
    fn list_backups(&self) -> Result<Vec<crate::config::BackupEntry>, String>;
    fn restore_backup(&self, path: &str) -> Result<(), String>;
    fn export_config(&self, path: &str) -> Result<(), String>;
    fn import_config(&self, path: &str) -> Result<crate::config::ClaudeConfig, String>;

    // Project config
    fn load_project_settings(
        &self,
        path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String>;
    fn load_project_settings_local(
        &self,
        path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String>;
    fn save_project_settings(
        &self,
        path: &str,
        settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String>;
    fn save_project_settings_local(
        &self,
        path: &str,
        settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String>;
    fn load_claude_md(&self, path: &str) -> Result<Option<String>, String>;

    // Chat
    fn build_chat_command(&self, args: ChatRequest) -> tokio::process::Command;
    fn build_resume_command(&self, session_id: &str) -> String;
    fn parse_stream_event(&self, event: &serde_json::Value) -> String;

    // History
    fn load_history(&self) -> Vec<crate::history::HistoryEntry>;

    // Terminal
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

    fn init_project(&self, project_path: &str) -> Result<bool, String>;
}

pub fn normalize_stream_event(agent_id: &str, event: &serde_json::Value) -> Vec<NormalizedEvent> {
    match agent_id {
        "claude-code" => claude_code::normalize_stream_event(event),
        "codex" => adapters::codex::normalize_stream_event(event),
        "opencode" => adapters::opencode::normalize_stream_event(event),
        _ => vec![NormalizedEvent::Raw {
            agent: agent_id.to_string(),
            raw: event.clone(),
        }],
    }
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub project_path: String,
    pub session_id: Option<String>,
    pub message: String,
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
        };

        let value = serde_json::to_value(status).unwrap();
        assert_eq!(
            value["capabilities"],
            serde_json::Value::String("1152921506754330624".to_string())
        );
    }
}
