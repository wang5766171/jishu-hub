use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Default cap on Repair-of-Repair depth when a node does not declare one.
/// Bounds automatic repair so a failing node cannot recurse indefinitely
/// (design §9.3: "每个节点必须有修复深度和总预算上限").
pub const DEFAULT_MAX_REPAIR_DEPTH: u32 = 2;

/// Policy attached to each GraphNode.
/// Proposed by Planner, adjusted by user, validated and enforced by Task Orchestrator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodePolicy {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub retry_policy: RetryPolicy,
    #[serde(default)]
    pub permission_scope: PermissionScope,
    #[serde(default)]
    pub approval_policy: ApprovalPolicy,
    #[serde(default)]
    pub resource_requirements: ResourceRequirements,
    #[serde(default)]
    pub read_set: Vec<PathBuf>,
    #[serde(default)]
    pub write_set: Vec<PathBuf>,
    #[serde(default)]
    pub token_budget: Option<u64>,
    #[serde(default)]
    pub cost_budget_usd: Option<f64>,
    #[serde(default)]
    pub preferred_capabilities: Vec<String>,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub idempotency_policy: IdempotencyPolicy,
    /// Maximum Repair subgraph depth allowed for this node before escalating to
    /// a human gate. `None` falls back to `DEFAULT_MAX_REPAIR_DEPTH`. `Some(0)`
    /// disables automatic repair for the node.
    #[serde(default)]
    pub max_repair_depth: Option<u32>,
}

impl NodePolicy {
    /// Effective repair depth limit. `None` policy → `DEFAULT_MAX_REPAIR_DEPTH`.
    pub fn repair_depth_limit(&self) -> u32 {
        self.max_repair_depth.unwrap_or(DEFAULT_MAX_REPAIR_DEPTH)
    }
}

impl Default for NodePolicy {
    fn default() -> Self {
        Self {
            timeout_ms: None,
            retry_policy: RetryPolicy::default(),
            permission_scope: PermissionScope::default(),
            approval_policy: ApprovalPolicy::default(),
            resource_requirements: ResourceRequirements::default(),
            read_set: vec![],
            write_set: vec![],
            token_budget: None,
            cost_budget_usd: None,
            preferred_capabilities: vec![],
            priority: 0,
            idempotency_policy: IdempotencyPolicy::default(),
            max_repair_depth: None,
        }
    }
}

/// Retry configuration for transient failures.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub backoff_multiplier: f64,
    /// Jitter fraction (0.0 = none, 1.0 = full).
    pub jitter: f64,
    /// Only retry errors classified as transient.
    pub retryable_only: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_backoff_ms: 1000,
            max_backoff_ms: 30000,
            backoff_multiplier: 2.0,
            jitter: 0.1,
            retryable_only: true,
        }
    }
}

impl RetryPolicy {
    /// Compute the backoff duration for a given attempt number (0-based).
    pub fn backoff_ms(&self, attempt: u32) -> u64 {
        let base = self.initial_backoff_ms as f64;
        let exp = self.backoff_multiplier.powi(attempt as i32);
        let raw = (base * exp).min(self.max_backoff_ms as f64) as u64;
        if self.jitter > 0.0 {
            // Simple deterministic jitter based on attempt — real impl uses RNG at runtime.
            let jitter_amount = (raw as f64 * self.jitter) as u64;
            raw.saturating_sub(jitter_amount / 2)
        } else {
            raw
        }
    }

    pub fn should_retry(&self, attempt: u32, is_transient: bool) -> bool {
        if self.retryable_only && !is_transient {
            return false;
        }
        attempt.saturating_add(1) < self.max_attempts
    }
}

/// What permissions this node requires.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PermissionScope {
    pub can_read_files: bool,
    pub can_write_files: bool,
    pub can_run_commands: bool,
    pub can_access_network: bool,
    pub can_deploy: bool,
}

/// When approval is required.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    /// Never requires approval.
    Never,
    /// Requires approval before first execution.
    Once,
    /// Requires approval before every execution.
    Always,
    /// Requires approval when risk exceeds threshold.
    OnHighRisk,
}

impl Default for ApprovalPolicy {
    fn default() -> Self {
        Self::OnHighRisk
    }
}

/// Resource requirements for the Resource Arbiter.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ResourceRequirements {
    /// Estimated CPU weight (relative).
    #[serde(default)]
    pub cpu_weight: Option<u32>,
    /// Estimated memory in MB.
    #[serde(default)]
    pub memory_mb: Option<u64>,
    /// Agent/Adapter capability slots needed.
    #[serde(default)]
    pub capability_slots: Vec<String>,
    /// Project / directory locks needed.
    #[serde(default)]
    pub directory_locks: Vec<PathBuf>,
    /// Network or external service quotas.
    #[serde(default)]
    pub network_quota: Option<String>,
}

/// How idempotency is handled for retries and recovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdempotencyPolicy {
    /// No side effects, safe to retry freely.
    None,
    /// Use a generated idempotency key.
    IdempotencyKey,
    /// Must verify checkpoint before retry.
    CheckpointRequired,
    /// Not safe to retry — fail fast.
    NoRetry,
}

impl Default for IdempotencyPolicy {
    fn default() -> Self {
        Self::IdempotencyKey
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_increases() {
        let policy = RetryPolicy {
            max_attempts: 5,
            initial_backoff_ms: 1000,
            max_backoff_ms: 30000,
            backoff_multiplier: 2.0,
            jitter: 0.0,
            retryable_only: true,
        };
        let b0 = policy.backoff_ms(0);
        let b1 = policy.backoff_ms(1);
        let b2 = policy.backoff_ms(2);
        assert!(b0 < b1);
        assert!(b1 < b2);
    }

    #[test]
    fn retry_should_retry_logic() {
        let policy = RetryPolicy {
            max_attempts: 3,
            initial_backoff_ms: 100,
            max_backoff_ms: 1000,
            backoff_multiplier: 2.0,
            jitter: 0.0,
            retryable_only: true,
        };
        assert!(policy.should_retry(0, true));
        assert!(policy.should_retry(1, true));
        assert!(!policy.should_retry(2, true));
        assert!(!policy.should_retry(0, false));
    }

    #[test]
    fn repair_depth_limit_defaults_when_unset() {
        let policy = NodePolicy::default();
        assert_eq!(policy.repair_depth_limit(), DEFAULT_MAX_REPAIR_DEPTH);
    }

    #[test]
    fn repair_depth_limit_honors_explicit_max() {
        let mut policy = NodePolicy::default();
        policy.max_repair_depth = Some(5);
        assert_eq!(policy.repair_depth_limit(), 5);
    }

    #[test]
    fn repair_depth_limit_zero_disables_repair() {
        let mut policy = NodePolicy::default();
        policy.max_repair_depth = Some(0);
        assert_eq!(policy.repair_depth_limit(), 0);
    }

    #[test]
    fn policy_serialization() {
        let policy = NodePolicy {
            timeout_ms: Some(30000),
            retry_policy: RetryPolicy::default(),
            permission_scope: PermissionScope {
                can_read_files: true,
                can_write_files: true,
                can_run_commands: false,
                can_access_network: false,
                can_deploy: false,
            },
            approval_policy: ApprovalPolicy::Always,
            resource_requirements: ResourceRequirements::default(),
            read_set: vec![PathBuf::from("/project/src")],
            write_set: vec![PathBuf::from("/project/output")],
            token_budget: Some(100000),
            cost_budget_usd: Some(0.50),
            preferred_capabilities: vec!["code_editing".into()],
            priority: 10,
            idempotency_policy: IdempotencyPolicy::CheckpointRequired,
            max_repair_depth: Some(3),
        };
        let json = serde_json::to_string(&policy).unwrap();
        let de: NodePolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(de.timeout_ms, Some(30000));
        assert_eq!(de.priority, 10);
        matches!(de.approval_policy, ApprovalPolicy::Always);
    }
}
