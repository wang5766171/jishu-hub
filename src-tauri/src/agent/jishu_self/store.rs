use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub project_path: Option<String>,
    pub started_at: Option<i64>,
    pub display_name: Option<String>,
}

/// Phase 2: stub implementation -- returns empty list.
/// Will be replaced with real session store backed by jishu internals.
pub fn list_sessions(_project_path: Option<&str>) -> Vec<SessionInfo> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_sessions_returns_empty() {
        assert!(list_sessions(None).is_empty());
        assert!(list_sessions(Some("/some/path")).is_empty());
    }
}
