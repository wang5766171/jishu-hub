//! 会话级模型表（v0.9.7 需求14：模型切换只影响当前会话）。
//!
//! 全局 active 模型仍是**新会话默认**；本表按真实会话 id 记录「该会话锁
//! 定的模型」——`send_message` 与启动签名漂移检测统一经
//! [`resolve_override`] 注入，长驻进程据此在下次空闲发送时按会话模型重拉。
//!
//! 存储：`~/.jishu-hub/session-models.json`
//! ```json
//! { "<sessionId>": { "provider": "zhipu", "model": "glm-5.3" } }
//! ```
//! 语义：缺失/损坏 → 空表（一切回落全局 active）；写入原子（tempfile
//! 替换）。条目随会话删除不主动清理（低频小文件，残留无行为影响——
//! 会话不存在则查不到）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[cfg(test)]
use crate::agent::manifest::env_test_lock;

type SessionModel = (String, String); // (provider, model)

fn config_path() -> std::path::PathBuf {
    super::agent::manifest::hub_home().join("session-models.json")
}

/// 进程内写锁（评审 P1-5 短期方案）：串行化本表的 load-modify-write——
/// JSON 单文件改表须整文件重写，两个会话并发切模型会互相覆盖（丢更新）。
/// 读取端不加锁：写入走 atomic_write（tempfile 替换），读到的恒为完整
/// 旧版或新版。SQLite 迁移为后续架构轮（评审 P1-5 短期方案）。
fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn load_all() -> HashMap<String, serde_json::Value> {
    let Ok(content) = std::fs::read_to_string(config_path()) else {
        return HashMap::new();
    };
    serde_json::from_str(&content).unwrap_or_else(|e| {
        log::warn!("[session-model] invalid session-models.json ({e}), ignoring");
        HashMap::new()
    })
}

/// 会话锁定模型（无记录 → None=跟全局 active）。
pub fn get_session_model(session_id: &str) -> Option<SessionModel> {
    if session_id.trim().is_empty()
        || crate::agent::command_config::is_transient_session_id(session_id)
    {
        return None; // 新会话（pending-*）/空 id 无会话级语义
    }
    let v = load_all().get(session_id)?.clone();
    let provider = v.get("provider")?.as_str()?.to_string();
    let model = v.get("model")?.as_str()?.to_string();
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider, model))
}

/// 覆写（model 空 = 清除该会话锁定，回落全局）。
pub fn set_session_model(session_id: &str, provider: &str, model: &str) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("session_id is required".to_string());
    }
    // 评审 P1-5：写锁内完成 load-modify-write（并发写串行化，防丢更新）。
    let _guard = write_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut all = load_all();
    if model.trim().is_empty() {
        all.remove(session_id);
    } else {
        all.insert(
            session_id.to_string(),
            serde_json::json!({ "provider": provider, "model": model }),
        );
    }
    let content = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    crate::util::atomic_write(&config_path(), content.as_bytes())
        .map_err(|e| format!("write session-models.json failed: {e}"))
}

/// 发送/签名构建的统一注入口：显式 override（节点/委派链）优先，其次会话
/// 锁定，末了 None=全局 active。
pub fn resolve_override(session_id: &str, explicit: Option<SessionModel>) -> Option<SessionModel> {
    explicit.or_else(|| get_session_model(session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated() -> tempfile::TempDir {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", home.path());
        home
    }

    #[test]
    fn roundtrip_and_transient_guard() {
        let _home = isolated();
        assert!(get_session_model("s1").is_none());
        set_session_model("s1", "zhipu", "glm-5.3").unwrap();
        assert_eq!(
            get_session_model("s1"),
            Some(("zhipu".to_string(), "glm-5.3".to_string()))
        );
        // 显式 override 优先于会话锁定。
        assert_eq!(
            resolve_override("s1", Some(("other".into(), "m".into()))),
            Some(("other".to_string(), "m".to_string()))
        );
        // transient（新会话）恒 None——即使表里脏数据也拦。
        set_session_model("pending-123", "zhipu", "x").unwrap();
        assert!(get_session_model("pending-123").is_none());
        // 清除。
        set_session_model("s1", "zhipu", "").unwrap();
        assert!(get_session_model("s1").is_none());
    }
}
