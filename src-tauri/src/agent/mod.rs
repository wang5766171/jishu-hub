use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub mod claude_code;

pub use claude_code::ClaudeCodeAgent;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub icon: String,
    pub enabled: bool,
}

pub struct AgentRegistry {
    agents: HashMap<String, Box<dyn AgentPlugin + Send + Sync>>,
    active_id: String,
}

impl AgentRegistry {
    pub fn new() -> Self {
        let mut agents: HashMap<String, Box<dyn AgentPlugin + Send + Sync>> = HashMap::new();
        let claude_code = ClaudeCodeAgent::new();
        let id = claude_code.info().id.clone();
        agents.insert(id.clone(), Box::new(claude_code));

        Self {
            agents,
            active_id: id,
        }
    }

    pub fn active(&self) -> &dyn AgentPlugin {
        self.agents
            .get(&self.active_id)
            .map(|a| a.as_ref())
            .unwrap()
    }

    pub fn list_agents(&self) -> Vec<AgentInfo> {
        self.agents.values().map(|a| a.info()).collect()
    }

    pub fn set_active(&mut self, id: &str) -> Result<(), String> {
        if self.agents.contains_key(id) {
            self.active_id = id.to_string();
            Ok(())
        } else {
            Err(format!("Agent not found: {}", id))
        }
    }
}

pub trait AgentPlugin {
    fn info(&self) -> AgentInfo;

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

    fn init_project(&self, project_path: &str) -> Result<bool, String>;
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub project_path: String,
    pub session_id: Option<String>,
    pub message: String,
}
