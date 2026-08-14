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

// TaskStore 按 aggregates 拆分（v0.7.3 需求1-M2）：各子模块以多个 impl 块扩展同一类型，
// mod.rs 保留类型定义、构造器、跨聚合共享助手与集成测试。
mod approval;
mod artifact;
mod events;
mod graph;
mod interaction;
mod node_run;
mod projection;
mod revision;
mod run;
mod schema;

impl TaskStore {
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

        // v0.7.2 需求 1 / M1.4：schema 版本即将变更（create_schema 会 DROP 全表
        // 重建）前，先把 WAL 合并回主库并整体备份。此前版本一变即清空，且
        // execute_batch 中途失败会留下半迁移 DB，导致后续启动反复崩溃。
        Self::backup_before_migrate(&writer_conn, db_path);

        if let Err(e) = Self::create_schema(&writer_conn) {
            log::error!(
                "taskstore create_schema 失败 (db={}, err={})；旧库已备份，上层将降级到内存库",
                db_path.display(),
                e
            );
            return Err(e);
        }

        // Open a separate read connection.
        let reader_conn = Connection::open(db_path)?;
        reader_conn.pragma_update(None, "busy_timeout", 5000)?;

        Ok(Self {
            writer: Mutex::new(writer_conn),
            reader: Mutex::new(reader_conn),
            db_path: db_path.to_path_buf(),
        })
    }

    /// 迁移前备份：若 user_version 与当前 schema 版本不一致（即 create_schema 即将
    /// DROP 全表重建），先把 WAL 合并回主库文件，复制一份带版本与时间戳的备份。
    /// 全新库（version=0）或版本一致时跳过。备份保留最近 5 份，超出清理。

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

#[cfg(test)]
mod tests;
