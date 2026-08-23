//! v0.8.0 需求10：会话用量记账（SQLite，`~/.jishu-hub/usage.db`）。
//!
//! 开发原则（DEVELOP_READ §9）：记录类数据优先 SQLite，不落 JSONL、不依赖
//! 前端存储。Rust 在 pi turn_end **分段级**记账（工具循环的中间段以 toolUse
//! 停止、不发 TurnComplete，按回合级记账会漏掉这些分段的生成量）。
//!
//! 表结构（初期一次设计完整，为会话索引等后续能力预留）：
//! - `session_usage`：会话聚合（精确 in/out/cache/cost + 水位 + 构成估算 +
//!   分段数/压缩次数）。
//! - `usage_segment`：每个生成分段一行（精确 usage + 内容块归因估算）。
//! - `usage_compaction`：每次压缩一行——压缩前后规模（pi 上报）、数据定位
//!   （first_kept_entry_id 保留边界条目）、生成摘要的调用开销。
//!
//! 归因口径：in/out/cache/cost 为 API 上报的**精确值**；思考/文本/工具/
//! 工具结果为对消息内容块的**估算值**（≈2.5 字符/token 中英混合粗估，仅供
//! 构成对比，UI 标注「估算」）。工具分类：pi-mcp-adapter 注册的 MCP 工具
//! 在 toolCall 块上**无标志**（实测仅 type/id/name/arguments 四字段），按
//! 用户裁决暂统一归入工具桶；est_mcp_tool/mcp_calls 列保留为前向预留。

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Default)]
pub struct SegmentUsage {
    pub stop_reason: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_tokens: u64,
    pub total_cost: f64,
    pub context_remaining: Option<u64>,
    pub context_window_total: Option<u64>,
    pub est_thinking: u64,
    pub est_text: u64,
    pub est_builtin_tool: u64,
    pub est_mcp_tool: u64,
    pub est_tool_results: u64,
    pub tool_calls: u64,
    pub mcp_calls: u64,
}

/// 压缩记录（来自 pi compaction_end 的 CompactionResult）。
#[derive(Debug, Clone, Default)]
pub struct CompactionRecord {
    pub reason: String,
    pub aborted: bool,
    /// 压缩前上下文规模（pi 上报，精确）。 */
    pub tokens_before: u64,
    /// 压缩后估算（pi estimatedTokensAfter）。 */
    pub tokens_after: u64,
    /// 数据定位：保留边界条目 id（压缩把该条目之前的历史摘要化）。 */
    pub first_kept_entry_id: Option<String>,
    /// 生成摘要的 LLM 调用开销（并入会话总量，明细 stop=compaction_summary）。 */
    pub summary_input: u64,
    pub summary_output: u64,
    pub summary_cost: f64,
    /// 摘要正文的估算规模。 */
    pub est_summary: u64,
}

#[derive(Debug, Clone, Default, serde::Serialize, PartialEq)]
pub struct SessionUsageRow {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_cost: f64,
    pub context_remaining: Option<u64>,
    pub context_window_total: Option<u64>,
    pub est_thinking: u64,
    pub est_text: u64,
    pub est_builtin_tool: u64,
    pub est_mcp_tool: u64,
    pub est_tool_results: u64,
    pub tool_calls: u64,
    pub mcp_calls: u64,
    pub segments: u64,
    pub compactions: u64,
    pub updated_at: i64,
}

struct UsageStore {
    conn: Mutex<Connection>,
}

static STORE: OnceLock<UsageStore> = OnceLock::new();

fn db_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(".jishu-hub");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("usage.db"))
}

/// Schema 版本（user_version）。无兼容策略（用户裁决）：版本不符直接
/// DROP 重建，旧数据弃置——不写 ALTER/迁移代码。
const SCHEMA_VERSION: i64 = 2;

fn init_conn(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if version != SCHEMA_VERSION {
        conn.execute_batch(
            "DROP TABLE IF EXISTS session_usage;
             DROP TABLE IF EXISTS usage_segment;
             DROP TABLE IF EXISTS usage_compaction;",
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_usage (
            session_id           TEXT PRIMARY KEY,
            agent_id             TEXT NOT NULL DEFAULT '',
            input_tokens         INTEGER NOT NULL DEFAULT 0,
            output_tokens        INTEGER NOT NULL DEFAULT 0,
            cache_read           INTEGER NOT NULL DEFAULT 0,
            cache_write          INTEGER NOT NULL DEFAULT 0,
            total_cost           REAL NOT NULL DEFAULT 0,
            context_remaining    INTEGER,
            context_window_total INTEGER,
            est_thinking         INTEGER NOT NULL DEFAULT 0,
            est_text             INTEGER NOT NULL DEFAULT 0,
            est_builtin_tool     INTEGER NOT NULL DEFAULT 0,
            est_mcp_tool         INTEGER NOT NULL DEFAULT 0,
            est_tool_results     INTEGER NOT NULL DEFAULT 0,
            tool_calls           INTEGER NOT NULL DEFAULT 0,
            mcp_calls            INTEGER NOT NULL DEFAULT 0,
            segments             INTEGER NOT NULL DEFAULT 0,
            compactions          INTEGER NOT NULL DEFAULT 0,
            updated_at           INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS usage_segment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            agent_id   TEXT NOT NULL DEFAULT '',
            ts INTEGER NOT NULL,
            stop_reason TEXT NOT NULL DEFAULT '',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read INTEGER NOT NULL DEFAULT 0,
            cache_write INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            est_thinking INTEGER NOT NULL DEFAULT 0,
            est_text INTEGER NOT NULL DEFAULT 0,
            est_builtin_tool INTEGER NOT NULL DEFAULT 0,
            est_mcp_tool INTEGER NOT NULL DEFAULT 0,
            est_tool_results INTEGER NOT NULL DEFAULT 0,
            tool_calls INTEGER NOT NULL DEFAULT 0,
            mcp_calls INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_segment_session
            ON usage_segment(session_id, id);
        CREATE TABLE IF NOT EXISTS usage_compaction (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            agent_id   TEXT NOT NULL DEFAULT '',
            ts INTEGER NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            aborted INTEGER NOT NULL DEFAULT 0,
            tokens_before INTEGER NOT NULL DEFAULT 0,
            tokens_after INTEGER NOT NULL DEFAULT 0,
            summary_input INTEGER NOT NULL DEFAULT 0,
            summary_output INTEGER NOT NULL DEFAULT 0,
            summary_cost REAL NOT NULL DEFAULT 0,
            est_summary INTEGER NOT NULL DEFAULT 0,
            first_kept_entry_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_usage_compaction_session
            ON usage_compaction(session_id, id);
        PRAGMA user_version = 2;",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn store() -> Result<&'static UsageStore, String> {
    if let Some(s) = STORE.get() {
        return Ok(s);
    }
    let conn = Connection::open(db_path()?).map_err(|e| e.to_string())?;
    init_conn(&conn)?;
    let _ = STORE.set(UsageStore {
        conn: Mutex::new(conn),
    });
    STORE.get().ok_or_else(|| "usage store init failed".to_string())
}

/// 记一个生成分段：明细入 usage_segment，聚合 upsert 进 session_usage
/// （数值列累加；context 字段覆盖语义——缺省保留旧值）。best-effort。
pub fn record_segment(agent_id: &str, session_id: &str, seg: &SegmentUsage) {
    if let Ok(s) = store() {
        if let Ok(conn) = s.conn.lock() {
            let _ = record_segment_on(&conn, agent_id, session_id, seg);
        }
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn record_segment_on(
    conn: &Connection,
    agent_id: &str,
    session_id: &str,
    seg: &SegmentUsage,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO usage_segment
            (session_id, agent_id, ts, stop_reason, input_tokens, output_tokens,
             cache_read, cache_write, total_tokens, est_thinking, est_text,
             est_builtin_tool, est_mcp_tool, est_tool_results, tool_calls, mcp_calls)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        rusqlite::params![
            session_id,
            agent_id,
            now_secs(),
            seg.stop_reason,
            seg.input_tokens,
            seg.output_tokens,
            seg.cache_read,
            seg.cache_write,
            seg.total_tokens,
            seg.est_thinking,
            seg.est_text,
            seg.est_builtin_tool,
            seg.est_mcp_tool,
            seg.est_tool_results,
            seg.tool_calls,
            seg.mcp_calls,
        ],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO session_usage
            (session_id, agent_id, input_tokens, output_tokens, cache_read, cache_write,
             total_cost, context_remaining, context_window_total, est_thinking, est_text,
             est_builtin_tool, est_mcp_tool, est_tool_results, tool_calls, mcp_calls,
             segments, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1, ?17)
         ON CONFLICT(session_id) DO UPDATE SET
            agent_id = excluded.agent_id,
            input_tokens = session_usage.input_tokens + excluded.input_tokens,
            output_tokens = session_usage.output_tokens + excluded.output_tokens,
            cache_read = session_usage.cache_read + excluded.cache_read,
            cache_write = session_usage.cache_write + excluded.cache_write,
            total_cost = session_usage.total_cost + excluded.total_cost,
            context_remaining = COALESCE(excluded.context_remaining, session_usage.context_remaining),
            context_window_total = COALESCE(excluded.context_window_total, session_usage.context_window_total),
            est_thinking = session_usage.est_thinking + excluded.est_thinking,
            est_text = session_usage.est_text + excluded.est_text,
            est_builtin_tool = session_usage.est_builtin_tool + excluded.est_builtin_tool,
            est_mcp_tool = session_usage.est_mcp_tool + excluded.est_mcp_tool,
            est_tool_results = session_usage.est_tool_results + excluded.est_tool_results,
            tool_calls = session_usage.tool_calls + excluded.tool_calls,
            mcp_calls = session_usage.mcp_calls + excluded.mcp_calls,
            segments = session_usage.segments + 1,
            updated_at = excluded.updated_at",
        rusqlite::params![
            session_id,
            agent_id,
            seg.input_tokens,
            seg.output_tokens,
            seg.cache_read,
            seg.cache_write,
            seg.total_cost,
            seg.context_remaining,
            seg.context_window_total,
            seg.est_thinking,
            seg.est_text,
            seg.est_builtin_tool,
            seg.est_mcp_tool,
            seg.est_tool_results,
            seg.tool_calls,
            seg.mcp_calls,
            now_secs(),
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// 记一次压缩：usage_compaction 行 + 摘要调用开销以 stop=compaction_summary
/// 分段并入总量 + session_usage.compactions 计数。best-effort。
pub fn record_compaction(agent_id: &str, session_id: &str, rec: &CompactionRecord) {
    if let Ok(s) = store() {
        if let Ok(conn) = s.conn.lock() {
            let _ = record_compaction_on(&conn, agent_id, session_id, rec);
        }
    }
}

fn record_compaction_on(
    conn: &Connection,
    agent_id: &str,
    session_id: &str,
    rec: &CompactionRecord,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO usage_compaction
            (session_id, agent_id, ts, reason, aborted, tokens_before, tokens_after,
             summary_input, summary_output, summary_cost, est_summary, first_kept_entry_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            session_id,
            agent_id,
            now_secs(),
            rec.reason,
            rec.aborted as i64,
            rec.tokens_before,
            rec.tokens_after,
            rec.summary_input,
            rec.summary_output,
            rec.summary_cost,
            rec.est_summary,
            rec.first_kept_entry_id,
        ],
    )
    .map_err(|e| e.to_string())?;

    // 摘要生成调用并入会话总量（作为特殊分段入明细）。
    let summary_seg = SegmentUsage {
        stop_reason: "compaction_summary".into(),
        input_tokens: rec.summary_input,
        output_tokens: rec.summary_output,
        total_cost: rec.summary_cost,
        est_text: rec.est_summary,
        ..Default::default()
    };
    record_segment_on(conn, agent_id, session_id, &summary_seg)?;

    // 压缩后水位即时更新：remaining = 窗口 - 压缩后规模（pi 上报
    // estimatedTokensAfter；窗口沿用会话行存量）——圆环无需等下一轮对话。
    conn.execute(
        "UPDATE session_usage SET
            compactions = compactions + 1,
            context_remaining = CASE
                WHEN context_window_total IS NOT NULL AND ?3 > 0
                THEN MAX(0, context_window_total - ?3)
                ELSE context_remaining
            END,
            updated_at = ?2
         WHERE session_id = ?1",
        rusqlite::params![session_id, now_secs(), rec.tokens_after as i64],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn read_on(conn: &Connection, session_id: &str) -> Result<SessionUsageRow, String> {
    conn.query_row(
        "SELECT input_tokens, output_tokens, cache_read, cache_write, total_cost,
                context_remaining, context_window_total, est_thinking, est_text,
                est_builtin_tool, est_mcp_tool, est_tool_results, tool_calls,
                mcp_calls, segments, compactions, updated_at
         FROM session_usage WHERE session_id = ?1",
        [session_id],
        |row| {
            Ok(SessionUsageRow {
                input_tokens: row.get(0)?,
                output_tokens: row.get(1)?,
                cache_read: row.get(2)?,
                cache_write: row.get(3)?,
                total_cost: row.get(4)?,
                context_remaining: row.get(5)?,
                context_window_total: row.get(6)?,
                est_thinking: row.get(7)?,
                est_text: row.get(8)?,
                est_builtin_tool: row.get(9)?,
                est_mcp_tool: row.get(10)?,
                est_tool_results: row.get(11)?,
                tool_calls: row.get(12)?,
                mcp_calls: row.get(13)?,
                segments: row.get(14)?,
                compactions: row.get(15)?,
                updated_at: row.get(16)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// 读取会话累计用量（无记录返回全零行）。
pub fn get(session_id: &str) -> Result<SessionUsageRow, String> {
    let s = store()?;
    let conn = s.conn.lock().map_err(|e| e.to_string())?;
    match read_on(&conn, session_id) {
        Ok(row) => Ok(row),
        Err(_) => Ok(SessionUsageRow::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(input: u64, output: u64) -> SegmentUsage {
        SegmentUsage {
            stop_reason: "end_turn".into(),
            input_tokens: input,
            output_tokens: output,
            total_cost: 0.01,
            context_remaining: Some(9000),
            context_window_total: Some(200_000),
            est_thinking: 10,
            est_text: 20,
            est_builtin_tool: 30,
            tool_calls: 1,
            ..Default::default()
        }
    }

    #[test]
    fn accumulates_segments_and_covers_context() {
        let conn = Connection::open_in_memory().unwrap();
        init_conn(&conn).unwrap();

        record_segment_on(&conn, "jishu-self", "s1", &seg(100, 50)).unwrap();
        let mut s2 = seg(200, 30);
        s2.context_remaining = None; // 缺省保留旧值（覆盖语义）
        record_segment_on(&conn, "jishu-self", "s1", &s2).unwrap();

        let row = read_on(&conn, "s1").unwrap();
        assert_eq!(row.input_tokens, 300);
        assert_eq!(row.output_tokens, 80);
        assert_eq!(row.segments, 2);
        assert_eq!(row.context_remaining, Some(9000));
        assert_eq!(row.est_builtin_tool, 60);
        assert_eq!(row.tool_calls, 2);
        assert_eq!(row.compactions, 0);

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM usage_segment WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn records_compaction_with_boundary_and_summary_cost() {
        let conn = Connection::open_in_memory().unwrap();
        init_conn(&conn).unwrap();
        record_segment_on(&conn, "jishu-self", "s1", &seg(1000, 500)).unwrap();

        record_compaction_on(
            &conn,
            "jishu-self",
            "s1",
            &CompactionRecord {
                reason: "threshold".into(),
                tokens_before: 190_000,
                tokens_after: 60_000,
                first_kept_entry_id: Some("entry-42".into()),
                summary_input: 180_000,
                summary_output: 8_000,
                summary_cost: 0.05,
                est_summary: 7_800,
                ..Default::default()
            },
        )
        .unwrap();

        // 压缩行 + 定位字段
        let (before, after, kept, reason): (i64, i64, String, String) = conn
            .query_row(
                "SELECT tokens_before, tokens_after, first_kept_entry_id, reason
                 FROM usage_compaction WHERE session_id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((before, after, reason.as_str()), (190_000, 60_000, "threshold"));
        assert_eq!(kept, "entry-42");

        // 摘要开销并入总量 + 分段数 + 压缩计数
        let row = read_on(&conn, "s1").unwrap();
        assert_eq!(row.input_tokens, 1000 + 180_000);
        assert_eq!(row.output_tokens, 500 + 8_000);
        assert!((row.total_cost - 0.06).abs() < 1e-9);
        assert_eq!(row.segments, 2);
        assert_eq!(row.compactions, 1);
        // 水位即时更新：200k 窗口 - 60k 压缩后 = 140k 剩余。
        assert_eq!(row.context_remaining, Some(140_000));
        assert_eq!(row.est_text, 20 + 7_800);

        // 摘要以特殊分段入明细
        let stops: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT stop_reason FROM usage_segment WHERE session_id='s1' ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        assert_eq!(stops, vec!["end_turn", "compaction_summary"]);
    }

    #[test]
    fn incompatible_schema_is_rebuilt_without_migration() {
        let conn = Connection::open_in_memory().unwrap();
        // 旧 v1 schema（8 列，无 user_version）。
        conn.execute_batch(
            "CREATE TABLE session_usage (
                session_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                total_cost REAL NOT NULL DEFAULT 0,
                context_remaining INTEGER,
                context_window_total INTEGER,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO session_usage (session_id) VALUES ('old');",
        )
        .unwrap();
        init_conn(&conn).unwrap(); // 版本不符 → DROP 重建，旧数据弃置
        assert!(read_on(&conn, "old").is_err());
        record_segment_on(&conn, "jishu-self", "new", &seg(1, 1)).unwrap();
        assert_eq!(read_on(&conn, "new").unwrap().segments, 1);
    }
}
