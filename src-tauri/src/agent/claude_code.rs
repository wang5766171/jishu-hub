use super::{AgentCapabilities, AgentHealth, AgentInfo, AgentPlugin, ChatRequest};

pub struct ClaudeCodeAgent;

impl ClaudeCodeAgent {
    pub fn new() -> Self {
        Self
    }
}

impl AgentPlugin for ClaudeCodeAgent {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "claude-code".to_string(),
            display_name: "Claude Code".to_string(),
            version: "1.0".to_string(),
            icon: "terminal".to_string(),
            enabled: true,
        }
    }

    fn capabilities(&self) -> AgentCapabilities {
        use AgentCapabilities as C;
        C::RESUME_BY_ID | C::SESSION_LIST | C::IMAGE_INPUT | C::FILE_INPUT
            | C::STREAM_TEXT_DELTA | C::STREAM_TOOL_CALLS | C::STREAM_THINKING | C::PARTIAL_MESSAGE
            | C::ABORT | C::CONFIG_GLOBAL | C::CONFIG_PROJECT | C::CONFIG_BACKUP | C::CONFIG_TEMPLATES
    }

    fn install_hint(&self) -> Option<String> {
        Some("npm install -g @anthropic-ai/claude-code".to_string())
    }

    fn probe_sync(&self) -> AgentHealth {
        let candidates = super::discovery::default_candidates_for("claude");
        // Synchronous check: just verify binary exists
        let runtime = tokio::runtime::Runtime::new();
        let result = if let Ok(rt) = runtime {
            rt.block_on(async {
                let binary = super::discovery::probe_binary("claude", &candidates.iter().map(|s| s.as_str()).collect::<Vec<_>>()).await;
                match binary {
                    Some(path) => {
                        let version = super::discovery::version_of(&path).await;
                        AgentHealth {
                            installed: true,
                            version,
                            error: None,
                            binary_path: Some(path.to_string_lossy().to_string()),
                            last_checked_at: now_ms(),
                        }
                    }
                    None => AgentHealth {
                        installed: false,
                        version: None,
                        error: Some("claude not found in PATH".to_string()),
                        binary_path: None,
                        last_checked_at: now_ms(),
                    },
                }
            })
        } else {
            AgentHealth {
                installed: false,
                version: None,
                error: Some("Failed to create tokio runtime".to_string()),
                binary_path: None,
                last_checked_at: now_ms(),
            }
        };
        result
    }

    fn scan_projects(&self) -> Vec<crate::project::Project> {
        crate::project::scan_projects()
    }

    fn add_project(&self, path: &str) -> Option<crate::project::Project> {
        crate::project::add_project(path)
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

    fn list_sessions(&self, encoded_name: &str) -> Result<Vec<crate::session::Session>, String> {
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        let projects_dir = home.join(".claude").join("projects");
        let project_dir = projects_dir.join(encoded_name);
        if !project_dir.exists() {
            return Err(format!("Project directory not found: {}", encoded_name));
        }

        let mut all_sessions = crate::session::list_sessions(&project_dir);

        if let Ok(secondaries) = crate::hub::get_merged_secondaries(encoded_name) {
            for sec in secondaries {
                let sec_dir = projects_dir.join(&sec);
                if sec_dir.exists() {
                    let mut sec_sessions = crate::session::list_sessions(&sec_dir);
                    all_sessions.append(&mut sec_sessions);
                }
            }
        }

        all_sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(all_sessions)
    }

    fn get_session_messages(
        &self,
        session_id: &str,
        encoded_name: &str,
    ) -> Result<Vec<crate::session::Message>, String> {
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        let session_path = home
            .join(".claude")
            .join("projects")
            .join(encoded_name)
            .join(format!("{}.jsonl", session_id));
        if !session_path.exists() {
            return Err(format!("Session file not found: {}", session_id));
        }
        crate::session::load_session(&session_path)
            .map(|s| s.messages)
            .ok_or_else(|| format!("Failed to parse session: {}", session_id))
    }

    fn load_config(&self) -> Result<crate::config::ClaudeConfig, String> {
        crate::config::load_config().map_err(|e| e.to_string())
    }

    fn save_config(&self, config: &crate::config::ClaudeConfig) -> Result<(), String> {
        crate::config::save_config(config).map_err(|e| e.to_string())
    }

    fn config_templates(&self) -> Vec<crate::hub::ConfigTemplate> {
        crate::hub::list_config_templates()
    }

    fn list_backups(&self) -> Result<Vec<crate::config::BackupEntry>, String> {
        crate::config::list_backups().map_err(|e| e.to_string())
    }

    fn restore_backup(&self, path: &str) -> Result<(), String> {
        crate::config::restore_backup(path).map_err(|e| e.to_string())
    }

    fn export_config(&self, path: &str) -> Result<(), String> {
        crate::config::export_config(path).map_err(|e| e.to_string())
    }

    fn import_config(&self, path: &str) -> Result<crate::config::ClaudeConfig, String> {
        crate::config::import_config(path).map_err(|e| e.to_string())
    }

    fn load_project_settings(
        &self,
        path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String> {
        crate::project_config::load_project_settings(path).map_err(|e| e.to_string())
    }

    fn load_project_settings_local(
        &self,
        path: &str,
    ) -> Result<crate::project_config::ProjectSettings, String> {
        crate::project_config::load_project_settings_local(path).map_err(|e| e.to_string())
    }

    fn save_project_settings(
        &self,
        path: &str,
        settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String> {
        crate::project_config::save_project_settings(path, settings).map_err(|e| e.to_string())
    }

    fn save_project_settings_local(
        &self,
        path: &str,
        settings: &crate::project_config::ProjectSettings,
    ) -> Result<(), String> {
        crate::project_config::save_project_settings_local(path, settings)
            .map_err(|e| e.to_string())
    }

    fn load_claude_md(&self, path: &str) -> Result<Option<String>, String> {
        crate::project_config::load_claude_md(path).map_err(|e| e.to_string())
    }

    fn build_chat_command(&self, req: ChatRequest) -> tokio::process::Command {
        let escaped_message = req.message.replace('\r', "").replace('\n', "\\n");

        let mut args: Vec<String> = vec![
            "-p".into(),
            escaped_message,
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
        ];

        if let Some(ref sid) = req.session_id {
            args.push("--resume".into());
            args.push(sid.clone());
        }

        #[cfg(target_os = "windows")]
        {
            let mut full_args = vec!["/C".to_string(), "claude".to_string()];
            full_args.extend(args);
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.args(&full_args).current_dir(&req.project_path);
            cmd
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = tokio::process::Command::new("claude");
            cmd.args(&args).current_dir(&req.project_path);
            cmd
        }
    }

    fn build_resume_command(&self, session_id: &str) -> String {
        format!("claude --resume {}", session_id)
    }

    fn parse_stream_event(&self, event: &serde_json::Value) -> String {
        match event.get("type").and_then(|v| v.as_str()) {
            Some("system") => event
                .get("subtype")
                .and_then(|v| v.as_str())
                .unwrap_or("system"),
            Some("stream_event") => "delta",
            Some("result") => "result",
            Some("assistant") => "message",
            Some(t) => t,
            None => "unknown",
        }
        .to_string()
    }

    fn load_history(&self) -> Vec<crate::history::HistoryEntry> {
        crate::history::load_history()
    }

    fn open_in_terminal(
        &self,
        project_path: &str,
        resume_session_id: Option<&str>,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        crate::command::open_in_terminal(project_path, resume_session_id)
    }

    fn open_in_terminal_with_command(
        &self,
        project_path: &str,
        command: &str,
    ) -> Result<u32, Box<dyn std::error::Error>> {
        crate::command::open_in_terminal_with_command(project_path, command)
    }

    fn init_project(&self, project_path: &str) -> Result<bool, String> {
        let command = "claude \"Please initialize this project and tell me when it's done.\"";
        crate::command::open_in_terminal_with_command(project_path, command)
            .map(|_| true)
            .map_err(|e| e.to_string())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
