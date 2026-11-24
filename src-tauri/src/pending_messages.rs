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
//! 1. **record**：发送入口受理即记一笔「入口账」（内容 = 用户原文），
//!    返回这笔账的身份（账本行号）。身份随发送请求带到引擎侧。
//! 2. **confirm_entries**：pi_rpc 循环内 prompt 真正写入 stdin 时，按身份
//!    把入口账**原地改写**为落地账（内容 = 实际发给 pi 的文本，含会话
//!    注入）——一笔消息自始至终只有一条账。
//! 3. **ack_persisted**：收到 pi `message_end(role=user)` 事件（= pi 已
//!    appendMessage 落盘）→ 按内容匹配删除。
//! 4. **dedupe_against**：会话消息加载时与 pi JSONL 已有用户消息比对——
//!    已落盘的清除 pending（ack 丢失兜底），未落盘的并入返回列表（重启
//!    后消息不丢，前端照常渲染）。
//!
//! v0.9.8 评审修复轮 R1-1：入口账与落地账之间**按身份关联，不按文本**。
//! 此前靠「内容相等」去认入口账——同一笔消息在入口是用户原文、到引擎侧
//! 已被追加工具说明块，两段文本永不相等，入口账永远销不掉 → 每条带工具
//! 的消息重开会话都多出一条「未送达」幽灵。
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

/// 一笔账的身份（账本行号）。发送入口记账时取得，随发送请求带到引擎侧，
/// 落地时按它找到同一笔账——与文本内容无关。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PendingEntryRef(pub i64);

/// 记一笔账，返回它的身份。
/// 同刻重发（PRIMARY KEY 撞 sent_at）语义为覆盖，可接受（内容最新的为准）。
/// 返回 None = 写入失败（仅意味着「保底记录缺失」，主链路不受影响）。
pub fn record(session_id: &str, agent_id: &str, content: &str) -> Option<PendingEntryRef> {
    let now = crate::util::now_ms();
    let rowid = with_conn(|conn| {
        conn.execute(
            "INSERT INTO pending_user_messages (session_id, agent_id, content, sent_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (session_id, sent_at) DO UPDATE SET
                agent_id = ?2, content = ?3",
            rusqlite::params![session_id, agent_id, content, now],
        )?;
        conn.query_row(
            "SELECT rowid FROM pending_user_messages WHERE session_id = ?1 AND sent_at = ?2",
            rusqlite::params![session_id, now],
            |row| row.get(0),
        )
    })
    .ok();
    // 失败仅意味着「保底记录缺失」——主链路（pi 落盘）不受影响，不向上抛。
    rowid.map(PendingEntryRef)
}

/// 落地确认：prompt 已写入 pi stdin——把入口账结算为一条落地账。
///
/// - `entries` 第一笔：**原地改写**（会话键改为落地键、内容改为实际发给
///   pi 的文本）；行已不在（用户清除了这条未送达 / 本就没记入口账，如新
///   会话首条）则新记一条落地账。
/// - `entries` 其余：删除。引擎取消善期多条缓冲消息会拼接成一条 prompt
///   发出，pi 只落盘一条用户消息——由第一笔改写成的落地账代表它们全部，
///   多留即多出「未送达」幽灵。
///
/// 落地账内容 = 发给 pi 的原文，与 `ack_persisted`（pi 落盘回执带回的
/// 文本）/ `dedupe_against`（JSONL 已有用户消息全文）的内容匹配口径一致。
pub fn confirm_entries(
    entries: &[PendingEntryRef],
    session_id: &str,
    agent_id: &str,
    persisted: &str,
) {
    let mut need_new_record = entries.is_empty();
    for (i, entry) in entries.iter().enumerate() {
        let affected = with_conn(|conn| {
            if i == 0 {
                conn.execute(
                    "UPDATE pending_user_messages
                     SET session_id = ?2, agent_id = ?3, content = ?4
                     WHERE rowid = ?1",
                    rusqlite::params![entry.0, session_id, agent_id, persisted],
                )
            } else {
                conn.execute(
                    "DELETE FROM pending_user_messages WHERE rowid = ?1",
                    [entry.0],
                )
            }
        })
        .unwrap_or(0);
        if i == 0 && affected == 0 {
            need_new_record = true;
        }
    }
    if need_new_record {
        record(session_id, agent_id, persisted);
    }
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

/// v0.9.8 需求2：用户主动清除一条未送达消息（编辑重发失败/投递挂死后
/// pending 行永等不到 ack——并入渲染即「幽灵」，无清除通道则永久滞留）。
/// 按主键 (session_id, sent_at) 精确删行；命中与否都幂等成功。
pub fn dismiss(session_id: &str, sent_at: i64) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute(
            "DELETE FROM pending_user_messages WHERE session_id = ?1 AND sent_at = ?2",
            rusqlite::params![session_id, sent_at],
        )?;
        Ok(())
    })
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

    /// v0.9.8 评审修复轮 R1-1：入口账按**身份**落地改写（不再按文本认账）。
    /// ① 入口原文 ≠ 落地文本（工具说明块/会话注入）：原地改写，账恒一条，
    /// 行号不变；ack 按落地文本销账闭环；
    /// ② 只记入口账未落地（发送失败/落地前挂死）：原文保留 = 未送达成立；
    /// ③ 键迁移时序无关：入口后账被迁到别的键，按行号仍命中并改到落地键；
    /// ④ 一条落地消息承载两笔入口账（缓冲合并）：第一笔改写、第二笔删除；
    /// ⑤ 行已不在（用户已清除）→ 新记一条落地账，不多不少。
    #[test]
    fn confirm_entries_rewrites_entry_in_place() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // ① 带注入：入口原文 → 落地（追加工具说明块 + 会话前缀）。
        let entry = record("s-l1", "jishu-self", "帮我看看这个报错").expect("入口账身份");
        let persisted =
            "<tag>\nsession: s-l1\n</tag>\n\n帮我看看这个报错\n\n<tool-block>…</tool-block>";
        confirm_entries(&[entry], "s-l1", "jishu-self", persisted);
        let rows = load("s-l1").unwrap();
        assert_eq!(rows.len(), 1, "一笔消息一条账（修前此处原文+落地两条并存）");
        assert_eq!(rows[0].content, persisted);
        // pi 落盘回执（落地文本）销账——闭环，无幽灵。
        ack_persisted("s-l1", persisted);
        assert!(load("s-l1").unwrap().is_empty());
        drop_session("s-l1");

        // ② 只记入口账：原文保留。
        record("s-l2", "jishu-self", "发送失败的原文").unwrap();
        let rows = load("s-l2").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content, "发送失败的原文");
        drop_session("s-l2");

        // ③ 入口账挂临时键，之后被 rename 迁到真实键——按身份仍命中。
        let entry = record("pending-l3", "jishu-self", "首条消息").unwrap();
        rename_session("pending-l3", "s-l3");
        confirm_entries(
            &[entry],
            "s-l3",
            "jishu-self",
            "<tag>s-l3</tag>\n\n首条消息",
        );
        assert!(load("pending-l3").unwrap().is_empty());
        let rows = load("s-l3").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].content.starts_with("<tag>"));
        drop_session("s-l3");

        // ④ 缓冲合并：两笔入口账 → 一条落地消息。
        let e1 = record("s-l4", "jishu-self", "第一条").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let e2 = record("s-l4", "jishu-self", "第二条").unwrap();
        assert_eq!(load("s-l4").unwrap().len(), 2);
        confirm_entries(
            &[e1, e2],
            "s-l4",
            "jishu-self",
            "<tag>s-l4</tag>\n\n第一条\n第二条",
        );
        let rows = load("s-l4").unwrap();
        assert_eq!(rows.len(), 1, "一条落地消息只留一条账");
        assert_eq!(rows[0].content, "<tag>s-l4</tag>\n\n第一条\n第二条");
        drop_session("s-l4");

        // ⑤ 无入口账（新会话首条 / 已被清除）：新记一条落地账。
        let gone = record("s-l5", "jishu-self", "待清除").unwrap();
        dismiss("s-l5", sent_at_of("s-l5", 0)).unwrap();
        confirm_entries(&[gone], "s-l5", "jishu-self", "落地文本");
        let rows = load("s-l5").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content, "落地文本");
        drop_session("s-l5");
    }

    fn sent_at_of(session_id: &str, index: usize) -> i64 {
        load(session_id).unwrap()[index].sent_at
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

    /// v0.9.8 需求2：按主键精确清除未送达消息（幂等）。
    #[test]
    fn dismiss_removes_by_primary_key() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        record("s3", "jishu-self", "幽灵消息");
        let rows = load("s3").unwrap();
        assert_eq!(rows.len(), 1);
        let sent_at = rows[0].sent_at;
        // 命中删除
        dismiss("s3", sent_at).unwrap();
        assert_eq!(load("s3").unwrap().len(), 0);
        // 不存在的主键：幂等成功
        dismiss("s3", sent_at).unwrap();
        // 其它会话同刻行不受影响
        drop_session("s3");
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
