use super::*;

impl TaskStore {
    pub fn save_projection_checkpoint(
        &self,
        run_id: &str,
        last_seq: u64,
        projection_json: &str,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO projection_checkpoint
             (run_id, last_seq, projection_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![run_id, last_seq, projection_json, updated_at],
        )?;
        Ok(())
    }

    pub fn get_projection_checkpoint(
        &self,
        run_id: &str,
    ) -> Result<Option<(u64, String)>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let result = conn
            .query_row(
                "SELECT last_seq, projection_json FROM projection_checkpoint WHERE run_id = ?1",
                params![run_id],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?)),
            )
            .optional()?;
        Ok(result)
    }

    // ── NodeRun operations ────────────────────────────────────────────

    // ── NodeRun operations ────────────────────────────────────────────
}

impl ProjectionReadModel for TaskStore {
    fn events_after(
        &self,
        run_id: &str,
        after_seq: u64,
        limit: u64,
    ) -> Result<Vec<crate::orchestrator::events::TaskEvent>, StoreError> {
        self.events_after(run_id, after_seq, limit)
    }

    fn all_events(
        &self,
        run_id: &str,
    ) -> Result<Vec<crate::orchestrator::events::TaskEvent>, StoreError> {
        self.all_events(run_id)
    }

    fn get_projection_checkpoint(&self, run_id: &str) -> Result<Option<(u64, String)>, StoreError> {
        self.get_projection_checkpoint(run_id)
    }

    fn save_projection_checkpoint(
        &self,
        run_id: &str,
        last_seq: u64,
        projection_json: &str,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        self.save_projection_checkpoint(run_id, last_seq, projection_json, updated_at)
    }
}

// Also implement for Arc<TaskStore> since service.rs holds an Arc
impl ProjectionReadModel for std::sync::Arc<TaskStore> {
    fn events_after(
        &self,
        run_id: &str,
        after_seq: u64,
        limit: u64,
    ) -> Result<Vec<crate::orchestrator::events::TaskEvent>, StoreError> {
        self.as_ref().events_after(run_id, after_seq, limit)
    }

    fn all_events(
        &self,
        run_id: &str,
    ) -> Result<Vec<crate::orchestrator::events::TaskEvent>, StoreError> {
        self.as_ref().all_events(run_id)
    }

    fn get_projection_checkpoint(&self, run_id: &str) -> Result<Option<(u64, String)>, StoreError> {
        self.as_ref().get_projection_checkpoint(run_id)
    }

    fn save_projection_checkpoint(
        &self,
        run_id: &str,
        last_seq: u64,
        projection_json: &str,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        self.as_ref()
            .save_projection_checkpoint(run_id, last_seq, projection_json, updated_at)
    }
}
