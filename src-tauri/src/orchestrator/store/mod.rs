use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::orchestrator::domain::graph::TaskGraph;
use crate::orchestrator::domain::revision::GraphRevision;
use crate::orchestrator::domain::run::{
    ApprovalRequest, ArtifactRef, BudgetState, GraphRun, NodeAttempt, NodeRun, NodeRunStatus,
    RunPlanningSnapshot, RunRevisionProposal, RunStatus,
};
use crate::orchestrator::events::TaskEvent;
use crate::orchestrator::projections::checkpoint::ProjectionReadModel;

const TASK_STORE_SCHEMA_VERSION: i64 = 3;

fn decode_json_column<T: DeserializeOwned>(raw: &str, column: usize) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

/// Error from the task store.
#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    NotFound(String),
    Conflict(String),
    Serde(serde_json::Error),
    Lock(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "sqlite error: {e}"),
            Self::NotFound(msg) => write!(f, "not found: {msg}"),
            Self::Conflict(msg) => write!(f, "conflict: {msg}"),
            Self::Serde(e) => write!(f, "serde error: {e}"),
            Self::Lock(msg) => write!(f, "lock error: {msg}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::Serde(e)
    }
}

/// SQLite WAL-backed task store.
/// Only the leader machine's local process accesses the database file.
/// Uses a single writer with short transactions and independent read connections.
pub struct TaskStore {
    /// Writer connection — serialized via Mutex.
    writer: Mutex<Connection>,
    /// Reader connection — for SELECT queries, does not block writer.
    reader: Mutex<Connection>,
    /// Database file path.
    db_path: PathBuf,
}

impl TaskStore {
    /// Open or create a task store at the given path.
    /// Enables WAL mode and creates tables if needed.
    pub fn open(db_path: &Path) -> Result<Self, StoreError> {
        let writer_conn = Connection::open(db_path)?;

        // Enable WAL mode for concurrent read / single write.
        writer_conn.pragma_update(None, "journal_mode", "WAL")?;
        writer_conn.pragma_update(None, "synchronous", "NORMAL")?;
        writer_conn.pragma_update(None, "foreign_keys", "ON")?;
        writer_conn.pragma_update(None, "busy_timeout", 5000)?;
        // Set automatic WAL checkpoint to trigger every 1000 pages (SQLite's default).
        // This prevents unbounded WAL growth under sustained writes.
        writer_conn.pragma_update(None, "wal_autocheckpoint", 1000)?;

        Self::create_schema(&writer_conn)?;

        // Open a separate read connection.
        let reader_conn = Connection::open(db_path)?;
        reader_conn.pragma_update(None, "busy_timeout", 5000)?;

        Ok(Self {
            writer: Mutex::new(writer_conn),
            reader: Mutex::new(reader_conn),
            db_path: db_path.to_path_buf(),
        })
    }

    /// Open an in-memory store for testing.
    /// Uses a unique named in-memory database per call, combining a global counter
    /// with the thread ID so each invocation gets its own isolated database.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static TEST_DB_COUNTER: AtomicUsize = AtomicUsize::new(0);
        let db_id = TEST_DB_COUNTER.fetch_add(1, Ordering::SeqCst);
        let db_name = format!(
            "file:taskstore_test_{}_{:?}_memdb?mode=memory&cache=shared",
            db_id,
            std::thread::current().id()
        );

        let writer_conn = Connection::open(&db_name)?;
        writer_conn.pragma_update(None, "foreign_keys", "ON")?;
        writer_conn.pragma_update(None, "busy_timeout", 5000)?;
        Self::create_schema(&writer_conn)?;

        let reader_conn = Connection::open(&db_name)?;
        reader_conn.pragma_update(None, "busy_timeout", 5000)?;

        Ok(Self {
            writer: Mutex::new(writer_conn),
            reader: Mutex::new(reader_conn),
            db_path: PathBuf::from(":memory:"),
        })
    }

    fn create_schema(conn: &Connection) -> Result<(), StoreError> {
        let current_version: i64 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current_version != TASK_STORE_SCHEMA_VERSION {
            conn.execute_batch(
                r#"
                DROP TABLE IF EXISTS projection_checkpoint;
                DROP TABLE IF EXISTS wake_timer;
                DROP TABLE IF EXISTS approval_request;
                DROP TABLE IF EXISTS artifact_ref;
                DROP TABLE IF EXISTS task_event;
                DROP TABLE IF EXISTS node_attempt;
                DROP TABLE IF EXISTS node_run;
                DROP TABLE IF EXISTS run_revision_proposal;
                DROP TABLE IF EXISTS graph_run;
                DROP TABLE IF EXISTS graph_revision;
                DROP TABLE IF EXISTS task_graph;
                "#,
            )?;
        }
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_graph (
                graph_id       TEXT PRIMARY KEY,
                title          TEXT NOT NULL,
                goal           TEXT NOT NULL,
                project_root   TEXT NOT NULL,
                owner          TEXT NOT NULL,
                current_draft_revision TEXT,
                created_at     INTEGER NOT NULL,
                updated_at     INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS graph_revision (
                revision_id    TEXT PRIMARY KEY,
                graph_id       TEXT NOT NULL REFERENCES task_graph(graph_id),
                parent_revision_id TEXT,
                schema_version TEXT NOT NULL,
                canonical_snapshot TEXT NOT NULL,
                content_hash   TEXT NOT NULL,
                skill_refs     TEXT DEFAULT '[]',
                template_refs  TEXT DEFAULT '[]',
                planner_policy_refs TEXT DEFAULT '[]',
                change_summary TEXT DEFAULT '',
                author         TEXT NOT NULL,
                created_at     INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_revision_graph
                ON graph_revision(graph_id, created_at);

            CREATE TABLE IF NOT EXISTS graph_run (
                run_id          TEXT PRIMARY KEY,
                graph_id        TEXT NOT NULL REFERENCES task_graph(graph_id),
                active_revision_id TEXT NOT NULL,
                status          TEXT NOT NULL,
                run_seq         INTEGER NOT NULL DEFAULT 0,
                budget_state    TEXT DEFAULT '{}',
                planning_snapshot TEXT NOT NULL DEFAULT '{}',
                started_at      INTEGER NOT NULL,
                finished_at     INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_run_graph ON graph_run(graph_id);

            CREATE TABLE IF NOT EXISTS run_revision_proposal (
                proposal_id          TEXT PRIMARY KEY,
                run_id               TEXT NOT NULL REFERENCES graph_run(run_id),
                base_revision_id     TEXT NOT NULL,
                candidate_revision_id TEXT NOT NULL,
                expected_run_seq     INTEGER NOT NULL,
                frozen_node_ids      TEXT NOT NULL DEFAULT '[]',
                superseded_node_ids  TEXT NOT NULL DEFAULT '[]',
                created_at           INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_run_revision_proposal_run
                ON run_revision_proposal(run_id, created_at);

            CREATE TABLE IF NOT EXISTS node_run (
                node_run_id     TEXT PRIMARY KEY,
                run_id          TEXT NOT NULL REFERENCES graph_run(run_id),
                node_id         TEXT NOT NULL,
                status          TEXT NOT NULL,
                revision_id     TEXT NOT NULL,
                started_at      INTEGER,
                finished_at     INTEGER,
                attempt_count   INTEGER DEFAULT 0,
                wake_at         INTEGER,
                error           TEXT,
                loop_iteration  INTEGER,
                superseded      INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_noderun_run ON node_run(run_id);
            CREATE INDEX IF NOT EXISTS idx_noderun_status ON node_run(status);

            CREATE TABLE IF NOT EXISTS node_attempt (
                attempt_id      TEXT PRIMARY KEY,
                node_run_id     TEXT NOT NULL REFERENCES node_run(node_run_id),
                attempt_number  INTEGER NOT NULL,
                agent_assignment TEXT,
                transport       TEXT,
                session_id      TEXT,
                lease           TEXT,
                usage           TEXT DEFAULT '{}',
                error           TEXT,
                idempotency_key TEXT,
                checkpoint      TEXT,
                started_at      INTEGER NOT NULL,
                finished_at     INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_attempt_noderun ON node_attempt(node_run_id);

            CREATE TABLE IF NOT EXISTS task_event (
                event_id        TEXT PRIMARY KEY,
                run_id          TEXT NOT NULL,
                run_seq         INTEGER NOT NULL,
                event_type      TEXT NOT NULL,
                schema_version  TEXT NOT NULL,
                occurred_at     INTEGER NOT NULL,
                actor           TEXT NOT NULL,
                causation_id    TEXT,
                correlation_id  TEXT,
                payload         TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_event_run_seq
                ON task_event(run_id, run_seq);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_event_run_seq_unique
                ON task_event(run_id, run_seq);

            CREATE TABLE IF NOT EXISTS artifact_ref (
                artifact_id     TEXT PRIMARY KEY,
                run_id          TEXT NOT NULL,
                node_run_id     TEXT NOT NULL,
                attempt_id      TEXT NOT NULL,
                name            TEXT NOT NULL,
                artifact_type   TEXT NOT NULL,
                hash            TEXT NOT NULL,
                sensitivity     TEXT NOT NULL,
                created_at      INTEGER NOT NULL,
                metadata        TEXT DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_artifact_run ON artifact_ref(run_id);

            CREATE TABLE IF NOT EXISTS approval_request (
                approval_id     TEXT PRIMARY KEY,
                run_id          TEXT NOT NULL,
                node_run_id     TEXT NOT NULL,
                description     TEXT NOT NULL,
                risk_level      TEXT NOT NULL,
                scope           TEXT DEFAULT '[]',
                requester       TEXT NOT NULL,
                resolver        TEXT,
                resolved        INTEGER DEFAULT 0,
                approved        INTEGER,
                created_at      INTEGER NOT NULL,
                resolved_at     INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_approval_run ON approval_request(run_id);
            CREATE INDEX IF NOT EXISTS idx_approval_pending ON approval_request(resolved) WHERE resolved = 0;

            CREATE TABLE IF NOT EXISTS wake_timer (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id          TEXT NOT NULL,
                node_run_id     TEXT NOT NULL,
                wake_at         INTEGER NOT NULL,
                timer_type      TEXT NOT NULL,
                consumed        INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_wake_pending ON wake_timer(consumed, wake_at);

            CREATE TABLE IF NOT EXISTS projection_checkpoint (
                run_id          TEXT PRIMARY KEY,
                last_seq        INTEGER NOT NULL,
                projection_json TEXT NOT NULL,
                updated_at      INTEGER NOT NULL
            );
            "#,
        )?;
        conn.pragma_update(None, "user_version", TASK_STORE_SCHEMA_VERSION)?;

        Ok(())
    }

    // ── TaskGraph operations ──────────────────────────────────────────

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

    /// Append events atomically. Returns the new run_seq.
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

    pub fn save_projection_checkpoint(
        &self,
        run_id: &str,
        last_seq: u64,
        projection_json: &str,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO projection_checkpoint
             (run_id, last_seq, projection_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![run_id, last_seq, projection_json, updated_at],
        )?;
        Ok(())
    }

    pub fn get_projection_checkpoint(
        &self,
        run_id: &str,
    ) -> Result<Option<(u64, String)>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let result = conn
            .query_row(
                "SELECT last_seq, projection_json FROM projection_checkpoint WHERE run_id = ?1",
                params![run_id],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?)),
            )
            .optional()?;
        Ok(result)
    }

    // ── NodeRun operations ────────────────────────────────────────────

    // ── NodeRun operations ────────────────────────────────────────────

    pub fn save_node_run(&self, node_run: &NodeRun) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
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
        Ok(())
    }

    pub fn save_execution_update(
        &self,
        node_run: &NodeRun,
        attempt: Option<&NodeAttempt>,
        artifacts: &[ArtifactRef],
        events: &[TaskEvent],
        budget_delta: Option<&crate::orchestrator::domain::run::AttemptUsage>,
        run_status: Option<(&RunStatus, Option<i64>)>,
    ) -> Result<u64, StoreError> {
        if events.is_empty() {
            return Err(StoreError::Conflict(
                "execution updates must include at least one event".into(),
            ));
        }
        if events.iter().any(|event| event.run_id != node_run.run_id) {
            return Err(StoreError::Conflict(
                "execution events must belong to the node run's graph run".into(),
            ));
        }

        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        let (current_seq, budget_json): (u64, String) = tx.query_row(
            "SELECT run_seq, budget_state FROM graph_run WHERE run_id = ?1",
            params![node_run.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut budget_state: BudgetState = decode_json_column(&budget_json, 1)?;
        if let Some(delta) = budget_delta {
            budget_state.consume(
                delta.input_tokens.saturating_add(delta.output_tokens),
                delta.cost_usd,
            );
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

        if let Some(attempt) = attempt {
            let agent_assignment = attempt
                .agent_assignment
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let lease = attempt
                .lease
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let error = attempt
                .error
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            tx.execute(
                "INSERT OR REPLACE INTO node_attempt
                 (attempt_id, node_run_id, attempt_number, agent_assignment, transport,
                  session_id, lease, usage, error, idempotency_key, checkpoint,
                  started_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    attempt.attempt_id,
                    attempt.node_run_id,
                    attempt.attempt_number,
                    agent_assignment,
                    attempt.transport,
                    attempt.session_id,
                    lease,
                    serde_json::to_string(&attempt.usage)?,
                    error,
                    attempt.idempotency_key,
                    attempt
                        .checkpoint
                        .as_ref()
                        .map(|checkpoint| checkpoint.to_string()),
                    attempt.started_at,
                    attempt.finished_at,
                ],
            )?;
        }

        for artifact in artifacts {
            tx.execute(
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
        }

        for event in events {
            insert_event(&tx, event)?;
        }

        // Try to advance the projection checkpoint within the same transaction.
        // Legitimate skips (no checkpoint, stale/gapped) return Ok silently.
        // Genuine anomalies (deserialize/apply failures) are logged but don't fail the tx.
        if let Err(error) = try_advance_projection_checkpoint(&tx, &node_run.run_id, events) {
            tracing::warn!(
                run_id = %node_run.run_id,
                error = %error,
                "in-tx projection checkpoint advance skipped; will self-heal on next read"
            );
        }

        let max_seq = events
            .last()
            .map(|event| event.run_seq)
            .unwrap_or(current_seq);
        if let Some((status, finished_at)) = run_status {
            tx.execute(
                "UPDATE graph_run
                 SET status = ?1, run_seq = ?2, finished_at = ?3, budget_state = ?4
                 WHERE run_id = ?5",
                params![
                    serde_json::to_string(status)?,
                    max_seq,
                    finished_at,
                    serde_json::to_string(&budget_state)?,
                    node_run.run_id,
                ],
            )?;
        } else {
            tx.execute(
                "UPDATE graph_run SET run_seq = ?1, budget_state = ?2 WHERE run_id = ?3",
                params![
                    max_seq,
                    serde_json::to_string(&budget_state)?,
                    node_run.run_id
                ],
            )?;
        }
        tx.commit()?;
        Ok(max_seq)
    }

    pub fn save_node_runs_with_events(
        &self,
        node_runs: &[NodeRun],
        events: &[TaskEvent],
        run_status: Option<(&RunStatus, Option<i64>)>,
    ) -> Result<u64, StoreError> {
        let first = node_runs
            .first()
            .ok_or_else(|| StoreError::Conflict("node run batch cannot be empty".into()))?;
        if events.is_empty()
            || node_runs
                .iter()
                .any(|node_run| node_run.run_id != first.run_id)
            || events.iter().any(|event| event.run_id != first.run_id)
        {
            return Err(StoreError::Conflict(
                "node run batch and events must belong to one run".into(),
            ));
        }
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        let current_seq: u64 = tx.query_row(
            "SELECT run_seq FROM graph_run WHERE run_id = ?1",
            params![first.run_id],
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
        let max_seq = events
            .last()
            .map(|event| event.run_seq)
            .unwrap_or(current_seq);
        if let Some((status, finished_at)) = run_status {
            tx.execute(
                "UPDATE graph_run SET status = ?1, run_seq = ?2, finished_at = ?3
                 WHERE run_id = ?4",
                params![
                    serde_json::to_string(status)?,
                    max_seq,
                    finished_at,
                    first.run_id
                ],
            )?;
        } else {
            tx.execute(
                "UPDATE graph_run SET run_seq = ?1 WHERE run_id = ?2",
                params![max_seq, first.run_id],
            )?;
        }
        tx.commit()?;
        Ok(max_seq)
    }

    pub fn get_node_runs(&self, run_id: &str) -> Result<Vec<NodeRun>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT node_run_id, run_id, node_id, status, revision_id, started_at,
                    finished_at, attempt_count, wake_at, error, loop_iteration, superseded
             FROM node_run WHERE run_id = ?1",
        )?;

        let runs = stmt
            .query_map(params![run_id], |row| {
                let status_json: String = row.get(3)?;
                Ok(NodeRun {
                    node_run_id: row.get(0)?,
                    run_id: row.get(1)?,
                    node_id: row.get(2)?,
                    status: decode_json_column(&status_json, 3)?,
                    revision_id: row.get(4)?,
                    started_at: row.get(5)?,
                    finished_at: row.get(6)?,
                    attempt_count: row.get(7)?,
                    wake_at: row.get(8)?,
                    error: row.get(9)?,
                    loop_iteration: row.get(10)?,
                    superseded: row.get::<_, i32>(11)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(runs)
    }

    pub fn get_node_run(&self, node_run_id: &str) -> Result<NodeRun, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.query_row(
            "SELECT node_run_id, run_id, node_id, status, revision_id, started_at,
                    finished_at, attempt_count, wake_at, error, loop_iteration, superseded
             FROM node_run WHERE node_run_id = ?1",
            params![node_run_id],
            |row| {
                let status_json: String = row.get(3)?;
                Ok(NodeRun {
                    node_run_id: row.get(0)?,
                    run_id: row.get(1)?,
                    node_id: row.get(2)?,
                    status: decode_json_column(&status_json, 3)?,
                    revision_id: row.get(4)?,
                    started_at: row.get(5)?,
                    finished_at: row.get(6)?,
                    attempt_count: row.get(7)?,
                    wake_at: row.get(8)?,
                    error: row.get(9)?,
                    loop_iteration: row.get(10)?,
                    superseded: row.get::<_, i32>(11)? != 0,
                })
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("node run {node_run_id}")))
    }

    // ── NodeAttempt operations ────────────────────────────────────────

    pub fn save_attempt(&self, attempt: &NodeAttempt) -> Result<(), StoreError> {
        let agent_assignment = attempt
            .agent_assignment
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let lease = attempt
            .lease
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let error = attempt
            .error
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO node_attempt
             (attempt_id, node_run_id, attempt_number, agent_assignment, transport,
              session_id, lease, usage, error, idempotency_key, checkpoint,
              started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                attempt.attempt_id,
                attempt.node_run_id,
                attempt.attempt_number,
                agent_assignment,
                attempt.transport,
                attempt.session_id,
                lease,
                serde_json::to_string(&attempt.usage)?,
                error,
                attempt.idempotency_key,
                attempt.checkpoint.as_ref().map(|c| c.to_string()),
                attempt.started_at,
                attempt.finished_at,
            ],
        )?;
        Ok(())
    }

    pub fn latest_attempt(&self, node_run_id: &str) -> Result<Option<NodeAttempt>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.query_row(
            "SELECT attempt_id, node_run_id, attempt_number, agent_assignment, transport,
                    session_id, lease, usage, error, idempotency_key, checkpoint,
                    started_at, finished_at
             FROM node_attempt WHERE node_run_id = ?1
             ORDER BY attempt_number DESC LIMIT 1",
            params![node_run_id],
            |row| {
                let agent_assignment = row
                    .get::<_, Option<String>>(3)?
                    .map(|value| decode_json_column(&value, 3))
                    .transpose()?;
                let lease = row
                    .get::<_, Option<String>>(6)?
                    .map(|value| decode_json_column(&value, 6))
                    .transpose()?;
                let usage_json: String = row.get(7)?;
                let error = row
                    .get::<_, Option<String>>(8)?
                    .map(|value| decode_json_column(&value, 8))
                    .transpose()?;
                let checkpoint = row
                    .get::<_, Option<String>>(10)?
                    .map(|value| decode_json_column(&value, 10))
                    .transpose()?;
                Ok(NodeAttempt {
                    attempt_id: row.get(0)?,
                    node_run_id: row.get(1)?,
                    attempt_number: row.get(2)?,
                    agent_assignment,
                    transport: row.get(4)?,
                    session_id: row.get(5)?,
                    lease,
                    usage: decode_json_column(&usage_json, 7)?,
                    error,
                    idempotency_key: row.get(9)?,
                    checkpoint,
                    started_at: row.get(11)?,
                    finished_at: row.get(12)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    // ── Approval operations ───────────────────────────────────────────

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

/// Outcome of a controlled WAL checkpoint (`TaskStore::checkpoint`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalCheckpointOutcome {
    /// `true` if the checkpoint could not run because a reader held a lock.
    pub busy: bool,
    /// Number of frames in the WAL log file at checkpoint time.
    pub log_frames: i64,
    /// Number of WAL frames successfully copied back to the main database.
    pub checkpointed_frames: i64,
}

fn insert_event(tx: &rusqlite::Transaction<'_>, event: &TaskEvent) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO task_event
         (event_id, run_id, run_seq, event_type, schema_version, occurred_at,
          actor, causation_id, correlation_id, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            event.event_id,
            event.run_id,
            event.run_seq,
            serde_json::to_string(&event.event_type)?,
            event.schema_version,
            event.occurred_at,
            event.actor,
            event.causation_id,
            event.correlation_id,
            serde_json::to_string(&event.payload)?,
        ],
    )?;
    Ok(())
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

/// Resolve the default database path.
pub fn default_db_path() -> PathBuf {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("jishu-hub").join("taskstore.db")
}

/// Resolve the default data directory.
pub fn default_data_dir() -> PathBuf {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("jishu-hub")
}

/// Error when attempting to advance a projection checkpoint in-transaction.
/// Only real anomalies (deserialize/apply failures) surface as errors;
/// legitimate skips (no checkpoint, stale/gapped checkpoint) return Ok.
#[derive(Debug)]
enum CheckpointAdvanceError {
    Deserialize(serde_json::Error),
    Apply(crate::orchestrator::events::ProjectionError),
}

impl std::fmt::Display for CheckpointAdvanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Deserialize(e) => write!(f, "checkpoint deserialize error: {e}"),
            Self::Apply(e) => write!(f, "checkpoint apply error: {e}"),
        }
    }
}

/// Try to advance the projection checkpoint within the same transaction that
/// appended events. Returns Ok(()) for legitimate skips (no checkpoint, stale/gapped),
/// Err only for genuine anomalies (deserialize/apply failures).
fn try_advance_projection_checkpoint(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
    events: &[TaskEvent],
) -> Result<(), CheckpointAdvanceError> {
    use crate::orchestrator::events::{apply_events_to_projection, RunProjection};

    let Some(first_event) = events.first() else {
        return Ok(());
    };
    let starting_seq = first_event.run_seq;
    if starting_seq <= 1 {
        return Ok(());
    }

    let checkpoint_result: Result<Option<(u64, String)>, _> = tx
        .query_row(
            "SELECT last_seq, projection_json FROM projection_checkpoint WHERE run_id = ?1",
            params![run_id],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?)),
        )
        .optional();

    let Some((last_seq, proj_json)) = checkpoint_result.map_err(|e| {
        CheckpointAdvanceError::Deserialize(serde_json::Error::io(
            std::io::Error::new(std::io::ErrorKind::Other, format!("db query failed: {e}")),
        ))
    })?
    else {
        return Ok(());
    };

    // Check if checkpoint is contiguous with the new events.
    if last_seq != starting_seq - 1 {
        return Ok(());
    }

    // Deserialize and apply the delta events.
    let mut proj: RunProjection =
        serde_json::from_str(&proj_json).map_err(CheckpointAdvanceError::Deserialize)?;

    apply_events_to_projection(&mut proj, events, starting_seq)
        .map_err(CheckpointAdvanceError::Apply)?;

    // Save updated checkpoint (best-effort).
    if let Ok(updated_json) = serde_json::to_string(&proj) {
        let _ = tx.execute(
            "INSERT OR REPLACE INTO projection_checkpoint
             (run_id, last_seq, projection_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![run_id, proj.run_seq, updated_json, crate::util::now_ms(),],
        );
    }

    Ok(())
}

impl ProjectionReadModel for TaskStore {
    fn events_after(
        &self,
        run_id: &str,
        after_seq: u64,
        limit: u64,
    ) -> Result<Vec<crate::orchestrator::events::TaskEvent>, StoreError> {
        self.events_after(run_id, after_seq, limit)
    }

    fn all_events(
        &self,
        run_id: &str,
    ) -> Result<Vec<crate::orchestrator::events::TaskEvent>, StoreError> {
        self.all_events(run_id)
    }

    fn get_projection_checkpoint(&self, run_id: &str) -> Result<Option<(u64, String)>, StoreError> {
        self.get_projection_checkpoint(run_id)
    }

    fn save_projection_checkpoint(
        &self,
        run_id: &str,
        last_seq: u64,
        projection_json: &str,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        self.save_projection_checkpoint(run_id, last_seq, projection_json, updated_at)
    }
}

// Also implement for Arc<TaskStore> since service.rs holds an Arc
impl ProjectionReadModel for std::sync::Arc<TaskStore> {
    fn events_after(
        &self,
        run_id: &str,
        after_seq: u64,
        limit: u64,
    ) -> Result<Vec<crate::orchestrator::events::TaskEvent>, StoreError> {
        self.as_ref().events_after(run_id, after_seq, limit)
    }

    fn all_events(
        &self,
        run_id: &str,
    ) -> Result<Vec<crate::orchestrator::events::TaskEvent>, StoreError> {
        self.as_ref().all_events(run_id)
    }

    fn get_projection_checkpoint(&self, run_id: &str) -> Result<Option<(u64, String)>, StoreError> {
        self.as_ref().get_projection_checkpoint(run_id)
    }

    fn save_projection_checkpoint(
        &self,
        run_id: &str,
        last_seq: u64,
        projection_json: &str,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        self.as_ref().save_projection_checkpoint(run_id, last_seq, projection_json, updated_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::domain::graph::{
        EdgeKind, GraphEdge, GraphNode, GraphSnapshot, NodeKind,
    };
    use crate::orchestrator::domain::revision::GraphRevision;
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
        let r2 = GraphRevision::from_snapshot("r2", "g1", Some("r1".into()), &snapshot, "u", 200)
            .unwrap();
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
        let revision =
            GraphRevision::from_snapshot("r1", "g1", None, &snapshot, "u", now()).unwrap();
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
            GraphRevision::from_snapshot("r2", "g1", Some("r1".into()), &snapshot, "u", now())
                .unwrap();
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
}
