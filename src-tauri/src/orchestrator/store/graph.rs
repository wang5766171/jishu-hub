use super::*;

impl TaskStore {
    pub fn create_graph(&self, graph: &TaskGraph) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT INTO task_graph (graph_id, title, goal, project_root, owner, current_draft_revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                graph.graph_id,
                graph.title,
                graph.goal,
                graph.project_root.to_string_lossy().to_string(),
                graph.owner,
                graph.current_draft_revision,
                graph.created_at,
                graph.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn create_graph_with_revision(
        &self,
        graph: &TaskGraph,
        revision: &GraphRevision,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO task_graph
             (graph_id, title, goal, project_root, owner, current_draft_revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                graph.graph_id,
                graph.title,
                graph.goal,
                graph.project_root.to_string_lossy().to_string(),
                graph.owner,
                graph.current_draft_revision,
                graph.created_at,
                graph.updated_at,
            ],
        )?;
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
        tx.commit()?;
        Ok(())
    }

    pub fn get_graph(&self, graph_id: &str) -> Result<TaskGraph, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let graph = conn
            .query_row(
                "SELECT graph_id, title, goal, project_root, owner, current_draft_revision, created_at, updated_at
                 FROM task_graph WHERE graph_id = ?1",
                params![graph_id],
                |row| {
                    Ok(TaskGraph {
                        graph_id: row.get(0)?,
                        title: row.get(1)?,
                        goal: row.get(2)?,
                        project_root: PathBuf::from(row.get::<_, String>(3)?),
                        owner: row.get(4)?,
                        current_draft_revision: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                    })
                },
            )
            .optional()?;

        graph.ok_or_else(|| StoreError::NotFound(format!("graph {graph_id}")))
    }

    pub fn latest_graph_for_project(
        &self,
        project_root: &Path,
    ) -> Result<Option<TaskGraph>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let graph = conn
            .query_row(
                "SELECT graph_id, title, goal, project_root, owner, current_draft_revision,
                        created_at, updated_at
                 FROM task_graph
                 WHERE project_root = ?1
                 ORDER BY updated_at DESC
                 LIMIT 1",
                params![project_root.to_string_lossy().to_string()],
                |row| {
                    Ok(TaskGraph {
                        graph_id: row.get(0)?,
                        title: row.get(1)?,
                        goal: row.get(2)?,
                        project_root: PathBuf::from(row.get::<_, String>(3)?),
                        owner: row.get(4)?,
                        current_draft_revision: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                    })
                },
            )
            .optional()?;
        Ok(graph)
    }

    pub fn list_graphs_for_project(
        &self,
        project_root: &Path,
    ) -> Result<Vec<TaskGraph>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT graph_id, title, goal, project_root, owner, current_draft_revision,
                    created_at, updated_at
             FROM task_graph
             WHERE project_root = ?1
             ORDER BY updated_at DESC, created_at DESC",
        )?;
        let graphs = stmt
            .query_map(params![project_root.to_string_lossy().to_string()], |row| {
                Ok(TaskGraph {
                    graph_id: row.get(0)?,
                    title: row.get(1)?,
                    goal: row.get(2)?,
                    project_root: PathBuf::from(row.get::<_, String>(3)?),
                    owner: row.get(4)?,
                    current_draft_revision: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(graphs)
    }

    pub fn delete_graph(&self, graph_id: &str) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM task_graph WHERE graph_id = ?1",
            params![graph_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(StoreError::NotFound(format!("graph {graph_id}")));
        }

        tx.execute(
            "DELETE FROM projection_checkpoint
             WHERE run_id IN (SELECT run_id FROM graph_run WHERE graph_id = ?1)",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM run_revision_proposal
             WHERE run_id IN (SELECT run_id FROM graph_run WHERE graph_id = ?1)",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM approval_request
             WHERE run_id IN (SELECT run_id FROM graph_run WHERE graph_id = ?1)",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM artifact_ref
             WHERE run_id IN (SELECT run_id FROM graph_run WHERE graph_id = ?1)",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM task_event
             WHERE run_id IN (SELECT run_id FROM graph_run WHERE graph_id = ?1)",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM task_interaction_request WHERE graph_id = ?1",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM node_attempt
             WHERE node_run_id IN (
                 SELECT node_run_id FROM node_run
                 WHERE run_id IN (SELECT run_id FROM graph_run WHERE graph_id = ?1)
             )",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM node_run
             WHERE run_id IN (SELECT run_id FROM graph_run WHERE graph_id = ?1)",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM graph_run WHERE graph_id = ?1",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM graph_revision WHERE graph_id = ?1",
            params![graph_id],
        )?;
        tx.execute(
            "DELETE FROM task_graph WHERE graph_id = ?1",
            params![graph_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn update_graph_draft_revision(
        &self,
        graph_id: &str,
        revision_id: &str,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE task_graph SET current_draft_revision = ?1, updated_at = ?2 WHERE graph_id = ?3",
            params![revision_id, updated_at, graph_id],
        )?;
        if affected == 0 {
            return Err(StoreError::NotFound(format!("graph {graph_id}")));
        }
        Ok(())
    }

    pub fn checkout_graph_draft_revision(
        &self,
        graph_id: &str,
        expected_revision_id: &str,
        target_revision_id: &str,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let affected = conn.execute(
            "UPDATE task_graph
             SET current_draft_revision = ?1, updated_at = ?2
             WHERE graph_id = ?3 AND current_draft_revision = ?4",
            params![
                target_revision_id,
                updated_at,
                graph_id,
                expected_revision_id
            ],
        )?;
        if affected == 0 {
            return Err(StoreError::Conflict(format!(
                "draft revision changed for graph {graph_id}"
            )));
        }
        Ok(())
    }

    // ── GraphRevision operations ──────────────────────────────────────
}
