use serde::{Deserialize, Serialize};

/// Severity of a rework item, as reported by the auditing/reviewing agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReworkSeverity {
    Low,
    Medium,
    High,
    Critical,
}

/// A rework item extracted from a step's trace output.
/// Created when an agent (e.g., auditor) identifies issues that need to be
/// routed to another role (e.g., developer) for fixing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReworkItem {
    pub item_id: String,
    /// The run that produced this rework item.
    pub source_run_id: String,
    /// The step within the source run.
    pub source_step_id: String,
    /// The role that identified the issue.
    pub source_role_id: String,
    /// Free-text role name from the agent output (parsed by ReworkEngine).
    pub responsible_role: String,
    /// Resolved from spec.roles by ReworkEngine.
    pub target_role_id: Option<String>,
    /// Resolved from spec.roles by ReworkEngine.
    pub target_agent_id: Option<String>,
    /// Set when the rework is dispatched as a child run.
    pub target_run_id: Option<String>,
    pub reason: String,
    pub evidence: String,
    pub suggested_action: String,
    pub severity: Option<ReworkSeverity>,
    pub created_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rework_item_roundtrip() {
        let item = ReworkItem {
            item_id: "ri_001".into(),
            source_run_id: "r_parent".into(),
            source_step_id: "sp_1".into(),
            source_role_id: "auditor".into(),
            responsible_role: "Developer".into(),
            target_role_id: Some("developer".into()),
            target_agent_id: Some("claude-code".into()),
            target_run_id: None,
            reason: "Missing error handling in auth module".into(),
            evidence: "src/auth.rs:42 — unwrap() on Option without check".into(),
            suggested_action: "Replace unwrap() with proper error propagation".into(),
            severity: Some(ReworkSeverity::High),
            created_at: 1700000000,
        };
        let json = serde_json::to_string(&item).unwrap();
        let de: ReworkItem = serde_json::from_str(&json).unwrap();
        assert_eq!(item.item_id, de.item_id);
        assert_eq!(de.target_role_id, Some("developer".into()));
        assert_eq!(de.severity, Some(ReworkSeverity::High));
    }

    #[test]
    fn rework_item_minimal() {
        let item = ReworkItem {
            item_id: "ri_min".into(),
            source_run_id: "r_1".into(),
            source_step_id: "sp_0".into(),
            source_role_id: "reviewer".into(),
            responsible_role: "unknown".into(),
            target_role_id: None,
            target_agent_id: None,
            target_run_id: None,
            reason: "Something needs fixing".into(),
            evidence: String::new(),
            suggested_action: String::new(),
            severity: None,
            created_at: 1,
        };
        let json = serde_json::to_string(&item).unwrap();
        let de: ReworkItem = serde_json::from_str(&json).unwrap();
        assert!(de.target_role_id.is_none());
        assert!(de.severity.is_none());
    }
}
