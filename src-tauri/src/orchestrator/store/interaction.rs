use super::*;

impl TaskStore {
    pub fn save_task_interaction(
        &self,
        request: &TaskInteractionRequest,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT INTO task_interaction_request
             (request_id, graph_id, run_id, node_id, node_run_id, session_id, prompt, options,
              allow_multiple, allow_custom_text, required, created_at, resolved_at, consumed_at,
              submission)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                request.request_id,
                request.graph_id,
                request.run_id,
                request.node_id,
                request.node_run_id,
                request.session_id,
                request.prompt,
                serde_json::to_string(&request.options)?,
                request.allow_multiple,
                request.allow_custom_text,
                request.required,
                request.created_at,
                request.resolved_at,
                request.consumed_at,
                request
                    .submission
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
            ],
        )?;
        Ok(())
    }

    pub fn get_task_interaction(
        &self,
        request_id: &str,
    ) -> Result<TaskInteractionRequest, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.query_row(
            "SELECT request_id, graph_id, run_id, node_id, node_run_id, session_id, prompt,
                    options, allow_multiple, allow_custom_text, required, created_at, resolved_at,
                    consumed_at, submission
             FROM task_interaction_request
             WHERE request_id = ?1",
            params![request_id],
            read_task_interaction,
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("task interaction {request_id}")))
    }

    pub fn pending_task_interactions(
        &self,
        graph_id: &str,
    ) -> Result<Vec<TaskInteractionRequest>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT request_id, graph_id, run_id, node_id, node_run_id, session_id, prompt,
                    options, allow_multiple, allow_custom_text, required, created_at, resolved_at,
                    consumed_at, submission
             FROM task_interaction_request
             WHERE graph_id = ?1 AND resolved_at IS NULL
             ORDER BY created_at, request_id",
        )?;
        let requests = stmt
            .query_map(params![graph_id], read_task_interaction)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(requests)
    }

    pub fn resolve_task_interaction(
        &self,
        request_id: &str,
        submission: &TaskInteractionSubmission,
        resolved_at: i64,
    ) -> Result<TaskInteractionRequest, StoreError> {
        let mut conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE task_interaction_request
             SET submission = ?1, resolved_at = ?2
             WHERE request_id = ?3 AND resolved_at IS NULL",
            params![serde_json::to_string(submission)?, resolved_at, request_id],
        )?;
        if changed == 0 {
            let exists = tx
                .query_row(
                    "SELECT 1 FROM task_interaction_request WHERE request_id = ?1",
                    params![request_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            return Err(if exists {
                StoreError::Conflict(format!("task interaction {request_id} is already resolved"))
            } else {
                StoreError::NotFound(format!("task interaction {request_id}"))
            });
        }
        let request = tx.query_row(
            "SELECT request_id, graph_id, run_id, node_id, node_run_id, session_id, prompt,
                    options, allow_multiple, allow_custom_text, required, created_at, resolved_at,
                    consumed_at, submission
             FROM task_interaction_request
             WHERE request_id = ?1",
            params![request_id],
            read_task_interaction,
        )?;
        tx.commit()?;
        Ok(request)
    }

    pub fn take_resolved_task_interaction(
        &self,
        node_run_id: &str,
        consumed_at: i64,
    ) -> Result<Option<TaskInteractionRequest>, StoreError> {
        let mut conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.transaction()?;
        let request = tx
            .query_row(
                "SELECT request_id, graph_id, run_id, node_id, node_run_id, session_id, prompt,
                        options, allow_multiple, allow_custom_text, required, created_at,
                        resolved_at, consumed_at, submission
                 FROM task_interaction_request
                 WHERE node_run_id = ?1 AND resolved_at IS NOT NULL AND consumed_at IS NULL
                 ORDER BY resolved_at, request_id
                 LIMIT 1",
                params![node_run_id],
                read_task_interaction,
            )
            .optional()?;
        let Some(mut request) = request else {
            tx.commit()?;
            return Ok(None);
        };
        tx.execute(
            "UPDATE task_interaction_request
             SET consumed_at = ?1
             WHERE request_id = ?2 AND consumed_at IS NULL",
            params![consumed_at, request.request_id],
        )?;
        request.consumed_at = Some(consumed_at);
        tx.commit()?;
        Ok(Some(request))
    }

    pub fn take_resolved_task_interaction_by_id(
        &self,
        request_id: &str,
        consumed_at: i64,
    ) -> Result<Option<TaskInteractionRequest>, StoreError> {
        let mut conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.transaction()?;
        let request = tx
            .query_row(
                "SELECT request_id, graph_id, run_id, node_id, node_run_id, session_id, prompt,
                        options, allow_multiple, allow_custom_text, required, created_at,
                        resolved_at, consumed_at, submission
                 FROM task_interaction_request
                 WHERE request_id = ?1 AND resolved_at IS NOT NULL AND consumed_at IS NULL",
                params![request_id],
                read_task_interaction,
            )
            .optional()?;
        let Some(mut request) = request else {
            tx.commit()?;
            return Ok(None);
        };
        tx.execute(
            "UPDATE task_interaction_request
             SET consumed_at = ?1
             WHERE request_id = ?2 AND consumed_at IS NULL",
            params![consumed_at, request.request_id],
        )?;
        request.consumed_at = Some(consumed_at);
        tx.commit()?;
        Ok(Some(request))
    }
}

fn read_task_interaction(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskInteractionRequest> {
    let options_json: String = row.get(7)?;
    let submission_json: Option<String> = row.get(14)?;
    Ok(TaskInteractionRequest {
        request_id: row.get(0)?,
        graph_id: row.get(1)?,
        run_id: row.get(2)?,
        node_id: row.get(3)?,
        node_run_id: row.get(4)?,
        session_id: row.get(5)?,
        prompt: row.get(6)?,
        options: decode_json_column(&options_json, 7)?,
        allow_multiple: row.get::<_, i32>(8)? != 0,
        allow_custom_text: row.get::<_, i32>(9)? != 0,
        required: row.get::<_, i32>(10)? != 0,
        created_at: row.get(11)?,
        resolved_at: row.get(12)?,
        consumed_at: row.get(13)?,
        submission: submission_json
            .as_deref()
            .map(|raw| decode_json_column(raw, 14))
            .transpose()?,
    })
}
