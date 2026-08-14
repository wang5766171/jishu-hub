use super::*;

impl TaskStore {
    pub fn save_approval(&self, approval: &ApprovalRequest) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO approval_request
             (approval_id, run_id, node_run_id, description, risk_level, scope,
              requester, resolver, resolved, approved, created_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                approval.approval_id,
                approval.run_id,
                approval.node_run_id,
                approval.description,
                approval.risk_level,
                serde_json::to_string(&approval.scope)?,
                approval.requester,
                approval.resolver,
                approval.resolved as i32,
                approval.approved.map(|b| b as i32),
                approval.created_at,
                approval.resolved_at,
            ],
        )?;
        Ok(())
    }

    pub fn save_approval_execution_update(
        &self,
        node_run: &NodeRun,
        approval: &ApprovalRequest,
        events: &[TaskEvent],
    ) -> Result<u64, StoreError> {
        if events.is_empty() {
            return Err(StoreError::Conflict(
                "approval updates must include at least one event".into(),
            ));
        }
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        let current_seq: u64 = tx.query_row(
            "SELECT run_seq FROM graph_run WHERE run_id = ?1",
            params![node_run.run_id],
            |row| row.get(0),
        )?;
        for (index, event) in events.iter().enumerate() {
            let expected_seq = current_seq + index as u64 + 1;
            if event.run_id != node_run.run_id || event.run_seq != expected_seq {
                return Err(StoreError::Conflict(format!(
                    "invalid approval event sequence: expected {expected_seq}, got {}",
                    event.run_seq
                )));
            }
        }

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
        insert_approval(&tx, approval)?;
        for event in events {
            insert_event(&tx, event)?;
        }
        let max_seq = events
            .last()
            .map(|event| event.run_seq)
            .unwrap_or(current_seq);
        tx.execute(
            "UPDATE graph_run SET run_seq = ?1 WHERE run_id = ?2",
            params![max_seq, node_run.run_id],
        )?;
        tx.commit()?;
        Ok(max_seq)
    }

    pub fn get_approval(&self, approval_id: &str) -> Result<ApprovalRequest, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.query_row(
            "SELECT approval_id, run_id, node_run_id, description, risk_level, scope,
                    requester, resolver, resolved, approved, created_at, resolved_at
             FROM approval_request WHERE approval_id = ?1",
            params![approval_id],
            decode_approval,
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("approval {approval_id}")))
    }

    pub fn has_approved_request(
        &self,
        run_id: &str,
        node_run_id: &str,
        scope_marker: &str,
    ) -> Result<bool, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT scope FROM approval_request
             WHERE run_id = ?1 AND node_run_id = ?2
               AND resolved = 1 AND approved = 1",
        )?;
        let scopes = stmt
            .query_map(params![run_id, node_run_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for scope in scopes {
            let decoded: Vec<String> = serde_json::from_str(&scope)?;
            if decoded.iter().any(|value| value == scope_marker) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn pending_approvals(&self, run_id: &str) -> Result<Vec<ApprovalRequest>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT approval_id, run_id, node_run_id, description, risk_level, scope,
                    requester, resolver, resolved, approved, created_at, resolved_at
             FROM approval_request WHERE run_id = ?1 AND resolved = 0",
        )?;

        let approvals = stmt
            .query_map(params![run_id], decode_approval)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(approvals)
    }

    // ── Artifact operations ───────────────────────────────────────────
}

fn insert_approval(
    tx: &rusqlite::Transaction<'_>,
    approval: &ApprovalRequest,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT OR REPLACE INTO approval_request
         (approval_id, run_id, node_run_id, description, risk_level, scope,
          requester, resolver, resolved, approved, created_at, resolved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            approval.approval_id,
            approval.run_id,
            approval.node_run_id,
            approval.description,
            approval.risk_level,
            serde_json::to_string(&approval.scope)?,
            approval.requester,
            approval.resolver,
            approval.resolved as i32,
            approval.approved.map(|value| value as i32),
            approval.created_at,
            approval.resolved_at,
        ],
    )?;
    Ok(())
}

fn decode_approval(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApprovalRequest> {
    let scope_json: String = row.get(5)?;
    Ok(ApprovalRequest {
        approval_id: row.get(0)?,
        run_id: row.get(1)?,
        node_run_id: row.get(2)?,
        description: row.get(3)?,
        risk_level: row.get(4)?,
        scope: decode_json_column(&scope_json, 5)?,
        requester: row.get(6)?,
        resolver: row.get(7)?,
        resolved: row.get::<_, i32>(8)? != 0,
        approved: row.get::<_, Option<i32>>(9)?.map(|value| value != 0),
        created_at: row.get(10)?,
        resolved_at: row.get(11)?,
    })
}
