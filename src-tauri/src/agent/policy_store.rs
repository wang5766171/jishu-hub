//! Once 审批记忆 SQLite 持久化（v0.8.1 需求1 M4）。
//!
//! 「始终允许」从「本次进程生命周期内该会话有效」升级为「该会话跨重启
//! 有效」：每批准一行落 `~/.jishu-hub/approval.db`（记录类数据独立库，
//! DEVELOP_READ §9）。审批是低频决策，直接查库不加内存缓存（KISS，
//! Mutex<Connection> 本地库微秒级）。
//!
//! 模式对齐 usage_store：OnceLock 单例 + Mutex<Connection> + user_version
//! 版本化 + 版本不符 DROP 重建（丢记忆 = 回到「每动作重新询问」，可接受）。
//! 路径经 `manifest::hub_home()` 覆盖（`JISHU_HUB_HOME`），测试注入
//! tempfile 隔离，不污染真实库。
//!
//! `OnceMemory` trait 抽象（实施记录裁决 3）：policy.rs 既有链测试原本
//! 直接操作全局记忆注册表（并行测试会写真实库），trait + 内存实现保持
//! 链测试可注入；生产路径纯 SQLite。

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

/// Once 记忆抽象：会话内「始终允许」动作键的登记与命中查询。
pub trait OnceMemory: Send + Sync {
    fn remember_once(&self, session_id: &str, action_key: &str);
    fn has_once(&self, session_id: &str, action_key: &str) -> bool;
}

/// 测试用内存实现（HashMap 直通，无 IO）。
pub struct InMemoryOnceMemory(Mutex<std::collections::HashSet<(String, String)>>);

impl InMemoryOnceMemory {
    pub fn new() -> Self {
        Self(Mutex::new(std::collections::HashSet::new()))
    }
}

impl Default for InMemoryOnceMemory {
    fn default() -> Self {
        Self::new()
    }
}

impl OnceMemory for InMemoryOnceMemory {
    fn remember_once(&self, session_id: &str, action_key: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert((session_id.to_string(), action_key.to_string()));
    }
    fn has_once(&self, session_id: &str, action_key: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&(session_id.to_string(), action_key.to_string()))
    }
}

fn approval_db_path() -> PathBuf {
    crate::agent::manifest::hub_home().join("approval.db")
}

fn open_connection() -> Connection {
    let path = approval_db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path).unwrap_or_else(|err| {
        panic!("failed to open approval db at {}: {err}", path.display())
    });
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn
}

/// SQLite 实现：`once_memory(session_id, action_key)` 两列主键，
/// user_version 版本化；版本不符 DROP 重建。读失败降级 false（回到
/// 「每动作重新询问」，等价无记忆现状——fail-soft 而非拖垮会话）。
pub struct SqliteOnceMemory {
    conn: Mutex<Connection>,
}

impl SqliteOnceMemory {
    fn new() -> Self {
        let conn = open_connection();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap_or(0);
        if version != 1 {
            let _ = conn.execute_batch(
                "DROP TABLE IF EXISTS once_memory;
                 CREATE TABLE once_memory(
                     session_id TEXT NOT NULL,
                     action_key TEXT NOT NULL,
                     created_at INTEGER NOT NULL,
                     PRIMARY KEY(session_id, action_key)
                 );
                 PRAGMA user_version = 1;",
            );
        }
        Self {
            conn: Mutex::new(conn),
        }
    }
}

impl OnceMemory for SqliteOnceMemory {
    fn remember_once(&self, session_id: &str, action_key: &str) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO once_memory(session_id, action_key, created_at)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![session_id, action_key, crate::util::now_ms()],
            );
        }
    }
    fn has_once(&self, session_id: &str, action_key: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.query_row(
            "SELECT 1 FROM once_memory WHERE session_id = ?1 AND action_key = ?2",
            rusqlite::params![session_id, action_key],
            |_| Ok(()),
        )
        .is_ok()
    }
}

/// 生产记忆（单例）：链装配与回写点共用同一 SQLite 连接。
pub fn default_memory() -> Arc<dyn OnceMemory> {
    static MEMORY: OnceLock<Arc<SqliteOnceMemory>> = OnceLock::new();
    MEMORY
        .get_or_init(|| Arc::new(SqliteOnceMemory::new()))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_roundtrip_and_idempotent() {
        let mem = InMemoryOnceMemory::new();
        assert!(!mem.has_once("s1", "k1"));
        mem.remember_once("s1", "k1");
        mem.remember_once("s1", "k1"); // 幂等
        assert!(mem.has_once("s1", "k1"));
        assert!(!mem.has_once("s1", "k2"));
        assert!(!mem.has_once("s2", "k1")); // 会话隔离
    }
}
