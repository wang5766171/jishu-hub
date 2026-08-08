use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::orchestrator::conversation::{TaskInteractionRequest, TaskInteractionSubmission};
use crate::orchestrator::domain::graph::TaskGraph;
use crate::orchestrator::domain::revision::GraphRevision;
use crate::orchestrator::domain::run::{
    AgentAssignment, ApprovalRequest, ArtifactRef, AttemptDispatch, BudgetState, GraphRun,
    NodeAttempt, NodeRun, NodeRunStatus, NodeSessionSummary, RunPlanningSnapshot,
    RunRevisionProposal, RunStatus,
};
use crate::orchestrator::events::TaskEvent;
use crate::orchestrator::projections::checkpoint::ProjectionReadModel;

const TASK_STORE_SCHEMA_VERSION: i64 = 4;

fn decode_json_column<T: DeserializeOwned>(raw: &str, column: usize) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

/// 对已有库安全补列：列不存在时 ALTER TABLE ADD COLUMN，已存在则跳过。
///
/// SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，通过 `pragma_table_info` 检查。
fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), StoreError> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |row| row.get(0),
    )?;
    if exists == 0 {
        // 表可能不存在（首次 create_schema 全新建库）——跳过。
        let table_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
            params![table],
            |row| row.get(0),
        )?;
        if table_exists == 0 {
            return Ok(());
        }
        let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
        conn.execute_batch(&sql)?;
        tracing::info!("migration: added column {table}.{column} {definition}");
    }
    Ok(())
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
                DROP TABLE IF EXISTS task_interaction_request;
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
                dispatch_prompt TEXT,
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

            CREATE TABLE IF NOT EXISTS task_interaction_request (
                request_id      TEXT PRIMARY KEY,
                graph_id       TEXT NOT NULL REFERENCES task_graph(graph_id),
                run_id         TEXT,
                node_id        TEXT,
                node_run_id    TEXT,
                session_id     TEXT,
                prompt         TEXT NOT NULL,
                options        TEXT NOT NULL DEFAULT '[]',
                allow_multiple INTEGER NOT NULL DEFAULT 0,
                allow_custom_text INTEGER NOT NULL DEFAULT 0,
                required       INTEGER NOT NULL DEFAULT 1,
                created_at     INTEGER NOT NULL,
                resolved_at    INTEGER,
                consumed_at    INTEGER,
                submission     TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_task_interaction_graph_pending
                ON task_interaction_request(graph_id, resolved_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_task_interaction_node_consumed
                ON task_interaction_request(node_run_id, resolved_at, consumed_at, created_at);

            CREATE TABLE IF NOT EXISTS projection_checkpoint (
                run_id          TEXT PRIMARY KEY,
                last_seq        INTEGER NOT NULL,
                projection_json TEXT NOT NULL,
                updated_at      INTEGER NOT NULL
            );
            "#,
        )?;

        // ── 轻量 migration：对已有库补列（新库 CREATE TABLE 已含）──
        // dispatch_prompt：T0 新增，node_attempt 派发 prompt（三角色识别用）。
        // SQLite 没有 ADD COLUMN IF NOT EXISTS，先查 pragma 检查列是否存在。
        ensure_column(&conn, "node_attempt", "dispatch_prompt", "TEXT")?;

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
                  session_id, lease, usage, error, idempotency_key, checkpoint, dispatch_prompt,
                  started_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
                    attempt.dispatch_prompt,
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
              session_id, lease, usage, error, idempotency_key, checkpoint, dispatch_prompt,
              started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
                attempt.dispatch_prompt,
                attempt.started_at,
                attempt.finished_at,
            ],
        )?;
        Ok(())
    }

    /// 节点 attempt 开始执行后，runtime 解析出真实 session_id（SessionResolved 事件）。
    /// 立即落库，使前端在节点**运行中**即可拿到 session_id 进入会话实时查看，
    /// 不必等到 attempt 完成（此前 session_id 仅完成时落库，导致运行中无法进入节点会话）。
    pub fn set_node_attempt_session_id(
        &self,
        attempt_id: &str,
        session_id: &str,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "UPDATE node_attempt SET session_id = ?1 WHERE attempt_id = ?2",
            params![session_id, attempt_id],
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
                    session_id, lease, usage, error, idempotency_key, checkpoint, dispatch_prompt,
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
                    dispatch_prompt: row.get(11)?,
                    started_at: row.get(12)?,
                    finished_at: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    /// Fetch a single attempt by (node_run_id, attempt_number).
    pub fn get_attempt(
        &self,
        node_run_id: &str,
        attempt_number: u32,
    ) -> Result<crate::orchestrator::domain::run::NodeAttempt, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.query_row(
            "SELECT attempt_id, node_run_id, attempt_number, agent_assignment, transport,
                    session_id, lease, usage, error, idempotency_key, checkpoint, dispatch_prompt,
                    started_at, finished_at
             FROM node_attempt WHERE node_run_id = ?1 AND attempt_number = ?2",
            params![node_run_id, attempt_number],
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
                    dispatch_prompt: row.get(11)?,
                    started_at: row.get(12)?,
                    finished_at: row.get(13)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                StoreError::NotFound(format!("attempt {node_run_id}/{attempt_number}"))
            }
            other => StoreError::Sqlite(other),
        })
    }

    /// 所有节点 attempt 的去重非空 session_id 列表。
    ///
    /// 用于前端把节点子代理会话从常规会话列表过滤（设计 18 §3 / 实施计划 19 T3.1）。
    /// 全表扫描：session_id 跨项目唯一（Pi session id），前端按当前项目 sessions 过滤时，
    /// 超集里的他项目 id 不会误伤（不在当前项目 session 列表里自然不匹配）。
    pub fn list_node_session_ids(&self) -> Result<Vec<String>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT session_id FROM node_attempt
             WHERE session_id IS NOT NULL AND session_id <> ''",
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    }

    /// 列出某次 run 下所有节点的最新 attempt 摘要（侧边栏任务二级树用）。
    ///
    /// 单条 SQL JOIN node_run + node_attempt（取每个 node_run 的最大 attempt_number），
    /// 避免 N+1 查询。设计 `02-总体设计.md` §6.2。
    pub fn list_node_sessions(&self, run_id: &str) -> Result<Vec<NodeSessionSummary>, StoreError> {
        // 1. 取出本 run 下所有节点的最新 attempt（含该节点所属的 revision_id）。
        //    用独立作用域持有 reader 锁，收集完即释放——避免后续 get_revision 再次加锁死锁。
        let node_rows: Vec<(
            String,       // node_id
            String,       // node_run_id
            String,       // status
            u32,          // attempt_number
            Option<String>, // session_id
            Option<String>, // agent_id
            String,       // revision_id
        )> = {
            let conn = self
                .reader
                .lock()
                .map_err(|e| StoreError::Lock(e.to_string()))?;
            let mut stmt = conn.prepare(
                "SELECT nr.node_id,
                        nr.node_run_id,
                        nr.status,
                        na.attempt_number,
                        na.session_id,
                        na.agent_assignment,
                        nr.revision_id
                 FROM node_run nr
                 LEFT JOIN node_attempt na
                   ON na.node_run_id = nr.node_run_id
                  AND na.attempt_number = (
                      SELECT MAX(attempt_number) FROM node_attempt WHERE node_run_id = nr.node_run_id
                  )
                 WHERE nr.run_id = ?1
                 ORDER BY nr.started_at ASC, nr.node_run_id ASC",
            )?;
            let rows = stmt.query_map(params![run_id], |row| {
                let status_raw: String = row.get(2)?;
                // node_run.status 列存的是 serde_json::to_string 结果（带引号的 JSON 字符串，
                // 如 `"succeeded"`）。这里解码回枚举再序列化为干净的 snake_case 字符串，
                // 避免前端拿到带引号的字符串导致状态图标匹配失败（全部走 default 空心圆）。
                let status = serde_json::from_str::<NodeRunStatus>(&status_raw)
                    .map(|s| {
                        serde_json::to_string(&s)
                            .map(|v| v.trim_matches('"').to_string())
                            .unwrap_or_else(|_| status_raw.clone())
                    })
                    .unwrap_or_else(|_| status_raw.clone());
                let agent_assignment_json: Option<String> = row.get(5)?;
                let agent_id = agent_assignment_json
                    .as_deref()
                    .and_then(|json| serde_json::from_str::<crate::orchestrator::domain::run::AgentAssignment>(json).ok())
                    .map(|assignment| assignment.agent_id);
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    status,
                    row.get::<_, Option<i64>>(3)?.map(|n| n as u32).unwrap_or(0),
                    row.get(4)?,
                    agent_id,
                    row.get::<_, String>(6)?,
                ))
            })?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row?);
            }
            v
        };

        if node_rows.is_empty() {
            return Ok(Vec::new());
        }

        // 2. 取 graph 的 current_draft_revision（兜底标题源）。
        let draft_revision_id: Option<String> = {
            let conn = self
                .reader
                .lock()
                .map_err(|e| StoreError::Lock(e.to_string()))?;
            conn.query_row(
                "SELECT g.current_draft_revision
                 FROM graph_run r
                 LEFT JOIN graph g ON g.graph_id = r.graph_id
                 WHERE r.run_id = ?1",
                params![run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        };

        // 3. 加载需要的 revision，构建 node_id → 中文标题 映射。
        //    优先用 run 实际执行的 revision（node_id 必然对齐）；draft 仅作兜底。
        let mut run_title_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut draft_title_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut loaded: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (_, _, _, _, _, _, rev_id) in &node_rows {
            if rev_id.is_empty() || !loaded.insert(rev_id.clone()) {
                continue;
            }
            if let Ok(rev) = self.get_revision(rev_id) {
                if let Ok(snap) = rev.canonical_snapshot.to_snapshot() {
                    for n in snap.nodes {
                        let t = n.title.trim().to_string();
                        if !t.is_empty() {
                            run_title_map.entry(n.node_id.clone()).or_insert(t);
                        }
                    }
                }
            }
        }
        if let Some(d) = &draft_revision_id {
            if !d.is_empty() && loaded.insert(d.clone()) {
                if let Ok(rev) = self.get_revision(d) {
                    if let Ok(snap) = rev.canonical_snapshot.to_snapshot() {
                        for n in snap.nodes {
                            let t = n.title.trim().to_string();
                            if !t.is_empty() {
                                draft_title_map.entry(n.node_id.clone()).or_insert(t);
                            }
                        }
                    }
                }
            }
        }

        // 4. 选择展示标题：run revision（对齐）优先，其次 draft，最后才回退裸 node_id。
        //    过滤掉 "Node n1" 这类占位标题，确保侧边栏永远显示中文标题、绝不出现 N1/N2。
        let pick = |title: Option<String>, node_id: &str| -> Option<String> {
            title.filter(|t| {
                let tt = t.trim();
                !tt.is_empty()
                    && !tt.eq_ignore_ascii_case(&format!("Node {node_id}"))
                    && !tt.starts_with("Node ")
            })
        };

        let mut summaries = Vec::with_capacity(node_rows.len());
        for (node_id, node_run_id, status, attempt_number, session_id, agent_id, _) in node_rows {
            let title = pick(run_title_map.get(&node_id).cloned(), &node_id)
                .or_else(|| pick(draft_title_map.get(&node_id).cloned(), &node_id))
                .unwrap_or_else(|| node_id.clone());
            summaries.push(NodeSessionSummary {
                node_id,
                node_run_id,
                status,
                attempt_number,
                session_id,
                agent_id,
                title,
            });
        }
        Ok(summaries)
    }

    /// 列出某节点所有 attempt 的派发 prompt（三角色识别用，设计 §7.1 方案 A）。
    ///
    /// 依赖 `dispatch_prompt` 列（T0 新增）。老库无此列时 SQLite ALTER TABLE ADD COLUMN
    /// 默认 NULL，返回空 prompt（前端降级为两角色）。
    pub fn list_attempt_dispatches(
        &self,
        node_run_id: &str,
    ) -> Result<Vec<AttemptDispatch>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT attempt_number, started_at, dispatch_prompt
             FROM node_attempt
             WHERE node_run_id = ?1 AND dispatch_prompt IS NOT NULL
             ORDER BY attempt_number ASC",
        )?;
        let rows = stmt.query_map(params![node_run_id], |row| {
            Ok(AttemptDispatch {
                attempt_number: row.get::<_, i64>(0)? as u32,
                dispatched_at: row.get(1)?,
                prompt: row.get(2)?,
            })
        })?;
        let mut dispatches = Vec::new();
        for row in rows {
            dispatches.push(row?);
        }
        Ok(dispatches)
    }

    /// Refresh the heartbeat deadline on the latest attempt's lease for a node run.
    /// Used by the execution heartbeat loop to keep an in-flight lease alive.
    pub fn refresh_lease_heartbeat(
        &self,
        node_run_id: &str,
        heartbeat_deadline: i64,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT attempt_id, lease FROM node_attempt
                 WHERE node_run_id = ?1 ORDER BY attempt_number DESC LIMIT 1",
                params![node_run_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let Some((attempt_id, lease_json)) = row else {
            return Ok(());
        };
        let Some(lease_json) = lease_json else {
            return Ok(());
        };
        let mut lease: crate::orchestrator::domain::run::Lease =
            serde_json::from_str(&lease_json).map_err(|e| StoreError::Serde(e.into()))?;
        lease.heartbeat_deadline = heartbeat_deadline;
        let updated = serde_json::to_string(&lease).map_err(|e| StoreError::Serde(e.into()))?;
        conn.execute(
            "UPDATE node_attempt SET lease = ?1 WHERE attempt_id = ?2",
            params![updated, attempt_id],
        )?;
        Ok(())
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
        CheckpointAdvanceError::Deserialize(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("db query failed: {e}"),
        )))
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
        self.as_ref()
            .save_projection_checkpoint(run_id, last_seq, projection_json, updated_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::normalized::InteractionOption;
    use crate::orchestrator::domain::graph::{
        EdgeKind, GraphEdge, GraphNode, GraphSnapshot, NodeKind,
    };
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
        let revision =
            GraphRevision::from_snapshot("rev1", "g1", None, &snapshot, "u", now()).unwrap();
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
        let mk_attempt = |id: &str, num: u32, sess: Option<&str>| {
            crate::orchestrator::domain::run::NodeAttempt {
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
            }
        };
        store.save_attempt(&mk_attempt("att1", 1, Some("sess-a"))).unwrap();
        store.save_attempt(&mk_attempt("att2", 2, None)).unwrap();
        store.save_attempt(&mk_attempt("att3", 3, Some("sess-a"))).unwrap();
        store.save_attempt(&mk_attempt("att4", 4, Some("sess-b"))).unwrap();

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
        let revision =
            GraphRevision::from_snapshot(&format!("rev-{run_id}"), &format!("g-{run_id}"), None, &snapshot, "user", now())
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
}
