//! 用户消息发送受理即落盘（v0.9.6 需求6 F3）。
//!
//! 背景：pi 侧只在回合真正启动、`message_end(role=user)` 时才把用户消息
//! append 进会话 JSONL——hub 侧此前无任何落盘通道。若 pi 受理 prompt
//! （response started）后回合启动前挂死（压缩预检/before_agent_start/LLM
//! 请求未发出——F2 看门狗盲区的成因），该消息永不落盘：重启后从 JSONL
//! 重载即丢失（用户实测：卡死重启后最新问话消失）。
//!
//! 本模块在 hub 侧记录「已发送、尚未确认落盘」的用户消息
//!（`~/.jishu-hub/pending_messages.db`，SQLite——DEVELOP_READ §9 记录类
//! 数据原则；路径经 manifest::hub_home，JISHU_HUB_HOME 可覆盖，测试隔离
//! 同源）。生命周期：
//!
//! 1. **record**：pi_rpc 循环内 prompt 写入 stdin 时记录（此时文本已应用
//!    会话注入，与 pi 落盘内容一致，可精确对账）。
//! 2. **ack_persisted**：收到 pi `message_end(role=user)` 事件（= pi 已
//!    appendMessage 落盘）→ 按内容匹配删除。
//! 3. **dedupe_against**：会话消息加载时与 pi JSONL 已有用户消息比对——
//!    已落盘的清除 pending（ack 丢失兜底），未落盘的并入返回列表（重启
//!    后消息不丢，前端照常渲染）。
//!
//! 不做的事：pending 不写 pi 的会话 JSONL（pi 也写该文件，双写冲突且
//! 格式耦合）；不提供重发按钮（P2 增强）。

use rusqlite::Connection;

const SCHEMA_VERSION: i64 = 1;

fn db_path() -> std::path::PathBuf {
    crate::agent::manifest::hub_home().join("pending_messages.db")
}

/// 打开连接并确保 schema（与 memory_store 同款：每次建连接 + busy_timeout +
/// 幂等 CREATE；仅更高版本降级时 DROP 重建——pending 数据可再生，弃置可接受）。
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
    if version > SCHEMA_VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS pending_user_messages;")
            .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pending_user_messages (
            session_id TEXT NOT NULL,
            agent_id   TEXT NOT NULL DEFAULT '',
            content    TEXT NOT NULL,
            sent_at    INTEGER NOT NULL,
            PRIMARY KEY (session_id, sent_at)
        );
        PRAGMA user_version = 1;",
    )
    .map_err(|e| e.to_string())?;
    f(&conn).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PendingMessage {
    pub session_id: String,
    pub agent_id: String,
    pub content: String,
    pub sent_at: i64,
}

/// prompt 已写入 pi stdin（受理）——记录待确认消息。
/// 同刻重发（PRIMARY KEY 撞 sent_at）语义为覆盖，可接受（内容最新的为准）。
pub fn record(session_id: &str, agent_id: &str, content: &str) {
    let now = crate::util::now_ms();
    let _ = with_conn(|conn| {
        conn.execute(
            "INSERT INTO pending_user_messages (session_id, agent_id, content, sent_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (session_id, sent_at) DO UPDATE SET
                agent_id = ?2, content = ?3",
            rusqlite::params![session_id, agent_id, content, now],
        )
    });
    // 失败仅意味着「保底记录缺失」——主链路（pi 落盘）不受影响，不向上抛。
}

/// pi `message_end(role=user)` 到达（pi 已真实落盘）——按内容匹配删除**最早一条**。
/// 内容即发送文本（record 在注入应用后记录，两侧一致）；不匹配（steer
/// 回显等非本条消息）则不动。只删最早一条是 FIFO 语义：同会话先发的内容
/// 先被 pi 处理落盘——若全量删除（v0.9.6 评审 P2-4），前条销账会把后条
/// 同文本 pending（挂死后重发同内容场景）连带撕掉，后条再出事时保险
/// 已丢（重启后消息真丢）。
pub fn ack_persisted(session_id: &str, pi_text: &str) {
    if pi_text.is_empty() {
        return;
    }
    let _ = with_conn(|conn| {
        conn.execute(
            "DELETE FROM pending_user_messages
             WHERE rowid = (
                 SELECT rowid FROM pending_user_messages
                 WHERE session_id = ?1 AND content = ?2
                 ORDER BY sent_at ASC, rowid ASC LIMIT 1
             )",
            rusqlite::params![session_id, pi_text],
        )
    });
}

/// 会话消息加载去重：`persisted_texts` = pi JSONL 中已有用户消息全文。
/// 已含相同内容的 pending 清除（ack 丢失兜底）；返回未落盘的（调用方
/// 并入返回列表，重启后消息不丢）。
pub fn dedupe_against(session_id: &str, persisted_texts: &[String]) -> Vec<PendingMessage> {
    let rows = match load(session_id) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut unsent = Vec::new();
    for row in rows {
        if persisted_texts.iter().any(|t| t == &row.content) {
            let _ = with_conn(|conn| {
                conn.execute(
                    "DELETE FROM pending_user_messages
                     WHERE session_id = ?1 AND sent_at = ?2",
                    rusqlite::params![session_id, row.sent_at],
                )
            });
        } else {
            unsent.push(row);
        }
    }
    unsent
}

fn load(session_id: &str) -> Result<Vec<PendingMessage>, String> {
    with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT session_id, agent_id, content, sent_at
             FROM pending_user_messages WHERE session_id = ?1 ORDER BY sent_at",
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id], |row| {
            Ok(PendingMessage {
                session_id: row.get(0)?,
                agent_id: row.get(1)?,
                content: row.get(2)?,
                sent_at: row.get(3)?,
            })
        })?;
        rows.collect()
    })
}

/// 会话 id 迁移（spawn 首条消息以 GUI 临时 id 记录，resolve 后迁到真实
/// id——与进程表/会话工具集同点迁移，见 chat.rs resolve 闭包）。
pub fn rename_session(old: &str, new: &str) {
    if old == new {
        return;
    }
    let _ = with_conn(|conn| {
        conn.execute(
            "UPDATE pending_user_messages SET session_id = ?2 WHERE session_id = ?1",
            rusqlite::params![old, new],
        )
    });
}

/// 删除会话时的清理（随会话删除联动）。
pub fn drop_session(session_id: &str) {
    let _ = with_conn(|conn| {
        conn.execute(
            "DELETE FROM pending_user_messages WHERE session_id = ?1",
            rusqlite::params![session_id],
        )
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // 测试隔离同 memory_store：hub_home cfg(test) 固定临时目录；并行测试
    // 共享库用互异 session key 避免串扰，另持 env 锁防 set_var 期间切库。

    #[test]
    fn record_ack_roundtrip() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        record("s1", "jishu-self", "你好，帮我修个 bug");
        assert_eq!(load("s1").unwrap().len(), 1);
        // pi 落盘回执：内容匹配删除
        ack_persisted("s1", "你好，帮我修个 bug");
        assert_eq!(load("s1").unwrap().len(), 0);
        // 不匹配内容（steer 回显）不动
        record("s1", "jishu-self", "第二条");
        ack_persisted("s1", "别的内容");
        assert_eq!(load("s1").unwrap().len(), 1);
        drop_session("s1");
    }

    #[test]
    fn dedupe_keeps_unsent_and_clears_persisted() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        record("s2", "jishu-self", "已落盘的消息");
        record("s2", "jishu-self", "未落盘的消息");
        // 重启加载：JSONL 已含第一条 → 清除；第二条未落盘 → 返回并入
        let unsent = dedupe_against("s2", &["已落盘的消息".to_string()]);
        assert_eq!(unsent.len(), 1);
        assert_eq!(unsent[0].content, "未落盘的消息");
        assert_eq!(load("s2").unwrap().len(), 1);
        drop_session("s2");
    }

    #[test]
    fn rename_migrates_session_key() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        record("pending-1", "jishu-self", "首条消息");
        rename_session("pending-1", "real-id");
        assert_eq!(load("pending-1").unwrap().len(), 0);
        let rows = load("real-id").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content, "首条消息");
        drop_session("real-id");
    }

    #[test]
    fn ack_fifo_when_duplicate_content() {
        // v0.9.6 评审 P2-4：同文本两条 pending（挂死→重发同内容），前条销账
        // 只删最早一条（FIFO），后条保险不丢——全量删除会把后条连带撕掉。
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        record("s-fifo", "jishu-self", "继续");
        // 隔开 sent_at（now_ms 毫秒粒度，同刻插入会被主键覆盖语义吞掉）
        std::thread::sleep(std::time::Duration::from_millis(5));
        record("s-fifo", "jishu-self", "继续");
        assert_eq!(load("s-fifo").unwrap().len(), 2, "前置：两条同文本 pending");
        // 第一条被 pi 落盘销账 → 只删最早一条
        ack_persisted("s-fifo", "继续");
        let rows = load("s-fifo").unwrap();
        assert_eq!(rows.len(), 1, "同内容只销最早一条，后条保留");
        // 第二条也落盘 → 清零
        ack_persisted("s-fifo", "继续");
        assert_eq!(load("s-fifo").unwrap().len(), 0);
        drop_session("s-fifo");
    }
}
