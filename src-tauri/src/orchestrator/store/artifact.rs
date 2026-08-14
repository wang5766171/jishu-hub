use super::*;

impl TaskStore {
    pub fn save_artifact(&self, artifact: &ArtifactRef) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO artifact_ref
             (artifact_id, run_id, node_run_id, attempt_id, name, artifact_type,
              hash, sensitivity, created_at, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                artifact.artifact_id,
                artifact.run_id,
                artifact.node_run_id,
                artifact.attempt_id,
                artifact.name,
                artifact.artifact_type,
                artifact.hash,
                serde_json::to_string(&artifact.sensitivity)?,
                artifact.created_at,
                serde_json::to_string(&artifact.metadata)?,
            ],
        )?;
        Ok(())
    }

    pub fn list_artifacts(&self, run_id: &str) -> Result<Vec<ArtifactRef>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT artifact_id, run_id, node_run_id, attempt_id, name, artifact_type,
                    hash, sensitivity, created_at, metadata
             FROM artifact_ref WHERE run_id = ?1 ORDER BY created_at, artifact_id",
        )?;
        let artifacts = stmt
            .query_map(params![run_id], |row| {
                let sensitivity_json: String = row.get(7)?;
                let metadata_json: String = row.get(9)?;
                Ok(ArtifactRef {
                    artifact_id: row.get(0)?,
                    run_id: row.get(1)?,
                    node_run_id: row.get(2)?,
                    attempt_id: row.get(3)?,
                    name: row.get(4)?,
                    artifact_type: row.get(5)?,
                    hash: row.get(6)?,
                    sensitivity: decode_json_column(&sensitivity_json, 7)?,
                    created_at: row.get(8)?,
                    metadata: decode_json_column(&metadata_json, 9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(artifacts)
    }

    /// Fetch a single artifact by id (§11.2 `artifact_get`). Returns `None` if
    /// no artifact has the given id.
    pub fn get_artifact(&self, artifact_id: &str) -> Result<Option<ArtifactRef>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let artifact = conn
            .query_row(
                "SELECT artifact_id, run_id, node_run_id, attempt_id, name, artifact_type,
                        hash, sensitivity, created_at, metadata
                 FROM artifact_ref WHERE artifact_id = ?1",
                params![artifact_id],
                |row| {
                    let sensitivity_json: String = row.get(7)?;
                    let metadata_json: String = row.get(9)?;
                    Ok(ArtifactRef {
                        artifact_id: row.get(0)?,
                        run_id: row.get(1)?,
                        node_run_id: row.get(2)?,
                        attempt_id: row.get(3)?,
                        name: row.get(4)?,
                        artifact_type: row.get(5)?,
                        hash: row.get(6)?,
                        sensitivity: decode_json_column(&sensitivity_json, 7)?,
                        created_at: row.get(8)?,
                        metadata: decode_json_column(&metadata_json, 9)?,
                    })
                },
            )
            .optional()?;
        Ok(artifact)
    }

    /// Run a controlled (PASSIVE) WAL checkpoint, returning how many WAL frames
    /// were processed. The outcome lets callers and tests confirm the checkpoint
    /// actually engaged the WAL machinery rather than being a silent no-op.
    pub fn checkpoint(&self) -> Result<WalCheckpointOutcome, StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        // `PRAGMA wal_checkpoint(PASSIVE)` returns (busy, log, checkpointed):
        //   busy         = 1 if the checkpoint could not start because a reader
        //                  holds a lock past the most recent frame, else 0;
        //   log          = frames in the WAL log file at checkpoint time;
        //   checkpointed = frames successfully copied back to the main database.
        let (busy, log_frames, checkpointed_frames) =
            conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
        Ok(WalCheckpointOutcome {
            busy: busy != 0,
            log_frames,
            checkpointed_frames,
        })
    }
}
