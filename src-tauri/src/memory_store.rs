//! hub 统一项目记忆 KV（v0.8.1 需求8 P1）。
//!
//! 背景：项目记忆此前散落在各家 agent 的私有文件（CLAUDE.md / pi session
//! context），没有跨 agent 的「用户在这个项目的偏好」共享层。本模块提供
//! per-project 的扁平 KV（`~/.jishu-hub/memory.db`，SQLite——DEVELOP_READ
//! §9 记录类数据原则；路径经 manifest::hub_home，JISHU_HUB_HOME 可覆盖，
//! 测试隔离同源）。
//!
//! 消费面（P1）：Tauri 命令（GUI）与 `jishu-cli memory`（插件脚本/智能体经
//! shell 读写——工具插件的 notes 可教智能体用 `jishu-cli memory` 持久化
//! 项目级信息）。P2 将经 hub MCP server 以 resource 形式暴露。

use rusqlite::Connection;

const SCHEMA_VERSION: i64 = 1;

fn db_path() -> std::path::PathBuf {
    crate::agent::manifest::hub_home().join("memory.db")
}

/// 打开连接并确保 schema（每次调用建立连接：读写低频，本地库开销可忽略，
/// 换取无全局锁与可注入路径）。schema 版本不符 → DROP 重建（记忆可丢失 =
/// 回到空记忆，可接受并记录）。
fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, String> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    // 幂等初始化（CREATE IF NOT EXISTS 为主路径，避免并发首建互删）：
    // 仅当库来自更高 schema 版本（未来降级）时 DROP 重建。
    if version > SCHEMA_VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS project_memory;")
            .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_memory (
            project    TEXT NOT NULL,
            key        TEXT NOT NULL,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (project, key)
        );
        PRAGMA user_version = 1;",
    )
    .map_err(|e| e.to_string())?;
    f(&conn).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MemoryEntry {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

pub fn set(project: &str, key: &str, value: &str) -> Result<(), String> {
    let now = crate::util::now_ms();
    with_conn(|conn| {
        conn.execute(
            "INSERT INTO project_memory (project, key, value, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (project, key) DO UPDATE SET value = ?3, updated_at = ?4",
            rusqlite::params![project, key, value, now],
        )
    })
    .map(|_| ())
}

pub fn get(project: &str, key: &str) -> Result<Option<String>, String> {
    with_conn(|conn| {
        conn.query_row(
            "SELECT value FROM project_memory WHERE project = ?1 AND key = ?2",
            rusqlite::params![project, key],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => rusqlite::Error::QueryReturnedNoRows,
            other => other,
        })
    })
    .map(Some)
    .or_else(|err| {
        if err == rusqlite::Error::QueryReturnedNoRows.to_string() {
            Ok(None)
        } else {
            Err(err)
        }
    })
}

pub fn list(project: &str) -> Result<Vec<MemoryEntry>, String> {
    with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT key, value, updated_at FROM project_memory WHERE project = ?1 ORDER BY key",
        )?;
        let rows = stmt.query_map(rusqlite::params![project], |row| {
            Ok(MemoryEntry {
                key: row.get(0)?,
                value: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })?;
        rows.collect()
    })
}

pub fn delete(project: &str, key: &str) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute(
            "DELETE FROM project_memory WHERE project = ?1 AND key = ?2",
            rusqlite::params![project, key],
        )
    })
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 测试隔离：hub_home 的 cfg(test) 固定临时目录（需求7 引入），memory.db
    // 天然落隔离目录；并行测试共享同库但用互异 project key 避免串扰。
    // M7：额外持共享 env 锁——其他模块 set_var(JISHU_HUB_HOME) 期间本模块
    // 落库路径会被切走导致随机失败。

    #[test]
    fn set_get_roundtrip_and_overwrite() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        set("p1", "k", "v1").unwrap();
        assert_eq!(get("p1", "k").unwrap().as_deref(), Some("v1"));
        set("p1", "k", "v2").unwrap(); // 覆盖
        assert_eq!(get("p1", "k").unwrap().as_deref(), Some("v2"));
        assert_eq!(get("p1", "missing").unwrap(), None);
        assert_eq!(get("other", "k").unwrap(), None); // 项目隔离
    }

    #[test]
    fn list_and_delete() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        set("p2", "a", "1").unwrap();
        set("p2", "b", "2").unwrap();
        let entries = list("p2").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "a"); // 按 key 排序
        delete("p2", "a").unwrap();
        let entries = list("p2").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "b");
    }
}
