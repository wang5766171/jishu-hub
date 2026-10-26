use super::run::{NodeRunStatus, RunStatus};
use thiserror::Error;

/// Validation error for graph structure.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ValidationError {
    #[error("duplicate node id detected")]
    DuplicateNodeId,

    #[error("node {node_id} references nonexistent parent {parent_id}")]
    DanglingParent { node_id: String, parent_id: String },

    #[error("node {node_id} is its own parent")]
    SelfParent { node_id: String },

    #[error("edge {edge_id} references nonexistent node {missing}")]
    DanglingEdge { edge_id: String, missing: String },

    #[error("cycle detected involving nodes: {nodes:?}")]
    CycleDetected { nodes: Vec<String> },

    #[error("parent cycle detected starting from node {node_id}")]
    ParentCycle { node_id: String },

    #[error("duplicate edge id: {edge_id}")]
    DuplicateEdgeId { edge_id: String },

    #[error("self-loop edge: {edge_id} on node {node_id}")]
    SelfLoopEdge { edge_id: String, node_id: String },

    #[error("duplicate edge between {source_node} and {target_node}")]
    DuplicateEdge {
        source_node: String,
        target_node: String,
    },

    #[error("loop node {node_id} has no body nodes")]
    EmptyLoopBody { node_id: String },

    #[error("loop node {node_id} has no termination condition")]
    MissingTermination { node_id: String },

    #[error("loop node {node_id} has no hard budget")]
    MissingLoopBudget { node_id: String },

    #[error("loop node {node_id} has invalid body reference {body_node_id}: {reason}")]
    InvalidLoopBody {
        node_id: String,
        body_node_id: String,
        reason: String,
    },

    #[error("executable node {node_id} has no payload")]
    MissingExecutablePayload { node_id: String },

    #[error("goal node {node_id} cannot have a parent")]
    GoalWithParent { node_id: String },

    #[error("multiple goal nodes found")]
    MultipleGoals,

    #[error("task graph must contain exactly one goal node")]
    MissingGoal,

    #[error("edge {edge_id} cannot target goal node {node_id}")]
    GoalDependencyTarget { edge_id: String, node_id: String },

    #[error("node {node_id} references nonexistent role {role_id}")]
    DanglingRole { node_id: String, role_id: String },

    #[error("policy path must be project-relative and stay within the project root: {path}")]
    PathEscape { path: String },

    #[error("node {node_id} has inconsistent permission policy: {detail}")]
    PermissionMismatch { node_id: String, detail: String },
}

/// Result of full graph validation.
#[derive(Debug, Clone)]
pub struct ValidationResult {
    pub warnings: Vec<String>,
}

/// State machine transition error for RunStatus.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RunTransitionError {
    #[error("invalid transition from {from:?} to {to:?}")]
    InvalidTransition { from: RunStatus, to: RunStatus },

    #[error("terminal status {status:?} cannot transition")]
    TerminalStatus { status: RunStatus },
}

/// State machine transition error for NodeRunStatus.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NodeRunTransitionError {
    #[error("invalid transition from {from:?} to {to:?}")]
    InvalidTransition {
        from: NodeRunStatus,
        to: NodeRunStatus,
    },

    #[error("terminal status {status:?} cannot transition")]
    TerminalStatus { status: NodeRunStatus },
}

/// Validate a RunStatus transition.
pub fn validate_run_transition(from: &RunStatus, to: &RunStatus) -> Result<(), RunTransitionError> {
    use RunStatus::*;

    // v0.9.3 需求5：失败节点人工干预（重试/跳过）后 run 从 Failed 拉回
    // Running——引擎下一 tick 重新调度（重试）或放行下游（跳过）。这是唯一
    // 允许离开终态的转移：由用户显式决策触发，非引擎自动流转。
    if matches!((from, to), (Failed, Running)) {
        return Ok(());
    }

    if from.is_terminal() {
        return Err(RunTransitionError::TerminalStatus {
            status: from.clone(),
        });
    }

    let valid = matches!(
        (from, to),
        (Draft, Validating)
            | (Draft, Ready)
            | (Draft, Cancelled)
            | (Validating, Ready)
            | (Validating, Draft)
            | (Validating, Failed)
            | (Ready, Running)
            | (Ready, Cancelled)
            | (Running, Paused)
            | (Running, AwaitingHuman)
            | (Running, Completed)
            | (Running, Failed)
            | (Running, Cancelled)
            | (Paused, Running)
            | (Paused, Cancelled)
            | (AwaitingHuman, Running)
            | (AwaitingHuman, Paused)
            | (AwaitingHuman, Cancelled)
    );

    if valid {
        Ok(())
    } else {
        Err(RunTransitionError::InvalidTransition {
            from: from.clone(),
            to: to.clone(),
        })
    }
}

/// Validate a NodeRunStatus transition.
pub fn validate_node_run_transition(
    from: &NodeRunStatus,
    to: &NodeRunStatus,
) -> Result<(), NodeRunTransitionError> {
    use NodeRunStatus::*;

    // v0.9.3 需求5：人工干预——失败节点重试（Failed→Blocked，重新进入调度
    // 管线：就绪判定以 Blocked 为可调度态）或跳过（Failed→Skipped，下游继续）。
    // 唯一允许离开 Failed 终态的转移（须在终态早退之前判定）。
    if matches!((from, to), (Failed, Blocked) | (Failed, Skipped)) {
        return Ok(());
    }

    if from.is_terminal() {
        return Err(NodeRunTransitionError::TerminalStatus {
            status: from.clone(),
        });
    }

    // Superseded and Cancelled are always reachable from non-terminal states.
    if matches!(to, Superseded | Cancelled) {
        return Ok(());
    }

    let valid = match (from, to) {
        (Blocked, Ready | Skipped) => true,
        (Ready, Leased | Skipped | Blocked) => true,
        (Leased, Running | Ready | Failed) => true,
        (Running, AwaitingApproval | Succeeded | Failed | RetryWait | Repairing) => true,
        (AwaitingApproval, Running | Succeeded | Failed) => true,
        (RetryWait, Ready) => true,
        (Repairing, Ready | Failed) => true,
        _ => false,
    };

    if valid {
        Ok(())
    } else {
        Err(NodeRunTransitionError::InvalidTransition {
            from: from.clone(),
            to: to.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_status_valid_transitions() {
        assert!(validate_run_transition(&RunStatus::Draft, &RunStatus::Validating).is_ok());
        assert!(validate_run_transition(&RunStatus::Validating, &RunStatus::Ready).is_ok());
        assert!(validate_run_transition(&RunStatus::Ready, &RunStatus::Running).is_ok());
        assert!(validate_run_transition(&RunStatus::Running, &RunStatus::Paused).is_ok());
        assert!(validate_run_transition(&RunStatus::Paused, &RunStatus::Running).is_ok());
        assert!(validate_run_transition(&RunStatus::Running, &RunStatus::Completed).is_ok());
        assert!(validate_run_transition(&RunStatus::Running, &RunStatus::Failed).is_ok());
        // v0.9.3 需求5：失败后人工干预（节点重试/跳过）允许拉回 Running。
        assert!(validate_run_transition(&RunStatus::Failed, &RunStatus::Running).is_ok());
    }

    #[test]
    fn run_status_invalid_transitions() {
        assert!(validate_run_transition(&RunStatus::Completed, &RunStatus::Running).is_err());
        assert!(validate_run_transition(&RunStatus::Failed, &RunStatus::Completed).is_err());
        assert!(validate_run_transition(&RunStatus::Draft, &RunStatus::Running).is_err());
        assert!(validate_run_transition(&RunStatus::Completed, &RunStatus::Cancelled).is_err());
    }

    #[test]
    fn node_run_valid_transitions() {
        assert!(
            validate_node_run_transition(&NodeRunStatus::Blocked, &NodeRunStatus::Ready).is_ok()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Ready, &NodeRunStatus::Leased).is_ok()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Leased, &NodeRunStatus::Running).is_ok()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Running, &NodeRunStatus::Succeeded)
                .is_ok()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Running, &NodeRunStatus::Failed).is_ok()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Running, &NodeRunStatus::RetryWait)
                .is_ok()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::RetryWait, &NodeRunStatus::Ready).is_ok()
        );
        // v0.9.3 需求5：失败节点人工重试/跳过。
        assert!(
            validate_node_run_transition(&NodeRunStatus::Failed, &NodeRunStatus::Blocked).is_ok()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Failed, &NodeRunStatus::Skipped).is_ok()
        );
        // 其他终态去向仍禁止（Succeeded 不可重试）。
        assert!(
            validate_node_run_transition(&NodeRunStatus::Succeeded, &NodeRunStatus::Blocked)
                .is_err()
        );
    }

    #[test]
    fn node_run_invalid_transitions() {
        assert!(
            validate_node_run_transition(&NodeRunStatus::Succeeded, &NodeRunStatus::Running)
                .is_err()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Failed, &NodeRunStatus::Ready).is_err()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Blocked, &NodeRunStatus::Running).is_err()
        );
    }

    #[test]
    fn node_run_superseded_always_reachable() {
        assert!(
            validate_node_run_transition(&NodeRunStatus::Ready, &NodeRunStatus::Superseded).is_ok()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Blocked, &NodeRunStatus::Superseded)
                .is_ok()
        );
    }

    #[test]
    fn node_run_cancelled_always_reachable() {
        assert!(
            validate_node_run_transition(&NodeRunStatus::Running, &NodeRunStatus::Cancelled)
                .is_ok()
        );
        assert!(
            validate_node_run_transition(&NodeRunStatus::Ready, &NodeRunStatus::Cancelled).is_ok()
        );
    }
}
