pub mod checkpoint;

pub use checkpoint::ProjectionStore;

use crate::orchestrator::domain::run::{NodeRunStatus, RunStatus};
use crate::orchestrator::events::{rebuild_projection, RunProjection};
use crate::orchestrator::store::{StoreError, TaskStore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A queryable view over the task store that combines persisted projections
/// with incremental event replay.
pub struct ProjectionService<'a> {
    store: &'a TaskStore,
}

impl<'a> ProjectionService<'a> {
    pub fn new(store: &'a TaskStore) -> Self {
        Self { store }
    }

    /// Get the current run projection by combining checkpoint + event replay.
    pub fn run_projection(&self, run_id: &str) -> Result<RunProjection, StoreError> {
        let events = self.store.all_events(run_id)?;
        if events.is_empty() {
            return Err(StoreError::NotFound(format!("no events for run {run_id}")));
        }
        let proj = rebuild_projection(run_id, &events)
            .map_err(|e| StoreError::Conflict(format!("projection error: {e}")))?;
        Ok(proj)
    }

    /// Get events after a sequence number (for incremental client updates).
    pub fn events_after(
        &self,
        run_id: &str,
        after_seq: u64,
    ) -> Result<Vec<crate::orchestrator::events::TaskEvent>, StoreError> {
        self.store.events_after(run_id, after_seq, 500)
    }

    /// Get a summary of node run statuses for a run.
    pub fn node_status_summary(&self, run_id: &str) -> Result<NodeStatusSummary, StoreError> {
        let proj = self.run_projection(run_id)?;
        let mut summary = NodeStatusSummary::default();
        for nr in proj.node_runs.values() {
            match nr.status {
                NodeRunStatus::Blocked => summary.blocked += 1,
                NodeRunStatus::Ready => summary.ready += 1,
                NodeRunStatus::Leased => summary.leased += 1,
                NodeRunStatus::Running => summary.running += 1,
                NodeRunStatus::AwaitingApproval => summary.awaiting_approval += 1,
                NodeRunStatus::RetryWait => summary.retry_wait += 1,
                NodeRunStatus::Repairing => summary.repairing += 1,
                NodeRunStatus::Succeeded => summary.succeeded += 1,
                NodeRunStatus::Failed => summary.failed += 1,
                NodeRunStatus::Skipped => summary.skipped += 1,
                NodeRunStatus::Cancelled => summary.cancelled += 1,
                NodeRunStatus::Superseded => summary.superseded += 1,
            }
        }
        summary.total = proj.node_runs.len() as u32;
        summary.run_status = proj.status;
        Ok(summary)
    }
}

/// Summary of node statuses for a run.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodeStatusSummary {
    pub total: u32,
    pub blocked: u32,
    pub ready: u32,
    pub leased: u32,
    pub running: u32,
    pub awaiting_approval: u32,
    pub retry_wait: u32,
    pub repairing: u32,
    pub succeeded: u32,
    pub failed: u32,
    pub skipped: u32,
    pub cancelled: u32,
    pub superseded: u32,
    #[serde(default)]
    pub run_status: RunStatus,
}

impl NodeStatusSummary {
    pub fn is_all_terminal(&self) -> bool {
        self.blocked == 0
            && self.ready == 0
            && self.leased == 0
            && self.running == 0
            && self.awaiting_approval == 0
            && self.retry_wait == 0
            && self.repairing == 0
    }

    pub fn health_percentage(&self) -> f64 {
        if self.total == 0 {
            return 100.0;
        }
        let good = self.succeeded as f64;
        let bad = (self.failed + self.cancelled) as f64;
        let total = self.total as f64;
        ((good + (total - good - bad - self.skipped as f64 - self.superseded as f64) * 0.5) / total
            * 100.0)
            .clamp(0.0, 100.0)
    }
}
