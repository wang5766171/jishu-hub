use super::*;

impl TaskStore {
    pub fn save_revision(&self, revision: &GraphRevision) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT INTO graph_revision
             (revision_id, graph_id, parent_revision_id, schema_version, canonical_snapshot,
              content_hash, skill_refs, template_refs, planner_policy_refs, change_summary,
              author, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                revision.revision_id,
                revision.graph_id,
                revision.parent_revision_id,
                revision.schema_version,
                revision.canonical_snapshot.json,
                revision.content_hash.0,
                serde_json::to_string(&revision.skill_refs)?,
                serde_json::to_string(&revision.template_refs)?,
                serde_json::to_string(&revision.planner_policy_refs)?,
                revision.change_summary,
                revision.author,
                revision.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn save_revision_and_update_draft(
        &self,
        graph_id: &str,
        expected_revision_id: &str,
        revision: &GraphRevision,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO graph_revision
             (revision_id, graph_id, parent_revision_id, schema_version, canonical_snapshot,
              content_hash, skill_refs, template_refs, planner_policy_refs, change_summary,
              author, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                revision.revision_id,
                revision.graph_id,
                revision.parent_revision_id,
                revision.schema_version,
                revision.canonical_snapshot.json,
                revision.content_hash.0,
                serde_json::to_string(&revision.skill_refs)?,
                serde_json::to_string(&revision.template_refs)?,
                serde_json::to_string(&revision.planner_policy_refs)?,
                revision.change_summary,
                revision.author,
                revision.created_at,
            ],
        )?;
        let affected = tx.execute(
            "UPDATE task_graph
             SET current_draft_revision = ?1, updated_at = ?2
             WHERE graph_id = ?3 AND current_draft_revision = ?4",
            params![
                revision.revision_id,
                updated_at,
                graph_id,
                expected_revision_id,
            ],
        )?;
        if affected == 0 {
            return Err(StoreError::Conflict(format!(
                "draft revision changed for graph {graph_id}"
            )));
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_revision(&self, revision_id: &str) -> Result<GraphRevision, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let rev = conn
            .query_row(
                "SELECT revision_id, graph_id, parent_revision_id, schema_version,
                        canonical_snapshot, content_hash, skill_refs, template_refs,
                        planner_policy_refs, change_summary, author, created_at
                 FROM graph_revision WHERE revision_id = ?1",
                params![revision_id],
                |row| {
                    let skill_refs_json: String = row.get(6)?;
                    let template_refs_json: String = row.get(7)?;
                    let policy_refs_json: String = row.get(8)?;
                    Ok(GraphRevision {
                        revision_id: row.get(0)?,
                        graph_id: row.get(1)?,
                        parent_revision_id: row.get(2)?,
                        schema_version: row.get(3)?,
                        canonical_snapshot:
                            crate::orchestrator::domain::revision::CanonicalSnapshot {
                                json: row.get(4)?,
                            },
                        content_hash: crate::orchestrator::domain::revision::ContentHash(
                            row.get(5)?,
                        ),
                        skill_refs: decode_json_column(&skill_refs_json, 6)?,
                        template_refs: decode_json_column(&template_refs_json, 7)?,
                        planner_policy_refs: decode_json_column(&policy_refs_json, 8)?,
                        change_summary: row.get(9)?,
                        author: row.get(10)?,
                        created_at: row.get(11)?,
                    })
                },
            )
            .optional()?;

        rev.ok_or_else(|| StoreError::NotFound(format!("revision {revision_id}")))
    }

    pub fn list_revisions(&self, graph_id: &str) -> Result<Vec<GraphRevision>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT revision_id, graph_id, parent_revision_id, schema_version,
                    canonical_snapshot, content_hash, skill_refs, template_refs,
                    planner_policy_refs, change_summary, author, created_at
             FROM graph_revision WHERE graph_id = ?1 ORDER BY created_at",
        )?;

        let revisions = stmt
            .query_map(params![graph_id], |row| {
                let skill_refs_json: String = row.get(6)?;
                let template_refs_json: String = row.get(7)?;
                let policy_refs_json: String = row.get(8)?;
                Ok(GraphRevision {
                    revision_id: row.get(0)?,
                    graph_id: row.get(1)?,
                    parent_revision_id: row.get(2)?,
                    schema_version: row.get(3)?,
                    canonical_snapshot: crate::orchestrator::domain::revision::CanonicalSnapshot {
                        json: row.get(4)?,
                    },
                    content_hash: crate::orchestrator::domain::revision::ContentHash(row.get(5)?),
                    skill_refs: decode_json_column(&skill_refs_json, 6)?,
                    template_refs: decode_json_column(&template_refs_json, 7)?,
                    planner_policy_refs: decode_json_column(&policy_refs_json, 8)?,
                    change_summary: row.get(9)?,
                    author: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(revisions)
    }

    // ── GraphRun operations ───────────────────────────────────────────
}
