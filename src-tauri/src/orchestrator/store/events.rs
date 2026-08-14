use super::*;

impl TaskStore {
    pub fn append_events(&self, events: &[TaskEvent]) -> Result<u64, StoreError> {
        if events.is_empty() {
            return Ok(0);
        }

        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;

        let run_id = &events[0].run_id;
        if events.iter().any(|event| event.run_id != *run_id) {
            return Err(StoreError::Conflict(
                "an event batch cannot contain multiple runs".into(),
            ));
        }
        let current_seq: u64 = tx.query_row(
            "SELECT run_seq FROM graph_run WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;
        for (index, event) in events.iter().enumerate() {
            let expected_seq = current_seq + index as u64 + 1;
            if event.run_seq != expected_seq {
                return Err(StoreError::Conflict(format!(
                    "expected run sequence {expected_seq}, got {}",
                    event.run_seq
                )));
            }
        }
        let max_seq = events
            .last()
            .map(|event| event.run_seq)
            .unwrap_or(current_seq);

        for event in events {
            insert_event(&tx, event)?;
        }
        tx.execute(
            "UPDATE graph_run SET run_seq = ?1 WHERE run_id = ?2",
            params![max_seq, run_id],
        )?;

        tx.commit()?;
        Ok(max_seq)
    }

    /// Get events for a run starting from a given sequence number.
    pub fn events_after(
        &self,
        run_id: &str,
        after_seq: u64,
        limit: u64,
    ) -> Result<Vec<TaskEvent>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT event_id, run_id, run_seq, event_type, schema_version,
                    occurred_at, actor, causation_id, correlation_id, payload
             FROM task_event
             WHERE run_id = ?1 AND run_seq > ?2
             ORDER BY run_seq
             LIMIT ?3",
        )?;

        let events = stmt
            .query_map(params![run_id, after_seq, limit], |row| {
                let event_type_json: String = row.get(3)?;
                let payload_json: String = row.get(9)?;
                Ok(TaskEvent {
                    event_id: row.get(0)?,
                    run_id: row.get(1)?,
                    run_seq: row.get(2)?,
                    event_type: decode_json_column(&event_type_json, 3)?,
                    schema_version: row.get(4)?,
                    occurred_at: row.get(5)?,
                    actor: row.get(6)?,
                    causation_id: row.get(7)?,
                    correlation_id: row.get(8)?,
                    payload: decode_json_column(&payload_json, 9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(events)
    }

    /// Get all events for a run (for replay).
    pub fn all_events(&self, run_id: &str) -> Result<Vec<TaskEvent>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT event_id, run_id, run_seq, event_type, schema_version,
                    occurred_at, actor, causation_id, correlation_id, payload
             FROM task_event
             WHERE run_id = ?1
             ORDER BY run_seq",
        )?;

        let events = stmt
            .query_map(params![run_id], |row| {
                let event_type_json: String = row.get(3)?;
                let payload_json: String = row.get(9)?;
                Ok(TaskEvent {
                    event_id: row.get(0)?,
                    run_id: row.get(1)?,
                    run_seq: row.get(2)?,
                    event_type: decode_json_column(&event_type_json, 3)?,
                    schema_version: row.get(4)?,
                    occurred_at: row.get(5)?,
                    actor: row.get(6)?,
                    causation_id: row.get(7)?,
                    correlation_id: row.get(8)?,
                    payload: decode_json_column(&payload_json, 9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(events)
    }

    // ── Projection checkpoint ─────────────────────────────────────────
}
