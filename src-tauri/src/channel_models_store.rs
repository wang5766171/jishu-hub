//! v0.9.2 需求9：渠道模型列表持久化（SQLite，`~/.jishu-hub/channel-models.db`）。
//!
//! 探测到的模型列表**落库**（用户裁决：不只存前端缓存，主目录持久一份），
//! 供模型设置页「首次自动展示、手动刷新更新」。作用域 = agent_id × 渠道
//! 键（渠道键由前端给定：官方直连 "direct"、第三方 = provider 名/baseUrl
//! 哈希，跨重启稳定）。
//!
//! 同 usage_store 模式：OnceLock + Mutex<Connection>；schema 版本不符直接
//! DROP 重建（无迁移策略，用户裁决）。

use rusqlite::Connection;
use serde::Serialize;
use crate::commands::channel_probe::ChannelModelsProbe;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

struct ChannelModelsStore {
    conn: Mutex<Connection>,
}

static STORE: OnceLock<ChannelModelsStore> = OnceLock::new();

fn db_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(".jishu-hub");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("channel-models.db"))
}

const SCHEMA_VERSION: i64 = 1;

fn init_conn(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if version != SCHEMA_VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS channel_models;")
            .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS channel_models (
            agent_id    TEXT NOT NULL,
            channel_key TEXT NOT NULL,
            models      TEXT NOT NULL,            -- JSON array of model ids
            endpoint    TEXT NOT NULL DEFAULT '', -- 探测端点（排查用）
            fetched_at  INTEGER NOT NULL,
            PRIMARY KEY (agent_id, channel_key)
        );
        PRAGMA user_version = 1;",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn store() -> Result<&'static ChannelModelsStore, String> {
    if let Some(s) = STORE.get() {
        return Ok(s);
    }
    let conn = Connection::open(db_path()?).map_err(|e| e.to_string())?;
    init_conn(&conn)?;
    let _ = STORE.set(ChannelModelsStore {
        conn: Mutex::new(conn),
    });
    STORE.get().ok_or_else(|| "channel models store init failed".into())
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredChannelModels {
    pub models: Vec<String>,
    pub endpoint: String,
    pub fetched_at: i64,
}

fn upsert(
    agent_id: &str,
    channel_key: &str,
    models: &[String],
    endpoint: &str,
) -> Result<(), String> {
    let store = store()?;
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let json = serde_json::to_string(models).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO channel_models (agent_id, channel_key, models, endpoint, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(agent_id, channel_key) DO UPDATE SET
           models = excluded.models,
           endpoint = excluded.endpoint,
           fetched_at = excluded.fetched_at",
        rusqlite::params![agent_id, channel_key, json, endpoint, crate::util::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn lookup(agent_id: &str, channel_key: &str) -> Result<Option<StoredChannelModels>, String> {
    let store = store()?;
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let result = conn.query_row(
        "SELECT models, endpoint, fetched_at FROM channel_models
         WHERE agent_id = ?1 AND channel_key = ?2",
        rusqlite::params![agent_id, channel_key],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    );
    match result {
        Ok((json, endpoint, fetched_at)) => {
            let models = serde_json::from_str(&json).unwrap_or_default();
            Ok(Some(StoredChannelModels { models, endpoint, fetched_at }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// ── Tauri 命令 ──

/// 探测 + 落库（探测成功才写；失败返回 unsupported，旧记录保留——手动刷新
/// 失败不清空既有列表）。
#[tauri::command]
pub(crate) async fn channel_models_probe_and_store(
    agent_id: String,
    channel_key: String,
    base_url: String,
    api_key: String,
) -> Result<ChannelModelsProbe, String> {
    let probe = {
        let agent_id = agent_id.clone();
        let channel_key = channel_key.clone();
        let base_url = base_url.clone();
        let api_key = api_key.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::commands::channel_probe::probe_channel_models_impl(&base_url, &api_key)
        })
        .await
        .map_err(|e| format!("probe task failed: {e}"))?
    };
    if probe.supported {
        upsert(&agent_id, &channel_key, &probe.models, &probe.endpoint)?;
    }
    Ok(probe)
}

/// 读取已持久化的渠道模型列表（无记录 = None → 前端显示引导文案）。
#[tauri::command]
pub(crate) async fn channel_models_stored(
    agent_id: String,
    channel_key: String,
) -> Result<Option<StoredChannelModels>, String> {
    tauri::async_runtime::spawn_blocking(move || lookup(&agent_id, &channel_key))
        .await
        .map_err(|e| format!("lookup task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_lookup_roundtrip() {
        // 直接内存库验证 SQL（绕过全局 STORE 的磁盘路径）。
        let conn = Connection::open_in_memory().unwrap();
        init_conn(&conn).unwrap();
        conn.execute(
            "INSERT INTO channel_models (agent_id, channel_key, models, endpoint, fetched_at)
             VALUES ('a1', 'ch1', '[\"m1\",\"m2\"]', 'https://x/models', 123)",
            [],
        )
        .unwrap();
        let (json, endpoint, fetched_at): (String, String, i64) = conn
            .query_row(
                "SELECT models, endpoint, fetched_at FROM channel_models WHERE agent_id='a1' AND channel_key='ch1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let models: Vec<String> = serde_json::from_str(&json).unwrap();
        assert_eq!(models, vec!["m1", "m2"]);
        assert_eq!(endpoint, "https://x/models");
        assert_eq!(fetched_at, 123);

        // upsert 语义：同键覆盖
        conn.execute(
            "INSERT INTO channel_models (agent_id, channel_key, models, endpoint, fetched_at)
             VALUES ('a1', 'ch1', '[\"m3\"]', 'https://y/models', 456)
             ON CONFLICT(agent_id, channel_key) DO UPDATE SET
               models = excluded.models, endpoint = excluded.endpoint, fetched_at = excluded.fetched_at",
            [],
        )
        .unwrap();
        let (json, _, fetched_at): (String, String, i64) = conn
            .query_row(
                "SELECT models, endpoint, fetched_at FROM channel_models WHERE agent_id='a1' AND channel_key='ch1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let models: Vec<String> = serde_json::from_str(&json).unwrap();
        assert_eq!(models, vec!["m3"]);
        assert_eq!(fetched_at, 456);
    }
}
