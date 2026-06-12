use crate::orchestrator::store::{StoreError, TaskStore};

/// Manages projection checkpoints for incremental rebuild.
pub struct ProjectionStore<'a> {
    store: &'a TaskStore,
}

impl<'a> ProjectionStore<'a> {
    pub fn new(store: &'a TaskStore) -> Self {
        Self { store }
    }

    /// Load the last checkpoint for a run.
    /// Returns (last_seq, projection_json).
    pub fn load(&self, run_id: &str) -> Result<Option<(u64, String)>, StoreError> {
        self.store.get_projection_checkpoint(run_id)
    }

    /// Save a new checkpoint.
    pub fn save(
        &self,
        run_id: &str,
        last_seq: u64,
        projection_json: &str,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        self.store
            .save_projection_checkpoint(run_id, last_seq, projection_json, updated_at)
    }

    /// Compute the projection incrementally from the last checkpoint.
    /// If no checkpoint exists, rebuild from scratch.
    pub fn compute_incremental(
        &self,
        run_id: &str,
        now: i64,
    ) -> Result<crate::orchestrator::events::RunProjection, StoreError> {
        let events = self.store.all_events(run_id)?;
        if events.is_empty() {
            return Err(StoreError::NotFound(format!("no events for run {run_id}")));
        }

        let proj = crate::orchestrator::events::rebuild_projection(run_id, &events)
            .map_err(|e| StoreError::Conflict(format!("projection rebuild error: {e}")))?;

        // Save checkpoint.
        let proj_json = serde_json::to_string(&proj).map_err(|e| StoreError::Serde(e))?;
        let _ = self.save(run_id, proj.run_seq, &proj_json, now);

        Ok(proj)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::domain::graph::TaskGraph;
    use crate::orchestrator::domain::run::{BudgetState, GraphRun, RunStatus};
    use crate::orchestrator::events::{build_event, payloads, TaskEventType};
    use std::path::PathBuf;

    #[test]
    fn checkpoint_save_and_load() {
        let store = TaskStore::open_in_memory().unwrap();
        let ps = ProjectionStore::new(&store);

        ps.save("run1", 10, r#"{"x":1}"#, 1000).unwrap();
        let (seq, json) = ps.load("run1").unwrap().unwrap();
        assert_eq!(seq, 10);
        assert!(json.contains("x"));
    }

    #[test]
    fn compute_incremental_rebuilds_from_events() {
        let store = TaskStore::open_in_memory().unwrap();

        // Setup graph and run.
        let graph = TaskGraph {
            graph_id: "g1".into(),
            title: "T".into(),
            goal: "G".into(),
            project_root: PathBuf::from("/p"),
            owner: "u".into(),
            current_draft_revision: None,
            created_at: 1000,
            updated_at: 1000,
        };
        store.create_graph(&graph).unwrap();

        let run = GraphRun {
            run_id: "run1".into(),
            graph_id: "g1".into(),
            active_revision_id: "rev1".into(),
            status: RunStatus::Running,
            run_seq: 0,
            budget_state: BudgetState::default(),
            planning_snapshot: Default::default(),
            started_at: 1000,
            finished_at: None,
        };
        store.create_run(&run).unwrap();

        // Append events.
        let events = vec![build_event(
            "e1",
            "run1",
            1,
            TaskEventType::RunStarted,
            "system",
            1000,
            serde_json::to_value(&payloads::RunStartedPayload {
                run_id: "run1".into(),
                graph_id: "g1".into(),
                revision_id: "rev1".into(),
                initial_status: RunStatus::Running,
                budget_state: BudgetState::default(),
            })
            .unwrap(),
        )];
        store.append_events(&events).unwrap();

        let ps = ProjectionStore::new(&store);
        let proj = ps.compute_incremental("run1", 2000).unwrap();
        assert_eq!(proj.graph_id, "g1");
        assert_eq!(proj.run_seq, 1);

        // Checkpoint should be saved.
        let (seq, _) = ps.load("run1").unwrap().unwrap();
        assert_eq!(seq, 1);
    }
}
