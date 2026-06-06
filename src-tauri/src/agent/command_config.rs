use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AgentCommandPreset {
    pub name: String,
    pub command: String,
}

pub fn terminal_window_id(agent_id: &str, session_id: &str) -> String {
    let safe_agent = agent_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    format!("{safe_agent}-{session_id}")
}

/// Session ids from all supported agents are UUIDs / `ses_*` tokens, i.e. only
/// `[A-Za-z0-9_-]`. Validating this set before a session id is interpolated
/// into a terminal command line prevents shell metacharacters from being
/// injected via the resume path. (K-MED-6)
pub fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn is_transient_session_id(session_id: &str) -> bool {
    session_id.starts_with("pending-") || session_id.starts_with("new_session_")
}

pub fn resume_markers(session_id: &str) -> Vec<String> {
    vec![
        format!("--resume {session_id}"),
        format!("resume {session_id}"),
        format!("--session {session_id}"),
        format!("-s {session_id}"),
    ]
}
