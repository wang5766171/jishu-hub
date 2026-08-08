use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use super::policy::NodePolicy;
use super::revision::{PlannerPolicyRef, SkillRef, TemplateRef};

/// Run-level status machine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Draft,
    Validating,
    Ready,
    Running,
    Paused,
    AwaitingHuman,
    Completed,
    Failed,
    Cancelled,
}

impl Default for RunStatus {
    fn default() -> Self {
        Self::Draft
    }
}

impl RunStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Draft
                | Self::Validating
                | Self::Ready
                | Self::Running
                | Self::Paused
                | Self::AwaitingHuman
        )
    }

    pub fn can_pause(&self) -> bool {
        matches!(self, Self::Running)
    }

    pub fn can_resume(&self) -> bool {
        matches!(self, Self::Paused | Self::AwaitingHuman)
    }
}

/// NodeRun-level status machine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NodeRunStatus {
    Blocked,
    Ready,
    Leased,
    Running,
    AwaitingApproval,
    RetryWait,
    Repairing,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    Superseded,
}

impl Default for NodeRunStatus {
    fn default() -> Self {
        Self::Blocked
    }
}

impl NodeRunStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Skipped | Self::Cancelled | Self::Superseded
        )
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Ready
                | Self::Leased
                | Self::Running
                | Self::AwaitingApproval
                | Self::RetryWait
                | Self::Repairing
        )
    }

    /// Nodes that are frozen during a hot-swap revision.
    pub fn is_frozen(&self) -> bool {
        matches!(
            self,
            Self::Leased
                | Self::Running
                | Self::AwaitingApproval
                | Self::Succeeded
                | Self::Failed
                | Self::Repairing
        )
    }
}

/// One execution of a GraphRevision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphRun {
    pub run_id: String,
    pub graph_id: String,
    pub active_revision_id: String,
    pub status: RunStatus,
    /// Monotonically increasing sequence within this run.
    pub run_seq: u64,
    pub budget_state: BudgetState,
    #[serde(default)]
    pub planning_snapshot: RunPlanningSnapshot,
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
}

/// A validated candidate revision waiting to be applied to an active run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRevisionProposal {
    pub proposal_id: String,
    pub run_id: String,
    pub base_revision_id: String,
    pub candidate_revision_id: String,
    pub expected_run_seq: u64,
    pub frozen_node_ids: Vec<String>,
    pub superseded_node_ids: Vec<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RunPlanningSnapshot {
    pub revision_content_hash: String,
    #[serde(default)]
    pub skill_refs: Vec<SkillRef>,
    #[serde(default)]
    pub template_refs: Vec<TemplateRef>,
    #[serde(default)]
    pub planner_policy_refs: Vec<PlannerPolicyRef>,
    #[serde(default)]
    pub node_policies: HashMap<String, NodePolicy>,
}

/// Budget tracking for a run.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BudgetState {
    pub token_used: u64,
    pub token_limit: Option<u64>,
    pub cost_used_usd: f64,
    pub cost_limit_usd: Option<f64>,
    pub deadline_ms: Option<u64>,
}

impl BudgetState {
    pub fn is_exhausted(&self) -> bool {
        if let Some(limit) = self.token_limit {
            if self.token_used >= limit {
                return true;
            }
        }
        if let Some(limit) = self.cost_limit_usd {
            if self.cost_used_usd >= limit {
                return true;
            }
        }
        false
    }

    pub fn consume(&mut self, tokens: u64, cost_usd: f64) {
        self.token_used += tokens;
        self.cost_used_usd += cost_usd;
    }
}

/// Logical running state of a node within a specific run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRun {
    pub node_run_id: String,
    pub run_id: String,
    pub node_id: String,
    pub status: NodeRunStatus,
    /// The revision this node run was created under.
    pub revision_id: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    /// Retry attempt count (0 = first attempt).
    pub attempt_count: u32,
    /// Wake time for retry_wait or loop sleeping (epoch ms).
    pub wake_at: Option<i64>,
    /// Error message if failed.
    pub error: Option<String>,
    /// Loop iteration number (if part of a loop).
    pub loop_iteration: Option<u32>,
    /// Whether this node run has been superseded by a revision swap.
    pub superseded: bool,
}

impl NodeRun {
    pub fn new(
        node_run_id: impl Into<String>,
        run_id: impl Into<String>,
        node_id: impl Into<String>,
        revision_id: impl Into<String>,
    ) -> Self {
        Self {
            node_run_id: node_run_id.into(),
            run_id: run_id.into(),
            node_id: node_id.into(),
            status: NodeRunStatus::Blocked,
            revision_id: revision_id.into(),
            started_at: None,
            finished_at: None,
            attempt_count: 0,
            wake_at: None,
            error: None,
            loop_iteration: None,
            superseded: false,
        }
    }
}

/// A single real execution attempt of a node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeAttempt {
    pub attempt_id: String,
    pub node_run_id: String,
    pub attempt_number: u32,
    /// Resolved agent assignment (Run-layer binding).
    pub agent_assignment: Option<AgentAssignment>,
    /// Transport used (for diagnostics, not for branching).
    #[serde(default)]
    pub transport: Option<String>,
    /// Native session id from the agent.
    pub session_id: Option<String>,
    /// Lease held during this attempt.
    pub lease: Option<Lease>,
    /// Token / cost usage for this attempt.
    #[serde(default)]
    pub usage: AttemptUsage,
    /// Error classification if failed.
    pub error: Option<AttemptError>,
    /// Idempotency key.
    pub idempotency_key: Option<String>,
    /// Checkpoint data for recovery.
    pub checkpoint: Option<serde_json::Value>,
    /// 派发给子代理的 prompt（三角色识别用；老数据可能为 None）。
    #[serde(default)]
    pub dispatch_prompt: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

/// 节点会话摘要（侧边栏任务二级树用）。
///
/// 设计 `docs/task-exec-dev/02-总体设计.md` §6.2。
/// 每个节点只返回最新 attempt 的 session_id / agent_id。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSessionSummary {
    pub node_id: String,
    pub node_run_id: String,
    /// NodeRunStatus 序列化后的字符串（如 "pending" / "running" / "succeeded"）。
    pub status: String,
    /// 最新 attempt 编号（从 0 开始；无 attempt 时为 0）。
    pub attempt_number: u32,
    /// 子代理 session id（可能为 null——节点尚未产生 attempt）。
    pub session_id: Option<String>,
    /// 解析后的 agent id（从 agent_assignment JSON 列提取；可能为 null）。
    pub agent_id: Option<String>,
    /// 节点中文标题（来自 run 执行所用 revision，缺失时回退 graph 的 current_draft_revision）。
    /// 侧边栏二级树直接显示此字段，无需前端再反查 revision。绝不应为裸 node_id（n1/n2）。
    pub title: String,
}

/// 单次 attempt 的派发 prompt（三角色识别用）。
///
/// 设计 `docs/task-exec-dev/02-总体设计.md` §7.1 方案 A。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptDispatch {
    pub attempt_number: u32,
    pub dispatched_at: i64,
    /// 派发给子代理的完整 prompt（含 policy 前缀包装）。
    pub prompt: String,
}

/// Usage for a single attempt.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AttemptUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
}

/// Actual agent binding resolved at run time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAssignment {
    pub agent_id: String,
    pub role_id: String,
    pub adapter_capability_snapshot: Vec<String>,
}

/// Lease granted by Resource Arbiter before execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lease {
    pub lease_id: String,
    pub node_run_id: String,
    pub attempt_id: String,
    pub owner: String,
    pub resources: Vec<LeasedResource>,
    pub expires_at: i64,
    pub heartbeat_deadline: i64,
}

/// A resource held by a lease.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LeasedResource {
    GlobalConcurrencySlot,
    CapabilitySlot { capability: String },
    DirectoryLock { path: PathBuf, mode: LockMode },
    CpuWeight { weight: u32 },
    MemoryMb { mb: u64 },
    TokenQuota { tokens: u64 },
    CostQuota { usd: f64 },
    NetworkQuota { name: String },
    ApprovalPermit { scope: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum LockMode {
    Shared,
    Exclusive,
}

/// Error classification for an attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptError {
    pub category: ErrorCategory,
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
    pub provider_detail: Option<String>,
}

/// Error categories per design doc section 9.1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Transient,
    Repairable,
    Policy,
    Deterministic,
    LostLease,
    NoProgress,
}

/// Structured task error (design doc section 15).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskError {
    pub code: String,
    pub category: TaskErrorCategory,
    pub message_key: String,
    pub field_path: Option<String>,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
    pub current_revision: Option<String>,
    pub current_run_seq: Option<u64>,
    pub remediation: Option<String>,
    pub provider_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskErrorCategory {
    Domain,
    Resource,
    Adapter,
    Policy,
    Conflict,
    Store,
    Internal,
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{:?}] {}: {}",
            self.category, self.code, self.message_key
        )
    }
}

impl std::error::Error for TaskError {}

/// Approval request record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub run_id: String,
    pub node_run_id: String,
    pub description: String,
    pub risk_level: String,
    pub scope: Vec<String>,
    pub requester: String,
    pub resolver: Option<String>,
    pub resolved: bool,
    pub approved: Option<bool>,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

/// Artifact reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub artifact_id: String,
    pub run_id: String,
    pub node_run_id: String,
    pub attempt_id: String,
    pub name: String,
    pub artifact_type: String,
    pub hash: String,
    pub sensitivity: ArtifactSensitivity,
    pub created_at: i64,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactSensitivity {
    Public,
    Internal,
    Confidential,
    Restricted,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_status_terminal() {
        assert!(RunStatus::Completed.is_terminal());
        assert!(RunStatus::Failed.is_terminal());
        assert!(RunStatus::Cancelled.is_terminal());
        assert!(!RunStatus::Running.is_terminal());
    }

    #[test]
    fn run_status_can_pause_resume() {
        assert!(RunStatus::Running.can_pause());
        assert!(!RunStatus::Completed.can_pause());
        assert!(RunStatus::Paused.can_resume());
        assert!(RunStatus::AwaitingHuman.can_resume());
        assert!(!RunStatus::Running.can_resume());
    }

    #[test]
    fn node_run_status_frozen() {
        assert!(NodeRunStatus::Running.is_frozen());
        assert!(NodeRunStatus::Leased.is_frozen());
        assert!(NodeRunStatus::AwaitingApproval.is_frozen());
        assert!(NodeRunStatus::Succeeded.is_frozen());
        assert!(!NodeRunStatus::Blocked.is_frozen());
        assert!(!NodeRunStatus::Ready.is_frozen());
    }

    #[test]
    fn budget_state_exhausted() {
        let mut budget = BudgetState {
            token_used: 900,
            token_limit: Some(1000),
            cost_used_usd: 0.0,
            cost_limit_usd: None,
            deadline_ms: None,
        };
        assert!(!budget.is_exhausted());
        budget.consume(200, 0.0);
        assert!(budget.is_exhausted());
    }

    #[test]
    fn node_run_new_is_blocked() {
        let nr = NodeRun::new("nr_1", "run_1", "node_a", "rev_1");
        assert_eq!(nr.status, NodeRunStatus::Blocked);
        assert_eq!(nr.attempt_count, 0);
        assert!(!nr.superseded);
    }

    #[test]
    fn task_error_display() {
        let err = TaskError {
            code: "DAG_CYCLE".into(),
            category: TaskErrorCategory::Domain,
            message_key: "error.dag_cycle".into(),
            field_path: None,
            retryable: false,
            retry_after_ms: None,
            current_revision: None,
            current_run_seq: None,
            remediation: Some("Remove the cycle".into()),
            provider_detail: None,
        };
        let s = format!("{err}");
        assert!(s.contains("DAG_CYCLE"));
    }
}
