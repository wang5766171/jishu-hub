use crate::orchestrator::events::{apply_events_to_projection, rebuild_projection};
use crate::orchestrator::store::{StoreError, TaskStore};

/// Maximum number of delta events to fetch in one incremental batch.
const DELTA_LIMIT: u64 = 100_000;

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
    /// If no checkpoint exists, rebuild from scratch and save checkpoint.
    /// If checkpoint exists, load it, apply only delta events, and update checkpoint.
    pub fn compute_incremental(
        &self,
        run_id: &str,
        now: i64,
    ) -> Result<crate::orchestrator::events::RunProjection, StoreError> {
        if let Some((last_seq, proj_json)) = self.load(run_id)? {
            // Warm start: load checkpoint and apply delta.
            let mut proj: crate::orchestrator::events::RunProjection =
                serde_json::from_str(&proj_json).map_err(StoreError::Serde)?;
            let delta = self.store.events_after(run_id, last_seq, DELTA_LIMIT)?;

            if !delta.is_empty() {
                apply_events_to_projection(&mut proj, &delta, last_seq + 1)
                    .map_err(|e| StoreError::Conflict(format!("projection delta error: {e}")))?;
                let json = serde_json::to_string(&proj).map_err(StoreError::Serde)?;
                let _ = self.save(run_id, proj.run_seq, &json, now);
            }

            Ok(proj)
        } else {
            // Cold start: full rebuild + checkpoint.
            let events = self.store.all_events(run_id)?;
            if events.is_empty() {
                return Err(StoreError::NotFound(format!("no events for run {run_id}")));
            }
            let proj = rebuild_projection(run_id, &events)
                .map_err(|e| StoreError::Conflict(format!("projection rebuild error: {e}")))?;
            let json = serde_json::to_string(&proj).map_err(StoreError::Serde)?;
            let _ = self.save(run_id, proj.run_seq, &json, now);
            Ok(proj)
        }
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

    /// Test that compute_incremental uses only the delta after a checkpoint exists.
    /// This is a behavioral equivalence test: incremental projection == full rebuild.
    #[test]
    fn compute_incremental_uses_delta_after_checkpoint() {
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

        let ps = ProjectionStore::new(&store);

        // Phase 1: Cold start with 10 events (seq 1-10).
        let mut events = vec![build_event(
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

        // Add 9 NodeReady events (seq 2-10).
        for i in 2..=10 {
            events.push(build_event(
                &format!("e{}", i),
                "run1",
                i,
                TaskEventType::NodeReady,
                "system",
                1000 + i as i64,
                serde_json::to_value(&payloads::NodeReadyPayload {
                    node_run_id: format!("nr{}", i),
                    node_id: format!("n{}", i),
                })
                .unwrap(),
            ));
        }

        store.append_events(&events).unwrap();

        // Cold start: should rebuild from all events and checkpoint at seq 10.
        let proj1 = ps.compute_incremental("run1", 2000).unwrap();
        assert_eq!(proj1.run_seq, 10);
        let (checkpoint_seq, _) = ps.load("run1").unwrap().unwrap();
        assert_eq!(checkpoint_seq, 10);

        // Verify equivalence with full rebuild.
        let all_events1 = store.all_events("run1").unwrap();
        let rebuilt1 =
            crate::orchestrator::events::rebuild_projection("run1", &all_events1).unwrap();
        assert_eq!(proj1.run_seq, rebuilt1.run_seq);
        assert_eq!(proj1.graph_id, rebuilt1.graph_id);
        assert_eq!(proj1.node_runs.len(), rebuilt1.node_runs.len());

        // Phase 2: Append 5 more events (seq 11-15).
        let delta_events: Vec<_> = (11..=15)
            .map(|i| {
                build_event(
                    &format!("e{}", i),
                    "run1",
                    i,
                    TaskEventType::NodeReady,
                    "system",
                    1000 + i as i64,
                    serde_json::to_value(&payloads::NodeReadyPayload {
                        node_run_id: format!("nr{}", i),
                        node_id: format!("n{}", i),
                    })
                    .unwrap(),
                )
            })
            .collect();

        store.append_events(&delta_events).unwrap();

        // Incremental rebuild: should load checkpoint, apply delta (seq 11-15), checkpoint at seq 15.
        let proj2 = ps.compute_incremental("run1", 3000).unwrap();
        assert_eq!(proj2.run_seq, 15);
        let (checkpoint_seq2, _) = ps.load("run1").unwrap().unwrap();
        assert_eq!(checkpoint_seq2, 15);

        // Verify equivalence with full rebuild from all 15 events.
        let all_events2 = store.all_events("run1").unwrap();
        assert_eq!(all_events2.len(), 15);
        let rebuilt2 =
            crate::orchestrator::events::rebuild_projection("run1", &all_events2).unwrap();
        assert_eq!(proj2.run_seq, rebuilt2.run_seq);
        assert_eq!(proj2.graph_id, rebuilt2.graph_id);
        assert_eq!(proj2.node_runs.len(), rebuilt2.node_runs.len());
    }

    /// Test that apply_events_to_projection applies exactly the given delta.
    #[test]
    fn apply_events_to_projection_applies_delta() {
        use crate::orchestrator::events::{
            apply_events_to_projection, build_event, payloads, RunProjection, TaskEventType,
        };

        // Create a base projection with seq 5.
        let mut proj = RunProjection {
            run_id: "run1".into(),
            run_seq: 5,
            ..Default::default()
        };

        // Create delta events starting at seq 6.
        let delta = vec![
            build_event(
                "e6",
                "run1",
                6,
                TaskEventType::NodeReady,
                "system",
                1006,
                serde_json::to_value(&payloads::NodeReadyPayload {
                    node_run_id: "nr6".into(),
                    node_id: "n6".into(),
                })
                .unwrap(),
            ),
            build_event(
                "e7",
                "run1",
                7,
                TaskEventType::NodeReady,
                "system",
                1007,
                serde_json::to_value(&payloads::NodeReadyPayload {
                    node_run_id: "nr7".into(),
                    node_id: "n7".into(),
                })
                .unwrap(),
            ),
        ];

        // Apply delta from seq 6.
        apply_events_to_projection(&mut proj, &delta, 6).unwrap();

        // Should have applied both events and advanced to seq 7.
        assert_eq!(proj.run_seq, 7);
        assert_eq!(proj.node_runs.len(), 2);
        assert!(proj.node_runs.contains_key("nr6"));
        assert!(proj.node_runs.contains_key("nr7"));
    }

    /// Test that apply_events_to_projection rejects seq gaps.
    #[test]
    fn apply_events_to_projection_rejects_seq_gaps() {
        use crate::orchestrator::events::{
            apply_events_to_projection, build_event, payloads, RunProjection, TaskEventType,
        };

        let mut proj = RunProjection {
            run_id: "run1".into(),
            run_seq: 5,
            ..Default::default()
        };

        let delta = vec![build_event(
            "e7", // Skips seq 6!
            "run1",
            7,
            TaskEventType::NodeReady,
            "system",
            1007,
            serde_json::to_value(&payloads::NodeReadyPayload {
                node_run_id: "nr7".into(),
                node_id: "n7".into(),
            })
            .unwrap(),
        )];

        let result = apply_events_to_projection(&mut proj, &delta, 6);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(
            err,
            crate::orchestrator::events::ProjectionError::Sequence {
                expected: 6,
                actual: 7
            }
        ));
    }
}
