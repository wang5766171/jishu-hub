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
//! 同源）。
//!
//! 一笔账 = 一次发送。账本身份 = 自增主键（随发送请求带到引擎侧，永不
//! 复用）。账目有三个状态：
//!
//! 1. **recorded（入口账）**：发送入口受理即记（内容 = 用户原文）。此时尚未
//!    写入引擎——确定未送达。
//! 2. **sent（落地账）**：prompt 真正写入引擎 stdin 时，按身份把入口账
//!    原地改写（内容 = 实际发给引擎的文本）——一笔消息自始至终只有一条账。
//! 3. **unsent（终态）**：确定没有送达、也不会再有回执——引擎明确拒收、
//!    回合已收口却没有落盘回执。界面照常显示「未送达」，但它**不再等回执**。
//!
//! 落地账怎么销（v0.9.8 评审修复轮 R2 / C2）：
//! - **按身份与顺序，不比文本。** 引擎回报「用户消息已落盘」（`message_end`
//!   role=user）时，销掉该会话里最早的一笔落地账。旧实现要求落盘文本等于
//!   发送文本——技能命令、提示模板是**展开后**才落盘，文本必然对不上，账
//!   永远销不掉（每发一条重开会话就多一条「未送达」）。
//! - **扩展命令**（引擎直接执行、不落用户消息）：引擎回「已处理」时按身份
//!   当场销掉（[`ack_handled`]）。
//! - **为什么要有终态**：一条被引擎拒收的消息不会有回执；若它仍挂在「等回执」
//!   的位置上，下一条发送成功的消息的回执会先销掉它，真正送达的那条反而
//!   留成「未送达」。所以「确定没送达」必须在确定的时刻落成终态：引擎回
//!   错误响应、回合收口时仍无回执、以及从空闲态发起新回合时。
//! - **加载时判定残留**（进程被杀、没来得及落终态的账）：按时间——账目记录
//!   时刻（发送之前）≤ 某条用户消息落盘时刻（发送之后），且该账是会话里最早
//!   的未销账落地账，则这条落盘消息就是它的回执。两个时刻同为本机墙钟毫秒，
//!   先记后落，恒有「记录 ≤ 落盘」。入口账与终态账不参与判定。
//! - **新回合发起时**（[`finalize_stale_sent`]）：此刻引擎空闲，上一代遗留的
//!   落地账等不到实时回执，有没有落盘只剩会话文件这一份证据——先按上面同一条
//!   时间规则对账，对不上的才落终态。判「送达」的三个入口（实时回执、加载、
//!   回合发起）只用一条规则；入口各看各的，就会出现「加载时认、回合发起时
//!   不认」——已送达的账被落成终态后不再参与加载判定，再没有第二次机会。
//!
//! v0.9.8 评审修复轮 R1-1：入口账与落地账之间**按身份关联，不按文本**（身份
//! 随发送请求一路带到引擎侧，与会话键的迁移时序无关）。
//!
//! 不做的事：pending 不写 pi 的会话 JSONL（pi 也写该文件，双写冲突且
//! 格式耦合）；不提供重发按钮（P2 增强）。

use rusqlite::Connection;

/// schema 版本。v2（评审修复轮 R2）：身份改为自增主键（删行后不复用）+
/// 新增 `state` 列（入口账 / 落地账 / 终态未送达）。
const SCHEMA_VERSION: i64 = 2;

/// 入口账：已受理、尚未写入引擎。
const STATE_RECORDED: &str = "recorded";
/// 落地账：已写入引擎，等落盘回执。
const STATE_SENT: &str = "sent";
/// 终态：确定未送达，不再等回执。
const STATE_UNSENT: &str = "unsent";

/// v2 表结构。`(session_id, sent_at)` 唯一：`sent_at` 在同一会话内顺延不撞，
/// 既是 FIFO 序，也是用户清除未送达消息时的寻址键。
const CREATE_TABLE: &str = "CREATE TABLE IF NOT EXISTS pending_user_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id   TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    sent_at    INTEGER NOT NULL,
    state      TEXT NOT NULL,
    UNIQUE (session_id, sent_at)
);";

/// v1 → v2 换表（自增主键加列加不出来，只能换表）。账本是用户未送达消息的
/// 唯一保险，不能 DROP 重建——旧行照搬。旧行分不清入口账还是落地账，一律按
/// 「落地账」判定：它们按时间规则该销的销、该留的留，与修前口径一致。
const MIGRATE_V1_TO_V2: &str = "
CREATE TABLE pending_user_messages_v2 (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id   TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    sent_at    INTEGER NOT NULL,
    state      TEXT NOT NULL,
    UNIQUE (session_id, sent_at)
);
INSERT INTO pending_user_messages_v2 (session_id, agent_id, content, sent_at, state)
    SELECT session_id, agent_id, content, sent_at, 'sent'
    FROM pending_user_messages ORDER BY rowid;
DROP TABLE pending_user_messages;
ALTER TABLE pending_user_messages_v2 RENAME TO pending_user_messages;
";

fn db_path() -> std::path::PathBuf {
    crate::agent::manifest::hub_home().join("pending_messages.db")
}

/// 测试用：让紧接着的几次开库失败，模拟瞬时故障（如 SQLITE_BUSY 超过等待
/// 期限后锁又释放了）。缺陷只在「先失败、后恢复」时才显形——持续打不开时
/// 修前修后都写不进任何东西。生产代码不含这段。
#[cfg(test)]
static FAIL_NEXT_OPEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 测试用（供别的模块的用例调）：让紧接着的 `count` 次开库失败。生产代码不含这段。
#[cfg(test)]
pub(crate) fn fail_next_opens(count: usize) {
    FAIL_NEXT_OPEN.store(count, std::sync::atomic::Ordering::Relaxed);
}

/// 测试用：钉住记账时刻（>0 生效）。「同毫秒两笔」的用例必须确定性地落在
/// 同一毫秒，不能靠真时钟碰运气。生产代码不含这段。
#[cfg(test)]
static TEST_CLOCK_MILLIS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// 记账时刻（毫秒）。
///
/// 调用方要在「写引擎之前」取这个时刻：落地时才新记的账（没带入口账的发
/// 送、入口账被用户清除）必须记下写出**之前**的时刻——模块说明的前提是
/// 「先记后落，恒有记录 ≤ 落盘」，取在写出之后就可能比引擎给用户消息打的
/// 时间戳还晚（评审修复轮 R3 / P2-2）。
pub(crate) fn ledger_now_ms() -> i64 {
    #[cfg(test)]
    {
        let pinned = TEST_CLOCK_MILLIS.load(std::sync::atomic::Ordering::Relaxed);
        if pinned > 0 {
            return pinned;
        }
    }
    crate::util::now_ms()
}

/// 测试用：把记账时钟钉在 `millis`（>0 生效），守卫离开作用域即恢复真时钟。
/// 供别的模块的用例调；生产代码不含这段。
#[cfg(test)]
pub(crate) struct PinnedLedgerClock;

#[cfg(test)]
impl PinnedLedgerClock {
    pub(crate) fn pin(millis: i64) -> Self {
        TEST_CLOCK_MILLIS.store(millis, std::sync::atomic::Ordering::Relaxed);
        Self
    }

    /// 写出进行到一半时把时钟拨到别的时刻（模拟「写出之后才取时刻」会取到什么）。
    pub(crate) fn advance_to(&self, millis: i64) {
        TEST_CLOCK_MILLIS.store(millis, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
impl Drop for PinnedLedgerClock {
    fn drop(&mut self) {
        TEST_CLOCK_MILLIS.store(0, std::sync::atomic::Ordering::Relaxed);
    }
}

/// 打开连接并确保 schema（与 memory_store 同款：每次建连接 + busy_timeout +
/// 幂等 CREATE；仅更高版本降级时 DROP 重建——pending 数据可再生，弃置可接受）。
fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, String> {
    #[cfg(test)]
    {
        let remaining = FAIL_NEXT_OPEN.load(std::sync::atomic::Ordering::Relaxed);
        if remaining > 0 {
            FAIL_NEXT_OPEN.store(remaining - 1, std::sync::atomic::Ordering::Relaxed);
            return Err("simulated transient open failure".to_string());
        }
    }
    let path = db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    f(&conn).map_err(|e| e.to_string())
}

/// 建表 / 迁移到当前版本。开库失败在这里以 Err 返回——调用方据此区分「库
/// 打不开」与「行不在」（评审修复轮 R2：此前两者都折叠成 0 行，开库失败会被
/// 当成「入口账已被清除」而新记一条，一笔消息两条账）。
fn ensure_schema(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version > SCHEMA_VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS pending_user_messages;")
            .map_err(|e| e.to_string())?;
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    // 先拿写锁再读版本：两个连接同时首开时，后到的在锁内看到已是 v2，直接跳过
    // （否则会把已迁移的表再搬一遍，状态列被抹回「落地账」）。
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| e.to_string())?;
    let migrated = (|| -> Result<(), rusqlite::Error> {
        let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current != SCHEMA_VERSION {
            let legacy_exists = conn
                .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_user_messages'")?
                .exists([])?;
            if legacy_exists {
                conn.execute_batch(MIGRATE_V1_TO_V2)?;
            } else {
                conn.execute_batch(CREATE_TABLE)?;
            }
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        Ok(())
    })();
    match migrated {
        Ok(()) => conn.execute_batch("COMMIT;").map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e.to_string())
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PendingMessage {
    pub session_id: String,
    pub agent_id: String,
    pub content: String,
    pub sent_at: i64,
    /// recorded = 入口账（未写入引擎）；sent = 落地账（等回执）；unsent = 终态。
    pub state: String,
}

/// 一笔账的身份（自增主键）。发送入口记账时取得，随发送请求带到引擎侧，
/// 落地时按它找到同一笔账——与文本内容无关。删过的身份不复用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PendingEntryRef(pub i64);

/// 插入一笔账并返回身份。同一会话同一毫秒里已有一笔时顺延 1 毫秒再插
///（评审修复轮 R2：此前按主键撞车做「覆盖」，同毫秒的第二笔会把第一笔改写
/// ——第一笔的防丢失效）。顺延后 `sent_at` 仍严格按记账先后递增，FIFO 序不变。
///
/// `sent_at` 由调用方给（入口账取记账时刻；落地时才新记的账取**写出之前**
/// 取好的时刻，见 [`ledger_now_ms`]）。
fn insert_entry(
    conn: &Connection,
    session_id: &str,
    agent_id: &str,
    content: &str,
    state: &str,
    mut sent_at: i64,
) -> Result<PendingEntryRef, rusqlite::Error> {
    loop {
        // 单语句完成「没撞才插」，判定与写入之间没有窗口。
        let inserted = conn.execute(
            "INSERT INTO pending_user_messages (session_id, agent_id, content, sent_at, state)
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE NOT EXISTS (
                 SELECT 1 FROM pending_user_messages WHERE session_id = ?1 AND sent_at = ?4
             )",
            rusqlite::params![session_id, agent_id, content, sent_at, state],
        )?;
        if inserted == 1 {
            return conn.query_row(
                "SELECT id FROM pending_user_messages WHERE session_id = ?1 AND sent_at = ?2",
                rusqlite::params![session_id, sent_at],
                |row| row.get(0).map(PendingEntryRef),
            );
        }
        sent_at += 1;
    }
}

/// 记一笔入口账，返回它的身份。
/// 返回 None = 写入失败（仅意味着「保底记录缺失」，主链路不受影响）。
pub fn record(session_id: &str, agent_id: &str, content: &str) -> Option<PendingEntryRef> {
    let recorded_at = ledger_now_ms();
    with_conn(|conn| {
        insert_entry(
            conn,
            session_id,
            agent_id,
            content,
            STATE_RECORDED,
            recorded_at,
        )
    })
    .ok()
}

/// 落地确认：prompt 已写入引擎 stdin——把入口账结算为一条落地账。
///
/// - `entries` 第一笔：**原地改写**（会话键改为落地键、内容改为实际发给
///   引擎的文本、状态置为落地）；行已不在（用户清除了这条未送达）则新记
///   一条落地账。
/// - `entries` 其余：删除。引擎取消善期多条缓冲消息会拼接成一条 prompt
///   发出，引擎只落盘一条用户消息——由第一笔改写成的落地账代表它们全部，
///   多留即多出「未送达」幽灵。
///
/// 返回**代表这次发送的那一行**的身份（评审修复轮 R3 / P2-1：没带入口账
/// 的发送、入口账被清除后的发送，新记的那一行要把身份交回给调用方——
/// 「已处理」销账、拒收落终态都按它找）。
///
/// `written_before`：调用方在写引擎**之前**取好的时刻（[`ledger_now_ms`]）。
/// 新记的那一行记这个时刻——「先记后落，恒有记录 ≤ 落盘」对落地时才记的账
/// 同样成立（评审修复轮 R3 / P2-2）。
///
/// 返回 Err = 账本库打不开或写入失败（此时什么都不做：入口账原样保留，
/// 加载时按未送达显示——宁可多报一条未送达，不凭空造账）。
pub fn confirm_entries(
    entries: &[PendingEntryRef],
    session_id: &str,
    agent_id: &str,
    persisted: &str,
    written_before: i64,
) -> Result<PendingEntryRef, String> {
    with_conn(|conn| {
        // 代表这次发送的那一行：首笔入口账改写而成；它已不在或是空集时，新记一行。
        let mut representative = None;
        for (i, entry) in entries.iter().enumerate() {
            let affected = if i == 0 {
                conn.execute(
                    "UPDATE pending_user_messages
                     SET session_id = ?2, agent_id = ?3, content = ?4, state = ?5
                     WHERE id = ?1",
                    rusqlite::params![entry.0, session_id, agent_id, persisted, STATE_SENT],
                )?
            } else {
                conn.execute("DELETE FROM pending_user_messages WHERE id = ?1", [entry.0])?
            };
            if i == 0 && affected == 0 {
                representative = Some(insert_entry(
                    conn,
                    session_id,
                    agent_id,
                    persisted,
                    STATE_SENT,
                    written_before,
                )?);
            }
        }
        Ok(match representative {
            Some(fresh) => fresh,
            None if entries.is_empty() => insert_entry(
                conn,
                session_id,
                agent_id,
                persisted,
                STATE_SENT,
                written_before,
            )?,
            None => entries[0],
        })
    })
}

/// 引擎回报「用户消息已落盘」（`message_end` role=user）——销掉该会话里
/// **最早的一笔落地账**。不比文本：技能命令、提示模板展开后才落盘，回执
/// 文本与发送文本本就不同。只销最早一笔是 FIFO 语义：同会话先发的先被处理
/// 落盘（挂死后重发同内容的两笔，前条销账不会把后条的保险连带撕掉）。
///
/// 返回有没有销掉一行。`false` 的一种来由是账本此刻打不开——调用方据此在
/// 回合收口时再销一次，而不是把这笔已经落盘的账落成终态（评审修复轮 R3 /
/// P2-12）。
pub fn ack_persisted(session_id: &str) -> bool {
    let settled = with_conn(|conn| {
        Ok(conn.execute(
            "DELETE FROM pending_user_messages
             WHERE id = (
                 SELECT id FROM pending_user_messages
                 WHERE session_id = ?1 AND state = ?2
                 ORDER BY sent_at ASC, id ASC LIMIT 1
             )",
            rusqlite::params![session_id, STATE_SENT],
        )?)
    });
    match settled {
        Ok(deleted) => deleted > 0,
        Err(e) => {
            // 回执到了却没销成：记下来。这笔账仍是落地账——回合收口时会再销一
            // 次，销不成也不会落成终态，加载时按时间规则对账。
            log::warn!("[pending] 落盘回执销账失败（账仍是落地账，收口时重试）: {e}");
            false
        }
    }
}

/// 引擎回报「这条消息已被扩展命令处理、不起回合」——不落用户消息，也就没有
/// 落盘回执；按身份当场销账（评审修复轮 R2 / C1）。
pub fn ack_handled(entries: &[PendingEntryRef]) {
    if entries.is_empty() {
        return;
    }
    let _ = with_conn(|conn| {
        for entry in entries {
            conn.execute("DELETE FROM pending_user_messages WHERE id = ?1", [entry.0])?;
        }
        Ok(())
    });
}

/// 这几笔账确定未送达（终态）：引擎拒收、回合已收口却没有落盘回执。仍在
/// 等回执的落地账落成终态；入口账本来就是未送达，不动。
pub fn mark_unsent(entries: &[PendingEntryRef]) {
    if entries.is_empty() {
        return;
    }
    let _ = with_conn(|conn| {
        for entry in entries {
            conn.execute(
                "UPDATE pending_user_messages SET state = ?2 WHERE id = ?1 AND state = ?3",
                rusqlite::params![entry.0, STATE_UNSENT, STATE_SENT],
            )?;
        }
        Ok(())
    });
}

/// 本会话里除 `current` 之外是否还有落地账在等回执。没有就不必做回合发起前
/// 的对账（绝大多数回合如此——不为此去读会话文件）。
pub fn has_stale_sent(session_id: &str, current: &[PendingEntryRef]) -> bool {
    with_conn(|conn| {
        let stale = sent_entries(conn, session_id)?;
        Ok(stale.iter().any(|entry| !current.contains(entry)))
    })
    .unwrap_or(false)
}

/// 从空闲态发起新回合时调用（在本次发送结算成落地账**之前**）：此刻引擎
/// 空闲，本会话里除本次发送之外还在等回执的落地账（上一代进程被杀留下的、
/// 或回合收口事件没等到就退出的）不可能再等到**实时的**回执——它们有没有
/// 落盘，证据只剩会话文件。所以先与 `persisted_user_at`（会话文件里用户消息
/// 的落盘时刻）对账，用的是与加载时同一条规则（[`dedupe_against`]）：对得上
/// 的销掉，对不上的才落成终态，免得它们抢走后续发送的回执。
///
/// 为什么不能一律落终态：引擎已把用户消息落盘、hub 在收到回执前退出，这笔
/// 账其实送达了。新回合若赶在界面加载之前发起（命令行直接续会话；大会话还
/// 在加载、用户已经发了下一条），不看证据就落终态——已送达的消息从此显示
/// 成「未送达」，而终态账不再参与加载时的判定，没有第二次机会。
pub fn finalize_stale_sent(
    session_id: &str,
    current: &[PendingEntryRef],
    persisted_user_at: &[i64],
) {
    let mut persisted = persisted_user_at.to_vec();
    persisted.sort_unstable();
    let _ = with_conn(|conn| {
        settle_delivered_on_load(conn, session_id, &persisted, current)?;
        for entry in sent_entries(conn, session_id)? {
            if current.contains(&entry) {
                continue;
            }
            conn.execute(
                "UPDATE pending_user_messages SET state = ?2 WHERE id = ?1",
                rusqlite::params![entry.0, STATE_UNSENT],
            )?;
        }
        Ok(())
    });
}

fn sent_entries(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<PendingEntryRef>, rusqlite::Error> {
    let mut statement =
        conn.prepare("SELECT id FROM pending_user_messages WHERE session_id = ?1 AND state = ?2")?;
    let rows = statement.query_map(rusqlite::params![session_id, STATE_SENT], |row| {
        row.get(0).map(PendingEntryRef)
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// 会话消息加载去重。`persisted_user_at` = 引擎会话文件里已有用户消息的
/// 落盘时刻（毫秒）。按时间规则销掉已有回执的落地账（ack 丢失兜底）；返回
/// 仍未送达的（调用方并入返回列表，重启后消息不丢），按记账先后排序。
pub fn dedupe_against(session_id: &str, persisted_user_at: &[i64]) -> Vec<PendingMessage> {
    let mut persisted = persisted_user_at.to_vec();
    persisted.sort_unstable();
    with_conn(|conn| {
        settle_delivered_on_load(conn, session_id, &persisted, &[])?;
        load_rows(conn, session_id)
    })
    .unwrap_or_default()
}

/// 加载时的销账：逐条落盘的用户消息（时刻升序）各结清一笔——会话里最早的
/// 未销账落地账，且它的记账时刻不晚于这条消息的落盘时刻。`exclude` 里的账
/// 不参与（回合发起前的对账用它保住本次发送的账）。
fn settle_delivered_on_load(
    conn: &Connection,
    session_id: &str,
    persisted_user_at: &[i64],
    exclude: &[PendingEntryRef],
) -> Result<(), rusqlite::Error> {
    let mut sent: Vec<(PendingEntryRef, i64)> = conn
        .prepare(
            "SELECT id, sent_at FROM pending_user_messages
             WHERE session_id = ?1 AND state = ?2
             ORDER BY sent_at ASC, id ASC",
        )?
        .query_map(rusqlite::params![session_id, STATE_SENT], |row| {
            Ok((PendingEntryRef(row.get(0)?), row.get(1)?))
        })?
        .filter_map(Result::ok)
        .filter(|(entry, _)| !exclude.contains(entry))
        .collect();
    if sent.is_empty() || persisted_user_at.is_empty() {
        return Ok(());
    }
    let mut settled = Vec::new();
    for &at in persisted_user_at {
        // 排在队头的未销账落地账记在这条消息之后：它不是这条消息的账，更靠后
        // 的账更不可能是——这条落盘消息谁的账也不是（引导消息、不经 hub 的发送）。
        let Some((_, sent_at)) = sent.first() else {
            break;
        };
        if *sent_at > at {
            continue;
        }
        let (entry, _) = sent.remove(0);
        settled.push(entry.0);
    }
    for id in settled {
        conn.execute("DELETE FROM pending_user_messages WHERE id = ?1", [id])?;
    }
    Ok(())
}

fn load_rows(conn: &Connection, session_id: &str) -> Result<Vec<PendingMessage>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT session_id, agent_id, content, sent_at, state
         FROM pending_user_messages WHERE session_id = ?1
         ORDER BY sent_at ASC, id ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(PendingMessage {
            session_id: row.get(0)?,
            agent_id: row.get(1)?,
            content: row.get(2)?,
            sent_at: row.get(3)?,
            state: row.get(4)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
fn load(session_id: &str) -> Result<Vec<PendingMessage>, String> {
    with_conn(|conn| load_rows(conn, session_id))
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
        )?;
        Ok(())
    });
}

/// 删除会话时的清理（随会话删除联动）。
pub fn drop_session(session_id: &str) {
    let _ = with_conn(|conn| {
        conn.execute(
            "DELETE FROM pending_user_messages WHERE session_id = ?1",
            rusqlite::params![session_id],
        )?;
        Ok(())
    });
}

/// v0.9.8 需求2：用户主动清除一条未送达消息（编辑重发失败/投递挂死后
/// pending 行永等不到 ack——并入渲染即「幽灵」，无清除通道则永久滞留）。
/// 按 (session_id, sent_at) 精确删行；命中与否都幂等成功。
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
    use serde_json::json;

    // 测试隔离同 memory_store：hub_home cfg(test) 固定临时目录；并行测试
    // 共享库用互异 session key 避免串扰，另持 env 锁防 set_var 期间切库。

    /// 界面模型里真正的用户消息（工具结果条目虽然 role 也被映射成 "user"，不在此列）。
    fn user_text_messages(messages: &[crate::session::Message]) -> Vec<&crate::session::Message> {
        messages
            .iter()
            .filter(|message| {
                message.role == "user"
                    && matches!(
                        message.content.first(),
                        Some(crate::session::ContentBlock::Text { .. })
                    )
            })
            .collect()
    }

    fn states_of(session_id: &str) -> Vec<String> {
        load(session_id)
            .unwrap()
            .iter()
            .map(|row| format!("{}|{}", row.content, row.state))
            .collect()
    }

    /// 账目三态闭环：入口账 → 落地账（原地改写）→ 回执销账。只记了入口账
    ///（没写进引擎）的消息不被回执销掉。
    #[test]
    fn record_confirm_ack_roundtrip() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = record("s1", "jishu-self", "你好，帮我修个 bug").unwrap();
        assert_eq!(states_of("s1"), vec!["你好，帮我修个 bug|recorded"]);
        confirm_entries(
            &[entry],
            "s1",
            "jishu-self",
            "你好，帮我修个 bug",
            ledger_now_ms(),
        )
        .unwrap();
        assert_eq!(states_of("s1"), vec!["你好，帮我修个 bug|sent"]);
        ack_persisted("s1");
        assert!(load("s1").unwrap().is_empty());

        // 只记入口账（发送失败、没写进引擎）：回执与它无关，原样保留。
        record("s1", "jishu-self", "没发出去的那条").unwrap();
        ack_persisted("s1");
        assert_eq!(states_of("s1"), vec!["没发出去的那条|recorded"]);
        drop_session("s1");
    }

    /// v0.9.8 评审修复轮 R1-1：入口账按**身份**落地改写（不再按文本认账）。
    /// ① 入口原文 ≠ 落地文本（工具说明块/会话注入）：原地改写，账恒一条，
    /// 行号不变；回执销账闭环；
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
        confirm_entries(&[entry], "s-l1", "jishu-self", persisted, ledger_now_ms()).unwrap();
        let rows = load("s-l1").unwrap();
        assert_eq!(rows.len(), 1, "一笔消息一条账（修前此处原文+落地两条并存）");
        assert_eq!(rows[0].content, persisted);
        assert_eq!(rows[0].state, STATE_SENT);
        // 引擎落盘回执销账——闭环，无幽灵。
        ack_persisted("s-l1");
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
            ledger_now_ms(),
        )
        .unwrap();
        assert!(load("pending-l3").unwrap().is_empty());
        let rows = load("s-l3").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].content.starts_with("<tag>"));
        drop_session("s-l3");

        // ④ 缓冲合并：两笔入口账 → 一条落地消息。
        let e1 = record("s-l4", "jishu-self", "第一条").unwrap();
        let e2 = record("s-l4", "jishu-self", "第二条").unwrap();
        assert_ne!(e1, e2, "同会话连续两笔身份不同");
        assert_eq!(load("s-l4").unwrap().len(), 2);
        confirm_entries(
            &[e1, e2],
            "s-l4",
            "jishu-self",
            "<tag>s-l4</tag>\n\n第一条\n第二条",
            ledger_now_ms(),
        )
        .unwrap();
        let rows = load("s-l4").unwrap();
        assert_eq!(rows.len(), 1, "一条落地消息只留一条账");
        assert_eq!(rows[0].content, "<tag>s-l4</tag>\n\n第一条\n第二条");
        drop_session("s-l4");

        // ⑤ 无入口账（新会话首条 / 已被清除）：新记一条落地账。
        let gone = record("s-l5", "jishu-self", "待清除").unwrap();
        dismiss("s-l5", sent_at_of("s-l5", 0)).unwrap();
        confirm_entries(&[gone], "s-l5", "jishu-self", "落地文本", ledger_now_ms()).unwrap();
        let rows = load("s-l5").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content, "落地文本");
        drop_session("s-l5");
    }

    fn sent_at_of(session_id: &str, index: usize) -> i64 {
        load(session_id).unwrap()[index].sent_at
    }

    /// 评审修复轮 R2（C2）：回执按顺序销账，不比文本——落盘文本与发送文本
    /// 不同（技能命令展开）也能销；一条回执只销一笔。
    #[test]
    fn ack_settles_oldest_sent_entry_regardless_of_text() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let e1 = record("s-ack-order", "jishu-self", "/skill:jishu-cli-guide").unwrap();
        confirm_entries(
            &[e1],
            "s-ack-order",
            "jishu-self",
            "/skill:jishu-cli-guide",
            ledger_now_ms(),
        )
        .unwrap();
        let e2 = record("s-ack-order", "jishu-self", "第二条原文").unwrap();
        confirm_entries(
            &[e2],
            "s-ack-order",
            "jishu-self",
            "第二条落地文本",
            ledger_now_ms(),
        )
        .unwrap();
        assert_eq!(states_of("s-ack-order").len(), 2);

        // 第一条回执（引擎落盘的是展开后的技能正文，与账上的命令原文不同）
        // 只销最早一笔。
        ack_persisted("s-ack-order");
        assert_eq!(states_of("s-ack-order"), vec!["第二条落地文本|sent"]);
        ack_persisted("s-ack-order");
        assert!(load("s-ack-order").unwrap().is_empty());
        drop_session("s-ack-order");
    }

    #[test]
    fn dedupe_keeps_unsent_and_clears_persisted() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let delivered = record("s2", "jishu-self", "已落盘的消息").unwrap();
        confirm_entries(
            &[delivered],
            "s2",
            "jishu-self",
            "已落盘的消息",
            ledger_now_ms(),
        )
        .unwrap();
        record("s2", "jishu-self", "未落盘的消息").unwrap();
        // 重启加载：之后有用户消息落盘 → 落地账清除；入口账未送达 → 返回并入。
        let unsent = dedupe_against("s2", &[crate::util::now_ms() + 1]);
        assert_eq!(unsent.len(), 1);
        assert_eq!(unsent[0].content, "未落盘的消息");
        assert_eq!(load("s2").unwrap().len(), 1);
        drop_session("s2");
    }

    /// v0.9.8 需求2：按会话与记账时刻精确清除未送达消息（幂等）。
    #[test]
    fn dismiss_removes_by_session_and_time() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        record("s3", "jishu-self", "幽灵消息").unwrap();
        let rows = load("s3").unwrap();
        assert_eq!(rows.len(), 1);
        let sent_at = rows[0].sent_at;
        // 命中删除
        dismiss("s3", sent_at).unwrap();
        assert_eq!(load("s3").unwrap().len(), 0);
        // 不存在的键：幂等成功
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
        let first = record("s-fifo", "jishu-self", "继续").unwrap();
        confirm_entries(&[first], "s-fifo", "jishu-self", "继续", ledger_now_ms()).unwrap();
        let second = record("s-fifo", "jishu-self", "继续").unwrap();
        confirm_entries(&[second], "s-fifo", "jishu-self", "继续", ledger_now_ms()).unwrap();
        assert_eq!(load("s-fifo").unwrap().len(), 2, "前置：两条同文本落地账");
        let second_sent_at = sent_at_of("s-fifo", 1);
        // 第一条被引擎落盘销账 → 只删最早一条
        ack_persisted("s-fifo");
        let rows = load("s-fifo").unwrap();
        assert_eq!(rows.len(), 1, "同内容只销最早一条，后条保留");
        assert_eq!(rows[0].sent_at, second_sent_at);
        // 第二条也落盘 → 清零
        ack_persisted("s-fifo");
        assert_eq!(load("s-fifo").unwrap().len(), 0);
        drop_session("s-fifo");
    }

    // ── v0.9.8 评审修复轮 R2（C2 账本销账按身份与顺序）──

    /// 加载判定：记账时刻 ≤ 落盘时刻的落地账，按时间规则销掉。
    #[test]
    fn load_settles_sent_entries_by_order_and_time() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // 技能命令：发给引擎的是命令原文，落盘的是展开后的正文——文本不等。
        let entry = record("s-load-1", "jishu-self", "/skill:x").unwrap();
        let sent_at = sent_at_of("s-load-1", 0);
        confirm_entries(
            &[entry],
            "s-load-1",
            "jishu-self",
            "/skill:x",
            ledger_now_ms(),
        )
        .unwrap();
        let unsent = dedupe_against("s-load-1", &[sent_at]);
        assert!(
            unsent.is_empty(),
            "落盘时刻等于记账时刻也算送达：{unsent:?}"
        );
        assert!(load("s-load-1").unwrap().is_empty());
        drop_session("s-load-1");
    }

    /// 加载判定：账之后没有用户消息落盘（或只有更早的）→ 仍是未送达。
    #[test]
    fn load_keeps_entries_without_later_persisted_user_message() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = record("s-load-2", "jishu-self", "卡死前发出的那条").unwrap();
        let sent_at = sent_at_of("s-load-2", 0);
        confirm_entries(
            &[entry],
            "s-load-2",
            "jishu-self",
            "卡死前发出的那条",
            ledger_now_ms(),
        )
        .unwrap();
        // 会话里只有更早的落盘消息：不是它的回执。
        let unsent = dedupe_against("s-load-2", &[sent_at - 10, sent_at - 5]);
        assert_eq!(unsent.len(), 1, "更早的落盘消息不能充当回执：{unsent:?}");
        assert_eq!(unsent[0].state, STATE_SENT);
        // 完全没有落盘消息：同样保留。
        let unsent = dedupe_against("s-load-2", &[]);
        assert_eq!(unsent.len(), 1);
        drop_session("s-load-2");
    }

    /// 终态：被引擎拒收的那笔不再等回执——下一条发送成功的回执只销它自己。
    #[test]
    fn rejected_send_is_final_and_does_not_absorb_later_receipt() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let rejected = record("s-final-1", "jishu-self", "被拒收的").unwrap();
        confirm_entries(
            &[rejected],
            "s-final-1",
            "jishu-self",
            "被拒收的",
            ledger_now_ms(),
        )
        .unwrap();
        mark_unsent(&[rejected]);
        let accepted = record("s-final-1", "jishu-self", "随后发出的").unwrap();
        confirm_entries(
            &[accepted],
            "s-final-1",
            "jishu-self",
            "随后发出的",
            ledger_now_ms(),
        )
        .unwrap();

        ack_persisted("s-final-1");
        assert_eq!(
            states_of("s-final-1"),
            vec!["被拒收的|unsent"],
            "回执只销已受理的那笔；被拒收的仍是未送达"
        );
        // 终态账不参与加载判定。
        let unsent = dedupe_against("s-final-1", &[crate::util::now_ms() + 1]);
        assert_eq!(unsent.len(), 1);
        assert_eq!(unsent[0].content, "被拒收的");
        drop_session("s-final-1");
    }

    /// 入口账（从没写进引擎）同样不等回执。
    #[test]
    fn entry_never_written_to_engine_is_not_settled_by_later_receipt() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        record("s-final-2", "jishu-self", "只记了入口账").unwrap();
        let sent = record("s-final-2", "jishu-self", "落地的").unwrap();
        confirm_entries(
            &[sent],
            "s-final-2",
            "jishu-self",
            "落地的",
            ledger_now_ms(),
        )
        .unwrap();
        ack_persisted("s-final-2");
        assert_eq!(states_of("s-final-2"), vec!["只记了入口账|recorded"]);
        let unsent = dedupe_against("s-final-2", &[crate::util::now_ms() + 1]);
        assert_eq!(unsent.len(), 1);
        drop_session("s-final-2");
    }

    /// 发起新回合时，上一代遗留的落地账落成终态；本次发送的账不受影响。
    #[test]
    fn sending_new_turn_finalizes_older_sent_entries() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stale = record("s-final-3", "jishu-self", "上一代进程留下的").unwrap();
        confirm_entries(
            &[stale],
            "s-final-3",
            "jishu-self",
            "上一代进程留下的",
            ledger_now_ms(),
        )
        .unwrap();
        let current = record("s-final-3", "jishu-self", "这次发的").unwrap();
        confirm_entries(
            &[current],
            "s-final-3",
            "jishu-self",
            "这次发的",
            ledger_now_ms(),
        )
        .unwrap();
        let other_session = record("s-final-3-other", "jishu-self", "别的会话的").unwrap();
        confirm_entries(
            &[other_session],
            "s-final-3-other",
            "jishu-self",
            "别的会话的",
            ledger_now_ms(),
        )
        .unwrap();

        // 会话文件里没有它之后的用户消息：没有证据，落终态。
        finalize_stale_sent("s-final-3", &[current], &[]);
        assert_eq!(
            states_of("s-final-3"),
            vec![
                "上一代进程留下的|unsent".to_string(),
                "这次发的|sent".to_string()
            ]
        );
        assert_eq!(states_of("s-final-3-other"), vec!["别的会话的|sent"]);
        // 之后的回执只会销本次发送的那笔。
        ack_persisted("s-final-3");
        assert_eq!(states_of("s-final-3"), vec!["上一代进程留下的|unsent"]);
        drop_session("s-final-3");
        drop_session("s-final-3-other");
    }

    /// 扩展命令：引擎回「已处理」→ 按身份当场销账，别的账不动。
    #[test]
    fn ack_handled_deletes_by_identity_only() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let command = record("s-handled", "jishu-self", "/todos").unwrap();
        confirm_entries(
            &[command],
            "s-handled",
            "jishu-self",
            "/todos",
            ledger_now_ms(),
        )
        .unwrap();
        let other = record("s-handled", "jishu-self", "别的消息").unwrap();
        confirm_entries(
            &[other],
            "s-handled",
            "jishu-self",
            "别的消息",
            ledger_now_ms(),
        )
        .unwrap();
        ack_handled(&[command]);
        assert_eq!(states_of("s-handled"), vec!["别的消息|sent"]);
        // 幂等：已销的身份再销一次无事发生。
        ack_handled(&[command]);
        assert_eq!(states_of("s-handled"), vec!["别的消息|sent"]);
        drop_session("s-handled");
    }

    /// 测试期间把记账时刻钉在一个固定值上（离开作用域即恢复真时钟，断言
    /// 失败也会走到 Drop）。`arm` = 默认时刻；`at` = 指定时刻（要造「记账
    /// 时刻落在某条落盘消息前后」的用例）。
    struct PinnedClock;

    impl PinnedClock {
        fn arm() -> Self {
            Self::at(1_700_000_000_000)
        }

        fn at(millis: i64) -> Self {
            TEST_CLOCK_MILLIS.store(millis, std::sync::atomic::Ordering::Relaxed);
            Self
        }
    }

    impl Drop for PinnedClock {
        fn drop(&mut self) {
            TEST_CLOCK_MILLIS.store(0, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// 身份唯一且不复用：同一毫秒两笔身份不同；删掉身份最大的一笔后新账不
    /// 沿用它的身份（用户清除一条仍在缓冲中的消息后，不会错改后来那笔）。
    ///
    /// 记账时刻钉住：两笔必然落在同一毫秒——靠真时钟的话两次开库多半已经跨
    /// 毫秒，用例测不到要测的东西。
    #[test]
    fn record_gives_unique_identity_within_same_millisecond() {
        let _g = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _clock = PinnedClock::arm();
        let first = record("s-ident", "jishu-self", "第一笔").unwrap();
        let second = record("s-ident", "jishu-self", "第二笔").unwrap();
        assert_ne!(first, second, "同毫秒两笔共用身份 → 前一笔被覆盖");
        let rows = load("s-ident").unwrap();
        assert_eq!(
            rows.len(),
            2,
            "同毫秒两笔都在账上（修前只剩被覆盖后的一条）"
        );
        assert_eq!(rows[0].content, "第一笔");
        assert_eq!(rows[1].content, "第二笔");
        assert_eq!(
            rows[1].sent_at,
            rows[0].sent_at + 1,
            "撞上同毫秒的那一笔顺延 1 毫秒，先后顺序不变"
        );

        let third = record("s-ident", "jishu-self", "第三笔").unwrap();
        // 清掉身份最大的那一笔，再记一笔：新账不得沿用它的身份。
        let top = load("s-ident").unwrap().pop().unwrap();
        assert_eq!(top.content, "第三笔");
        dismiss("s-ident", top.sent_at).unwrap();
        let fourth = record("s-ident", "jishu-self", "第四笔").unwrap();
        assert!(
            fourth.0 > third.0,
            "删行后身份被复用：{third:?} → {fourth:?}"
        );
        // 被清除的那笔（第三笔）若还挂在缓冲里，按它原来的身份结算：行已不在
        // → 新记一条落地账，不会碰到后来那笔（第四笔）。
        confirm_entries(&[third], "s-ident", "jishu-self", "改写", ledger_now_ms()).unwrap();
        let after = states_of("s-ident");
        assert_eq!(after.len(), 4, "{after:?}");
        assert!(
            after.contains(&"第四笔|recorded".to_string()),
            "新账不得被已清除那笔的旧身份改写：{after:?}"
        );
        assert!(
            after.contains(&"改写|sent".to_string()),
            "行已不在 → 新记一条落地账：{after:?}"
        );
        drop_session("s-ident");
    }

    /// 开库失败 ≠ 行不在（评审修复轮 R2）。模拟瞬时故障：落地结算的第一次
    /// 开库失败、之后的都正常。修前把失败当成「0 行」——首笔入口账被当成
    /// 「已被清除」而另记一条落地账（一笔消息两条账），其余入口账则照常被
    /// 删掉。现在结算报错且什么都不做，账还是结算前的样子。
    ///
    /// 持续打不开（整段都失败）时修前修后都写不进任何东西，显不出差别——
    /// 所以这里必须是「先失败、后恢复」。
    #[test]
    fn confirm_entries_distinguishes_open_failure_from_missing_row() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let first = record("s-open-fail", "jishu-self", "第一笔原文").unwrap();
        let rest = record("s-open-fail", "jishu-self", "第二笔原文").unwrap();
        let before = vec!["第一笔原文|recorded", "第二笔原文|recorded"];
        assert_eq!(states_of("s-open-fail"), before);

        FAIL_NEXT_OPEN.store(1, std::sync::atomic::Ordering::Relaxed);
        let result = confirm_entries(
            &[first, rest],
            "s-open-fail",
            "jishu-self",
            "合并后的落地文本",
            ledger_now_ms(),
        );
        assert!(result.is_err(), "开库失败应返回错误：{result:?}");
        assert_eq!(
            states_of("s-open-fail"),
            before,
            "开库失败时什么都不做：首笔不被改写、次笔不被删、不凭空新记落地账"
        );

        // 行真不在（用户已清除这条未送达）→ 这是正常路径，不是失败：新记一条。
        dismiss("s-open-fail", sent_at_of("s-open-fail", 0)).unwrap();
        confirm_entries(
            &[first],
            "s-open-fail",
            "jishu-self",
            "落地文本",
            ledger_now_ms(),
        )
        .unwrap();
        assert_eq!(
            states_of("s-open-fail"),
            vec!["第二笔原文|recorded", "落地文本|sent"]
        );
        drop_session("s-open-fail");
        drop(guard);
    }

    /// schema v1 → v2：旧表原样换到新表（不 DROP 重建），旧行一律按落地账
    /// 判定，`user_version` 升到 2。
    #[test]
    fn schema_v1_rows_migrate_in_place_and_are_judged_as_sent() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", home.path());
        {
            // 手工搭一张 v1 旧表（评审修复轮 R2 之前的结构）。
            let conn = Connection::open(db_path()).unwrap();
            conn.execute_batch(
                "CREATE TABLE pending_user_messages (
                    session_id TEXT NOT NULL,
                    agent_id   TEXT NOT NULL DEFAULT '',
                    content    TEXT NOT NULL,
                    sent_at    INTEGER NOT NULL,
                    PRIMARY KEY (session_id, sent_at)
                );
                INSERT INTO pending_user_messages VALUES ('s-legacy', 'jishu-self', '修前留下的账', 1);
                INSERT INTO pending_user_messages VALUES ('s-legacy', 'jishu-self', '另一条', 2);
                PRAGMA user_version = 1;",
            )
            .unwrap();
        }

        assert_eq!(
            states_of("s-legacy"),
            vec!["修前留下的账|sent".to_string(), "另一条|sent".to_string()],
            "旧行照搬，按落地账判定"
        );
        let version: i64 =
            with_conn(|conn| conn.query_row("PRAGMA user_version", [], |r| r.get(0))).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        // 旧行按时间规则该销的销。
        let unsent = dedupe_against("s-legacy", &[1]);
        assert_eq!(unsent.len(), 1, "落盘时刻 1 只能结清记账时刻 1 的那一笔");
        assert_eq!(unsent[0].content, "另一条");

        std::env::remove_var("JISHU_HUB_HOME");
        drop(guard);
    }

    // ── 公司电脑实证（主控转）：旧包留下的存量账怎么销、什么算回执 ───────────

    /// RFC3339 时刻 → 毫秒。
    fn ms(rfc3339: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .timestamp_millis()
    }

    /// 毫秒 → 条目级 timestamp（RFC3339，毫秒精度）。
    fn rfc3339(millis: i64) -> String {
        chrono::DateTime::from_timestamp_millis(millis)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// 公司电脑那份会话里，六条用户消息正文后面跟的是同一段注入块。
    const MCP_HINT_BLOCK: &str = "<JISHU-MCP-HINT>\n本项目已接入 MCP 服务：优先用 MCP 工具读取与检索，结果以文件引用形式给出。\n</JISHU-MCP-HINT>";

    /// 落盘的用户消息：正文 = 用户原文 + hub 注入块（公司那份同形——旧包入口
    /// 按用户原文记账，引擎落盘的是拼了注入块之后的文本）。
    fn user_line(id: &str, parent: &str, original: &str, at: i64) -> String {
        json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "timestamp": rfc3339(at),
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": format!("{original}\n\n{MCP_HINT_BLOCK}") }],
                "timestamp": at,
            },
        })
        .to_string()
    }

    fn assistant_line(id: &str, parent: &str, text: &str, at: i64) -> String {
        json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "timestamp": rfc3339(at),
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": text }],
                "timestamp": at,
            },
        })
        .to_string()
    }

    fn tool_call_line(id: &str, parent: &str, call_id: &str, at: i64) -> String {
        json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "timestamp": rfc3339(at),
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "我先看一下相关文件。" },
                    { "type": "toolCall", "id": call_id, "name": "read", "arguments": { "path": "src/main.rs" } },
                ],
                "timestamp": at,
            },
        })
        .to_string()
    }

    fn tool_result_line(id: &str, parent: &str, call_id: &str, at: i64) -> String {
        json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "timestamp": rfc3339(at),
            "message": {
                "role": "toolResult",
                "toolCallId": call_id,
                "content": [{ "type": "text", "text": "fn main() {}" }],
                "isError": false,
                "timestamp": at,
            },
        })
        .to_string()
    }

    /// 失败尝试：errorMessage-only 的助手消息（模型限流 429，一次轮多次重试）。
    fn error_line(id: &str, parent: &str, at: i64) -> String {
        json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "timestamp": rfc3339(at),
            "message": {
                "role": "assistant",
                "content": [],
                "errorMessage": "429 Too Many Requests: rate limit exceeded, retrying",
                "timestamp": at,
            },
        })
        .to_string()
    }

    fn session_header(session_id: &str, at: i64) -> String {
        json!({
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": rfc3339(at),
            "cwd": "D:\\Work\\demo",
        })
        .to_string()
    }

    /// 写一份合成会话文件到临时目录，返回（临时目录, 路径）。
    fn write_session_file(
        name: &str,
        lines: Vec<String>,
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        std::fs::write(&path, lines.join("\n")).unwrap();
        (dir, path)
    }

    /// 走真实的加载入口（「按会话号找文件」那一段不在内——它依赖用户目录）。
    fn load_messages(session_id: &str, path: &std::path::Path) -> Vec<crate::session::Message> {
        let parsed = crate::agent::jishu_self::pi_session::load_pi_session(path)
            .expect("合成会话文件应能解析");
        crate::agent::jishu_self::pi_session::session_messages_with_pending(
            session_id, path, parsed,
        )
    }

    fn text_of(message: &crate::session::Message) -> String {
        match message.content.first() {
            Some(crate::session::ContentBlock::Text { text, .. }) => text.clone(),
            _ => String::new(),
        }
    }

    /// 公司电脑实证（主控转）：一个会话重开后底部挂着 6 条「未送达」，其中 5
    /// 条实际都已送达并被处理过。来源是旧包留下的**存量账**——旧包入口按用户
    /// 原文记账、销账按拼了注入块之后的文本比对，每发一条留一条。
    ///
    /// 形状照那份会话来（内容全是合成）：会话文件 6 条用户消息（前 5 条在
    /// 11-25、第 6 条在 11-26；每条后面都有助手回复与工具结果；其中一处连续
    /// 5 条 429 报错条目）；v1 旧表同一会话 6 行，内容是用户原文，记账比落盘
    /// 早几百毫秒到几秒；第 6 行对应的消息根本没落盘（夹在第 5、6 条之间）。
    ///
    /// 销法：迁移后旧行一律是落地账；加载时按顺序与时间，6 条落盘的用户消息
    /// 依次结清 6 行。第 6 条结清的是没落盘的那一行——第 6 条自己的账早被新包
    /// 实时销掉了，所以谁也不剩。修前按文本全等对账（原文 ≠ 原文 + 注入块），
    /// 一行也销不掉。
    #[test]
    fn legacy_rows_from_old_builds_settle_by_order_and_time() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", home.path());
        let session = "sid-legacy-rows";
        // 落盘时刻：11-25 的 11:22、11:40、12:15、13:30、14:08，11-26 的 09:21（北京时间）。
        let landed = [
            "2025-11-25T03:22:00.500Z",
            "2025-11-25T03:40:12.800Z",
            "2025-11-25T04:15:03.200Z",
            "2025-11-25T05:30:44.100Z",
            "2025-11-25T06:08:29.900Z",
            "2025-11-26T01:21:07.300Z",
        ]
        .map(ms);
        let originals = ["第一问", "第二问", "第三问", "第四问", "第五问", "第六问"];
        // 记账比落盘早几百毫秒到几秒。
        let lead = [420_i64, 1_310, 650, 2_140, 980];

        let mut lines = vec![session_header(session, landed[0] - 60_000)];
        for index in 0..6 {
            let (user, call, result, reply) = (
                format!("u{}", index + 1),
                format!("a{}", index + 1),
                format!("t{}", index + 1),
                format!("r{}", index + 1),
            );
            let at = landed[index];
            lines.push(user_line(&user, "p0", originals[index], at));
            lines.push(tool_call_line(
                &call,
                &user,
                &format!("call{index}"),
                at + 1_500,
            ));
            lines.push(tool_result_line(
                &result,
                &call,
                &format!("call{index}"),
                at + 4_000,
            ));
            if index == 3 {
                // 第 4 条之后：连续 5 条限流报错，然后才成功。
                let mut parent = result;
                for retry in 0..5 {
                    let error = format!("e{retry}");
                    lines.push(error_line(&error, &parent, at + 10_000 + retry * 1_000));
                    parent = error;
                }
                lines.push(assistant_line(&reply, &parent, "处理完了。", at + 30_000));
            } else {
                lines.push(assistant_line(&reply, &result, "处理完了。", at + 6_000));
            }
        }
        let (_dir, path) = write_session_file("20251125_032155_sid-legacy-rows.jsonl", lines);

        {
            // 手工搭一张 v1 旧表（旧包的账）：入口按用户原文记，落地后不改写。
            let conn = Connection::open(db_path()).unwrap();
            conn.execute_batch(
                "CREATE TABLE pending_user_messages (
                    session_id TEXT NOT NULL,
                    agent_id   TEXT NOT NULL DEFAULT '',
                    content    TEXT NOT NULL,
                    sent_at    INTEGER NOT NULL,
                    PRIMARY KEY (session_id, sent_at)
                );",
            )
            .unwrap();
            for index in 0..5 {
                conn.execute(
                    "INSERT INTO pending_user_messages VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        session,
                        "jishu-self",
                        originals[index],
                        landed[index] - lead[index]
                    ],
                )
                .unwrap();
            }
            // 第 6 行：用户把第 5 条改写后又发了一遍，旧版本没落盘——排在第 5、6 条之间。
            conn.execute(
                "INSERT INTO pending_user_messages VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    session,
                    "jishu-self",
                    "第五问（改写前的旧稿）",
                    landed[4] + 20 * 60_000
                ],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        // 前置：迁移后 6 行都在，一律按落地账判定。
        let before = states_of(session);
        assert_eq!(before.len(), 6, "{before:?}");
        assert!(
            before.iter().all(|row| row.ends_with("|sent")),
            "{before:?}"
        );

        let messages = load_messages(session, &path);
        assert_eq!(
            user_text_messages(&messages).len(),
            6,
            "前置：六条用户消息都读到了"
        );
        assert!(
            messages.iter().all(|message| message.unsent.is_none()),
            "加载后不该再挂「未送达」：{:?}",
            messages
                .iter()
                .filter(|message| message.unsent.is_some())
                .map(text_of)
                .collect::<Vec<_>>()
        );
        assert!(
            load(session).unwrap().is_empty(),
            "库里该会话应 0 行：{:?}",
            states_of(session)
        );
        drop_session(session);
        std::env::remove_var("JISHU_HUB_HOME");
        drop(guard);
    }

    /// 主控提醒：只有「用户消息落盘」才是回执。工具结果在界面模型里也归在
    /// 用户名下（`parse_pi_message` 把 role 映射成 "user"），但它不是回执——算
    /// 进来会把回合中途发出、实际没落盘的那笔账错销掉；模型限流（429）的报错
    /// 条目更不是。
    #[test]
    fn tool_results_and_error_entries_are_not_receipts() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", home.path());
        let session = "sid-receipts";
        let landed_at = ms("2025-11-25T03:22:00.500Z");
        // 第二笔落地账上的文本（发给引擎的 = 原文 + 注入）。
        const LOST_SENT_TEXT: &str = "没落盘的那条\n\n<注入>";
        let mut lines = vec![
            session_header(session, landed_at - 60_000),
            user_line("u1", "p0", "第一问", landed_at),
            tool_call_line("a1", "u1", "call1", landed_at + 1_000),
            tool_result_line("t1", "a1", "call1", landed_at + 4_000),
        ];
        let mut parent = "t1".to_string();
        for retry in 0..5 {
            let error = format!("e{retry}");
            lines.push(error_line(
                &error,
                &parent,
                landed_at + 10_000 + retry * 1_000,
            ));
            parent = error;
        }
        lines.push(assistant_line(
            "r1",
            &parent,
            "处理完了。",
            landed_at + 30_000,
        ));
        let (_dir, path) = write_session_file("20251125_032155_sid-receipts.jsonl", lines);

        {
            // 第一笔：记在用户消息落盘之前 → 它就是这条消息的账，已送达。
            let _clock = PinnedClock::at(landed_at - 500);
            let delivered = record(session, "jishu-self", "第一问").unwrap();
            confirm_entries(
                &[delivered],
                session,
                "jishu-self",
                "第一问\n\n<注入>",
                ledger_now_ms(),
            )
            .unwrap();
            // 第二笔：记在用户消息落盘之后、工具结果之前（回合进行中发出），
            // 引擎没落盘；之后这个会话再没有任何用户消息落盘。
            TEST_CLOCK_MILLIS.store(landed_at + 2_000, std::sync::atomic::Ordering::Relaxed);
            let lost = record(session, "jishu-self", "没落盘的那条").unwrap();
            confirm_entries(
                &[lost],
                session,
                "jishu-self",
                LOST_SENT_TEXT,
                ledger_now_ms(),
            )
            .unwrap();
        }

        let messages = load_messages(session, &path);
        let unsent: Vec<String> = messages
            .iter()
            .filter(|message| message.unsent == Some(true))
            .map(text_of)
            .collect();
        assert_eq!(
            unsent,
            vec![LOST_SENT_TEXT.to_string()],
            "工具结果、报错条目都不是回执"
        );
        assert_eq!(states_of(session), vec![format!("{LOST_SENT_TEXT}|sent")]);
        drop_session(session);
        std::env::remove_var("JISHU_HUB_HOME");
        drop(guard);
    }

    /// 主控边界：回合发起前的对账看的是会话文件——上一代的落地账，之后有落
    /// 盘用户消息的其实送达了（引擎落了盘、hub 没等到回执就退出），销掉；没
    /// 有的才落终态。本次发送的账不动。
    #[test]
    fn stale_sent_entries_are_judged_by_session_file_before_turn() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let session = "s-turn-evidence";
        for text in ["上一代：已落盘", "上一代：也已落盘", "上一代：没落盘"] {
            let entry = record(session, "jishu-self", text).unwrap();
            confirm_entries(&[entry], session, "jishu-self", text, ledger_now_ms()).unwrap();
        }
        let current = record(session, "jishu-self", "这次发的").unwrap();
        assert!(
            has_stale_sent(session, &[current]),
            "前置：有上一代的落地账"
        );

        // 会话文件里：前两笔之后各落了一条用户消息；第三笔之后没有。
        let later = crate::util::now_ms() + 60_000;
        finalize_stale_sent(session, &[current], &[later, later + 1]);
        assert_eq!(
            states_of(session),
            vec![
                "上一代：没落盘|unsent".to_string(),
                "这次发的|recorded".to_string()
            ],
            "对得上会话文件的销掉，对不上的才落终态"
        );
        // 上一代的账都了结了：下一次回合发起前不必再读会话文件。
        assert!(!has_stale_sent(session, &[current]));
        drop_session(session);
        drop(guard);
    }

    // ── 评审修复轮 R3：落地新记的账身份回登记、时刻先于写出、销账如实返回 ──────

    /// 评审修复轮 R3（P2-1）：结算交回「代表这次发送的那一行」的身份——带了
    /// 入口账是首笔；没带入口账、或入口账已被清除，是落地时新记的那一行。
    /// 修前这个身份没有交回：「已处理」销不掉新记的账，它还会抢走下一条的回执。
    #[test]
    fn confirm_entries_returns_the_identity_of_the_row() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // 没带入口账（编排节点、命令行）：新记一行，身份是它的。
        let session = "s-ident-return";
        let fresh = confirm_entries(
            &[],
            session,
            "jishu-self",
            "节点派发的提示",
            ledger_now_ms(),
        )
        .unwrap();
        let rows = load(session).unwrap();
        assert_eq!(rows.len(), 1, "一次发送一笔账");
        assert_eq!(rows[0].content, "节点派发的提示");
        assert_eq!(rows[0].state, STATE_SENT);
        // 按交回的身份销账：销得掉（修前登记里是空集，这一行留成「未送达」）。
        ack_handled(&[fresh]);
        assert!(load(session).unwrap().is_empty(), "按交回的身份销账");
        drop_session(session);

        // 带了入口账：身份就是首笔入口账（原地改写，不多记）。
        let session = "s-ident-return-2";
        let entry = record(session, "jishu-self", "原文").unwrap();
        let returned = confirm_entries(
            &[entry],
            session,
            "jishu-self",
            "原文\n\n<注入>",
            ledger_now_ms(),
        )
        .unwrap();
        assert_eq!(returned, entry);
        assert_eq!(load(session).unwrap().len(), 1);
        drop_session(session);

        // 入口账已被用户清除：新记一行，身份是它的——不是那笔已被清除的。
        let session = "s-ident-return-3";
        let gone = record(session, "jishu-self", "待清除").unwrap();
        dismiss(session, sent_at_of(session, 0)).unwrap();
        let returned =
            confirm_entries(&[gone], session, "jishu-self", "落地文本", ledger_now_ms()).unwrap();
        assert_ne!(returned, gone, "清除过的身份不复用");
        ack_handled(&[returned]);
        assert!(load(session).unwrap().is_empty());
        drop_session(session);

        // 缓冲合并：两笔入口账拼成一条——代表是第一笔，第二笔删掉。
        let session = "s-ident-return-4";
        let first = record(session, "jishu-self", "第一条").unwrap();
        let second = record(session, "jishu-self", "第二条").unwrap();
        let returned = confirm_entries(
            &[first, second],
            session,
            "jishu-self",
            "第一条\n第二条",
            ledger_now_ms(),
        )
        .unwrap();
        assert_eq!(returned, first);
        assert_eq!(states_of(session), vec!["第一条\n第二条|sent"]);
        drop_session(session);
        drop(guard);
    }

    /// 评审修复轮 R3（P2-2）：落地时才新记的账，时刻取调用方在写出**之前**
    /// 取好的那个（「先记后落，恒有记录 ≤ 落盘」）。
    #[test]
    fn entryless_row_takes_the_marker_taken_before_the_write() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stamps = |session: &str| -> Vec<i64> {
            load(session)
                .unwrap()
                .iter()
                .map(|row| row.sent_at)
                .collect()
        };
        let written_before = 1_700_000_123_456_i64;
        let session = "s-write-time";
        confirm_entries(&[], session, "jishu-self", "提示", written_before).unwrap();
        assert_eq!(stamps(session), vec![written_before]);
        drop_session(session);

        // 入口账被清除后新记的那一行同样。
        let session = "s-write-time-cleared";
        let gone = record(session, "jishu-self", "待清除").unwrap();
        dismiss(session, sent_at_of(session, 0)).unwrap();
        confirm_entries(
            &[gone],
            session,
            "jishu-self",
            "落地文本",
            written_before + 7,
        )
        .unwrap();
        assert_eq!(stamps(session), vec![written_before + 7]);
        drop_session(session);
        drop(guard);
    }

    /// 评审修复轮 R3（P2-12）：销账没落库要如实返回——账本打不开时是 false，
    /// 不是「已经销掉了」。
    #[test]
    fn ack_persisted_reports_whether_it_settled() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let session = "s-ack-report";
        let entry = record(session, "jishu-self", "你好").unwrap();
        confirm_entries(&[entry], session, "jishu-self", "你好", ledger_now_ms()).unwrap();

        FAIL_NEXT_OPEN.store(1, std::sync::atomic::Ordering::Relaxed);
        assert!(!ack_persisted(session), "账本打不开：没销成");
        assert_eq!(states_of(session), vec!["你好|sent"], "账仍在");
        assert!(ack_persisted(session), "销成了");
        assert!(load(session).unwrap().is_empty());
        // 没有等回执的账：没销成。
        assert!(!ack_persisted(session));
        drop_session(session);
        drop(guard);
    }
}
