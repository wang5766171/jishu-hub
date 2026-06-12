use serde::{Deserialize, Serialize};

use crate::orchestrator::domain::run::{NodeRun, NodeRunStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStrategy {
    RetryNow,
    SkipNode,
    FailNode,
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
}
