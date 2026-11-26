//! pi_rpc_runtime 子模块（v0.9.8 评审修复轮 R2 拆出）：发送簿记与扩展命令
//! 识别。连接循环（主文件）只保留状态迁移；「一条消息怎么发给引擎、怎么认
//! 它的回执、是不是扩展命令、压缩停止后的收尾期限」这些可独立命名的关注点
//! 放这里。
//!
//! 评审修复轮 R2 的三件事都落在这个模块：
//! - **C1 扩展命令**：与引擎原生 TUI 一致。引擎对扩展命令（扩展自己注册的
//!   `/名字`）的处理是立即执行、不起回合、不落用户消息，执行完回
//!   `disposition: "handled"`。此前 hub 把 handled 只当成「解除看门狗」，状态
//!   机停在「回合进行中」——会话从此一直「处理中」，点停止也救不回来（发版
//!   前评审 P0）。两条事实都以引擎为准：是不是扩展命令看引擎的命令清单；
//!   有没有起回合看引擎对 prompt 的回执。
//! - **C2 账本销账**：一次发送在循环里登记一笔（请求号 + 账本身份），回执
//!   按请求号认，账按身份销（见 [`crate::pending_messages`]）。回合发起之前
//!   先了结上一代留下的落地账——拿会话文件里用户消息的落盘时刻对账，与加载
//!   时同一条规则（[`finalize_stale_sent_before_turn`]）。
//! - **压缩停止的收尾期限**：只在「压缩中点过停止、引擎不收尾」时武装。
//!
//! 子模块项经主文件根 `pub(crate) use` 重导出，外部路径 `crate::pi_rpc_runtime::X`
//! 不变。

use super::*;
use crate::pending_messages::PendingEntryRef;

// ---------------------------------------------------------------------------
// 压缩中点停止后的收尾期限
// ---------------------------------------------------------------------------

/// 与取消收尾的 15s 对称。只在「压缩中点过停止」之后武装——引擎对 abort
/// 不收尾时（compaction_end 永不到），「压缩中」会一直挂到重启，而压缩期间
/// 空闲回收又是关掉的，没有任何机制来收场。正常压缩不武装：不给引擎的正常
/// 压缩加期限（「坚决信任 pi」），这条期限只针对「点了停止、引擎却不收尾」。
pub(crate) const COMPACTION_SETTLE_TIMEOUT: Duration = CANCEL_SETTLE_TIMEOUT;

/// 期限到了、hub 替引擎收场时写进日志的原因（不发给界面，见下方事件说明）。
pub(crate) const COMPACTION_SETTLE_MESSAGE: &str =
    "上下文压缩停止超时，引擎没有响应停止——已强制结束智能体进程。";

/// 压缩进行中又发起一次压缩时，hub 拒绝第二个请求的提示。与前端词典
/// `sessions.compactAlreadyRunning` **逐字相同**（二轮评审域 3 P2-22 / P2-24）：
/// 同一个场景界面只该有一种说法——前端在前端拦一道、后端在后端拦一道，此前
/// 两边各写各的。单测拿词典原文做相等断言，哪一天对不上直接变红。
pub(crate) const DUPLICATE_COMPACT_HINT: &str = "上下文正在压缩，等它结束再试。";

/// 收尾期限判定（纯函数，供单测）。未武装恒为假。
pub(crate) fn compaction_settle_due(
    armed_at: Option<tokio::time::Instant>,
    now: tokio::time::Instant,
) -> bool {
    armed_at.is_some_and(|at| now >= at)
}

/// 期限到了发给界面的事件：与「引擎响应停止」（compaction_end 带 aborted）
/// 归一化出来的一对**逐字同形**——终态分隔线在前、`status(false)` 在后。
///
/// 为什么不发错误事件：用户点了停止、引擎只是没收尾，语义上是「已取消」。
/// 界面收到 `status(false)` 就把纯压缩流连同其中的分隔线提交进缓存并丢流；
/// 错误块只会写进还存在的流，排在后面到达时流已经没了、会被静默丢弃，排
/// 在前面又会改变「纯压缩流」的判定。原因写日志即可。单测拿这对事件与
/// 引擎真实取消的事件做整体相等断言，两边不一致即变红。
pub(crate) fn compaction_settle_events() -> Vec<NormalizedEvent> {
    vec![
        NormalizedEvent::PhaseDivider {
            phase: "compaction".to_string(),
            title: "上下文压缩已取消".to_string(),
        },
        NormalizedEvent::CompactionStatus {
            active: false,
            // hub 只在纯压缩（手动压缩，状态是 Idle）时武装这条期限。
            reason: "manual".to_string(),
        },
    ]
}

/// 测试可缩短收尾期限（端到端用例不必等 15 秒）；0 = 用默认窗口。
#[cfg(test)]
static TEST_COMPACTION_SETTLE_MILLIS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// 缩短压缩收尾期限（仅测试用；传入 0 恢复默认窗口）。
#[cfg(test)]
pub(crate) fn set_compaction_settle_timeout_for_test(millis: u64) {
    TEST_COMPACTION_SETTLE_MILLIS.store(millis, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn compaction_settle_timeout() -> Duration {
    #[cfg(test)]
    {
        let millis = TEST_COMPACTION_SETTLE_MILLIS.load(std::sync::atomic::Ordering::Relaxed);
        if millis > 0 {
            return Duration::from_millis(millis);
        }
    }
    COMPACTION_SETTLE_TIMEOUT
}

// ---------------------------------------------------------------------------
// 扩展命令识别
// ---------------------------------------------------------------------------

/// 扩展命令名：`/` 之后、第一个空格之前的整段。与引擎的命令识别逐字对齐
///（引擎按首个空格切片取名，换行不算分隔）——hub 的判定必须能预测引擎的
/// 行为，否则「立即转发」和「当普通消息」会判反。不是 `/` 开头，或 `/` 后
/// 直接是空格 → None。
pub(crate) fn extension_command_name(text: &str) -> Option<&str> {
    let name = text.strip_prefix('/')?.split(' ').next()?;
    (!name.is_empty()).then_some(name)
}

/// 从引擎 `get_commands` 的响应里取扩展命令名。只认 `source == "extension"`
/// ——提示模板、技能命令展开后照常起回合、落用户消息，不属于「执行完即
/// 结束」这一类。响应不是本命令的、或失败 → None（调用方保留上一次的集合）。
pub(crate) fn extension_command_names(
    response: &serde_json::Value,
) -> Option<std::collections::HashSet<String>> {
    if !is_pi_response(response, "get_commands")
        || response.get("success").and_then(|v| v.as_bool()) != Some(true)
    {
        return None;
    }
    let commands = response.get("data")?.get("commands")?.as_array()?;
    Some(
        commands
            .iter()
            .filter_map(|command| {
                if command.get("source")?.as_str()? != "extension" {
                    return None;
                }
                let name = command.get("name")?.as_str()?;
                (!name.is_empty()).then(|| name.to_string())
            })
            .collect(),
    )
}

/// 这段文本是不是本会话引擎的扩展命令：以 `/` 开头，且名字在引擎报告的
/// 扩展命令清单里。
pub(crate) fn is_extension_command(
    extension_commands: &std::collections::HashSet<String>,
    text: &str,
) -> bool {
    extension_command_name(text).is_some_and(|name| extension_commands.contains(name))
}

/// 等引擎回答 `get_commands` 的上限。此时引擎刚答完 `get_state`，这张清单是
/// 内存里的现成数据；超时按「没有扩展命令」处理，不挡首条消息。
const PI_COMMANDS_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// 握手后等引擎回答扩展命令清单（请求已随 get_state 一并发出）。只在首条
/// 消息以 `/` 开头时才需要等——只有这时「是不是扩展命令」才决定首条消息
/// 怎么发；其余情况不等，响应到了在主循环里更新清单。
///
/// 返回（扩展命令名， 等待期间替主循环收下的行）。等待期间引擎可能已经发出
/// 别的行（扩展在 session_start 里发起的 hub_invoke、界面请求）——不能丢，
/// 按先后交回主循环处理（评审修复轮 R3 / P2-6）。引擎对这条命令回失败（不
/// 认识 `get_commands` 的引擎）也立即结束等待，按「没有扩展命令」往下发——
/// 此前失败响应不算答复，会白等满上限。
pub(crate) async fn await_extension_commands(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<String>,
) -> (std::collections::HashSet<String>, Vec<String>) {
    let deadline = tokio::time::Instant::now() + PI_COMMANDS_FETCH_TIMEOUT;
    let mut held = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let line = match tokio::time::timeout(remaining, stdout_rx.recv()).await {
            Ok(Some(line)) => line,
            // 超时，或引擎输出已关闭：按「没有扩展命令」处理。
            Ok(None) | Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
            held.push(line);
            continue;
        };
        match extension_command_names(&msg) {
            Some(names) => return (names, held),
            // 引演回了这条命令的失败响应：它给不出清单，再等也没有答复。
            None if is_pi_response(&msg, "get_commands") => {
                log::warn!(
                    "Pi RPC get_commands failed; proceeding as if the engine had no extension commands"
                );
                break;
            }
            None => held.push(line),
        }
    }
    (std::collections::HashSet::new(), held)
}

/// 主循环读下一行：先把等命令清单期间替主循环收下的行按先后交还，再读通道。
pub(crate) async fn next_line(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<String>,
    held: &mut std::collections::VecDeque<String>,
) -> Option<String> {
    if let Some(line) = held.pop_front() {
        return Some(line);
    }
    stdout_rx.recv().await
}

// ---------------------------------------------------------------------------
// 请求号与发送登记
// ---------------------------------------------------------------------------

/// hub → 引擎的请求号。引擎在 response 里原样回带（pi RPC 的命令可带 `id`）；
/// 按号认响应，不依赖响应先后——并发的两条请求（两次压缩、回合中转发的
/// 扩展命令）响应会串，串了就会把结果回给错的调用方。
pub(crate) const REQUEST_ID_PROMPT: &str = "hub-prompt-";
pub(crate) const REQUEST_ID_COMPACT: &str = "hub-compact-";
pub(crate) const REQUEST_ID_COMMANDS: &str = "hub-commands-";

#[derive(Default)]
pub(crate) struct RequestIds {
    seq: u64,
}

impl RequestIds {
    /// 三种命令共用一个序号空间：一个号只对应一次请求。
    pub(crate) fn next(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }
}

pub(crate) fn request_id(kind: &str, seq: u64) -> String {
    format!("{kind}{seq}")
}

/// 从 response 的 `id` 里取回 hub 请求号；不是 hub 的这类请求（没带 id、前缀
/// 不符）→ None。
pub(crate) fn request_seq(response_id: Option<&str>, kind: &str) -> Option<u64> {
    response_id?.strip_prefix(kind)?.parse().ok()
}

/// 这次发送的落盘回执到了没有、销掉没有（评审修复轮 R3 / P2-12）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Receipt {
    /// 还没到。
    NotArrived,
    /// 到了，但销账没落库（账本那一刻打不开）——回合收口时要再销一次。
    Arrived,
    /// 到了，账已销。
    Settled,
}

/// 一次发送在连接循环里的登记：请求号（认回执）+ 这次发送的账本身份。
pub(crate) struct PromptRecord {
    pub(crate) seq: u64,
    /// 代表这次发送的那一笔账（见 [`write_prompt`]）。
    pub(crate) entries: Vec<PendingEntryRef>,
    /// 按引擎清单判定为扩展命令而转发的（不落用户消息，账等「已处理」回执来销）。
    pub(crate) extension: bool,
    pub(crate) receipt: Receipt,
}

impl PromptRecord {
    pub(crate) fn new(seq: u64, entries: Vec<PendingEntryRef>, extension: bool) -> Self {
        Self {
            seq,
            entries,
            extension,
            receipt: Receipt::NotArrived,
        }
    }

    /// 引擎回报「用户消息已落盘」。`settled` = 账销掉了没有。
    pub(crate) fn receipt_arrived(&mut self, settled: bool) {
        if self.receipt == Receipt::NotArrived {
            self.receipt = if settled {
                Receipt::Settled
            } else {
                Receipt::Arrived
            };
        }
    }
}

/// 按请求号取回一次发送的登记（回执到了）。返回 (登记, 是否拥有回合)。
/// 引擎没回带请求号时按「当前回合由这条消息启动；否则是最早转发的那条」认。
pub(crate) fn take_prompt_record(
    seq: Option<u64>,
    turn_prompt: &mut Option<PromptRecord>,
    side_prompts: &mut Vec<PromptRecord>,
) -> (Option<PromptRecord>, bool) {
    if let Some(seq) = seq {
        if turn_prompt.as_ref().is_some_and(|record| record.seq == seq) {
            return (turn_prompt.take(), true);
        }
        if let Some(index) = side_prompts.iter().position(|record| record.seq == seq) {
            return (Some(side_prompts.remove(index)), false);
        }
        return (None, false);
    }
    if turn_prompt.is_some() {
        return (turn_prompt.take(), true);
    }
    if !side_prompts.is_empty() {
        return (Some(side_prompts.remove(0)), false);
    }
    (None, false)
}

/// 回合到此为止（已收口，或进程被 hub 结束）：这次发送若还没有落盘回执，
/// 它的账落成终态——确定未送达，不再占「等回执」的位置。
///
/// 回执**到过**的发送不落终态（评审修复轮 R3 / P2-12）：回执到的那一刻账本
/// 可能打不开，销账没落库；此后若照常落终态，一条已经落盘的消息会从此显示
/// 成「未送达」，而终态账不再参与加载时的判定，没有第二次机会。所以回执到
/// 过而没销成的，这里再销一次（同一顺序：会话里最早的落地账）；再销不成也
/// 留作落地账，加载时按时间规则对得上。
pub(crate) fn finalize_turn_prompt(turn_prompt: &mut Option<PromptRecord>, session_id: &str) {
    let Some(record) = turn_prompt.take() else {
        return;
    };
    match record.receipt {
        Receipt::Arrived => {
            crate::pending_messages::ack_persisted(session_id);
        }
        Receipt::Settled => {}
        Receipt::NotArrived => crate::pending_messages::mark_unsent(&record.entries),
    }
}

/// 引擎不回带请求号时，一条失败的 prompt 回执认不出属于哪一次发送——当前回
/// 合的发送与转发出去的命令并存，两者都可能失败。这时不猜（评审修复轮 R3 /
/// P2-10）：此前按「先认当前回合的那一次」落笔，会把正在跑的回合记成失败、
/// 把它的账落成终态。只有一次发送在等回执时才认得出，那条路不经过这里。
pub(crate) fn unattributable_failure(
    seq: Option<u64>,
    turn_prompt: &Option<PromptRecord>,
    side_prompts: &[PromptRecord],
) -> bool {
    seq.is_none() && turn_prompt.is_some() && !side_prompts.is_empty()
}

/// 发起新回合之前，了结本会话里上一代的落地账（规则见
/// [`crate::pending_messages::finalize_stale_sent`]）。证据在会话文件里：读文件
/// 是同步 I/O，大会话要几百毫秒，放进阻塞线程池，不占连接循环所在的线程。
/// 只有账本里真有上一代的落地账时才读——绝大多数回合只花一次账本查询。
pub(crate) async fn finalize_stale_sent_before_turn(session_id: &str, current: &[PendingEntryRef]) {
    if !crate::pending_messages::has_stale_sent(session_id, current) {
        return;
    }
    let lookup = session_id.to_string();
    let persisted_user_at =
        tokio::task::spawn_blocking(move || persisted_user_at_evidence(&lookup))
            .await
            .unwrap_or_default();
    crate::pending_messages::finalize_stale_sent(session_id, current, &persisted_user_at);
}

/// 回合发起前对账用的证据：会话文件里用户消息的落盘时刻。找不到文件、读不
/// 了 → 空（按「没有证据」处理：上一代的落地账落终态，与没有会话文件同）。
fn persisted_user_at_evidence(session_id: &str) -> Vec<i64> {
    if let Some(times) = stale_evidence_override() {
        return times;
    }
    crate::agent::jishu_self::pi_session::persisted_user_message_at_for_session(session_id)
}

/// 生产代码恒为 None：照实读会话文件。
#[cfg(not(test))]
fn stale_evidence_override() -> Option<Vec<i64>> {
    None
}

/// 测试用的替身证据（见 [`set_persisted_user_at_for_test`]）。测试恒有值：没设
/// 替身就当「会话文件里没有用户消息」——测试一律不碰用户目录里的真实会话。
#[cfg(test)]
fn stale_evidence_override() -> Option<Vec<i64>> {
    Some(
        TEST_PERSISTED_USER_AT
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_default(),
    )
}

/// 测试用：回合发起前对账拿到的「会话文件里用户消息落盘时刻」。None = 没有用户
/// 消息（也即测试的默认态）。生产代码不含这段。
#[cfg(test)]
static TEST_PERSISTED_USER_AT: std::sync::Mutex<Option<Vec<i64>>> = std::sync::Mutex::new(None);

/// 设定上面这份替身证据（仅测试用）。
#[cfg(test)]
pub(crate) fn set_persisted_user_at_for_test(times: Option<Vec<i64>>) {
    *TEST_PERSISTED_USER_AT
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = times;
}

/// 测试用：替身证据的守卫，离开作用域恢复默认态。
#[cfg(test)]
pub(crate) struct PersistedUserAtGuard;

#[cfg(test)]
impl PersistedUserAtGuard {
    pub(crate) fn set(times: Vec<i64>) -> Self {
        set_persisted_user_at_for_test(Some(times));
        Self
    }
}

#[cfg(test)]
impl Drop for PersistedUserAtGuard {
    fn drop(&mut self) {
        set_persisted_user_at_for_test(None);
    }
}

/// 一条失败的 prompt 回执是不是「回合中转发的扩展命令」的：是 → 它在
/// `side_prompts` 里的下标。引擎没回带请求号时，只有当前没有回合发送、却有
/// 转发出去的命令，才算它的。
pub(crate) fn side_prompt_index(
    seq: Option<u64>,
    turn_prompt: &Option<PromptRecord>,
    side_prompts: &[PromptRecord],
) -> Option<usize> {
    let seq = match seq {
        Some(seq) => Some(seq),
        None if turn_prompt.is_none() && !side_prompts.is_empty() => return Some(0),
        None => return None,
    };
    side_prompts
        .iter()
        .position(|record| Some(record.seq) == seq)
}

/// 把一条消息写给引擎，并按身份把这次发送的账结算为落地账（首条消息、
/// 空闲直发、缓冲重发、回合中转发的扩展命令共用）。请求号随命令带出，
/// 引擎在回执里原样回带。
///
/// 返回**代表这次发送的那一笔账的身份**，调用方把它写进这次发送的登记。
/// 带了入口账就是首笔入口账；没带入口账（编排节点、命令行、入口账被用户
/// 清除）是落地时新记的那一行——评审修复轮 R3（P2-1）之前这个身份没有回
/// 到登记：「已处理」销不掉它，它还会作为「最早的落地账」抢走下一条消息
/// 的回执。账本结算失败时把入口账的身份原样交回（入口账仍在、按未送达显
/// 示）。
pub(crate) async fn write_prompt(
    stdin: &Arc<TokioMutex<ChildStdin>>,
    seq: u64,
    outgoing: &str,
    session_id: &str,
    agent_id: &str,
    entries: &[PendingEntryRef],
) -> Result<Vec<PendingEntryRef>, String> {
    // 记账时刻在写引擎**之前**取（评审修复轮 R3 / P2-2）：落地时才新记的
    // 账此前取在写出之后，可能比引擎给用户消息打的时间戳还晚——实时回执
    // 没等到时，加载对账会对不上它自己的那条消息。
    let written_before = crate::pending_messages::ledger_now_ms();
    send_pi_command(
        stdin,
        &json!({
            "type": "prompt",
            "id": request_id(REQUEST_ID_PROMPT, seq),
            "message": outgoing
        }),
    )
    .await?;
    // v0.9.6 需求6 F3 / 评审修复轮 R1-1：prompt 已写入引擎 stdin——按身份
    // 把发送入口记的防丢账结算为落地账（内容 = 实际发给引擎的文本）。身份
    // 随消息带来，与会话键的迁移时序无关。
    match crate::pending_messages::confirm_entries(
        entries,
        session_id,
        agent_id,
        outgoing,
        written_before,
    ) {
        Ok(entry) => Ok(vec![entry]),
        Err(e) => {
            log::warn!("[pending] 落地账结算失败（入口账保留，加载时按未送达显示）: {e}");
            Ok(entries.to_vec())
        }
    }
}

/// 回合收口后把缓冲的后继消息发出去，并把它登记为当前回合的发送。
pub(super) async fn resend_buffered_prompt(
    stdin: &Arc<TokioMutex<ChildStdin>>,
    payload: PromptPayload,
    seq: u64,
    session_id: &str,
    agent_id: &str,
    injection: Option<&ResolvedSessionPromptInjection>,
    turn_watchdog: &mut Option<(WatchdogPhase, tokio::time::Instant)>,
    turn_prompt: &mut Option<PromptRecord>,
) -> Result<(), String> {
    // 能进缓冲的只有普通消息（扩展命令是立即转发的）——发组装后的文本。
    let PromptPayload {
        message,
        user_text: _,
        pending_entries,
    } = payload;
    let outgoing = apply_resolved_session_prompt_injection(message, session_id, injection);
    // 代表这次发送的那一笔账的身份由 write_prompt 交回（没带入口账的发送是
    // 落地时新记的那一行）。
    let entries = write_prompt(
        stdin,
        seq,
        &outgoing,
        session_id,
        agent_id,
        &pending_entries,
    )
    .await?;
    // v0.9.6 需求6 F2：settle 后重发的 prompt 同样纳入分级看门狗（与 Idle
    // 直发一致，AwaitResponse 宽窗起）——滞留回合恢复后 pi 若再次无响应，
    // 兜底终结而非永挂。
    *turn_watchdog = Some((
        WatchdogPhase::AwaitResponse,
        tokio::time::Instant::now() + turn_watchdog_window(WatchdogPhase::AwaitResponse),
    ));
    *turn_prompt = Some(PromptRecord::new(seq, entries, false));
    Ok(())
}

// ---------------------------------------------------------------------------
// 会话前缀注入
// ---------------------------------------------------------------------------

/// prompt 发出前套上会话级的前缀注入（adapter 声明的 `ResolvedSessionPromptInjection`；
/// 首条消息、空闲直发、缓冲重发三处共用）。扩展命令不走这里——命令按用户原文
/// 交给引擎。
pub(crate) fn apply_resolved_session_prompt_injection(
    message: String,
    session_id: &str,
    injection: Option<&ResolvedSessionPromptInjection>,
) -> String {
    match injection {
        Some(injection) => injection.apply(&message, session_id),
        None => message,
    }
}

// ---------------------------------------------------------------------------
// 结构化错误前缀
// ---------------------------------------------------------------------------

/// 「交互卡已过期」的结构化错误前缀（v0.9.8 评审修复轮 R2 / C5）。前端按
/// 前缀撤卡，不再靠报错子串猜；前缀之后保留原句（按子串回退的旧前端仍可用）。
pub(crate) const ERR_INTERACTION_STALE: &str = "[interaction_stale]";
