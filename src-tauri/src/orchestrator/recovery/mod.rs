use serde::{Deserialize, Serialize};

use crate::orchestrator::domain::run::{ErrorCategory, NodeRun, NodeRunStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStrategy {
    RetryNow,
    SkipNode,
    FailNode,
}

/// Automatic recovery decision produced by the central dispatcher (design §9.1).
/// Distinct from `RecoveryStrategy`, which is the manual, user-driven override.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// Back off and retry the node (new attempt). Caller computes backoff from retry policy.
    Retry,
    /// Generate a bounded Repair subgraph (new candidate revision) and re-run.
    Repair,
    /// Pause for a human decision (AwaitingHuman).
    HumanGate { reason: String },
    /// Give up on the node (terminal Failed).
    Fail,
}

/// Inputs to `decide_recovery`. Encodes the §9.1 category → action mapping with
/// the guard rails (retries/repair depth/budget) that escalate to HumanGate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryContext {
    pub category: ErrorCategory,
    /// True when retry policy + idempotency still allow another attempt.
    pub retries_remaining: bool,
    /// Current repair depth of the source node (0 = no repair yet).
    pub repair_depth: u32,
    /// True when repair is still allowed (depth budget remaining and enabled).
    pub repair_allowed: bool,
    /// True when run-level budget has not been exhausted.
    pub budget_remaining: bool,
}

/// Central recovery dispatcher (design §9.1 / §9.4). Maps an attempt's error
/// category and guard-rail state to a single recovery action. Deterministic —
/// same inputs always yield the same decision.
pub fn decide_recovery(ctx: &RecoveryContext) -> RecoveryDecision {
    match ctx.category {
        ErrorCategory::Transient | ErrorCategory::LostLease => {
            if ctx.retries_remaining {
                RecoveryDecision::Retry
            } else {
                RecoveryDecision::Fail
            }
        }
        ErrorCategory::Repairable => {
            if ctx.repair_allowed && ctx.budget_remaining {
                RecoveryDecision::Repair
            } else {
                RecoveryDecision::HumanGate {
                    reason: "repair depth or budget exhausted".into(),
                }
            }
        }
        ErrorCategory::NoProgress => RecoveryDecision::HumanGate {
            reason: "no progress detected".into(),
        },
        ErrorCategory::Policy => RecoveryDecision::HumanGate {
            reason: "policy requires a human decision".into(),
        },
        ErrorCategory::Deterministic => RecoveryDecision::Fail,
    }
}

pub fn apply_recovery(
    node_run: &mut NodeRun,
    strategy: &RecoveryStrategy,
    now: i64,
) -> Result<(), String> {
    if node_run.status.is_terminal() && node_run.status != NodeRunStatus::Failed {
        return Err(format!(
            "cannot recover terminal node in state {:?}",
            node_run.status
        ));
    }
    match strategy {
        RecoveryStrategy::RetryNow => {
            node_run.status = NodeRunStatus::Blocked;
            node_run.wake_at = None;
            node_run.finished_at = None;
            node_run.error = None;
        }
        RecoveryStrategy::SkipNode => {
            node_run.status = NodeRunStatus::Skipped;
            node_run.finished_at = Some(now);
        }
        RecoveryStrategy::FailNode => {
            node_run.status = NodeRunStatus::Failed;
            node_run.finished_at = Some(now);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_now_clears_wait_and_error_without_losing_attempt_count() {
        let mut run = NodeRun::new("nr", "run", "node", "rev");
        run.status = NodeRunStatus::RetryWait;
        run.attempt_count = 2;
        run.wake_at = Some(100);
        run.error = Some("temporary".into());

        apply_recovery(&mut run, &RecoveryStrategy::RetryNow, 50).unwrap();

        assert_eq!(run.status, NodeRunStatus::Blocked);
        assert_eq!(run.attempt_count, 2);
        assert_eq!(run.wake_at, None);
        assert_eq!(run.error, None);
    }

    fn ctx(category: ErrorCategory) -> RecoveryContext {
        RecoveryContext {
            category,
            retries_remaining: true,
            repair_depth: 0,
            repair_allowed: true,
            budget_remaining: true,
        }
    }

    #[test]
    fn dispatcher_retries_transient_when_retries_remain() {
        assert_eq!(
            decide_recovery(&ctx(ErrorCategory::Transient)),
            RecoveryDecision::Retry
        );
        assert_eq!(
            decide_recovery(&ctx(ErrorCategory::LostLease)),
            RecoveryDecision::Retry
        );
    }

    #[test]
    fn dispatcher_fails_transient_when_retries_exhausted() {
        let mut c = ctx(ErrorCategory::Transient);
        c.retries_remaining = false;
        assert_eq!(decide_recovery(&c), RecoveryDecision::Fail);
    }

    #[test]
    fn dispatcher_repairs_repairable_within_depth_and_budget() {
        assert_eq!(
            decide_recovery(&ctx(ErrorCategory::Repairable)),
            RecoveryDecision::Repair
        );
    }

    #[test]
    fn dispatcher_human_gates_repairable_when_depth_or_budget_exhausted() {
        let mut depth = ctx(ErrorCategory::Repairable);
        depth.repair_allowed = false;
        assert!(matches!(
            decide_recovery(&depth),
            RecoveryDecision::HumanGate { .. }
        ));
        let mut budget = ctx(ErrorCategory::Repairable);
        budget.budget_remaining = false;
        assert!(matches!(
            decide_recovery(&budget),
            RecoveryDecision::HumanGate { .. }
        ));
    }

    #[test]
    fn dispatcher_human_gates_no_progress_and_policy() {
        assert!(matches!(
            decide_recovery(&ctx(ErrorCategory::NoProgress)),
            RecoveryDecision::HumanGate { .. }
        ));
        assert!(matches!(
            decide_recovery(&ctx(ErrorCategory::Policy)),
            RecoveryDecision::HumanGate { .. }
        ));
    }

    #[test]
    fn dispatcher_fails_deterministic() {
        assert_eq!(
            decide_recovery(&ctx(ErrorCategory::Deterministic)),
            RecoveryDecision::Fail
        );
    }
}
