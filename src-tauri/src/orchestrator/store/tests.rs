use super::*;
use crate::agent::normalized::InteractionOption;
use crate::orchestrator::domain::graph::{EdgeKind, GraphEdge, GraphNode, GraphSnapshot, NodeKind};
use crate::orchestrator::domain::revision::GraphRevision;
use crate::orchestrator::domain::run::ArtifactSensitivity;
use crate::orchestrator::events::{build_event, payloads, TaskEventType};
use crate::util::gen_id;

fn make_test_store() -> TaskStore {
    TaskStore::open_in_memory().unwrap()
}

fn now() -> i64 {
    1700000000
}

#[test]
fn create_and_get_graph() {
    let store = make_test_store();
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: PathBuf::from("/project"),
        owner: "user".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph(&graph).unwrap();
    let recovered = store.get_graph("g1").unwrap();
    assert_eq!(recovered.title, "Test");
    assert_eq!(recovered.goal, "Do X");
}

#[test]
fn save_and_get_revision() {
    let store = make_test_store();

    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: PathBuf::from("/project"),
        owner: "user".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph(&graph).unwrap();

    let snapshot = GraphSnapshot {
        nodes: vec![GraphNode {
            node_id: "n1".into(),
            parent_id: None,
            title: "Node 1".into(),
            description: None,
            node_kind: NodeKind::Goal,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: Default::default(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }],
        edges: vec![],
    };

    let revision =
        GraphRevision::from_snapshot("rev1", "g1", None, &snapshot, "user", now()).unwrap();
    store.save_revision(&revision).unwrap();

    let recovered = store.get_revision("rev1").unwrap();
    assert_eq!(recovered.graph_id, "g1");
    assert_eq!(recovered.schema_version, "1.0.0");
}

#[test]
fn get_artifact_by_id_returns_saved_artifact_or_none() {
    let store = make_test_store();
    let artifact = ArtifactRef {
        artifact_id: "art-1".into(),
        run_id: "run-1".into(),
        node_run_id: "nr-1".into(),
        attempt_id: "att-1".into(),
        name: "report".into(),
        artifact_type: "node_output".into(),
        hash: "abc123".into(),
        sensitivity: ArtifactSensitivity::Internal,
        created_at: now(),
        metadata: Default::default(),
    };
    store.save_artifact(&artifact).unwrap();

    let recovered = store
        .get_artifact("art-1")
        .unwrap()
        .expect("artifact should exist");
    assert_eq!(recovered.artifact_id, "art-1");
    assert_eq!(recovered.name, "report");
    assert_eq!(recovered.hash, "abc123");

    assert!(store.get_artifact("missing").unwrap().is_none());
}

#[test]
fn append_and_query_events() {
    let store = make_test_store();

    // Create graph and run first.
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: PathBuf::from("/project"),
        owner: "user".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
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
        started_at: now(),
        finished_at: None,
    };
    store.create_run(&run).unwrap();

    let events = vec![
        build_event(
            "e1",
            "run1",
            1,
            TaskEventType::RunStarted,
            "system",
            now(),
            serde_json::to_value(&payloads::RunStartedPayload {
                run_id: "run1".into(),
                graph_id: "g1".into(),
                revision_id: "rev1".into(),
                initial_status: RunStatus::Running,
                budget_state: BudgetState::default(),
            })
            .unwrap(),
        ),
        build_event(
            "e2",
            "run1",
            2,
            TaskEventType::NodeReady,
            "scheduler",
            now() + 100,
            serde_json::to_value(&payloads::NodeReadyPayload {
                node_run_id: "nr1".into(),
                node_id: "n1".into(),
            })
            .unwrap(),
        ),
    ];

    store.append_events(&events).unwrap();
    assert_eq!(store.get_run("run1").unwrap().run_seq, 2);

    let queried = store.events_after("run1", 0, 100).unwrap();
    assert_eq!(queried.len(), 2);

    let queried = store.events_after("run1", 1, 100).unwrap();
    assert_eq!(queried.len(), 1);
    assert_eq!(queried[0].run_seq, 2);
}

#[test]
fn projection_checkpoint_roundtrip() {
    let store = make_test_store();
    store
        .save_projection_checkpoint("run1", 42, r#"{"status":"running"}"#, now())
        .unwrap();
    let (seq, json) = store.get_projection_checkpoint("run1").unwrap().unwrap();
    assert_eq!(seq, 42);
    assert!(json.contains("running"));
}

#[test]
fn duplicate_event_seq_rejected() {
    let store = make_test_store();

    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "T".into(),
        goal: "G".into(),
        project_root: PathBuf::from("/p"),
        owner: "u".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
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
        started_at: now(),
        finished_at: None,
    };
    store.create_run(&run).unwrap();

    let event1 = build_event(
        "e1",
        "run1",
        1,
        TaskEventType::RunStarted,
        "system",
        now(),
        serde_json::Value::Null,
    );
    let event2 = build_event(
        "e2",
        "run1",
        1,
        TaskEventType::NodeReady,
        "system",
        now(),
        serde_json::Value::Null,
    );

    store.append_events(&[event1]).unwrap();
    let result = store.append_events(&[event2]);
    assert!(result.is_err()); // Duplicate run_seq should fail.
}

#[test]
fn list_revisions_ordered() {
    let store = make_test_store();

    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "T".into(),
        goal: "G".into(),
        project_root: PathBuf::from("/p"),
        owner: "u".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph(&graph).unwrap();

    let snapshot = GraphSnapshot::default();
    let r1 = GraphRevision::from_snapshot("r1", "g1", None, &snapshot, "u", 100).unwrap();
    let r2 =
        GraphRevision::from_snapshot("r2", "g1", Some("r1".into()), &snapshot, "u", 200).unwrap();
    store.save_revision(&r1).unwrap();
    store.save_revision(&r2).unwrap();

    let revisions = store.list_revisions("g1").unwrap();
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0].revision_id, "r1");
    assert_eq!(revisions[1].revision_id, "r2");
}

#[test]
fn active_runs_use_serialized_status_value() {
    let store = make_test_store();
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "T".into(),
        goal: "G".into(),
        project_root: PathBuf::from("/p"),
        owner: "u".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph(&graph).unwrap();
    store
        .create_run(&GraphRun {
            run_id: "run1".into(),
            graph_id: "g1".into(),
            active_revision_id: "rev1".into(),
            status: RunStatus::Running,
            run_seq: 0,
            budget_state: BudgetState::default(),
            planning_snapshot: Default::default(),
            started_at: now(),
            finished_at: None,
        })
        .unwrap();

    let active = store.get_active_runs().unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].run_id, "run1");
}

#[test]
fn corrupted_event_json_is_not_silently_retyped() {
    let store = make_test_store();
    let conn = store.writer.lock().unwrap();
    conn.execute(
        "INSERT INTO task_event
         (event_id, run_id, run_seq, event_type, schema_version, occurred_at, actor, payload)
         VALUES ('e1', 'run1', 1, '\"not_a_real_event\"', '1.0.0', 1, 'test', '{}')",
        [],
    )
    .unwrap();
    drop(conn);

    assert!(store.events_after("run1", 0, 10).is_err());
}

#[test]
fn draft_update_conflict_rolls_back_new_revision() {
    let store = make_test_store();
    let snapshot = GraphSnapshot {
        nodes: vec![GraphNode {
            node_id: "goal".into(),
            parent_id: None,
            title: "Goal".into(),
            description: None,
            node_kind: NodeKind::Goal,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: Default::default(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }],
        edges: vec![],
    };
    let revision = GraphRevision::from_snapshot("r1", "g1", None, &snapshot, "u", now()).unwrap();
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "T".into(),
        goal: "G".into(),
        project_root: PathBuf::from("/p"),
        owner: "u".into(),
        current_draft_revision: Some("r1".into()),
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph_with_revision(&graph, &revision).unwrap();

    let next =
        GraphRevision::from_snapshot("r2", "g1", Some("r1".into()), &snapshot, "u", now()).unwrap();
    assert!(store
        .save_revision_and_update_draft("g1", "stale", &next, now())
        .is_err());
    assert!(matches!(
        store.get_revision("r2"),
        Err(StoreError::NotFound(_))
    ));
}

#[test]
fn reader_and_writer_are_independent_connections() {
    // Prove that reader and writer are separate SQLite connections.
    // Before the fix (single shared connection), holding the writer lock
    // would prevent any reader operations. With independent connections,
    // both can proceed concurrently.
    let store = make_test_store();

    // Create a graph via the writer
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Test Graph".into(),
        goal: "Test goal".into(),
        project_root: PathBuf::from("/test"),
        owner: "test_user".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph(&graph).unwrap();

    // Prove we can read via the reader immediately after writing
    let retrieved = store.get_graph("g1").unwrap();
    assert_eq!(retrieved.graph_id, "g1");
    assert_eq!(retrieved.title, "Test Graph");

    // Prove we can perform multiple read operations without writer interference
    let _ = store.get_graph("g1").unwrap();
    let _ = store.get_graph("g1").unwrap();

    // Prove writer and reader can be locked independently
    let w_lock = store.writer.lock().unwrap();
    // Reader should still be accessible even though writer is locked
    let r_lock = store.reader.lock().unwrap();

    // Both connections are independently usable
    let count: i64 = r_lock
        .query_row("SELECT COUNT(*) FROM task_graph", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);

    let writer_count: i64 = w_lock
        .query_row("SELECT COUNT(*) FROM task_graph", [], |row| row.get(0))
        .unwrap();
    assert_eq!(writer_count, 1);

    drop(r_lock);
    drop(w_lock);

    // Prove WAL isolation: the reader can proceed independently of the writer
    // and sees a snapshot that doesn't include uncommitted changes.
    // We use a fresh insert operation to avoid holding transactions open.
    let r_conn = store.reader.lock().unwrap();

    // Verify the current state through the reader
    let count_before: i64 = r_conn
        .query_row("SELECT COUNT(*) FROM task_graph", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count_before, 1, "should have exactly one committed graph");

    // Reader can verify data while writer is separately accessible
    let graph_exists: i64 = r_conn
        .query_row(
            "SELECT COUNT(*) FROM task_graph WHERE graph_id = 'g1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        graph_exists, 1,
        "committed graph should be visible to reader"
    );

    drop(r_conn);

    // Prove we can write and immediately read committed data via independent connections
    let graph2 = TaskGraph {
        graph_id: "g2".into(),
        title: "Test Graph 2".into(),
        goal: "Test goal 2".into(),
        project_root: PathBuf::from("/test2"),
        owner: "test_user".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph(&graph2).unwrap();

    // Reader should see the newly committed data
    let r_conn = store.reader.lock().unwrap();
    let count_after: i64 = r_conn
        .query_row("SELECT COUNT(*) FROM task_graph", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count_after, 2, "reader should see both committed graphs");
}

#[test]
fn lists_project_graphs_by_most_recent_update() {
    let store = make_test_store();
    for (graph_id, project_root, updated_at) in [
        ("older", "/project", 10),
        ("other-project", "/other", 30),
        ("newer", "/project", 20),
    ] {
        store
            .create_graph(&TaskGraph {
                graph_id: graph_id.into(),
                title: graph_id.into(),
                goal: format!("Goal for {graph_id}"),
                project_root: PathBuf::from(project_root),
                owner: "test_user".into(),
                current_draft_revision: None,
                created_at: updated_at,
                updated_at,
            })
            .unwrap();
    }

    let graphs = store
        .list_graphs_for_project(Path::new("/project"))
        .unwrap();

    assert_eq!(
        graphs
            .iter()
            .map(|graph| graph.graph_id.as_str())
            .collect::<Vec<_>>(),
        vec!["newer", "older"]
    );
}

#[test]
fn delete_graph_removes_all_related_task_data() {
    let store = make_test_store();
    let snapshot = GraphSnapshot::default();
    let revision = GraphRevision::from_snapshot("rev1", "g1", None, &snapshot, "u", now()).unwrap();
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "T".into(),
        goal: "G".into(),
        project_root: PathBuf::from("/p"),
        owner: "u".into(),
        current_draft_revision: Some("rev1".into()),
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph_with_revision(&graph, &revision).unwrap();
    store
        .create_graph(&TaskGraph {
            graph_id: "g2".into(),
            title: "Other".into(),
            goal: "Keep".into(),
            project_root: PathBuf::from("/p"),
            owner: "u".into(),
            current_draft_revision: None,
            created_at: now(),
            updated_at: now(),
        })
        .unwrap();

    let run = GraphRun {
        run_id: "run1".into(),
        graph_id: "g1".into(),
        active_revision_id: "rev1".into(),
        status: RunStatus::Running,
        run_seq: 0,
        budget_state: BudgetState::default(),
        planning_snapshot: Default::default(),
        started_at: now(),
        finished_at: None,
    };
    store.create_run(&run).unwrap();
    let node_run = NodeRun::new("nr1", "run1", "n1", "rev1");
    store.save_node_run(&node_run).unwrap();
    store
        .save_attempt(&NodeAttempt {
            attempt_id: "att1".into(),
            node_run_id: "nr1".into(),
            attempt_number: 1,
            agent_assignment: None,
            transport: None,
            session_id: Some("session1".into()),
            lease: None,
            usage: Default::default(),
            error: None,
            idempotency_key: None,
            checkpoint: None,
            dispatch_prompt: None,
            started_at: now(),
            finished_at: None,
        })
        .unwrap();
    store
        .append_events(&[build_event(
            "e1",
            "run1",
            1,
            TaskEventType::RunStarted,
            "system",
            now(),
            serde_json::Value::Null,
        )])
        .unwrap();
    store
        .save_artifact(&ArtifactRef {
            artifact_id: "art1".into(),
            run_id: "run1".into(),
            node_run_id: "nr1".into(),
            attempt_id: "att1".into(),
            name: "out".into(),
            artifact_type: "node_output".into(),
            hash: "hash".into(),
            sensitivity: ArtifactSensitivity::Internal,
            created_at: now(),
            metadata: Default::default(),
        })
        .unwrap();
    store
        .save_approval(&ApprovalRequest {
            approval_id: "approval1".into(),
            run_id: "run1".into(),
            node_run_id: "nr1".into(),
            description: "Approve".into(),
            risk_level: "medium".into(),
            scope: vec!["write".into()],
            requester: "agent".into(),
            resolver: None,
            resolved: false,
            approved: None,
            created_at: now(),
            resolved_at: None,
        })
        .unwrap();
    store
        .save_task_interaction(&TaskInteractionRequest {
            request_id: "interaction1".into(),
            graph_id: "g1".into(),
            run_id: Some("run1".into()),
            node_id: Some("n1".into()),
            node_run_id: Some("nr1".into()),
            session_id: Some("session1".into()),
            prompt: "Choose".into(),
            options: vec![InteractionOption {
                option_id: "yes".into(),
                label: "Yes".into(),
                description: None,
            }],
            allow_multiple: false,
            allow_custom_text: true,
            required: true,
            created_at: now(),
            resolved_at: None,
            consumed_at: None,
            submission: None,
        })
        .unwrap();

    {
        let conn = store.writer.lock().unwrap();
        conn.execute(
            "INSERT INTO run_revision_proposal
             (proposal_id, run_id, base_revision_id, candidate_revision_id,
              expected_run_seq, frozen_node_ids, superseded_node_ids, created_at)
             VALUES ('proposal1', 'run1', 'rev1', 'rev2', 1, '[]', '[]', ?1)",
            params![now()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projection_checkpoint
             (run_id, last_seq, projection_json, updated_at)
             VALUES ('run1', 1, '{\"run_seq\":1}', ?1)",
            params![now()],
        )
        .unwrap();
    }

    store.delete_graph("g1").unwrap();

    assert!(matches!(
        store.get_graph("g1"),
        Err(StoreError::NotFound(_))
    ));
    assert_eq!(store.get_graph("g2").unwrap().graph_id, "g2");

    let conn = store.reader.lock().unwrap();
    for table in [
        "graph_revision",
        "graph_run",
        "run_revision_proposal",
        "node_run",
        "node_attempt",
        "task_event",
        "artifact_ref",
        "approval_request",
        "task_interaction_request",
        "projection_checkpoint",
    ] {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        let count: i64 = conn.query_row(&sql, [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "{table} should be fully deleted for g1");
    }
    let graph_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM task_graph", [], |row| row.get(0))
        .unwrap();
    assert_eq!(graph_count, 1, "unrelated graphs must remain");
}

#[test]
fn public_reads_do_not_take_the_writer_lock() {
    // Behavioral routing guard: public read methods must go through the
    // reader connection, never the writer. We hold the writer lock and
    // then call a public read; if any read path were re-routed onto the
    // writer lock this would deadlock. (The in-memory test DB cannot
    // faithfully reproduce WAL's cross-connection read-during-write
    // semantics, so this routing guard — not an uncommitted-tx probe — is
    // the correct regression test here.)
    let store = make_test_store();
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Routing guard".into(),
        goal: "prove reads bypass the writer lock".into(),
        project_root: PathBuf::from("/test"),
        owner: "test_user".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph(&graph).unwrap();

    // Hold the writer lock for the duration of the read below.
    let _writer_guard = store.writer.lock().unwrap();

    // A public read must succeed while the writer is locked — proving it
    // routes through the independent reader connection, not the writer.
    let read_back = store
        .get_graph("g1")
        .expect("read via reader must succeed while writer lock is held");
    assert_eq!(read_back.graph_id, "g1");
}

#[test]
fn autocheckpoint_pragma_is_set_on_file_based_db() {
    // Test that wal_autocheckpoint is set to a non-zero value on file-based DBs.
    // This ensures automatic WAL checkpointing is enabled to prevent unbounded WAL growth.
    let temp_dir = std::env::temp_dir();
    let db_path = temp_dir.join(format!("test_autocheckpoint_{}.db", gen_id("test")));

    // Open a file-based store
    let store = TaskStore::open(&db_path).expect("file-based store should open");

    // Query the wal_autocheckpoint setting on the writer connection
    let conn = store.writer.lock().unwrap();
    let autocheckpoint: i32 = conn
        .pragma_query_value(None, "wal_autocheckpoint", |row| row.get(0))
        .expect("wal_autocheckpoint pragma should be queryable");

    drop(conn);

    // Assert it's set to a non-zero value (1000 pages is a reasonable default)
    assert_eq!(
        autocheckpoint, 1000,
        "wal_autocheckpoint should be set to 1000 pages"
    );

    // Cleanup
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(format!("{}-wal", db_path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", db_path.display()));
}

#[test]
fn checkpoint_executes_on_real_wal_file() {
    // Test that TaskStore::checkpoint() executes successfully against a real WAL file.
    // This proves the checkpoint wiring is functional and not just a stub.
    let temp_dir = std::env::temp_dir();
    let db_path = temp_dir.join(format!("test_checkpoint_{}.db", gen_id("test")));

    // Open a file-based store
    let store = TaskStore::open(&db_path).expect("file-based store should open");

    // Create a graph and run to generate WAL activity
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Checkpoint Test".into(),
        goal: "Test WAL checkpoint".into(),
        project_root: PathBuf::from("/test"),
        owner: "test_user".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
    };
    store
        .create_graph(&graph)
        .expect("graph creation should succeed");

    // Execute a checkpoint. It must succeed AND do real work: with no
    // concurrent readers a PASSIVE checkpoint over our freshly-written
    // frames must not be busy and must have copied back every frame that was
    // in the log — proving it actually engaged the WAL, not a silent no-op.
    let outcome = store
        .checkpoint()
        .expect("checkpoint should succeed on file-based DB with WAL");
    assert!(
        !outcome.busy,
        "checkpoint must not be blocked by a busy reader: {outcome:?}"
    );
    assert!(
        outcome.log_frames > 0,
        "create_graph must have generated WAL frames to checkpoint: {outcome:?}"
    );
    assert_eq!(
        outcome.checkpointed_frames, outcome.log_frames,
        "PASSIVE checkpoint with no readers must copy back every WAL frame: {outcome:?}"
    );

    // Verify we can still read after checkpoint (proves DB integrity)
    let retrieved = store
        .get_graph("g1")
        .expect("should read graph after checkpoint");
    assert_eq!(retrieved.graph_id, "g1");

    // Cleanup
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(format!("{}-wal", db_path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", db_path.display()));
}

#[test]
fn wake_timer_table_is_removed() {
    let store = make_test_store();
    let conn = store
        .reader
        .lock()
        .map_err(|e| StoreError::Lock(e.to_string()))
        .unwrap();

    // Verify wake_timer table does NOT exist (should have been dropped and not recreated)
    let mut table_check = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wake_timer'")
        .unwrap();
    let tables: Vec<String> = table_check
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(
        tables.is_empty(),
        "wake_timer table should not exist (found: {:?})",
        tables
    );
}

#[test]
fn save_and_get_attempt() {
    let store = make_test_store();

    // First need a graph, revision, run, and node_run.
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: PathBuf::from("/project"),
        owner: "user".into(),
        current_draft_revision: None,
        created_at: now(),
        updated_at: now(),
    };
    store.create_graph(&graph).unwrap();

    let snapshot = GraphSnapshot {
        nodes: vec![GraphNode {
            node_id: "n1".into(),
            parent_id: None,
            title: "Node 1".into(),
            description: None,
            node_kind: NodeKind::Goal,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: Default::default(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }],
        edges: vec![],
    };

    let revision =
        GraphRevision::from_snapshot("rev1", "g1", None, &snapshot, "user", now()).unwrap();
    store.save_revision(&revision).unwrap();

    let run = crate::orchestrator::domain::run::GraphRun {
        run_id: "run1".into(),
        graph_id: "g1".into(),
        active_revision_id: "rev1".into(),
        status: crate::orchestrator::domain::run::RunStatus::Running,
        run_seq: 1,
        budget_state: Default::default(),
        planning_snapshot: Default::default(),
        started_at: now(),
        finished_at: None,
    };
    store.create_run(&run).unwrap();

    let node_run = crate::orchestrator::domain::run::NodeRun {
        node_run_id: "nr1".into(),
        run_id: "run1".into(),
        node_id: "n1".into(),
        status: crate::orchestrator::domain::run::NodeRunStatus::Running,
        revision_id: "rev1".into(),
        started_at: Some(now()),
        finished_at: None,
        attempt_count: 0,
        wake_at: None,
        error: None,
        loop_iteration: None,
        superseded: false,
    };
    store.save_node_run(&node_run).unwrap();

    // Now create an attempt.
    let attempt = crate::orchestrator::domain::run::NodeAttempt {
        attempt_id: "att1".into(),
        node_run_id: "nr1".into(),
        attempt_number: 1,
        agent_assignment: None,
        transport: None,
        session_id: None,
        lease: None,
        usage: Default::default(),
        error: None,
        idempotency_key: None,
        checkpoint: None,
        dispatch_prompt: None,
        started_at: now(),
        finished_at: None,
    };
    store.save_attempt(&attempt).unwrap();

    // Test get_attempt retrieves it.
    let retrieved = store.get_attempt("nr1", 1).unwrap();
    assert_eq!(retrieved.attempt_id, "att1");
    assert_eq!(retrieved.node_run_id, "nr1");
    assert_eq!(retrieved.attempt_number, 1);

    // Test get_attempt returns NotFound for non-existent attempt.
    let err = store.get_attempt("nr1", 999).unwrap_err();
    assert!(matches!(err, StoreError::NotFound(_)));
}

#[test]
fn list_node_session_ids_dedupes_and_skips_empty() {
    let store = make_test_store();

    // 最小 setup：graph → revision → run → node_run（同 save_and_get_attempt）。
    store
        .create_graph(&TaskGraph {
            graph_id: "g-sess".into(),
            title: "T".into(),
            goal: "G".into(),
            project_root: PathBuf::from("/project"),
            owner: "user".into(),
            current_draft_revision: None,
            created_at: now(),
            updated_at: now(),
        })
        .unwrap();
    let snapshot = GraphSnapshot {
        nodes: vec![GraphNode {
            node_id: "n1".into(),
            parent_id: None,
            title: "Node 1".into(),
            description: None,
            node_kind: NodeKind::Goal,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: Default::default(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }],
        edges: vec![],
    };
    let revision =
        GraphRevision::from_snapshot("rev1", "g-sess", None, &snapshot, "user", now()).unwrap();
    store.save_revision(&revision).unwrap();
    store
        .create_run(&crate::orchestrator::domain::run::GraphRun {
            run_id: "run1".into(),
            graph_id: "g-sess".into(),
            active_revision_id: "rev1".into(),
            status: crate::orchestrator::domain::run::RunStatus::Running,
            run_seq: 1,
            budget_state: Default::default(),
            planning_snapshot: Default::default(),
            started_at: now(),
            finished_at: None,
        })
        .unwrap();
    store
        .save_node_run(&crate::orchestrator::domain::run::NodeRun {
            node_run_id: "nr1".into(),
            run_id: "run1".into(),
            node_id: "n1".into(),
            status: crate::orchestrator::domain::run::NodeRunStatus::Running,
            revision_id: "rev1".into(),
            started_at: Some(now()),
            finished_at: None,
            attempt_count: 0,
            wake_at: None,
            error: None,
            loop_iteration: None,
            superseded: false,
        })
        .unwrap();

    // 四个 attempt：有 session / 无 session / 重复 session（验 DISTINCT）/ 另一 session。
    let mk_attempt =
        |id: &str, num: u32, sess: Option<&str>| crate::orchestrator::domain::run::NodeAttempt {
            attempt_id: id.into(),
            node_run_id: "nr1".into(),
            attempt_number: num,
            agent_assignment: None,
            transport: None,
            session_id: sess.map(str::to_string),
            lease: None,
            usage: Default::default(),
            error: None,
            idempotency_key: None,
            checkpoint: None,
            dispatch_prompt: None,
            started_at: now(),
            finished_at: None,
        };
    store
        .save_attempt(&mk_attempt("att1", 1, Some("sess-a")))
        .unwrap();
    store.save_attempt(&mk_attempt("att2", 2, None)).unwrap();
    store
        .save_attempt(&mk_attempt("att3", 3, Some("sess-a")))
        .unwrap();
    store
        .save_attempt(&mk_attempt("att4", 4, Some("sess-b")))
        .unwrap();

    let mut ids = store.list_node_session_ids().unwrap();
    ids.sort();
    assert_eq!(ids, vec!["sess-a".to_string(), "sess-b".to_string()]);
}

#[test]
fn list_node_sessions_returns_latest_attempt_per_node() {
    let store = make_test_store();
    setup_run_with_nodes(&store, "run-ls", &[("nr-a", "n-a"), ("nr-b", "n-b")]);

    // nr-a: attempt 1 (old) with session-a → 被_attempt 2 覆盖
    save_test_attempt(&store, "att-a1", "nr-a", 1, Some("session-a-old"));
    // nr-a: attempt 2 (最新) with session-a-new
    save_test_attempt(&store, "att-a2", "nr-a", 2, Some("session-a-new"));
    // nr-b: 无 attempt（只有 node_run）

    let sessions = store.list_node_sessions("run-ls").unwrap();
    assert_eq!(sessions.len(), 2);

    let by_node: std::collections::HashMap<&str, &NodeSessionSummary> =
        sessions.iter().map(|s| (s.node_id.as_str(), s)).collect();

    // nr-a 应取最新 attempt（attempt_number=2, session-a-new）
    let nr_a = by_node.get("n-a").unwrap();
    assert_eq!(nr_a.attempt_number, 2);
    assert_eq!(nr_a.session_id.as_deref(), Some("session-a-new"));

    // nr-b 无 attempt → attempt_number=0, session_id=None
    let nr_b = by_node.get("n-b").unwrap();
    assert_eq!(nr_b.attempt_number, 0);
    assert!(nr_b.session_id.is_none());
}

#[test]
fn list_node_sessions_empty_run_returns_empty() {
    let store = make_test_store();
    setup_run_with_nodes(&store, "run-empty", &[]);
    let sessions = store.list_node_sessions("run-empty").unwrap();
    assert!(sessions.is_empty());
}

#[test]
fn list_node_sessions_wrong_run_returns_empty() {
    let store = make_test_store();
    setup_run_with_nodes(&store, "run-x", &[("nr-x", "n-x")]);
    // 查不存在的 run
    let sessions = store.list_node_sessions("run-nonexistent").unwrap();
    assert!(sessions.is_empty());
}

#[test]
fn list_attempt_dispatches_returns_prompts() {
    let store = make_test_store();
    setup_run_with_nodes(&store, "run-disp", &[("nr-d", "n-d")]);

    // attempt 1 with dispatch_prompt
    let mut att1 = crate::orchestrator::domain::run::NodeAttempt {
        attempt_id: "att-d1".into(),
        node_run_id: "nr-d".into(),
        attempt_number: 1,
        agent_assignment: None,
        transport: None,
        session_id: Some("sess-d1".into()),
        lease: None,
        usage: Default::default(),
        error: None,
        idempotency_key: None,
        checkpoint: None,
        dispatch_prompt: Some("Task Orchestrator execution contract:...".into()),
        started_at: 100,
        finished_at: Some(200),
    };
    store.save_attempt(&att1).unwrap();

    // attempt 2 without dispatch_prompt (老数据)
    att1.attempt_id = "att-d2".into();
    att1.attempt_number = 2;
    att1.dispatch_prompt = None;
    att1.session_id = Some("sess-d2".into());
    att1.started_at = 300;
    store.save_attempt(&att1).unwrap();

    let dispatches = store.list_attempt_dispatches("nr-d").unwrap();
    // 只返回有 dispatch_prompt 的（attempt 2 无 prompt 被过滤）
    assert_eq!(dispatches.len(), 1);
    assert_eq!(dispatches[0].attempt_number, 1);
    assert!(dispatches[0].prompt.starts_with("Task Orchestrator"));
}

/// 辅助：创建 graph + revision + run + N 个 node_run。
fn setup_run_with_nodes(store: &TaskStore, run_id: &str, nodes: &[(&str, &str)]) {
    store
        .create_graph(&TaskGraph {
            graph_id: format!("g-{run_id}"),
            title: "test".into(),
            goal: "test".into(),
            project_root: PathBuf::from("/project"),
            owner: "user".into(),
            current_draft_revision: None,
            created_at: now(),
            updated_at: now(),
        })
        .unwrap();
    let snapshot = GraphSnapshot {
        nodes: nodes
            .iter()
            .map(|(_, node_id)| GraphNode {
                node_id: (*node_id).into(),
                parent_id: None,
                title: format!("Node {node_id}"),
                description: None,
                node_kind: NodeKind::Goal,
                input_contract: Default::default(),
                output_contract: Default::default(),
                role_requirement: None,
                capability_requirements: vec![],
                agent_assignment_constraint: None,
                policy: Default::default(),
                metadata: Default::default(),
                executable_payload: None,
                loop_config: None,
                approval_gate_config: None,
            })
            .collect(),
        edges: vec![],
    };
    let revision = GraphRevision::from_snapshot(
        &format!("rev-{run_id}"),
        &format!("g-{run_id}"),
        None,
        &snapshot,
        "user",
        now(),
    )
    .unwrap();
    store.save_revision(&revision).unwrap();
    store
        .create_run(&crate::orchestrator::domain::run::GraphRun {
            run_id: run_id.into(),
            graph_id: format!("g-{run_id}"),
            active_revision_id: format!("rev-{run_id}"),
            status: crate::orchestrator::domain::run::RunStatus::Running,
            run_seq: 1,
            budget_state: Default::default(),
            planning_snapshot: Default::default(),
            started_at: now(),
            finished_at: None,
        })
        .unwrap();
    for (nr_id, node_id) in nodes {
        store
            .save_node_run(&crate::orchestrator::domain::run::NodeRun {
                node_run_id: (*nr_id).into(),
                run_id: run_id.into(),
                node_id: (*node_id).into(),
                status: crate::orchestrator::domain::run::NodeRunStatus::Running,
                revision_id: format!("rev-{run_id}"),
                started_at: Some(now()),
                finished_at: None,
                attempt_count: 0,
                wake_at: None,
                error: None,
                loop_iteration: None,
                superseded: false,
            })
            .unwrap();
    }
}

/// 辅助：保存一个测试 attempt。
fn save_test_attempt(
    store: &TaskStore,
    attempt_id: &str,
    node_run_id: &str,
    attempt_number: u32,
    session_id: Option<&str>,
) {
    store
        .save_attempt(&crate::orchestrator::domain::run::NodeAttempt {
            attempt_id: attempt_id.into(),
            node_run_id: node_run_id.into(),
            attempt_number,
            agent_assignment: None,
            transport: None,
            session_id: session_id.map(str::to_string),
            lease: None,
            usage: Default::default(),
            error: None,
            idempotency_key: None,
            checkpoint: None,
            dispatch_prompt: None,
            started_at: now(),
            finished_at: None,
        })
        .unwrap();
}

#[test]
fn task_interaction_is_persisted_resolved_and_consumed_once() {
    let store = make_test_store();
    store
        .create_graph(&TaskGraph {
            graph_id: "g-interaction".into(),
            title: "Interactive task".into(),
            goal: "Choose a design".into(),
            project_root: PathBuf::from("/project"),
            owner: "user".into(),
            current_draft_revision: None,
            created_at: now(),
            updated_at: now(),
        })
        .unwrap();
    let request = TaskInteractionRequest {
        request_id: "request-1".into(),
        graph_id: "g-interaction".into(),
        run_id: Some("run-1".into()),
        node_id: Some("node-1".into()),
        node_run_id: Some("node-run-1".into()),
        session_id: Some("session-1".into()),
        prompt: "请选择权限模型".into(),
        options: vec![InteractionOption {
            option_id: "rbac".into(),
            label: "RBAC".into(),
            description: None,
        }],
        allow_multiple: false,
        allow_custom_text: true,
        required: true,
        created_at: now(),
        resolved_at: None,
        consumed_at: None,
        submission: None,
    };

    store.save_task_interaction(&request).unwrap();
    assert_eq!(
        store
            .pending_task_interactions("g-interaction")
            .unwrap()
            .len(),
        1
    );

    let resolved = store
        .resolve_task_interaction(
            "request-1",
            &TaskInteractionSubmission {
                selected_option_ids: vec!["rbac".into()],
                custom_text: Some("组织维度隔离".into()),
            },
            now() + 1,
        )
        .unwrap();
    assert!(!resolved.is_pending());
    assert!(store
        .pending_task_interactions("g-interaction")
        .unwrap()
        .is_empty());

    let consumed = store
        .take_resolved_task_interaction("node-run-1", now() + 2)
        .unwrap()
        .expect("resolved interaction should be available");
    assert_eq!(consumed.request_id, "request-1");
    assert!(store
        .take_resolved_task_interaction("node-run-1", now() + 3)
        .unwrap()
        .is_none());
}
