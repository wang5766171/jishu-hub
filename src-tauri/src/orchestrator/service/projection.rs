use super::*;

impl TaskService {
    /// Get events for a run after a given sequence.
    pub fn run_events_after(
        &self,
        run_id: &str,
        after_seq: u64,
    ) -> Result<Vec<TaskEvent>, TaskServiceError> {
        let store = &self.store;
        Ok(store.events_after(run_id, after_seq, 500)?)
    }

    /// Get the current run projection.
    pub fn run_projection(
        &self,
        run_id: &str,
    ) -> Result<crate::orchestrator::events::RunProjection, TaskServiceError> {
        let ps = crate::orchestrator::projections::checkpoint::ProjectionStore::new(&self.store);
        let now = crate::util::now_ms();
        ps.compute_incremental(run_id, now).map_err(|e| match e {
            StoreError::NotFound(msg) => TaskServiceError::NotFound(msg),
            other => TaskServiceError::Internal(other.to_string()),
        })
    }

    /// Run a WAL checkpoint.
    pub fn checkpoint(&self) -> Result<(), TaskServiceError> {
        let store = &self.store;
        store.checkpoint()?;
        Ok(())
    }
}
