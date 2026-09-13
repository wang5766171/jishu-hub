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
        "CREATE TABLE IF NOT EXISTS channel_custom_models (
            agent_id    TEXT NOT NULL,
            channel_key TEXT NOT NULL,
            models      TEXT NOT NULL,
            updated_at  INTEGER NOT NULL,
            PRIMARY KEY (agent_id, channel_key)
        );
        CREATE TABLE IF NOT EXISTS channel_models (
            agent_id    TEXT NOT NULL,
            channel_key TEXT NOT NULL,
            models      TEXT NOT NULL,            -- JSON array of model ids
            endpoint    TEXT NOT NULL DEFAULT '', -- 探测端点（排查用）
            fetched_at  INTEGER NOT NULL,
            PRIMARY KEY (agent_id, channel_key)
        );
        CREATE TABLE IF NOT EXISTS model_session_visibility (
            agent_id     TEXT NOT NULL,
            provider_key TEXT NOT NULL,
            model_id     TEXT NOT NULL,
            hidden       INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL,
            PRIMARY KEY (agent_id, provider_key, model_id)
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

// ── 手动配置模型（渠道自定义模型，三 agent 第三方渠道共用存储）──

pub(crate) fn custom_upsert(
    agent_id: &str,
    channel_key: &str,
    models_json: &str,
) -> Result<(), String> {
    let store = store()?;
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO channel_custom_models (agent_id, channel_key, models, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(agent_id, channel_key) DO UPDATE SET
           models = excluded.models, updated_at = excluded.updated_at",
        rusqlite::params![agent_id, channel_key, models_json, crate::util::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn custom_lookup(
    agent_id: &str,
    channel_key: &str,
) -> Result<Option<serde_json::Value>, String> {
    let store = store()?;
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let result = conn.query_row(
        "SELECT models FROM channel_custom_models WHERE agent_id = ?1 AND channel_key = ?2",
        rusqlite::params![agent_id, channel_key],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(json) => Ok(Some(serde_json::from_str(&json).unwrap_or(serde_json::Value::Null))),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 读取渠道手动配置模型（JSON 数组；无记录 = null）。
#[tauri::command]
pub(crate) async fn channel_custom_models_get(
    agent_id: String,
    channel_key: String,
) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || custom_lookup(&agent_id, &channel_key))
        .await
        .map_err(|e| format!("custom lookup task failed: {e}"))?
}

/// 保存渠道手动配置模型（整组覆盖；models 为模型条目 JSON 数组）。
#[tauri::command]
pub(crate) async fn channel_custom_models_set(
    agent_id: String,
    channel_key: String,
    models: serde_json::Value,
) -> Result<(), String> {
    let json = serde_json::to_string(&models).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || custom_upsert(&agent_id, &channel_key, &json))
        .await
        .map_err(|e| format!("custom upsert task failed: {e}"))?
}

// ── 会话可见性（v0.9.2 需求13：jishu 模型会话可选可见性）──
// 显式记录（hidden 布尔）覆盖默认规则；无记录 = 默认规则（版本倒序前 3
// 可见）。激活（set_active）时写入 visible 记录——「激活过的模型可见」。

pub(crate) fn visibility_upsert(
    agent_id: &str,
    provider_key: &str,
    model_id: &str,
    hidden: bool,
) -> Result<(), String> {
    let store = store()?;
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO model_session_visibility (agent_id, provider_key, model_id, hidden, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(agent_id, provider_key, model_id) DO UPDATE SET
           hidden = excluded.hidden, updated_at = excluded.updated_at",
        rusqlite::params![agent_id, provider_key, model_id, hidden as i64, crate::util::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 渠道内显式可见性记录（model_id → hidden）；无记录的模型走默认规则。
pub(crate) fn visibility_lookup(
    agent_id: &str,
    provider_key: &str,
) -> Result<std::collections::HashMap<String, bool>, String> {
    let store = store()?;
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT model_id, hidden FROM model_session_visibility
             WHERE agent_id = ?1 AND provider_key = ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![agent_id, provider_key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
        })
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (id, hidden) = row.map_err(|e| e.to_string())?;
        map.insert(id, hidden);
    }
    Ok(map)
}

/// agent 全量可见性（provider_key → model_id → hidden），picker 过滤用。
pub(crate) fn visibility_map(
    agent_id: &str,
) -> Result<std::collections::HashMap<String, std::collections::HashMap<String, bool>>, String> {
    let store = store()?;
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT provider_key, model_id, hidden FROM model_session_visibility
             WHERE agent_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![agent_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut map: std::collections::HashMap<String, std::collections::HashMap<String, bool>> =
        std::collections::HashMap::new();
    for row in rows {
        let (provider, id, hidden) = row.map_err(|e| e.to_string())?;
        map.entry(provider).or_default().insert(id, hidden);
    }
    Ok(map)
}

/// 读取渠道内显式可见性记录（无记录 = 空对象 → 前端走默认规则）。
#[tauri::command]
pub(crate) async fn model_visibility_list(
    agent_id: String,
    provider_key: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let map = visibility_lookup(&agent_id, &provider_key)?;
        serde_json::to_value(map).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("visibility lookup task failed: {e}"))?
}

/// 写单模型会话可见性（显式记录，覆盖默认规则）。
#[tauri::command]
pub(crate) async fn model_visibility_set(
    agent_id: String,
    provider_key: String,
    model_id: String,
    hidden: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        visibility_upsert(&agent_id, &provider_key, &model_id, hidden)
    })
    .await
    .map_err(|e| format!("visibility upsert task failed: {e}"))?
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
            "INSERT OR REPLACE INTO channel_custom_models (agent_id, channel_key, models, updated_at)
             VALUES ('a1', 'ch1', '[{\"id\":\"m9\"}]', 1)",
            [],
        )
        .unwrap();
        let cj: String = conn
            .query_row(
                "SELECT models FROM channel_custom_models WHERE agent_id='a1' AND channel_key='ch1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(cj.contains("m9"));
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
            "INSERT OR REPLACE INTO channel_custom_models (agent_id, channel_key, models, updated_at)
             VALUES ('a1', 'ch1', '[{\"id\":\"m9\"}]', 1)",
            [],
        )
        .unwrap();
        let cj: String = conn
            .query_row(
                "SELECT models FROM channel_custom_models WHERE agent_id='a1' AND channel_key='ch1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(cj.contains("m9"));
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
