use super::*;

impl TaskStore {
    pub fn create_run(&self, run: &GraphRun) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT INTO graph_run
             (run_id, graph_id, active_revision_id, status, run_seq, budget_state,
              planning_snapshot, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                run.run_id,
                run.graph_id,
                run.active_revision_id,
                serde_json::to_string(&run.status)?,
                run.run_seq,
                serde_json::to_string(&run.budget_state)?,
                serde_json::to_string(&run.planning_snapshot)?,
                run.started_at,
                run.finished_at,
            ],
        )?;
        Ok(())
    }

    pub fn create_run_with_event(
        &self,
        run: &GraphRun,
        event: &TaskEvent,
    ) -> Result<(), StoreError> {
        if event.run_id != run.run_id || event.run_seq != run.run_seq || run.run_seq != 1 {
            return Err(StoreError::Conflict(
                "initial run event must use sequence 1 for the same run".into(),
            ));
        }
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO graph_run
             (run_id, graph_id, active_revision_id, status, run_seq, budget_state,
              planning_snapshot, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                run.run_id,
                run.graph_id,
                run.active_revision_id,
                serde_json::to_string(&run.status)?,
                run.run_seq,
                serde_json::to_string(&run.budget_state)?,
                serde_json::to_string(&run.planning_snapshot)?,
                run.started_at,
                run.finished_at,
            ],
        )?;
        insert_event(&tx, event)?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_run(&self, run_id: &str) -> Result<GraphRun, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let run = conn
            .query_row(
                "SELECT run_id, graph_id, active_revision_id, status, run_seq,
                        budget_state, planning_snapshot, started_at, finished_at
                 FROM graph_run WHERE run_id = ?1",
                params![run_id],
                |row| {
                    let status_json: String = row.get(3)?;
                    let budget_json: String = row.get(5)?;
                    let planning_json: String = row.get(6)?;
                    Ok(GraphRun {
                        run_id: row.get(0)?,
                        graph_id: row.get(1)?,
                        active_revision_id: row.get(2)?,
                        status: decode_json_column(&status_json, 3)?,
                        run_seq: row.get(4)?,
                        budget_state: decode_json_column(&budget_json, 5)?,
                        planning_snapshot: decode_json_column(&planning_json, 6)?,
                        started_at: row.get(7)?,
                        finished_at: row.get(8)?,
                    })
                },
            )
            .optional()?;

        run.ok_or_else(|| StoreError::NotFound(format!("run {run_id}")))
    }

    pub fn get_active_runs(&self) -> Result<Vec<GraphRun>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let running_status = serde_json::to_string(&RunStatus::Running)?;
        let mut stmt = conn.prepare(
            "SELECT run_id, graph_id, active_revision_id, status, run_seq,
                    budget_state, planning_snapshot, started_at, finished_at
             FROM graph_run WHERE status = ?1",
        )?;

        let runs = stmt
            .query_map(params![running_status], |row| {
                let status_json: String = row.get(3)?;
                let budget_json: String = row.get(5)?;
                let planning_json: String = row.get(6)?;
                Ok(GraphRun {
                    run_id: row.get(0)?,
                    graph_id: row.get(1)?,
                    active_revision_id: row.get(2)?,
                    status: decode_json_column(&status_json, 3)?,
                    run_seq: row.get(4)?,
                    budget_state: decode_json_column(&budget_json, 5)?,
                    planning_snapshot: decode_json_column(&planning_json, 6)?,
                    started_at: row.get(7)?,
                    finished_at: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(runs)
    }

    pub fn list_runs(&self, graph_id: &str) -> Result<Vec<GraphRun>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT run_id, graph_id, active_revision_id, status, run_seq,
                    budget_state, planning_snapshot, started_at, finished_at
             FROM graph_run WHERE graph_id = ?1 ORDER BY started_at DESC",
        )?;

        let runs = stmt
            .query_map(params![graph_id], |row| {
                let status_json: String = row.get(3)?;
                let budget_json: String = row.get(5)?;
                let planning_json: String = row.get(6)?;
                Ok(GraphRun {
                    run_id: row.get(0)?,
                    graph_id: row.get(1)?,
                    active_revision_id: row.get(2)?,
                    status: decode_json_column(&status_json, 3)?,
                    run_seq: row.get(4)?,
                    budget_state: decode_json_column(&budget_json, 5)?,
                    planning_snapshot: decode_json_column(&planning_json, 6)?,
                    started_at: row.get(7)?,
                    finished_at: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(runs)
    }

    pub fn update_run_status(
        &self,
        run_id: &str,
        status: &RunStatus,
        run_seq: u64,
        finished_at: Option<i64>,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE graph_run SET status = ?1, run_seq = ?2, finished_at = ?3 WHERE run_id = ?4",
            params![serde_json::to_string(status)?, run_seq, finished_at, run_id,],
        )?;
        if affected == 0 {
            return Err(StoreError::NotFound(format!("run {run_id}")));
        }
        Ok(())
    }

    pub fn transition_run_with_event(
        &self,
        run_id: &str,
        expected_status: &RunStatus,
        new_status: &RunStatus,
        finished_at: Option<i64>,
        event: &TaskEvent,
    ) -> Result<(), StoreError> {
        if event.run_id != run_id {
            return Err(StoreError::Conflict(
                "event belongs to a different run".into(),
            ));
        }
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        let affected = tx.execute(
            "UPDATE graph_run
             SET status = ?1, run_seq = ?2, finished_at = ?3
             WHERE run_id = ?4 AND status = ?5 AND run_seq = ?6",
            params![
                serde_json::to_string(new_status)?,
                event.run_seq,
                finished_at,
                run_id,
                serde_json::to_string(expected_status)?,
                event.run_seq.saturating_sub(1),
            ],
        )?;
        if affected == 0 {
            return Err(StoreError::Conflict(format!(
                "run {run_id} changed before transition"
            )));
        }
        insert_event(&tx, event)?;
        tx.commit()?;
        Ok(())
    }

    pub fn save_run_revision_proposal(
        &self,
        proposal: &RunRevisionProposal,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM run_revision_proposal WHERE run_id = ?1",
            params![proposal.run_id],
        )?;
        tx.execute(
            "INSERT INTO run_revision_proposal
             (proposal_id, run_id, base_revision_id, candidate_revision_id,
              expected_run_seq, frozen_node_ids, superseded_node_ids, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                proposal.proposal_id,
                proposal.run_id,
                proposal.base_revision_id,
                proposal.candidate_revision_id,
                proposal.expected_run_seq,
                serde_json::to_string(&proposal.frozen_node_ids)?,
                serde_json::to_string(&proposal.superseded_node_ids)?,
                proposal.created_at,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_run_revision_proposal(
        &self,
        proposal_id: &str,
    ) -> Result<RunRevisionProposal, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.query_row(
            "SELECT proposal_id, run_id, base_revision_id, candidate_revision_id,
                    expected_run_seq, frozen_node_ids, superseded_node_ids, created_at
             FROM run_revision_proposal WHERE proposal_id = ?1",
            params![proposal_id],
            |row| {
                let frozen_node_ids: String = row.get(5)?;
                let superseded_node_ids: String = row.get(6)?;
                Ok(RunRevisionProposal {
                    proposal_id: row.get(0)?,
                    run_id: row.get(1)?,
                    base_revision_id: row.get(2)?,
                    candidate_revision_id: row.get(3)?,
                    expected_run_seq: row.get(4)?,
                    frozen_node_ids: decode_json_column(&frozen_node_ids, 5)?,
                    superseded_node_ids: decode_json_column(&superseded_node_ids, 6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("run revision proposal {proposal_id}")))
    }

    pub fn apply_run_revision(
        &self,
        proposal: &RunRevisionProposal,
        expected_run_seq: u64,
        planning_snapshot: &RunPlanningSnapshot,
        node_runs: &[NodeRun],
        events: &[TaskEvent],
    ) -> Result<GraphRun, StoreError> {
        if events.is_empty() || events.iter().any(|event| event.run_id != proposal.run_id) {
            return Err(StoreError::Conflict(
                "revision application requires events for the same run".into(),
            ));
        }
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        let (active_revision_id, current_seq): (String, u64) = tx.query_row(
            "SELECT active_revision_id, run_seq FROM graph_run WHERE run_id = ?1",
            params![proposal.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if current_seq != expected_run_seq
            || expected_run_seq != proposal.expected_run_seq
            || active_revision_id != proposal.base_revision_id
        {
            return Err(StoreError::Conflict(format!(
                "run {} changed before revision application",
                proposal.run_id
            )));
        }
        for (index, event) in events.iter().enumerate() {
            let expected_seq = current_seq + index as u64 + 1;
            if event.run_seq != expected_seq {
                return Err(StoreError::Conflict(format!(
                    "expected run sequence {expected_seq}, got {}",
                    event.run_seq
                )));
            }
        }
        for node_run in node_runs {
            tx.execute(
                "INSERT OR REPLACE INTO node_run
                 (node_run_id, run_id, node_id, status, revision_id, started_at, finished_at,
                  attempt_count, wake_at, error, loop_iteration, superseded)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    node_run.node_run_id,
                    node_run.run_id,
                    node_run.node_id,
                    serde_json::to_string(&node_run.status)?,
                    node_run.revision_id,
                    node_run.started_at,
                    node_run.finished_at,
                    node_run.attempt_count,
                    node_run.wake_at,
                    node_run.error,
                    node_run.loop_iteration,
                    node_run.superseded as i32,
                ],
            )?;
        }
        for event in events {
            insert_event(&tx, event)?;
        }
        let final_seq = events
            .last()
            .map(|event| event.run_seq)
            .unwrap_or(current_seq);
        let affected = tx.execute(
            "UPDATE graph_run
             SET active_revision_id = ?1, planning_snapshot = ?2, run_seq = ?3
             WHERE run_id = ?4 AND active_revision_id = ?5 AND run_seq = ?6",
            params![
                proposal.candidate_revision_id,
                serde_json::to_string(planning_snapshot)?,
                final_seq,
                proposal.run_id,
                proposal.base_revision_id,
                current_seq,
            ],
        )?;
        if affected == 0 {
            return Err(StoreError::Conflict(format!(
                "run {} changed before revision application",
                proposal.run_id
            )));
        }
        tx.execute(
            "DELETE FROM run_revision_proposal WHERE proposal_id = ?1",
            params![proposal.proposal_id],
        )?;
        tx.commit()?;
        drop(conn);
        self.get_run(&proposal.run_id)
    }

    // ── TaskEvent operations ──────────────────────────────────────────

    pub fn terminate_run_with_events(
        &self,
        run_id: &str,
        expected_status: &RunStatus,
        new_status: &RunStatus,
        finished_at: i64,
        cancelled_node_run_ids: &[String],
        events: &[TaskEvent],
    ) -> Result<(), StoreError> {
        if events.is_empty() {
            return Err(StoreError::Conflict(
                "run termination must include at least one event".into(),
            ));
        }
        if events.iter().any(|event| event.run_id != run_id) {
            return Err(StoreError::Conflict(
                "termination events must belong to the terminated run".into(),
            ));
        }

        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
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

        let cancelled_status = serde_json::to_string(&NodeRunStatus::Cancelled)?;
        for node_run_id in cancelled_node_run_ids {
            let affected = tx.execute(
                "UPDATE node_run
                 SET status = ?1, finished_at = COALESCE(finished_at, ?2), wake_at = NULL
                 WHERE node_run_id = ?3 AND run_id = ?4",
                params![&cancelled_status, finished_at, node_run_id, run_id],
            )?;
            if affected == 0 {
                return Err(StoreError::Conflict(format!(
                    "node run {node_run_id} changed before run termination"
                )));
            }
            tx.execute(
                "UPDATE node_attempt
                 SET lease = NULL, finished_at = COALESCE(finished_at, ?1)
                 WHERE node_run_id = ?2 AND finished_at IS NULL",
                params![finished_at, node_run_id],
            )?;
        }

        for event in events {
            insert_event(&tx, event)?;
        }
        let final_seq = events
            .last()
            .map(|event| event.run_seq)
            .unwrap_or(current_seq);
        let affected = tx.execute(
            "UPDATE graph_run
             SET status = ?1, run_seq = ?2, finished_at = ?3
             WHERE run_id = ?4 AND status = ?5 AND run_seq = ?6",
            params![
                serde_json::to_string(new_status)?,
                final_seq,
                finished_at,
                run_id,
                serde_json::to_string(expected_status)?,
                current_seq,
            ],
        )?;
        if affected == 0 {
            return Err(StoreError::Conflict(format!(
                "run {run_id} changed before termination"
            )));
        }
        tx.commit()?;
        Ok(())
    }
}
