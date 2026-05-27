use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AgentCommandPreset {
    pub name: String,
    pub command: String,
}

pub fn launch_command(agent_id: &str) -> String {
    match agent_id {
        "claude-code" => "claude".to_string(),
        "codex" => "codex".to_string(),
        "opencode" => "opencode".to_string(),
        other => other.to_string(),
    }
}

pub fn resume_command(agent_id: &str, session_id: &str) -> String {
    match agent_id {
        "claude-code" => format!("claude --resume {session_id}"),
        "codex" => format!("codex resume {session_id}"),
        "opencode" => format!("opencode --session {session_id}"),
        other => format!("{other} {session_id}"),
    }
}

pub fn init_command(agent_id: &str) -> String {
    let prompt = "Please initialize this project and tell me when it's done.";
    match agent_id {
        "claude-code" => format!("claude \"{prompt}\""),
        "codex" => format!("codex \"{prompt}\""),
        "opencode" => format!("opencode \"{prompt}\""),
        other => format!("{other} \"{prompt}\""),
    }
}

pub fn built_in_commands(agent_id: &str) -> Vec<AgentCommandPreset> {
    match agent_id {
        "claude-code" => vec![
            preset("claude --version", "claude --version"),
            preset("claude mcp list", "claude mcp list"),
        ],
        "codex" => vec![
            preset("codex --version", "codex --version"),
            preset("codex exec", "codex exec \"Say hello\""),
        ],
        "opencode" => vec![
            preset("opencode --version", "opencode --version"),
            preset("opencode models", "opencode models"),
            preset("opencode run", "opencode run --format json \"Say hello\""),
        ],
        other => vec![preset(
            format!("{other} --version"),
            format!("{other} --version"),
        )],
    }
}

pub fn terminal_window_id(agent_id: &str, session_id: &str) -> String {
    let safe_agent = agent_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    format!("{safe_agent}-{session_id}")
}

pub fn resume_markers(session_id: &str) -> Vec<String> {
    vec![
        format!("--resume {session_id}"),
        format!("resume {session_id}"),
        format!("--session {session_id}"),
        format!("-s {session_id}"),
    ]
}

fn preset(name: impl Into<String>, command: impl Into<String>) -> AgentCommandPreset {
    AgentCommandPreset {
        name: name.into(),
        command: command.into(),
    }
}
