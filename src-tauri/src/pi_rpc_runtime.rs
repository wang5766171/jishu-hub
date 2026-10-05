//! Pi native RPC protocol runtime (adapter for `--mode rpc`).
//!
//! 【§12 规模处置说明（v0.9.5 三轮评审 C13，拆分已执行）】本文件原 3900+
//! 行超 2500 红线，已按预案完成三段纯移动拆出（零逻辑变更）：
//! ①事件归一化 → [`normalize`]（normalize_pi_agent_event 与用量/压缩归因）；
//! ②问答卡协议翻译 → [`protocol`]（rpiv-ask 哨兵/多选还原/自动应答静态表）；
//! ③hub_invoke 分发 → [`hub_invoke`]（桥接命令与 HUB_APP_HANDLE）。
//! 主文件保留连接循环（LoopState 状态机 + 三看门狗 + 合批 flush——按 §12
//! 边界问强耦合状态机整体保留）与测试模块。子模块项经本文件根 `pub(crate)
//! use` 重导出，`crate::pi_rpc_runtime::X` 外部路径不变。
//!
//! Pi's RPC mode uses simple JSON-line commands/responses rather than
//! JSON-RPC 2.0. This module translates between Pi's native protocol
//! and the `AcpControl` / `NormalizedEvent` interfaces used by the GUI.
//!
//! Protocol:
//! - Commands (stdin):  `{"type":"prompt","message":"..."}`, `{"type":"abort"}`
//! - Responses (stdout): `{"type":"response","command":"prompt","success":true}`
//! - Events (stdout):   AgentEvent objects (`message_update`, `tool_execution_*`, …)

mod hub_invoke;
mod normalize;
mod protocol;

// 子模块项经根重导出：外部 `crate::pi_rpc_runtime::X` 路径与文件内 tests 的
// `super::X` 引用均保持拆分前形态（§12：原 pub 项经根 pub use 重导出）。
// allow：部分名字的消费面是 #[cfg(test)] tests 模块——lib check 时未编译。
#[allow(unused_imports)]
pub(crate) use hub_invoke::{handle_hub_invoke, HUB_APP_HANDLE};
#[allow(unused_imports)]
pub(crate) use normalize::{
    normalize_pi_agent_event, pi_compaction_record, pi_segment_usage, pi_turn_usage,
};
#[allow(unused_imports)]
pub(crate) use protocol::{
    convert_extension_ui_request, is_sentinel_option, migrate_auto_answer_key,
    rewrite_multiselect_input, rewrite_multiselect_response, rewrite_sentinel_response,
    strip_sentinel_option, take_interaction_auto_answer, PiToolApproval, INTERACTION_AUTO_ANSWER,
    INTERACTION_SENTINELS, MULTI_SELECT_REQUESTS, PROTOCOL_TABLE_LIMIT,
};

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::acp_runtime::{tauri_event_emitter, AcpCommand, AcpControl, AcpEventEmit};
use crate::agent::normalized::{
    interaction_requests_from_tool_call, InteractionDeliveryHint, InteractionOption,
    InteractionOrigin, InteractionTransport, NormalizedEvent, TurnEndReason, UsageStats,
};
use crate::agent::ResolvedSessionPromptInjection;
// v0.9.5 需求2 测试期：连接循环关键事实 → 前端日志中心（[runtime] 类别）。
use crate::dev_log_bridge::{dev_log_emitter, noop_dev_log_emitter, DevLogEmit};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Spawn the Pi RPC driver: starts Pi in `--mode rpc`, returns an
/// `AcpControl` that speaks Pi's native protocol internally.
pub fn spawn_pi_rpc_session(
    app: tauri::AppHandle,
    agent_id: String,
    pending_session_id: String,
    child: tokio::process::Child,
    _project_path: String,
    _requested_session_id: Option<String>,
    first_message: Option<String>,
    resolved_session_prompt_injection: Option<ResolvedSessionPromptInjection>,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    // v0.9.5 需求2 测试期：日志中心桥发射器需借用 app——先于 emitter 构造
    //（tauri_event_emitter 接收 app 所有权）。
    let devlog = dev_log_emitter(&app);
    let emit = tauri_event_emitter(app, agent_id.clone());
    // 需求1 A7：Hub 侧 thinking 档位偏好（state.json），spawn 时应用。
    let thinking_pref = crate::hub::load_agent_thinking_level(&agent_id);
    // 需求1 A3：Hub 侧自动压缩偏好，spawn 时应用。
    let auto_compaction_pref = crate::hub::load_agent_auto_compaction(&agent_id);
    spawn_pi_rpc_session_inner(
        emit,
        devlog,
        agent_id,
        pending_session_id,
        child,
        first_message,
        resolved_session_prompt_injection,
        thinking_pref,
        auto_compaction_pref,
        on_finish,
        on_session_resolved,
    )
}

/// Spawn a Pi RPC session with a custom event emitter (for orchestrator use).
/// The orchestrator has no `AppHandle`; it provides a callback that pushes
/// events into the streaming `InvocationHandle`.
#[allow(clippy::too_many_arguments)]
pub fn spawn_pi_rpc_session_with_emitter(
    emit: AcpEventEmit,
    agent_id: String,
    pending_session_id: String,
    child: tokio::process::Child,
    first_message: Option<String>,
    resolved_session_prompt_injection: Option<ResolvedSessionPromptInjection>,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    spawn_pi_rpc_session_inner(
        emit,
        // 编排器会话无 AppHandle——非 GUI 会话不进日志中心。
        noop_dev_log_emitter(),
        agent_id,
        pending_session_id,
        child,
        first_message,
        resolved_session_prompt_injection,
        // 编排器会话无 Hub 偏好上下文，跟随 Pi 自身默认。
        None,
        None,
        on_finish,
        on_session_resolved,
    )
}

#[allow(clippy::too_many_arguments)]
fn spawn_pi_rpc_session_inner(
    emit: AcpEventEmit,
    devlog: DevLogEmit,
    agent_id: String,
    pending_session_id: String,
    mut child: tokio::process::Child,
    first_message: Option<String>,
    resolved_session_prompt_injection: Option<ResolvedSessionPromptInjection>,
    thinking_pref: Option<String>,
    auto_compaction_pref: Option<bool>,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    // v0.9.5：watchdog 杀进程用 pid（child 的所有权在下方移入清理任务）。
    let child_pid = child.id();
    let stdin = child.stdin.take().expect("Pi RPC process must have stdin");
    let stdout = child
        .stdout
        .take()
        .expect("Pi RPC process must have stdout");
    let stderr = child.stderr.take();

    let stdin_arc = Arc::new(TokioMutex::new(stdin));
    let acp_session_id = Arc::new(std::sync::Mutex::new(None::<String>));
    // 四轮评审 P2-1：退出清扫需读 resolve 后的真实会话 id（原件 move 进
    // 连接循环，此处留一份给循环退出后的清扫路径）。
    let acp_session_id_for_cleanup = acp_session_id.clone();

    // Capture stderr for diagnostics
    let stderr_buf = Arc::new(TokioMutex::new(String::new()));
    if let Some(stderr_stream) = stderr {
        let stderr_buf_clone = stderr_buf.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr_stream).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::warn!("[pi-rpc stderr] {}", line);
                let mut buf = stderr_buf_clone.lock().await;
                buf.push_str(&line);
                buf.push('\n');
            }
        });
    }

    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(8);

    let control = AcpControl {
        tx: cmd_tx,
        acp_session_id: acp_session_id.clone(),
        supports_interaction_mid_turn: Arc::new(AtomicBool::new(true)),
        // v0.8.0 需求7：初始值随形态——常规形态连接建立即发首条 prompt
        // （true）；resume-fork 形态 first_message=None，停在 Idle 等待
        // ForkSession（false）。
        turn_active: Arc::new(AtomicBool::new(first_message.is_some())),
    };
    let control_clone = control.clone();
    let turn_active_for_loop = control.turn_active.clone();
    let turn_active_for_exit = control.turn_active.clone();

    tauri::async_runtime::spawn(async move {
        let result = pi_rpc_connection_loop(
            emit.clone(),
            devlog.clone(),
            agent_id.clone(),
            pending_session_id.clone(),
            stdin_arc,
            acp_session_id,
            stdout,
            cmd_rx,
            first_message,
            resolved_session_prompt_injection,
            thinking_pref,
            auto_compaction_pref,
            turn_active_for_loop,
            &on_session_resolved,
            child_pid,
        )
        .await;

        // 三轮评审 B2：会话连接退出——清扫本会话挂起的哨兵自动应答（未送达
        // 的追问 input 永不到，条目不再滞留；协议表其余两张按 request_id 键、
        // 由 PROTOCOL_TABLE_LIMIT 守卫）。四轮评审 P2-1：resolve 后登记键是
        // pi 真实 id（migrate_auto_answer_key 已随迁），真实 id 键一并清扫；
        // pending 键防御性同删（resolve 前退出时兜底）。
        {
            let real_id = acp_session_id_for_cleanup
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let mut reg = INTERACTION_AUTO_ANSWER
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            reg.remove(&pending_session_id);
            if let Some(real) = real_id {
                reg.remove(&real);
            }
        }

        if let Err(err) = &result {
            // Enrich error with stderr output
            let stderr_content = stderr_buf.lock().await.clone();
            let enriched_err = if !stderr_content.trim().is_empty() {
                let tail = if stderr_content.len() > 500 {
                    &stderr_content[stderr_content.len() - 500..]
                } else {
                    &stderr_content
                };
                // 三轮评审 P1-4 补漏：此 Err 经 NormalizedEvent::Error 直达界面，
                // 分隔行不得暴露内部引擎代号（Pi）。
                format!("{}\n--- 智能体引擎 stderr ---\n{}", err, tail.trim())
            } else {
                err.clone()
            };
            log::warn!("Pi RPC connection loop exited with error: {}", enriched_err);
            devlog(
                "error",
                "连接循环退出（异常——Error+TurnComplete 已发前端）",
                &pending_session_id,
                json!({ "error": enriched_err }),
            );
            let events = vec![
                NormalizedEvent::SessionResolved {
                    session_id: pending_session_id.clone(),
                },
                NormalizedEvent::Error {
                    message: enriched_err,
                    recoverable: false,
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Error,
                    usage: None,
                },
            ];
            emit(&events, &pending_session_id);
            on_session_resolved(&pending_session_id);
        } else {
            log::info!(
                "Pi RPC connection loop exited normally for session {}",
                pending_session_id
            );
            devlog(
                "info",
                "连接循环退出（正常路径——idle 回收/Shutdown/EOF/watchdog 杀进程，见上方 runtime 日志）",
                &pending_session_id,
                json!({}),
            );
        }

        // Ensure child exits
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => {
                log::info!("Pi RPC child exited with status: {}", status);
            }
            Ok(Err(e)) => log::warn!("Pi RPC child wait error: {}", e),
            Err(_) => {
                log::warn!("Pi RPC child did not exit in 5s, force-killing");
                let pid = child.id().unwrap_or(0);
                let _ = crate::process_control::terminate_process_tree(pid);
            }
        }

        // v0.8.0 需求7：循环已退出（正常或出错），回合必然不再进行。
        turn_active_for_exit.store(false, Ordering::Relaxed);

        on_finish();
    });

    control_clone
}

// ---------------------------------------------------------------------------
// Internal: connection loop
// ---------------------------------------------------------------------------

enum LoopState {
    Idle,
    Prompting,
    CancelPending { pending_prompt: Option<String> },
}

/// v0.9.5 需求2 测试期：prompt 回合启动 watchdog——prompt 发出后该时限内
/// 无任何 pi 事件（连 message_start 都没有）视为回合未启动（实测 01a0db68：
/// 消息不落盘、模型请求未发出、前端思考中 5.5 分钟）。事件到达即清零。
const PROMPT_ACK_TIMEOUT: Duration = Duration::from_secs(20);
/// CancelPending（abort 后）收尾 watchdog——pi 滞留时 agent_settled 永不到
///（停止不了的兜底）——超时杀进程终结流。
const CANCEL_SETTLE_TIMEOUT: Duration = Duration::from_secs(15);

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// 归一化事件合批的 flush 间隔上限。行驱动的 flush 检查（每条 stdout 行
/// 处理尾部）之外，buf 非空时以此间隔兜底：无输出长命令执行期间 pi 静默
/// 无新行，若只靠行驱动，ToolUseStart 会在 buf 里滞留整个执行期
///（需求4 打包卡事故：start 滞留 15 分钟才随命令结束的事件一起冲出）。
const EVENT_FLUSH_INTERVAL: Duration = Duration::from_millis(8);
/// 兜底 flush 触发时距上次 flush 超过此值 = 事件在静默期异常滞留，打
/// 日志中心 warn（正常合批静默放行，不刷屏）。
const EVENT_FLUSH_LAG_WARN: Duration = Duration::from_secs(1);

/// 需求8：get_state 握手总预算。原 30s 一刀切在「5 扩展包随装 + 大会话
/// resume」冷启动下不够（jiti 冷编译扩展/会话 JSONL 重放/lens 首跑扫描，
/// 用户实测 30s 超时后手动重发即成功——冷活在首进程后台已完成，第二进程
/// 秒连）。改为同进程等到底：总预算 150s，每 30s 打进度日志（stdout 保持
/// 打开即进程存活；真死亡走「stdout closed」路径即时报错）。
const PI_STATE_HANDSHAKE_BUDGET: Duration = Duration::from_secs(150);
/// 握手等待进度日志步长。
const PI_STATE_HANDSHAKE_LOG_STEP: Duration = Duration::from_secs(30);

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

#[allow(clippy::too_many_arguments)]
async fn pi_rpc_connection_loop(
    emit: AcpEventEmit,
    devlog: DevLogEmit,
    agent_id: String,
    pending_session_id: String,
    stdin_arc: Arc<TokioMutex<ChildStdin>>,
    acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    stdout: tokio::process::ChildStdout,
    mut command_rx: tokio::sync::mpsc::Receiver<AcpCommand>,
    first_message: Option<String>,
    resolved_session_prompt_injection: Option<ResolvedSessionPromptInjection>,
    thinking_pref: Option<String>,
    auto_compaction_pref: Option<bool>,
    turn_active: Arc<AtomicBool>,
    on_session_resolved: &(dyn Fn(&str) + Send + Sync),
    child_pid: Option<u32>,
) -> Result<(), String> {
    // 1. stdout reader sub-task
    let (stdout_tx, mut stdout_rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(stdout_reader(stdout, stdout_tx));

    // 2. Get session ID via get_state command
    send_pi_command(&stdin_arc, &json!({"type": "get_state"})).await?;

    // Read lines until we get the get_state response
    let mut context_window: Option<u64> = None;
    let mut initial_thinking_level: Option<String> = None;
    let mut initial_auto_compaction: Option<bool> = None;
    // v0.8.0 需求1 A5：fork 后进程重绑到分支会话，此变量随之更新——
    // 事件 envelope、prompt 注入、日志统一引用最新会话 id。
    // 需求8：预算制等待（见 PI_STATE_HANDSHAKE_BUDGET 注释）——同进程
    // 等到底，不杀进程不重发；期间每 30s 打 runtime 进度日志（日志中心
    // 可见「正在等什么」），stdout 关闭（进程死）仍即时失败。
    let handshake_deadline = tokio::time::Instant::now() + PI_STATE_HANDSHAKE_BUDGET;
    let mut handshake_next_log = tokio::time::Instant::now() + PI_STATE_HANDSHAKE_LOG_STEP;
    let mut session_id = loop {
        let remaining = handshake_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "智能体引擎启动超时（{}s）——扩展装载/会话恢复较慢，重发消息可恢复",
                PI_STATE_HANDSHAKE_BUDGET.as_secs()
            ));
        }
        // 三轮评审 C11：等待拆 30s 步进——静默期（无 stdout 行）也能按步打
        // 进度日志（修前进度检查在 recv 成功之后，静默挂起期日志中心零打
        // 点，「正在等什么」对用户不可见）。步进超时≠预算尽：打点后继续等。
        let wait_slice = remaining.min(PI_STATE_HANDSHAKE_LOG_STEP);
        let line = match tokio::time::timeout(wait_slice, stdout_rx.recv()).await {
            Ok(v) => {
                v.ok_or_else(|| "智能体引擎在启动期间意外退出（连接中断），请重试。".to_string())?
            }
            Err(_) => {
                // 步进到期（非总预算尽）——打进度日志继续等下一片。
                let waited = PI_STATE_HANDSHAKE_BUDGET
                    - handshake_deadline.saturating_duration_since(tokio::time::Instant::now());
                devlog(
                    "runtime",
                    "智能体引擎握手等待中（扩展装载/会话恢复冷启动可能较慢）",
                    &pending_session_id,
                    json!({ "waitedSecs": waited.as_secs(), "budgetSecs": PI_STATE_HANDSHAKE_BUDGET.as_secs() }),
                );
                handshake_next_log = tokio::time::Instant::now() + PI_STATE_HANDSHAKE_LOG_STEP;
                continue;
            }
        };

        if tokio::time::Instant::now() >= handshake_next_log {
            let waited = PI_STATE_HANDSHAKE_BUDGET - remaining;
            devlog(
                "runtime",
                "智能体引擎握手等待中（扩展装载/会话恢复冷启动可能较慢）",
                &pending_session_id,
                json!({ "waitedSecs": waited.as_secs(), "budgetSecs": PI_STATE_HANDSHAKE_BUDGET.as_secs() }),
            );
            handshake_next_log += PI_STATE_HANDSHAKE_LOG_STEP;
        }
        if line.trim().is_empty() {
            continue;
        }
        let msg: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue, // Skip non-JSON lines (startup diagnostics)
        };

        if is_pi_response(&msg, "get_state") {
            if msg.get("success").and_then(|v| v.as_bool()) == Some(true) {
                if let Some(sid) = msg
                    .get("data")
                    .and_then(|d| d.get("sessionId"))
                    .and_then(|v| v.as_str())
                {
                    // 需求2：捕获 model.contextWindow 作为水位百分比分母（缺失则仅显示绝对值）
                    context_window = msg
                        .get("data")
                        .and_then(|d| d.get("model"))
                        .and_then(|m| m.get("contextWindow"))
                        .and_then(|v| v.as_u64());
                    // 需求1 A7：捕获当前 thinking 级别作为 UI 初始值。
                    initial_thinking_level = msg
                        .get("data")
                        .and_then(|d| d.get("thinkingLevel"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    // 需求1 A3：捕获自动压缩当前值（Hub 偏好对齐用）。
                    initial_auto_compaction = msg
                        .get("data")
                        .and_then(|d| d.get("autoCompactionEnabled"))
                        .and_then(|v| v.as_bool());
                    break sid.to_string();
                }
            }
            // If get_state failed, proceed with pending ID
            break pending_session_id.clone();
        }
        // Ignore other events during initialization
    };

    log::info!(
        "Pi RPC session established: {} (pending: {})",
        session_id,
        pending_session_id
    );

    // Store session id
    {
        let mut guard = acp_session_id.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(session_id.clone());
    }
    // v0.9.5 四轮评审 P2-1（B2 收尾）：resolve（pending 幂等 id → pi 真实
    // id）时迁移挂起应答键——登记（chat.rs respond 传 resolve 后的 id）与
    // 消费（循环内 session_id）都用真实 id；不迁移则退出清扫的 pending 键
    // 与登记键不同源，新会话场景（两 id 不同）清扫恒 miss。
    migrate_auto_answer_key(&pending_session_id, &session_id);

    // Emit SessionResolved
    emit(
        &[NormalizedEvent::SessionResolved {
            session_id: session_id.clone(),
        }],
        &pending_session_id,
    );
    // 需求1 A7：应用 Hub 侧 thinking 档位偏好。与 Pi 当前值一致时直接上报
    // 当前值；不同则下发 set_thinking_level（Pi clamp 后经
    // thinking_level_changed 事件回传生效值，无需此处回退读取）。
    match (&thinking_pref, &initial_thinking_level) {
        (Some(pref), Some(current)) if pref == current => {
            emit(
                &[NormalizedEvent::ThinkingLevelChanged {
                    level: pref.clone(),
                }],
                &pending_session_id,
            );
        }
        (Some(pref), _) => {
            send_pi_command(
                &stdin_arc,
                &json!({
                    "type": "set_thinking_level",
                    "level": pref
                }),
            )
            .await?;
            log::debug!("Pi RPC applied hub thinking level at spawn: {pref}");
        }
        (None, Some(current)) => {
            emit(
                &[NormalizedEvent::ThinkingLevelChanged {
                    level: current.clone(),
                }],
                &pending_session_id,
            );
        }
        (None, None) => {}
    }
    // 需求1 A3：应用 Hub 侧自动压缩偏好（仅当与 Pi 当前值不同时发送）。
    if let Some(pref) = auto_compaction_pref {
        if Some(pref) != initial_auto_compaction {
            send_pi_command(
                &stdin_arc,
                &json!({
                    "type": "set_auto_compaction",
                    "enabled": pref
                }),
            )
            .await?;
            log::debug!("Pi RPC applied hub auto compaction at spawn: {pref}");
        }
    }
    on_session_resolved(&session_id);

    // v0.9.5 需求2 测试期 watchdog 状态（绝对时刻）：
    // - prompt_ack_at：prompt 发出后 20s 内未收到任何 pi 事件的判定线——
    //   事件到达（回合启动）即清零；回合启动后的间隙（模型慢）不再计时。
    // - cancel_settle_at：abort 进入 CancelPending 后 15s 未 agent_settled
    //   的判定线——杀进程终结（pi 滞留时 turn_end(Aborted) 永不到）。
    let mut prompt_ack_at: Option<tokio::time::Instant> = None;
    let mut cancel_settle_at: Option<tokio::time::Instant> = None;

    // 3. Send first prompt. v0.8.0 需求1 A5：resume-fork 形态传 None——不发
    // prompt，连接停在 Idle 等待 ForkSession（历史会话静默分支，零历史污染）。
    let mut state = LoopState::Idle;
    if let Some(first_message) = first_message {
        let first_message = apply_resolved_session_prompt_injection(
            first_message,
            &session_id,
            resolved_session_prompt_injection.as_ref(),
        );
        send_pi_command(
            &stdin_arc,
            &json!({"type": "prompt", "message": first_message}),
        )
        .await?;
        log::debug!("Pi RPC sent first prompt");
        prompt_ack_at = Some(tokio::time::Instant::now() + PROMPT_ACK_TIMEOUT);
        state = LoopState::Prompting;
    }
    // v0.8.0 需求10：经 Steer 命令注入的文本登记——用于区分 pi 回显的
    // message_start(role=user) 是真引导还是普通 prompt 送达。
    let mut steer_texts: Vec<String> = Vec::new();
    // 当前 pending 的 extension_ui_request id（select/input 等待用户响应时）。
    // abort 时用它发 cancelled response 释放 pi 的阻塞，否则 pi 卡在等响应、abort 推进不了。
    let mut pending_interaction_id: Option<String> = None;
    // v0.8.0 需求1 P-2：待回写的审批型 extension_ui（Delegate 弹窗路径）。
    let mut pending_tool_approvals: std::collections::HashMap<String, PiToolApproval> =
        std::collections::HashMap::new();
    let mut buf: Vec<NormalizedEvent> = Vec::with_capacity(32);
    let mut last_flush = std::time::Instant::now();
    // Track call IDs of interaction tools whose tool_execution_start was
    // suppressed (request_user_input, ask_user, etc.) so their matching
    // tool_execution_end can also be suppressed — preventing orphaned
    // tool_result blocks in the streaming content.
    let mut suppressed_interaction_calls: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    // PhaseDivider arrives during agent_end. Buffer it and inject it as the
    // first content event of the next phase run.
    let mut pending_phase_divider: Option<NormalizedEvent> = None;
    // Pi may run awaited agent_end handlers and queue another core run after the
    // final turn_end, so keep the GUI stream alive until agent_settled.
    let mut pending_turn_complete: Option<NormalizedEvent> = None;
    // 需求1 A3：进行中的 compact 请求回填通道（响应到达时 resolve IPC）。
    let mut pending_compact: Option<
        tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>,
    > = None;
    // 需求1 A5（v0.8.0）：fork 会话两段式回填。clone 响应不携带新会话 id，
    // 需再发一次 get_state 取 data.sessionId（clone → get_state → resolve IPC）。
    // 元组第一项标记已进入第二段（等待 get_state 响应）。
    let mut pending_fork: Option<(
        bool,
        tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>,
    )> = None;

    loop {
        // v0.8.0 需求7：每轮头部把回合真值同步到 AcpControl 共享标志——
        // 状态迁移都发生在 select 分支内，此处统一收口，避免逐点翻转移漏。
        // CancelPending 期间旧回合尚未收到 TurnComplete，仍算进行中。
        turn_active.store(!matches!(state, LoopState::Idle), Ordering::Relaxed);
        let cmd_future = command_rx.recv();
        let idle_deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;
        // v0.9.5 需求2 测试期：watchdog deadline（绝对时刻，事件到达清零——
        // 非每轮重算，防模型慢时误杀）。
        // 需求4 打包卡事故：buf 非空时把 flush 截止纳入 deadline——静默期
        // 无新行驱动行尾 flush 检查，事件最多滞留一个 flush 间隔即被
        // sleep 分支兜底发出。
        let flush_deadline = if buf.is_empty() {
            None
        } else {
            Some(tokio::time::Instant::from_std(last_flush) + EVENT_FLUSH_INTERVAL)
        };
        let next_deadline = [
            Some(idle_deadline),
            prompt_ack_at,
            cancel_settle_at,
            flush_deadline,
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(idle_deadline);

        let exit = tokio::select! {
            cmd = cmd_future => {
                match cmd {
                    Some(AcpCommand::Prompt(msg)) => {
                        log::info!("Pi RPC loop received Prompt command (state={})", loop_state_name(&state));
                        match &mut state {
                            LoopState::Idle => {
                                let msg = apply_resolved_session_prompt_injection(
                                    msg,
                                    &session_id,
                                    resolved_session_prompt_injection.as_ref(),
                                );
                                send_pi_command(&stdin_arc, &json!({
                                    "type": "prompt",
                                    "message": msg
                                })).await?;
                                log::info!("Pi RPC prompt sent to Pi ({} bytes)", msg.len());
                                prompt_ack_at = Some(tokio::time::Instant::now() + PROMPT_ACK_TIMEOUT);
                                state = LoopState::Prompting;
                                devlog(
                                    "info",
                                    "Prompt 直发 pi（Prompting，20s 看门狗武装）",
                                    &session_id,
                                    json!({ "bytes": msg.len() }),
                                );
                            }
                            LoopState::Prompting => {
                                // v0.9.5 需求2 测试期（会话 01a0d868 实证）：GUI 仅在
                                // 自认空闲时发新消息（isStreaming 时前端走暂存/引导，不
                                // 发 Prompt），此刻仍 Prompting = 循环视图滞留——settle
                                // 后晚到的 agent_start 把 Idle 翻回 Prompting（无内容的
                                // 生命周期事件），或滞留回合的模型流挂死。原「静默忽略」
                                // = 用户消息丢失 + GUI 永等（turn 2 发「继续」后零事件）。
                                // 改按「停止后重发」语义收口：取消滞留回合（含 pending
                                // extension_ui 释放，abort 打断不了它的等待），本条消息进
                                // pending_prompt，settle 后由 CancelPending 通道送达；pi
                                // 无响应时 cancel watchdog 15s 杀进程兜底。
                                log::warn!(
                                    "Pi RPC prompt in Prompting state — aborting stale turn and resending"
                                );
                                if let Some(id) = pending_interaction_id.take() {
                                    let _ = send_pi_command(&stdin_arc, &json!({
                                        "type": "extension_ui_response",
                                        "id": id,
                                        "cancelled": true
                                    })).await;
                                }
                                pending_turn_complete = Some(NormalizedEvent::TurnComplete {
                                    reason: TurnEndReason::Aborted,
                                    usage: None,
                                });
                                let _ = send_pi_command(&stdin_arc, &json!({
                                    "type": "clear_queue"
                                })).await;
                                let _ = send_pi_command(&stdin_arc, &json!({
                                    "type": "abort"
                                })).await;
                                // v0.9.5 三轮评审 P1-1：同 GUI 停止路径——进入
                                // CancelPending 解除 prompt 看门狗（互斥，防双闹钟
                                // 竞速时 ack 先检查误报失联并丢弃缓冲消息）。
                                prompt_ack_at = None;
                                cancel_settle_at =
                                    Some(tokio::time::Instant::now() + CANCEL_SETTLE_TIMEOUT);
                                state = LoopState::CancelPending {
                                    pending_prompt: Some(msg),
                                };
                                devlog(
                                    "warn",
                                    "Prompting 态收到 Prompt：滞留回合取消重发（clear_queue+abort，消息缓冲，15s 收口看门狗）",
                                    &session_id,
                                    json!({}),
                                );
                            }
                            LoopState::CancelPending { pending_prompt } => {
                                log::warn!("Pi RPC prompt buffered: still CancelPending (awaiting agent_settled after abort)");
                                // 三轮评审 C12：已有缓冲消息时拼接保留（\n 分隔）——
                                // 修前静默覆盖丢前一条（编排器路径可触发：取消
                                // 善中期连续派发多条）。拼接送达与 GUI 暂存多条
                                // 合并发送同构。
                                *pending_prompt = Some(match pending_prompt.take() {
                                    Some(prev) => {
                                        devlog(
                                            "warn",
                                            "CancelPending 态已缓冲一条，新消息拼接保留（不覆盖丢弃）",
                                            &session_id,
                                            json!({ "prevBytes": prev.len(), "newBytes": msg.len() }),
                                        );
                                        format!("{prev}\n{msg}")
                                    }
                                    None => msg,
                                });
                                devlog(
                                    "warn",
                                    "CancelPending 态收到 Prompt：缓冲，settle 后送达",
                                    &session_id,
                                    json!({}),
                                );
                            }
                        }
                        false
                    }
                    Some(AcpCommand::Steer(msg)) => {
                        // Pi RPC native steer: inject text into the current turn.
                        // The agent considers it while continuing — no turn restart.
                        steer_texts.push(msg.clone());
                        send_pi_command(&stdin_arc, &json!({
                            "type": "steer",
                            "message": msg
                        })).await?;
                        log::debug!("Pi RPC steer sent");
                        false
                    }
                    Some(AcpCommand::SetThinkingLevel(level)) => {
                        // 需求1 A7：Pi 原生 set_thinking_level。Pi 会把请求值
                        // clamp 到当前模型支持的档位并持久化为默认级别，随后广播
                        // thinking_level_changed 事件（归一化后回传生效值）。
                        send_pi_command(&stdin_arc, &json!({
                            "type": "set_thinking_level",
                            "level": level
                        })).await?;
                        log::debug!("Pi RPC set_thinking_level sent: {level}");
                        false
                    }
                    Some(AcpCommand::Compact { instructions, response }) => {
                        // 需求1 A3：手动压缩。Pi 压缩期间排队消息、完成后经
                        // compact 响应回填结果（见 stdout 分支）。
                        let mut payload = json!({ "type": "compact" });
                        if let Some(instr) = instructions {
                            payload["customInstructions"] = json!(instr);
                        }
                        send_pi_command(&stdin_arc, &payload).await?;
                        pending_compact = Some(response);
                        log::info!("Pi RPC compact requested");
                        false
                    }
                    Some(AcpCommand::SetAutoCompaction {
                        enabled,
                        threshold_percent,
                    }) => {
                        // 需求1 A3 + v0.8.0 需求9 收尾：自动压缩开关/阈值热推
                        // （fire-and-forget；两字段均可选，只发送出现的字段）。
                        let mut payload = serde_json::Map::new();
                        payload.insert("type".into(), json!("set_auto_compaction"));
                        if let Some(enabled) = enabled {
                            payload.insert("enabled".into(), json!(enabled));
                        }
                        if let Some(threshold) = threshold_percent {
                            payload.insert("thresholdPercent".into(), json!(threshold));
                        }
                        send_pi_command(&stdin_arc, &serde_json::Value::Object(payload)).await?;
                        log::debug!(
                            "Pi RPC set_auto_compaction sent: enabled={enabled:?}, threshold={threshold_percent:?}"
                        );
                        false
                    }
                    Some(AcpCommand::ForkSession { response }) => {
                        // 需求1 A5（v0.8.0）：从当前会话末尾创建分支。Pi 的 clone
                        // 复制整棵会话树到新分支文件并重绑本进程；新会话 id 经随后
                        // 的 get_state 响应回填（见 stdout 分支）。原会话文件保留。
                        // 流式期间禁止（重绑与流式事件竞态）——IPC 层前置校验，
                        // 此处再挡一道。
                        if matches!(state, LoopState::Idle) {
                            send_pi_command(&stdin_arc, &json!({ "type": "clone" })).await?;
                            pending_fork = Some((false, response));
                            log::info!("Pi RPC clone requested for session {}", session_id);
                        } else {
                            let _ = response.send(Err(
                                "Cannot fork while the session is streaming — wait for the turn to finish".to_string(),
                            ));
                        }
                        false
                    }
                    Some(AcpCommand::Cancel) => {
                        // 若有 pending extension_ui（select/input 阻塞等响应），先发 cancelled
                        // response 释放 pi 的 Promise，否则 pi 卡在 await、abort 推进不了
                        //（pi 的 abort 打断 LLM 生成，但打断不了 in-flight extension_ui 等待）。
                        if let Some(id) = pending_interaction_id.take() {
                            let _ = send_pi_command(&stdin_arc, &json!({
                                "type": "extension_ui_response",
                                "id": id,
                                "cancelled": true
                            })).await;
                            log::info!(
                                "Pi RPC cancel: sent cancelled extension_ui_response for id={}",
                                id
                            );
                        }
                        match &state {
                            LoopState::Prompting => {
                                pending_turn_complete = Some(NormalizedEvent::TurnComplete {
                                    reason: TurnEndReason::Aborted,
                                    usage: None,
                                });
                                // v0.9.1 需求3 #1：pi 的 abort 会继续执行残留的排队
                                // 消息（rpc.md），hub 停止语义为「作废」——先清空
                                // 队列再 abort；被清空的文本经 clear_queue 响应回传
                                // GUI 回填输入框（响应分支发 SteerQueueCleared）。
                                let _ = send_pi_command(&stdin_arc, &json!({
                                    "type": "clear_queue"
                                })).await;
                                let _ = send_pi_command(&stdin_arc, &json!({
                                    "type": "abort"
                                })).await;
                                log::info!("Pi RPC cancel sent (clear_queue + abort)");
                                // v0.9.5 三轮评审 P1-1：进入停止善中即解除 prompt
                                // 看门狗——两看门狗互斥（ack 只武装于 Idle/Prompting
                                // 的「等回合启动」，CancelPending 的兜底职责归
                                // settle 看门狗），否则停止后 20s 误报「pi 未响应」。
                                prompt_ack_at = None;
                                cancel_settle_at =
                                    Some(tokio::time::Instant::now() + CANCEL_SETTLE_TIMEOUT);
                                state = LoopState::CancelPending {
                                    pending_prompt: None,
                                };
                            }
                            LoopState::CancelPending { .. } => {
                                pending_turn_complete = Some(NormalizedEvent::TurnComplete {
                                    reason: TurnEndReason::Aborted,
                                    usage: None,
                                });
                            }
                            LoopState::Idle => {}
                        }
                        false
                    }
                    Some(AcpCommand::RespondToInput { id, value, response }) => {
                        // Respond to a Pi extension_ui_request (planning-phase
                        // pause-resume). Pi is blocked waiting for this response.
                        let result = send_pi_command(&stdin_arc, &json!({
                            "type": "extension_ui_response",
                            "id": id,
                            "value": value
                        })).await;
                        match &result {
                            Ok(()) => log::debug!("Pi RPC extension_ui_response sent for id={}", id),
                            Err(error) => log::error!(
                                "Pi RPC extension_ui_response write failed for id={}: {error}",
                                id
                            ),
                        }
                        // Only the matching response resolves the tracked request.
                        if pending_interaction_id.as_deref() == Some(id.as_str()) {
                            pending_interaction_id = None;
                        }
                        // Report the write-back outcome (R6: authoritative delivery).
                        let _ = response.send(result);
                        false
                    }
                    Some(AcpCommand::ResolvePermission { request_id, approved, response }) => {
                        // v0.8.0 需求1 P-2：审批型 extension_ui 的用户裁决回写
                        // （此前 Pi 无审批通道，此分支恒报错）。
                        let result = match pending_tool_approvals.remove(&request_id) {
                            Some(_approval) => {
                                let _ = send_pi_command(
                                    &stdin_arc,
                                    &json!({
                                        "type": "extension_ui_response",
                                        "id": request_id,
                                        "confirmed": approved
                                    }),
                                )
                                .await;
                                log::info!(
                                    "Pi tool approval resolved: approved={approved} (session {session_id})"
                                );
                                Ok(())
                            }
                            None => Err(format!(
                                "No pending Pi tool approval for request {request_id}"
                            )),
                        };
                        let _ = response.send(result);
                        false
                    }
                    Some(AcpCommand::Shutdown) => {
                        log::info!("Pi RPC shutdown requested for session {}", session_id);
                        true
                    }
                    None => {
                        log::info!("Pi RPC command channel closed for session {}", session_id);
                        true
                    }
                }
            }
            line = stdout_rx.recv() => {
                match line {
                    Some(line) => {
                        if line.trim().is_empty() { continue; }
                        let msg: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };

                        // Handle RPC responses
                        if let Some(cmd) = msg.get("type").and_then(|v| v.as_str()) {
                            if cmd == "response" {
                                let response_cmd = msg.get("command").and_then(|v| v.as_str()).unwrap_or_default();
                                let success = msg.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                                // v0.9.5 三轮评审 P1-1：response 到达（无论成败）=
                                // pi 活着且已处理请求——解除 prompt 看门狗（事件类
                                // 消息在下方统一清，response 不走那条路）。失败路径
                                // 若不清：Error+TurnComplete 已发、state=Idle 后 20s
                                // 看门狗仍会误触发一次「pi 未响应本轮」。
                                prompt_ack_at = None;

                                match response_cmd {
                                    "prompt" | "steer" | "follow_up" => {
                                        if success {
                                            // Prompt accepted, events will follow
                                            log::info!("Pi RPC response for {}: success=true", response_cmd);
                                            if response_cmd == "prompt" {
                                                devlog(
                                                    "info",
                                                    "pi 受理 prompt（response success，等待回合启动）",
                                                    &session_id,
                                                    json!({}),
                                                );
                                            }
                                        } else {
                                            log::error!("Pi RPC response for {}: success=false", response_cmd);
                                            let err_msg = msg
                                                .get("error")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("Unknown prompt error");

                                            buf.push(NormalizedEvent::Error {
                                                message: err_msg.to_string(),
                                                recoverable: false,
                                            });
                                            buf.push(NormalizedEvent::TurnComplete {
                                                reason: TurnEndReason::Error,
                                                usage: None,
                                            });
                                            flush_buf(&emit, &session_id, &mut buf);

                                            state = LoopState::Idle;
                                            // v0.9.5 三轮评审 P1-1：失败已终结名单
                                            // （Error+TurnComplete 已发），跳过下方通用
                                            // !success 检查——否则同一失败报两次错。
                                            continue;
                                        }
                                    }
                                    "abort" => {
                                        log::info!("Pi RPC abort acknowledged");
                                        // session.abort() responds after awaited agent_end
                                        // handlers and emits agent_settled, which owns final
                                        // completion and the local Idle transition.
                                        continue;
                                    }
                                    "clear_queue" => {
                                        // v0.9.1 需求3 #1：停止前清队的响应——
                                        // 排队文本回传 GUI；空队列不发事件（无排队
                                        // 消息的停止零噪声）。v0.9.4 需求7：分组回传
                                        // ——steering（用户引导）与 followUp（普通
                                        // 排队）分开，前端对 steering 自动重发、
                                        // followUp 回填输入框。
                                        if success {
                                            let collect = |key: &str| -> Vec<String> {
                                                let mut out: Vec<String> = Vec::new();
                                                if let Some(arr) = msg
                                                    .get("data")
                                                    .and_then(|d| d.get(key))
                                                    .and_then(|v| v.as_array())
                                                {
                                                    for item in arr {
                                                        if let Some(text) = item.as_str() {
                                                            if !text.trim().is_empty() {
                                                                out.push(text.to_string());
                                                            }
                                                        }
                                                    }
                                                }
                                                out
                                            };
                                            let steering = collect("steering");
                                            let follow_ups = collect("followUp");
                                            // texts 保持「全部被清文本」语义（先
                                            // steering 后 followUp，与旧合并序一致）。
                                            let mut texts = steering.clone();
                                            texts.extend(follow_ups.iter().cloned());
                                            if !texts.is_empty() {
                                                log::info!(
                                                    "Pi RPC clear_queue: {} 条排队消息回传（steering {} / followUp {}）",
                                                    texts.len(),
                                                    steering.len(),
                                                    follow_ups.len()
                                                );
                                                buf.push(NormalizedEvent::SteerQueueCleared {
                                                    texts,
                                                    follow_up_texts: follow_ups,
                                                });
                                                flush_buf(&emit, &session_id, &mut buf);
                                            }
                                        }
                                        continue;
                                    }
                                    "compact" => {
                                        // 需求1 A3：压缩完成/失败——回填 IPC（不进
                                        // 通用 error 分支，避免误发 TurnComplete）。
                                        if let Some(tx) = pending_compact.take() {
                                            let result = if success {
                                                Ok(msg
                                                    .get("data")
                                                    .cloned()
                                                    .unwrap_or(serde_json::Value::Null))
                                            } else {
                                                Err(msg
                                                    .get("error")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("compaction failed")
                                                    .to_string())
                                            };
                                            let _ = tx.send(result);
                                        }
                                        continue;
                                    }
                                    "clone" => {
                                        // 需求1 A5（v0.8.0）：clone 完成/失败。成功后
                                        // 进程已重绑到分支会话，再发 get_state 取新
                                        // 会话 id（不进通用 error 分支）。
                                        if let Some((_, tx)) = pending_fork.take() {
                                            if success {
                                                send_pi_command(
                                                    &stdin_arc,
                                                    &json!({"type": "get_state"}),
                                                )
                                                .await?;
                                                pending_fork = Some((true, tx));
                                                log::info!("Pi RPC clone succeeded, resolving branch session id");
                                            } else {
                                                let err = msg
                                                    .get("error")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("fork failed");
                                                let _ = tx.send(Err(err.to_string()));
                                            }
                                        }
                                        continue;
                                    }
                                    "get_state" => {
                                        // 需求1 A5（v0.8.0）：fork 第二段——clone 后的
                                        // get_state 响应携带分支会话 id。进程重绑后，
                                        // 后续事件 envelope 全部切换为新 id。
                                        if let Some((_, tx)) = pending_fork.take() {
                                            let branch_id = msg
                                                .get("data")
                                                .and_then(|d| d.get("sessionId"))
                                                .and_then(|v| v.as_str());
                                            match branch_id {
                                                Some(new_id) => {
                                                    session_id = new_id.to_string();
                                                    {
                                                        let mut guard = acp_session_id
                                                            .lock()
                                                            .unwrap_or_else(|e| e.into_inner());
                                                        *guard = Some(new_id.to_string());
                                                    }
                                                    log::info!(
                                                        "Pi RPC forked session; process rebound to {}",
                                                        new_id
                                                    );
                                                    let _ = tx.send(Ok(json!({
                                                        "new_session_id": new_id
                                                    })));
                                                }
                                                None => {
                                                    let _ = tx.send(Err(
                                                        "fork succeeded but branch session id is unknown"
                                                            .to_string(),
                                                    ));
                                                }
                                            }
                                            continue;
                                        }
                                        // 非 fork 期间的 get_state 响应：落入通用处理
                                        //（与原先 `_` 分支行为一致）。
                                    }
                                    _ => {
                                        // Other responses (set_model, etc.) - ignore
                                    }
                                }

                                // Check for error responses
                                if !success {
                                    let error_msg = msg.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown Pi RPC error");
                                    log::warn!("Pi RPC error response for {}: {}", response_cmd, error_msg);
                                    buf.push(NormalizedEvent::Error {
                                        message: error_msg.to_string(),
                                        recoverable: false,
                                    });
                                    buf.push(NormalizedEvent::TurnComplete {
                                        reason: TurnEndReason::Error,
                                        usage: None,
                                    });
                                    flush_buf(&emit, &session_id, &mut buf);
                                    state = LoopState::Idle;
                                    continue;
                                }

                                // Periodic flush
                                if buf.len() >= 32
                                    || last_flush.elapsed() >= EVENT_FLUSH_INTERVAL
                                {
                                    flush_buf(&emit, &session_id, &mut buf);
                                    last_flush = std::time::Instant::now();
                                }
                                continue;
                            }
                        }

                        // Handle extension_ui_request (Pi planning-phase pause-resume).
                        // Pi emits this when the LLM calls a tool that triggers
                        // extension_ui (e.g., request_user_input). The Hub converts
                        // it to an InteractionRequest; the user responds via
                        // AcpCommand::RespondToInput → extension_ui_response.
                        if msg.get("type").and_then(|v| v.as_str()) == Some("extension_ui_request") {
                            // ── hub_invoke 桥接（Phase 2）：扩展通过 select 编码调 Hub 后端命令 ──
                            // Pi 扩展 API 无通用 invoke，复用 select 通道：
                            // title 以 "\x00hub_invoke:" 开头时，Hub 直接执行命令并响应，不经过前端。
                            let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
                            let title = msg.get("title").and_then(|v| v.as_str()).unwrap_or("");

                            // ── v0.8.0 需求1 P-2：审批型 confirm（jishu-tool-approval
                            // 扩展）。标题格式 "[jishu-tool-approval]<mode>|<tool>"。
                            // 先过策略链（Phase 2 挂载点的 Pi 版）：Allow/Deny 直接
                            // extension_ui_response 回写；Delegate 转 ApprovalRequest
                            // 走前端审批弹窗（复用 resolve_chat_permission 回写路径）。
                            if method == "confirm" && title.starts_with("[jishu-tool-approval") {
                                let request_id = msg
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let meta = title
                                    .strip_prefix("[jishu-tool-approval]")
                                    .unwrap_or("");
                                let (_mode, tool) = meta.split_once('|').unwrap_or(("", meta));
                                let message = msg
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                // 档位选链（v0.8.1 修复：完全访问模式仍弹审批窗）：
                                // 权威档位是 hub 侧 per-agent 工具档（前端访问菜单写入
                                // hub state，并联动同步 Pi settings），扩展标题里回传的
                                // mode 只是参考显示——此前按标题 mode 二分
                                // ask_always/其它，完全访问（full）落进智能链导致
                                // 插件 bash 仍弹审批。统一走 for_session_tool_mode：
                                // full→[AlwaysAllow]、full-approve/readonly→[LowRisk]、
                                // smart-approve→[Once, LowRisk]。
                                let hub_mode = crate::hub::load_agent_tool_mode(&agent_id)
                                    .unwrap_or_else(|| "full".to_string());
                                let approval_ctx = crate::agent::policy::ApprovalContext {
                                    channel: crate::agent::policy::DecisionChannel::Interactive,
                                    kind: crate::agent::policy::ApprovalKindWire::Other,
                                    session_id: session_id.clone(),
                                    tool: Some(tool.to_string()),
                                    payload: serde_json::json!({
                                        "tool": tool,
                                        "summary": message,
                                        "mode": hub_mode,
                                    }),
                                    payload_declares: false,
                                    high_risk: false,
                                };
                                let approval_chain =
                                    crate::agent::policy::for_session_tool_mode(&agent_id, &session_id);
                                match approval_chain.evaluate(&approval_ctx) {
                                    crate::agent::policy::ChainOutcome::Allow(policy_id) => {
                                        let _ = send_pi_command(
                                            &stdin_arc,
                                            &json!({
                                                "type": "extension_ui_response",
                                                "id": request_id,
                                                "confirmed": true
                                            }),
                                        )
                                        .await;
                                        log::info!(
                                            "Pi tool approval auto-allowed by policy {policy_id} (session {session_id})"
                                        );
                                    }
                                    crate::agent::policy::ChainOutcome::Deny(policy_id) => {
                                        let _ = send_pi_command(
                                            &stdin_arc,
                                            &json!({
                                                "type": "extension_ui_response",
                                                "id": request_id,
                                                "confirmed": false
                                            }),
                                        )
                                        .await;
                                        log::info!(
                                            "Pi tool approval auto-denied by policy {policy_id} (session {session_id})"
                                        );
                                    }
                                    crate::agent::policy::ChainOutcome::Delegate => {
                                        // 登记待审批表（ResolvePermission 回写用）并
                                        // 转标准 ApprovalRequest 事件给前端弹窗；
                                        // 到达上下文按 request_id 登记——「始终允许」
                                        // 取回同形状回写 Once 记忆（见 chat.rs）。
                                        crate::agent::policy::register_arrival_context(
                                            &request_id,
                                            &approval_ctx,
                                        );
                                        pending_tool_approvals
                                            .insert(request_id.clone(), PiToolApproval);
                                        buf.push(NormalizedEvent::ApprovalRequest {
                                            request_id,
                                            // 审批类型按工具名分类（bash→命令执行，
                                            // write/edit→文件写入），弹窗显示正确类型。
                                            approval_kind:
                                                crate::agent::normalized::ApprovalKind::for_tool(tool),
                                            payload: serde_json::json!({
                                                "tool": tool,
                                                "summary": message,
                                                "mode": hub_mode,
                                                "origin": "jishu-tool-approval",
                                            }),
                                        });
                                        flush_buf(&emit, &session_id, &mut buf);
                                        last_flush = std::time::Instant::now();
                                    }
                                }
                                continue;
                            }

                            if method == "select" && title.starts_with("\x00hub_invoke:") {
                                let payload_str = title
                                    .strip_prefix("\x00hub_invoke:")
                                    .unwrap_or("{}");
                                let request_id = msg
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let payload: serde_json::Value = serde_json::from_str(payload_str)
                                    .unwrap_or_else(|_| serde_json::json!({}));
                                let command = payload
                                    .get("command")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let params = payload
                                    .get("params")
                                    .cloned()
                                    .unwrap_or_else(|| serde_json::json!({}));
                                let result = handle_hub_invoke(command, &params);
                                let response_value = match result {
                                    Ok(data) => serde_json::json!({
                                        "type": "extension_ui_response",
                                        "id": request_id,
                                        "value": serde_json::json!({ "success": true, "data": data }).to_string()
                                    }),
                                    Err(err) => serde_json::json!({
                                        "type": "extension_ui_response",
                                        "id": request_id,
                                        "value": serde_json::json!({ "success": false, "error": err }).to_string()
                                    }),
                                };
                                let _ = send_pi_command(&stdin_arc, &response_value).await;
                                continue;
                            }

                            log::info!(
                                "[tool-visibility] extension_ui_request method={} id={}",
                                msg.get("method").and_then(|v| v.as_str()).unwrap_or("?"),
                                msg.get("id").and_then(|v| v.as_str()).unwrap_or("?"),
                            );
                            // v0.9.5 需求5 测试期 T1：rpiv-ask 哨兵行适配——select
                            // 末项为 "N. Type something." 时剥离（自定义入口收敛
                            // 到 hub 卡片自带「其他」），登记 request_id→哨兵原文
                            //（respond_chat_interaction 应答改写用）。
                            // T1 + T5：先做 select 哨兵剥离与 input 多选题还原
                            //（多选题还原把 method 改写为 multiSelect，须在下方
                            // 哨兵追问自动应答的 input 判定之前）。
                            let msg = rewrite_multiselect_input(strip_sentinel_option(msg));
                            // T1：哨兵追问的 input 到达且本会话挂有自动应答文本
                            // → 幕后直接回填，不转发前端（用户一次输入直接生效，
                            // 扩展收到合法的「哨兵→input 文本」两步协议）。
                            if msg.get("method").and_then(|v| v.as_str()) == Some("input") {
                                let auto_answer = take_interaction_auto_answer(&session_id);
                                if let Some(text) = auto_answer {
                                    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                    log::info!(
                                        "[pi-ext] sentinel follow-up auto-answered (session {session_id}, id {id})"
                                    );
                                    let _ = send_pi_command(
                                        &stdin_arc,
                                        &json!({
                                            "type": "extension_ui_response",
                                            "id": id,
                                            "value": text
                                        }),
                                    )
                                    .await;
                                    continue;
                                }
                            }
                            if let Some(event) = convert_extension_ui_request(&msg) {
                                // Track only requests that actually wait for a response.
                                if matches!(event, NormalizedEvent::InteractionRequest { .. }) {
                                    if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                                        pending_interaction_id = Some(id.to_string());
                                    }
                                }
                                // PhaseDivider arrives during agent_end and belongs at
                                // the beginning of the next phase run.
                                if matches!(event, NormalizedEvent::PhaseDivider { .. }) {
                                    pending_phase_divider = Some(event);
                                } else {
                                    buf.push(event);
                                    flush_buf(&emit, &session_id, &mut buf);
                                    last_flush = std::time::Instant::now();
                                }
                            }
                            continue;
                        }

                        // Handle AgentEvent objects.
                        let event_type = msg
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let events = normalize_pi_agent_event(&msg, context_window, &mut steer_texts);

                        // v0.8.0 需求10：回合用量按【分段】入 SQLite（记录类
                        // 数据优先 SQLite 的开发原则）。pi 的 turn_end 每个生成
                        // 分段都携带 usage——工具循环的中间段以 toolUse 停止、
                        // 不发 TurnComplete，按 TurnComplete 记账会漏掉这些分段
                        // 的生成量（长文分段写文件场景尤甚），故在分段级记账；
                        // 同时按消息内容块归因（思考/文本/内置工具/MCP/工具结果，
                        // 估算口径见 usage_store）。
                        if event_type == "turn_end" {
                            if let Some(seg) = pi_segment_usage(&msg, context_window) {
                                crate::usage_store::record_segment(
                                    &agent_id,
                                    &session_id,
                                    &seg,
                                );
                            }
                        }

                        // v0.8.0 需求10：压缩事件入 usage_compaction 表（压缩
                        // 前后规模 + firstKeptEntryId 数据定位 + 摘要调用开销
                        // 并入总量），为后续会话索引等能力提供数据支撑。
                        if event_type == "compaction_end" {
                            crate::usage_store::record_compaction(
                                &agent_id,
                                &session_id,
                                &pi_compaction_record(&msg),
                            );
                        }

                        // v0.9.5：任何 pi 事件到达 = pi 活着且（若在）回合已启动
                        // ——清 prompt watchdog（回合启动后不再计时，防模型慢误杀）。
                        prompt_ack_at = None;
                        if matches!(event_type, "agent_start" | "turn_start")
                            && !matches!(state, LoopState::CancelPending { .. })
                        {
                            // v0.9.5 需求2 测试期：settle 后晚到的 agent_start 会把
                            // Idle 翻回 Prompting（01a0d868 事故「路径 A」的签名）——
                            // 此后无事件的 Prompting 是看门狗盲区。仅在翻转发生时
                            // 打点（Prompting 内的常规 agent_start 不记，防噪声）。
                            if matches!(state, LoopState::Idle) {
                                devlog(
                                    "info",
                                    "回合启动（Idle→Prompting 翻转）",
                                    &session_id,
                                    json!({ "event": event_type }),
                                );
                            }
                            state = LoopState::Prompting;
                        }

                        // 需求4 打包卡事故取证锚点：pi 事件到达 hub 的时刻进
                        // 日志中心（[runtime]）。与前端 pipeline 的
                        // "chunk tool_use_start" 对表——差值即归一化/转发链
                        // 滞留；前端未见而此处已见 = 事件在 hub→前端链路丢失。
                        if event_type == "tool_execution_start" {
                            devlog(
                                "info",
                                "pi 事件到达 hub：tool_execution_start",
                                &session_id,
                                json!({
                                    "call_id": msg.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("?"),
                                    "tool": msg.get("toolName").and_then(|v| v.as_str()).unwrap_or("?"),
                                }),
                            );
                        }

                        // Track interaction tool call IDs: when tool_execution_start
                        // returns empty events for an interaction tool (request_user_input,
                        // ask_user, etc.), record the call_id so we can suppress the
                        // matching tool_execution_end later.
                        if event_type == "tool_execution_start" && events.is_empty() {
                            if let Some(call_id) = msg.get("toolCallId").and_then(|v| v.as_str()) {
                                suppressed_interaction_calls.insert(call_id.to_string());
                            }
                        }

                        // Suppress tool_execution_end for interaction tools whose
                        // start was also suppressed.
                        let mut events: Vec<NormalizedEvent> = if event_type == "tool_execution_end" {
                            if let Some(call_id) = msg.get("toolCallId").and_then(|v| v.as_str()) {
                                if suppressed_interaction_calls.remove(call_id) {
                                    vec![]
                                } else {
                                    events
                                }
                            } else {
                                events
                            }
                        } else {
                            events
                        };

                        // A final turn_end is only a candidate completion. Pi still
                        // awaits agent_end extension handlers, which may ask the user
                        // a question or enqueue the next conductor phase.
                        if let Some(index) = events
                            .iter()
                            .position(|event| matches!(event, NormalizedEvent::TurnComplete { .. }))
                        {
                            pending_turn_complete = Some(events.remove(index));
                        }

                        // An explicit phase-enter marker supersedes the setStatus
                        // fallback buffered during the preceding agent_end.
                        if events
                            .iter()
                            .any(|event| matches!(event, NormalizedEvent::PhaseDivider { .. }))
                        {
                            pending_phase_divider = None;
                        }

                        // Inject pending PhaseDivider as the first content event of a new run.
                        let has_content = events.iter().any(|e| {
                            matches!(e,
                                NormalizedEvent::TextDelta { .. }
                                | NormalizedEvent::Thinking { .. }
                                | NormalizedEvent::Message { .. }
                            )
                        });
                        if has_content {
                            if let Some(divider) = pending_phase_divider.take() {
                                buf.push(divider);
                            }
                        }

                        buf.extend(events);

                        if event_type == "agent_end" {
                            // v0.80.10 emits agent_settled only after retries,
                            // compaction recovery, and queued continuations are exhausted.
                            // agent_end is therefore a per-core-run boundary only.
                            flush_buf(&emit, &session_id, &mut buf);
                            last_flush = std::time::Instant::now();
                        } else if pi_prompt_is_settled(event_type) {
                            log::info!("Pi RPC agent_settled received (state={})", loop_state_name(&state));
                            cancel_settle_at = None;
                            if matches!(state, LoopState::CancelPending { .. }) {
                                pending_turn_complete = Some(NormalizedEvent::TurnComplete {
                                    reason: TurnEndReason::Aborted,
                                    usage: None,
                                });
                            }
                            // Settle fallback (B2.5 T3 / issue R4).
                            //
                            // `agent_settled` owns final completion, but it can only
                            // forward a TurnComplete that some earlier `turn_end`
                            // produced.  When a tool returns `terminate: true` the
                            // agent stops *inside* the tool turn, so that final
                            // `turn_end` carries `stopReason == "toolUse"` and is
                            // dropped upstream (see the turn_end handler) -- leaving
                            // `pending_turn_complete` empty.  Without a fallback the
                            // GUI never receives `turn_complete`, so the streaming
                            // state is never dropped and the spinner stays on forever.
                            //
                            // The CancelPending branch above already synthesises a
                            // completion for the abort path; this is the symmetric
                            // case for a normal settle.  Gated on `Prompting` so we
                            // only ever synthesise while a turn is actually in flight.
                            if pending_turn_complete.is_none()
                                && matches!(state, LoopState::Prompting)
                            {
                                pending_turn_complete = Some(NormalizedEvent::TurnComplete {
                                    reason: TurnEndReason::Complete,
                                    usage: None,
                                });
                            }
                            // A PhaseDivider buffered during the preceding agent_end
                            // has no next run to be injected into once we settle.
                            //
                            // Task mode does NOT render phase dividers -- the
                            // TaskPhaseNavBar tabs own phase navigation, and they
                            // derive state from TaskInstance.current_phase, never from
                            // these events (see derivePhaseDisplayState). So drop the
                            // stale divider instead of flushing it; keeping it would
                            // put a redundant separator inside the task conversation.
                            // Regular (non-task) sessions are unaffected: their
                            // dividers still flush on the next run's first content.
                            pending_phase_divider = None;
                            if let Some(completion) = pending_turn_complete.take() {
                                buf.push(completion);
                            }
                            flush_buf(&emit, &session_id, &mut buf);
                            last_flush = std::time::Instant::now();

                            // A user prompt may arrive while cancellation is settling.
                            let mut resent_buffered = false;
                            state = if let LoopState::CancelPending { pending_prompt } = &mut state {
                                let buffered = pending_prompt.take();
                                if let Some(msg) = buffered {
                                    let msg = apply_resolved_session_prompt_injection(
                                        msg,
                                        &session_id,
                                        resolved_session_prompt_injection.as_ref(),
                                    );
                                    send_pi_command(&stdin_arc, &json!({
                                        "type": "prompt",
                                        "message": msg
                                    })).await?;
                                    // v0.9.5 需求2 测试期：settle 后重发的 prompt 同样
                                    // 纳入 20s prompt_ack 看门狗（与 Idle 直发一致）——
                                    // 滞留回合恢复后 pi 若再次无响应，兜底终结而非永挂。
                                    prompt_ack_at = Some(tokio::time::Instant::now() + PROMPT_ACK_TIMEOUT);
                                    resent_buffered = true;
                                    LoopState::Prompting
                                } else {
                                    LoopState::Idle
                                }
                            } else {
                                LoopState::Idle
                            };
                            devlog(
                                "info",
                                if resent_buffered {
                                    "agent_settled：重发缓冲 prompt（Prompting，20s 看门狗武装）"
                                } else {
                                    "agent_settled：回合收口 → Idle"
                                },
                                &session_id,
                                json!({ "resent_buffered": resent_buffered }),
                            );
                        } else if buf.len() >= 32
                            || last_flush.elapsed() >= EVENT_FLUSH_INTERVAL
                        {
                            flush_buf(&emit, &session_id, &mut buf);
                            last_flush = std::time::Instant::now();
                        }
                        false
                    }
                    None => {
                        log::warn!("Pi RPC stdout EOF for session {} (state={})", session_id, match &state { LoopState::Idle => "Idle", LoopState::Prompting => "Prompting", LoopState::CancelPending {..} => "CancelPending" });
                        // If Pi closed while we were expecting a response, treat as error
                        if matches!(state, LoopState::Prompting) {
                            return Err(format!(
                                "智能体引擎意外退出（会话 {}），请查看日志后重试。",
                                session_id
                            ));
                        }
                        // v0.9.5 三轮评审 P1-2：停止善中期进程退出（崩溃/被杀）——
                        // agent_settled 永不到，若不补发终结名单，前端本轮永远等
                        // 不到 turn_complete（界面永挂「处理中」）。此处统一补发：
                        // pending_turn_complete（取消路径已备好的 Aborted）或直接
                        // 合成 Aborted。
                        if matches!(state, LoopState::CancelPending { .. }) {
                            flush_buf(&emit, &session_id, &mut buf);
                            let terminator = pending_turn_complete
                                .take()
                                .unwrap_or(NormalizedEvent::TurnComplete {
                                    reason: TurnEndReason::Aborted,
                                    usage: None,
                                });
                            emit(&[terminator], &session_id);
                            devlog(
                                "warn",
                                "停止善中期 pi 进程退出：补发 Aborted 终结（防界面永挂）",
                                &session_id,
                                json!({}),
                            );
                        }
                        true
                    }
                }
            }
            _ = tokio::time::sleep_until(next_deadline) => {
                // 合批兜底 flush：静默期（无新 stdout 行驱动行尾检查）buf 里的
                // 事件最多滞留一个 flush 间隔。滞留超阈值时打点——静默期事件
                // 滞留的异常签名（对表：pi 到达打点 ↔ 前端 chunk 到达打点）。
                if !buf.is_empty() && last_flush.elapsed() >= EVENT_FLUSH_INTERVAL {
                    if last_flush.elapsed() >= EVENT_FLUSH_LAG_WARN {
                        devlog(
                            "warn",
                            "事件合批兜底 flush：静默期滞留超阈值，事件随本批发出",
                            &session_id,
                            json!({
                                "events": buf.len(),
                                "since_last_flush_ms": last_flush.elapsed().as_millis() as u64,
                            }),
                        );
                    }
                    flush_buf(&emit, &session_id, &mut buf);
                    last_flush = std::time::Instant::now();
                }
                if matches!(state, LoopState::Idle) && idle_deadline <= next_deadline {
                    log::info!(
                        "Pi RPC idle timeout ({}s), shutting down session {}",
                        IDLE_TIMEOUT.as_secs(),
                        session_id
                    );
                    true
                } else if cancel_settle_at.is_some() && tokio::time::Instant::now() >= cancel_settle_at.unwrap() {
                    // v0.9.5 三轮评审 P1-1：检查序 settle 优先于 ack（防御性——
                    // 进入 CancelPending 已清 ack，两者互斥；即便未来新增武装
                    // 路径遗漏清理，取消收口（含缓冲消息语义）也不被 ack 抢跑）。
                    // ⚠ abort 后 15s 未收尾（pi 滞留，agent_settled 永不到）——
                    // 杀进程终结流。
                    log::warn!(
                        "[watchdog] Pi RPC cancel unsettled 15s (session {session_id}) — killing process"
                    );
                    devlog(
                        "error",
                        "cancel 看门狗触发：15s 未收口（pi 滞留）——杀 pi 进程终结",
                        &session_id,
                        json!({}),
                    );
                    flush_buf(&emit, &session_id, &mut buf);
                    emit(
                        &[NormalizedEvent::TurnComplete { reason: TurnEndReason::Aborted, usage: None }],
                        &session_id,
                    );
                    if let Some(pid) = child_pid {
                        let _ = crate::process_control::terminate_process_tree(pid);
                    }
                    true
                } else if prompt_ack_at.is_some() && tokio::time::Instant::now() >= prompt_ack_at.unwrap() {
                    // ⚠ prompt 送达后回合未启动（20s 无任何事件）——合成终结。
                    log::warn!(
                        "[watchdog] Pi RPC prompt unacknowledged 20s (session {session_id}) — \
                         round never started (message not persisted); synthesizing abort"
                    );
                    devlog(
                        "error",
                        "prompt 看门狗触发：20s 零事件——回合未启动（消息未送达），合成 Aborted 终结，可重发",
                        &session_id,
                        json!({}),
                    );
                    flush_buf(&emit, &session_id, &mut buf);
                    emit(
                        &[
                            NormalizedEvent::Error {
                                message: "智能体未响应本轮（20 秒无事件，回合未启动——消息未送达模型）。请重新发送；若反复出现请重启会话。".to_string(),
                                recoverable: true,
                            },
                            NormalizedEvent::TurnComplete { reason: TurnEndReason::Aborted, usage: None },
                        ],
                        &session_id,
                    );
                    prompt_ack_at = None;
                    state = LoopState::Idle;
                    false
                } else {
                    false
                }
            }
        };

        if exit {
            break;
        }
    }

    if !buf.is_empty() {
        flush_buf(&emit, &session_id, &mut buf);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal: helpers
// ---------------------------------------------------------------------------

async fn send_pi_command(
    stdin: &Arc<TokioMutex<ChildStdin>>,
    cmd: &serde_json::Value,
) -> Result<(), String> {
    let mut stdin = stdin.lock().await;
    let line = format!("{}\n", cmd);
    stdin
        .write_all(line.as_bytes())
        .await
        // 三轮评审 P1-4 补漏：两处以 ? 传播进连接循环 Err → 前端
        // NormalizedEvent::Error，属用户可见文案——泛化内部代号（Pi RPC）。
        .map_err(|e| format!("智能体引擎通信写入失败（进程可能已退出）：{e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("智能体引擎通信刷新失败：{e}"))?;
    Ok(())
}

fn is_pi_response(msg: &serde_json::Value, command: &str) -> bool {
    msg.get("type").and_then(|v| v.as_str()) == Some("response")
        && msg.get("command").and_then(|v| v.as_str()) == Some(command)
}

async fn stdout_reader(stdout: tokio::process::ChildStdout, tx: tokio::sync::mpsc::Sender<String>) {
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if tx.send(line).await.is_err() {
            break;
        }
    }
}

// 三段（事件归一化 / 问答卡协议翻译 / hub_invoke 分发）已于三轮评审 C13 拆分
// 拆出至 pi_rpc_runtime/{normalize,protocol,hub_invoke}.rs（零逻辑纯移动）。

fn pi_prompt_is_settled(event_type: &str) -> bool {
    event_type == "agent_settled"
}

/// 诊断辅助：把 LoopState 转成可读名称，用于 log 行。
fn loop_state_name(state: &LoopState) -> &'static str {
    match state {
        LoopState::Idle => "Idle",
        LoopState::Prompting => "Prompting",
        LoopState::CancelPending { .. } => "CancelPending",
    }
}

fn flush_buf(emit: &AcpEventEmit, session_id: &str, buf: &mut Vec<NormalizedEvent>) {
    if buf.is_empty() {
        return;
    }
    emit(buf, session_id);
    buf.clear();
}

#[cfg(test)]
mod tests {
    use super::handle_hub_invoke;

    /// v0.9.5 需求5 测试期 T1：rpiv-ask 哨兵行判定——精确匹配
    /// "N. Type something."（N 为纯数字），其他形态（含正常选项）不命中。
    #[test]
    fn sentinel_option_detection() {
        assert!(super::is_sentinel_option("4. Type something."));
        assert!(super::is_sentinel_option("1. Type something."));
        assert!(!super::is_sentinel_option("1. 红 — 红色选项"));
        assert!(!super::is_sentinel_option("Type something."));
        assert!(!super::is_sentinel_option("x. Type something."));
        assert!(!super::is_sentinel_option("12. Type something. extra"));
    }

    /// T1 ①：select 末项哨兵剥离 + 登记；非 select / 无哨兵原样返回。
    #[test]
    fn strip_sentinel_from_select_request() {
        let msg = serde_json::json!({
            "type": "extension_ui_request",
            "method": "select",
            "id": "t1-strip",
            "title": "颜色？",
            "options": ["1. 红 — 红", "2. 绿 — 绿", "3. Type something."]
        });
        let stripped = super::strip_sentinel_option(msg.clone());
        let options = stripped["options"].as_array().unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].as_str().unwrap(), "1. 红 — 红");
        // 登记可取回（取用即消费）
        {
            let mut reg = super::INTERACTION_SENTINELS
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            assert_eq!(
                reg.remove("t1-strip").as_deref(),
                Some("3. Type something.")
            );
        }
        // 无哨兵：原样
        let plain = serde_json::json!({
            "method": "select", "id": "t1-plain", "options": ["a", "b"]
        });
        assert_eq!(super::strip_sentinel_option(plain.clone()), plain);
        // input 方法：不动
        let input = serde_json::json!({"method": "input", "id": "t1-in", "title": "q"});
        assert_eq!(super::strip_sentinel_option(input.clone()), input);
    }

    /// v0.9.5 需求5 测试期 T5：多选题 input 还原——题干含序号选项块 +
    /// 英文序号说明 → 改写 multiSelect（题干=问句、选项=序号行）；非该
    /// 形态（普通 input / 选项块非全序号 / select）原样返回。
    #[test]
    fn multiselect_input_restored_from_rpc_fallback() {
        let msg = serde_json::json!({
            "type": "extension_ui_request",
            "method": "input",
            "id": "t5-multi",
            "title": "[多选题] 哪些鸟不会飞？

1. 企鹅 — 南极
2. 鸵鸟 — 最大
3. 天鹅 — 会飞

Enter the numbers of all that apply, comma-separated (e.g. \"1,3\"), or type a custom answer as plain text.",
            "placeholder": "1,3"
        });
        let rewritten = super::rewrite_multiselect_input(msg);
        assert_eq!(rewritten["method"].as_str().unwrap(), "multiSelect");
        assert_eq!(
            rewritten["title"].as_str().unwrap(),
            "[多选题] 哪些鸟不会飞？"
        );
        let options = rewritten["options"].as_array().unwrap();
        assert_eq!(options.len(), 3);
        assert_eq!(options[0].as_str().unwrap(), "1. 企鹅 — 南极");
        assert!(super::MULTI_SELECT_REQUESTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove("t5-multi"));

        // 普通 input（无英文说明）不动
        let plain =
            serde_json::json!({"method": "input", "id": "t5-plain", "title": "随便说点什么"});
        assert_eq!(super::rewrite_multiselect_input(plain.clone()), plain);
        // 选项块含非序号行 → 不还原（防误伤含空行的题干）
        let bad = serde_json::json!({
            "method": "input", "id": "t5-bad",
            "title": "问题

1. 企鹅 — 南极
补充说明一行

Enter the numbers of all that apply, comma-separated (e.g. \"1,3\"), or type a custom answer as plain text."
        });
        assert_eq!(super::rewrite_multiselect_input(bad.clone()), bad);
        // select 方法不动
        let sel = serde_json::json!({"method": "select", "id": "t5-sel", "title": "x", "options": ["1. a"]});
        assert_eq!(super::rewrite_multiselect_input(sel.clone()), sel);
    }

    /// T5 ②：多选卡应答翻译——选中序号行 → "1,3"；纯自定义文本透传；
    /// 未登记的请求原样返回。
    #[test]
    fn multiselect_response_translated_to_indices() {
        {
            let mut reg = super::MULTI_SELECT_REQUESTS
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            reg.insert("t5-rw".to_string());
        }
        let interaction = serde_json::json!({
            "selected_options": ["1. 企鹅 — 南极", "3. 天鹅 — 会飞"]
        });
        assert_eq!(
            super::rewrite_multiselect_response(
                "t5-rw",
                "1. 企鹅 — 南极
3. 天鹅 — 会飞",
                Some(&interaction)
            ),
            "1,3"
        );
        // 已消费：再答原样
        assert_eq!(
            super::rewrite_multiselect_response("t5-rw", "再来", Some(&interaction)),
            "再来"
        );
        // 纯自定义（无选中）透传
        {
            let mut reg = super::MULTI_SELECT_REQUESTS
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            reg.insert("t5-custom".to_string());
        }
        let custom = serde_json::json!({"selected_options": []});
        assert_eq!(
            super::rewrite_multiselect_response("t5-custom", "鹦鹉不会飞", Some(&custom)),
            "鹦鹉不会飞"
        );
        // 未登记请求不动
        assert_eq!(
            super::rewrite_multiselect_response("t5-unknown", "1. a", Some(&interaction)),
            "1. a"
        );
    }

    /// 四轮评审 P2-1：resolve 键迁移——pending 键的挂起应答随迁到真实 id；
    /// 真实键已有值时保守不覆盖；同 id 不动。
    #[test]
    fn auto_answer_key_migration_on_resolve() {
        {
            let mut reg = super::INTERACTION_AUTO_ANSWER
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            reg.insert("p21-pending".to_string(), "答案A".to_string());
        }
        super::migrate_auto_answer_key("p21-pending", "p21-real");
        {
            let reg = super::INTERACTION_AUTO_ANSWER
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            assert!(reg.get("p21-pending").is_none());
            assert_eq!(reg.get("p21-real").map(String::as_str), Some("答案A"));
        }
        // 真实键已有值：保守不覆盖（迁移值丢弃）
        {
            let mut reg = super::INTERACTION_AUTO_ANSWER
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            reg.insert("p21-pending2".to_string(), "旧答案".to_string());
            reg.insert("p21-real2".to_string(), "已有答案".to_string());
        }
        super::migrate_auto_answer_key("p21-pending2", "p21-real2");
        {
            let reg = super::INTERACTION_AUTO_ANSWER
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            assert_eq!(reg.get("p21-real2").map(String::as_str), Some("已有答案"));
            assert!(reg.get("p21-pending2").is_none());
        }
        // 同 id：无操作（不丢已有值）
        super::migrate_auto_answer_key("p21-real", "p21-real");
        {
            let reg = super::INTERACTION_AUTO_ANSWER
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            assert_eq!(reg.get("p21-real").map(String::as_str), Some("答案A"));
        }
        // 清理（全局静态表，防污染其他用例）
        {
            let mut reg = super::INTERACTION_AUTO_ANSWER
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            reg.remove("p21-real");
            reg.remove("p21-real2");
        }
    }

    /// T1 ②：应答改写——无选中项纯文本 + 挂有哨兵 → 回传哨兵并暂存文本；
    /// 有选中项 / 未挂哨兵 → 原样。
    #[test]
    fn sentinel_response_rewrite_rules() {
        // 准备登记（本测试独立 key）
        {
            let mut reg = super::INTERACTION_SENTINELS
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            reg.insert("t2-rw".to_string(), "3. Type something.".to_string());
        }
        let interaction = serde_json::json!({"selected_options": []});
        let rewritten = super::rewrite_sentinel_response(
            "t2-rw",
            "t2-session",
            "自定义：蓝色",
            Some(&interaction),
        );
        assert_eq!(rewritten, "3. Type something.");
        // 暂存文本可取（消费式）
        {
            let mut stash = super::INTERACTION_AUTO_ANSWER
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            assert_eq!(stash.remove("t2-session").as_deref(), Some("自定义：蓝色"));
        }
        // 已消费（登记被取走）：再次应答原样返回
        assert_eq!(
            super::rewrite_sentinel_response("t2-rw", "t2-session", "再来一次", Some(&interaction)),
            "再来一次"
        );
        // 有选中项（普通选项点击）：即使挂哨兵也不改写
        {
            let mut reg = super::INTERACTION_SENTINELS
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            reg.insert("t2-opt".to_string(), "3. Type something.".to_string());
        }
        let with_selection = serde_json::json!({"selected_options": ["1. 红 — 红"]});
        assert_eq!(
            super::rewrite_sentinel_response("t2-opt", "s", "1. 红 — 红", Some(&with_selection)),
            "1. 红 — 红"
        );
    }

    // v0.9.2 测试期：plugin_preview_html 校验阶梯——文件存在性/扩展名/大小
    // 逐级拒绝；合法文件在无 Hub 句柄的测试环境落到「界面未就绪」分支
    //（证明前两级校验已通过）。
    #[test]
    fn plugin_preview_html_rejects_missing_file() {
        let err = handle_hub_invoke(
            "plugin_preview_html",
            &serde_json::json!({"file": "Z:/definitely/not/there.html"}),
        )
        .unwrap_err();
        assert!(err.contains("不存在"), "unexpected: {err}");
    }

    // v0.9.3 测试期（前端项目预览）：url 模式回环校验——仅本机
    // localhost/127.0.0.1/[::1] 的 http/https 放行，其余（外网/内网/非
    // http scheme）拒绝；合法 url 在无 Hub 句柄环境落到「界面未就绪」。
    #[test]
    fn plugin_preview_html_url_loopback_ladder() {
        for bad in [
            "http://example.com:5173",
            "http://192.168.1.10:3000",
            "file://localhost/x",
            "ftp://localhost",
            "http://localhost.evil.com",
        ] {
            let err = handle_hub_invoke("plugin_preview_html", &serde_json::json!({"url": bad}))
                .unwrap_err();
            // 各级拒绝（scheme/回环）皆可，断言核心：到不了「界面未就绪」
            //（即校验全部放行的路径）。
            assert!(
                !err.contains("未就绪"),
                "url={bad} should be rejected: {err}"
            );
        }
        for ok in [
            "http://localhost:5173",
            "http://127.0.0.1:3000/index.html",
            "https://localhost",
        ] {
            let err = handle_hub_invoke("plugin_preview_html", &serde_json::json!({"url": ok}))
                .unwrap_err();
            assert!(
                err.contains("未就绪"),
                "url={ok} should pass validation: {err}"
            );
        }
    }

    #[test]
    fn plugin_preview_html_rejects_non_html_extension() {
        let md = std::env::temp_dir().join(format!("jishu-hub-preview-{}.md", std::process::id()));
        std::fs::write(&md, "x").unwrap();
        let err = handle_hub_invoke(
            "plugin_preview_html",
            &serde_json::json!({"file": md.to_string_lossy()}),
        )
        .unwrap_err();
        assert!(err.contains(".html"), "unexpected: {err}");
        let _ = std::fs::remove_file(&md);
    }

    #[test]
    fn plugin_preview_html_valid_file_reaches_hub_gate() {
        let html =
            std::env::temp_dir().join(format!("jishu-hub-preview-{}.html", std::process::id()));
        std::fs::write(&html, "<!DOCTYPE html><html></html>").unwrap();
        // 测试环境未注册 HUB_APP_HANDLE：合法文件应越过存在性/扩展名校验，
        // 落到「Hub 界面未就绪」而非文件错误。
        let err = handle_hub_invoke(
            "plugin_preview_html",
            &serde_json::json!({"file": html.to_string_lossy()}),
        )
        .unwrap_err();
        assert!(err.contains("未就绪"), "unexpected: {err}");
        let _ = std::fs::remove_file(&html);
    }

    /// 真实形态回归：写小说场景的分段（thinking + text + toolCall=write +
    /// toolResults），验证分段记账的精确字段与内容归因。
    #[test]
    fn pi_segment_usage_attributes_realistic_turn_end() {
        let event = serde_json::json!({
            "type": "turn_end",
            "message": {
                "role": "assistant",
                "stopReason": "toolUse",
                "content": [
                    {"type": "thinking", "thinking": "规划第一章结构", "thinkingSignature": "sig"},
                    {"type": "text", "text": "我先写入第一章。"},
                    {"type": "toolCall", "id": "call_1", "name": "write",
                     "arguments": {"path": "novel.md", "content": "第一章 雾夜坠楼。江州的雾，是有脾气的。"}}
                ],
                "usage": {
                    "input": 1166, "output": 1380, "cacheRead": 113472,
                    "cacheWrite": 0, "totalTokens": 116018,
                    "cost": {"total": 0.0123}
                }
            },
            "toolResults": [
                {"role": "toolResult", "toolCallId": "call_1", "toolName": "write",
                 "content": [{"type": "text", "text": "Written 42 lines."}]}
            ]
        });
        let seg = pi_segment_usage(&event, Some(1_000_000)).unwrap();
        assert_eq!(seg.stop_reason, "toolUse");
        assert_eq!(seg.input_tokens, 1166);
        assert_eq!(seg.output_tokens, 1380);
        assert_eq!(seg.cache_read, 113_472);
        assert_eq!(seg.total_tokens, 116_018);
        assert!((seg.total_cost - 0.0123).abs() < 1e-9);
        assert_eq!(seg.context_remaining, Some(1_000_000 - 116_018));
        // 归因：三块皆有值；工具调用一次（MCP 无标志并入工具桶）。
        assert!(seg.est_thinking > 0);
        assert!(seg.est_text > 0);
        assert!(seg.est_builtin_tool > 0);
        assert_eq!(seg.est_mcp_tool, 0);
        assert_eq!(seg.tool_calls, 1);
        assert_eq!(seg.mcp_calls, 0);
        assert!(seg.est_tool_results > 0);
    }

    /// 真实形态回归：compaction_end（threshold 触发，含 CompactionResult）。
    #[test]
    fn pi_compaction_record_extracts_result_fields() {
        let event = serde_json::json!({
            "type": "compaction_end",
            "reason": "threshold",
            "aborted": false,
            "result": {
                "summary": "## Goal
        - 用户要求写 20 万字小说",
                "firstKeptEntryId": "entry-42",
                "tokensBefore": 118_910,
                "estimatedTokensAfter": 62_389,
                "usage": {"input": 110_000, "output": 6_340, "totalTokens": 116_340,
                          "cost": {"total": 0.08}}
            }
        });
        let rec = pi_compaction_record(&event);
        assert_eq!(rec.reason, "threshold");
        assert!(!rec.aborted);
        assert_eq!(rec.tokens_before, 118_910);
        assert_eq!(rec.tokens_after, 62_389);
        assert_eq!(rec.first_kept_entry_id.as_deref(), Some("entry-42"));
        assert_eq!(rec.summary_input, 110_000);
        assert_eq!(rec.summary_output, 6_340);
        assert!((rec.summary_cost - 0.08).abs() < 1e-9);
        assert!(rec.est_summary > 0);

        // result 缺失（压缩失败）——字段全缺省，不 panic。
        let empty = pi_compaction_record(&serde_json::json!({
            "type": "compaction_end", "reason": "manual", "aborted": true
        }));
        assert!(empty.aborted);
        assert_eq!(empty.tokens_before, 0);
        assert_eq!(empty.first_kept_entry_id, None);
    }

    #[test]
    fn pi_turn_usage_maps_turn_end_usage_with_watermark() {
        let event = serde_json::json!({
            "type": "turn_end",
            "message": {
                "stopReason": "end_turn",
                "usage": {
                    "input": 1000,
                    "output": 300,
                    "cacheRead": 60000,
                    "cacheWrite": 0,
                    "totalTokens": 61300,
                    "cost": { "total": 0.05 }
                }
            }
        });
        let usage = pi_turn_usage(&event, Some(128_000)).unwrap();
        assert_eq!(usage.input_tokens, Some(1000));
        assert_eq!(usage.output_tokens, Some(300));
        assert_eq!(usage.total_cost, Some(0.05));
        assert_eq!(usage.context_window_total, Some(128_000));
        // totalTokens 优先（对齐 pi calculateContextTokens），remaining = 128k - 61.3k
        assert_eq!(usage.context_remaining, Some(128_000 - 61_300));

        // totalTokens 缺省时回退四项求和
        let event2 = serde_json::json!({
            "message": { "usage": { "input": 10, "output": 5, "cacheRead": 5, "cacheWrite": 0 } }
        });
        let usage2 = pi_turn_usage(&event2, Some(100)).unwrap();
        assert_eq!(usage2.context_remaining, Some(80));

        // 无 usage / 全空 → None
        assert!(pi_turn_usage(&serde_json::json!({ "message": {} }), Some(100)).is_none());
        // ctx 未知 → remaining/total 为 None，in/out 仍上报
        let usage3 = pi_turn_usage(&event2, None).unwrap();
        assert_eq!(usage3.context_remaining, None);
        assert_eq!(usage3.input_tokens, Some(10));
    }

    #[test]
    fn turn_end_maps_usage_into_turn_complete() {
        let event = serde_json::json!({
            "type": "turn_end",
            "message": {
                "stopReason": "end_turn",
                "usage": { "input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 12, "cost": { "total": 0.01 } }
            }
        });
        let events = normalize_pi_agent_event(&event, Some(1000), &mut Vec::new());
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::TurnComplete { usage, .. } => {
                let u = usage.as_ref().unwrap();
                assert_eq!(u.context_window_total, Some(1000));
                assert_eq!(u.context_remaining, Some(988));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    /// v0.9.1 需求14：auto_retry_start/end 归一化——字段透传 + end 失败
    /// 携最终原因。
    #[test]
    fn auto_retry_events_normalize_to_status() {
        let mut steers = Vec::new();
        let start = normalize_pi_agent_event(
            &serde_json::json!({
                "type": "auto_retry_start",
                "attempt": 2,
                "maxAttempts": 10,
                "delayMs": 4000,
                "errorMessage": "provider 503"
            }),
            None,
            &mut steers,
        );
        assert_eq!(start.len(), 1);
        match &start[0] {
            NormalizedEvent::AutoRetryStatus {
                active,
                attempt,
                max_attempts,
                delay_ms,
                error_message,
                success,
                final_error,
            } => {
                assert!(active);
                assert_eq!((*attempt, *max_attempts, *delay_ms), (2, 10, 4000));
                assert_eq!(error_message, "provider 503");
                assert!(!success);
                assert!(final_error.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }

        let end = normalize_pi_agent_event(
            &serde_json::json!({
                "type": "auto_retry_end",
                "success": false,
                "attempt": 10,
                "finalError": "all retries exhausted"
            }),
            None,
            &mut steers,
        );
        match &end[0] {
            NormalizedEvent::AutoRetryStatus {
                active,
                success,
                final_error,
                ..
            } => {
                assert!(!active);
                assert!(!success);
                assert_eq!(final_error.as_deref(), Some("all retries exhausted"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// v0.9.1 需求3 #2：compaction_end 三态呈现——成功「已压缩」、aborted
    /// 「已取消」、errorMessage「失败 + Error(recoverable)」。字段形态对齐
    /// pi agent-session catch 分支（errorMessage 仅非 abort 失败时下发）。
    #[test]
    fn compaction_end_renders_success_aborted_and_failure_states() {
        let success = normalize_pi_agent_event(
            &serde_json::json!({
                "type": "compaction_end", "reason": "threshold",
                "result": {"tokensBefore": 100, "estimatedTokensAfter": 50},
                "aborted": false
            }),
            None,
            &mut Vec::new(),
        );
        assert!(matches!(
            success.as_slice(),
            [
                NormalizedEvent::CompactionStatus { active: false, .. },
                NormalizedEvent::PhaseDivider { title, .. }
            ] if title == "上下文已压缩"
        ));

        let aborted = normalize_pi_agent_event(
            &serde_json::json!({
                "type": "compaction_end", "reason": "manual",
                "result": null, "aborted": true
            }),
            None,
            &mut Vec::new(),
        );
        assert!(matches!(
            aborted.as_slice(),
            [
                NormalizedEvent::CompactionStatus { active: false, .. },
                NormalizedEvent::PhaseDivider { title, .. }
            ] if title == "上下文压缩已取消"
        ));

        let failed = normalize_pi_agent_event(
            &serde_json::json!({
                "type": "compaction_end", "reason": "manual",
                "result": null, "aborted": false,
                "errorMessage": "Compaction failed: provider 500"
            }),
            None,
            &mut Vec::new(),
        );
        assert!(matches!(
            failed.as_slice(),
            [
                NormalizedEvent::CompactionStatus { active: false, .. },
                NormalizedEvent::PhaseDivider { title, .. },
                NormalizedEvent::Error { message, recoverable: true }
            ] if title == "上下文压缩失败" && message.contains("provider 500")
        ));
    }

    use super::*;

    #[test]
    fn waits_for_agent_settled_before_completing_prompt() {
        assert!(!pi_prompt_is_settled("agent_end"));
        assert!(!pi_prompt_is_settled("turn_end"));
        assert!(pi_prompt_is_settled("agent_settled"));
    }

    /// R4 root cause, pinned so a future change cannot silently undo it.
    ///
    /// A `turn_end` carrying `stopReason == "toolUse"` yields no events at all --
    /// intentionally, so a mid-turn tool call cannot make the GUI drop its
    /// streaming state early.  The consequence is that a tool returning
    /// `terminate: true` produces *no* TurnComplete anywhere, which is why the
    /// settle branch in `run_loop` has to synthesise one (B2.5 T3).
    ///
    /// v0.9.4 需求8：tool_execution_update → ToolUseProgress（partialResult
    /// 透传不解析；无 callId 丢弃）。
    #[test]
    fn tool_execution_update_maps_to_progress() {
        let events = normalize_pi_agent_event(
            &json!({
                "type": "tool_execution_update",
                "toolCallId": "call-1",
                "toolName": "bash",
                "partialResult": {
                    "content": [{ "type": "text", "text": "step 3/45 done" }],
                    "details": { "fullOutputPath": null }
                }
            }),
            None,
            &mut Vec::new(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::ToolUseProgress {
                call_id,
                partial_output,
            } => {
                assert_eq!(call_id, "call-1");
                assert_eq!(partial_output, "step 3/45 done");
            }
            other => panic!("Expected ToolUseProgress, got {other:?}"),
        }

        // 兜底形状（output 直出）：也能提取。
        let events = normalize_pi_agent_event(
            &json!({
                "type": "tool_execution_update",
                "toolCallId": "call-1b",
                "toolName": "bash",
                "partialResult": { "output": "legacy shape" }
            }),
            None,
            &mut Vec::new(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::ToolUseProgress { partial_output, .. } => {
                assert_eq!(partial_output, "legacy shape");
            }
            other => panic!("Expected ToolUseProgress, got {other:?}"),
        }

        // 无 callId：丢弃（防御）。
        let events = normalize_pi_agent_event(
            &json!({
                "type": "tool_execution_update",
                "toolName": "bash",
                "partialResult": { "output": "x" }
            }),
            None,
            &mut Vec::new(),
        );
        assert!(events.is_empty(), "no callId should be dropped: {events:?}");
    }

    #[test]
    fn tool_use_turn_end_yields_no_events() {
        let events = normalize_pi_agent_event(
            &json!({
                "type": "turn_end",
                "message": { "stopReason": "toolUse" }
            }),
            None,
            &mut Vec::new(),
        );
        assert!(
            events.is_empty(),
            "toolUse turn_end must stay suppressed, got {events:?}"
        );
    }

    /// Counterpart to the above: a normal turn boundary does produce the
    /// completion that `agent_settled` later forwards.
    #[test]
    fn normal_turn_end_yields_turn_complete() {
        let events = normalize_pi_agent_event(
            &json!({
                "type": "turn_end",
                "message": { "stopReason": "end_turn" }
            }),
            None,
            &mut Vec::new(),
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, NormalizedEvent::TurnComplete { .. })),
            "expected TurnComplete, got {events:?}"
        );
    }

    #[test]
    fn ignores_request_user_input_tool_start_until_extension_ui_request_arrives() {
        let events = normalize_pi_agent_event(
            &json!({
                "type": "tool_execution_start",
                "toolCallId": "call-1",
                "toolName": "request_user_input",
                "args": {
                    "question": "请选择发布方式",
                    "options": ["A", "B"]
                }
            }),
            None,
            &mut Vec::new(),
        );

        assert!(events.is_empty());
    }

    #[test]
    fn detects_custom_role_phase_enter_marker() {
        let events = normalize_pi_agent_event(
            &json!({
                "type": "message_start",
                "message": {
                    "role": "custom",
                    "customType": "jishu-conductor:phase-enter:plan",
                    "content": "进入流程规划阶段",
                    "display": true,
                    "timestamp": 0
                }
            }),
            None,
            &mut Vec::new(),
        );

        match events.as_slice() {
            [NormalizedEvent::PhaseDivider { phase, title }] => {
                assert_eq!(phase, "plan");
                assert_eq!(title, "流程规划");
            }
            other => panic!("expected phase divider, got {other:?}"),
        }
    }

    #[test]
    fn surfaces_user_role_message_start_as_steer_injected() {
        // Pi 对每条送达的用户消息都回显 message_start(role=user)——只有
        // 经 Steer 命令注入（连接循环登记进 pending_steers）的才是真引导。
        let event = json!({
            "type": "message_start",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "改用 TypeScript 实现" }],
                "timestamp": 0
            }
        });

        // 登记过的 steer 文本 → SteerInjected（并消费登记）。
        let mut steers = vec!["改用 TypeScript 实现".to_string()];
        let events = normalize_pi_agent_event(&event, None, &mut steers);
        match events.as_slice() {
            [NormalizedEvent::SteerInjected { content }] => {
                assert_eq!(content, "改用 TypeScript 实现");
            }
            other => panic!("expected [SteerInjected], got {other:?}"),
        }
        assert!(steers.is_empty(), "steer 登记应被消费");

        // 未登记（普通 prompt / 压缩前排队的消息回显）→ 不产生事件，
        // 否则用户消息会被误标「已引导」并重复渲染（v0.8.0 需求10 修复）。
        let events = normalize_pi_agent_event(
            &json!({
                "type": "message_start",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "继续" }],
                    "timestamp": 0
                }
            }),
            None,
            &mut Vec::new(),
        );
        assert!(
            events.is_empty(),
            "prompt 回显不应产生 steer 事件: {events:?}"
        );
    }

    #[test]
    fn ignores_assistant_role_message_start() {
        // Assistant content arrives via message_update, so the assistant
        // message_start must not be surfaced (it carries no steer).
        let events = normalize_pi_agent_event(
            &json!({
                "type": "message_start",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "" }],
                    "timestamp": 0
                }
            }),
            None,
            &mut Vec::new(),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn ignores_message_end_for_steer() {
        // Only message_start is converted; message_end is a duplicate marker.
        let events = normalize_pi_agent_event(
            &json!({
                "type": "message_end",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "steer text" }],
                    "timestamp": 0
                }
            }),
            None,
            &mut Vec::new(),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn applies_resolved_session_prompt_injection_before_prompt_is_sent() {
        let injection = crate::agent::ResolvedSessionPromptInjection {
            open_tag: "<jishu-runtime-context>".into(),
            close_tag: "</jishu-runtime-context>".into(),
            session_id_field: "session_id".into(),
            guidance: "直接使用该 session_id，不要扫描 session 文件。".into(),
        };

        let message = apply_resolved_session_prompt_injection(
            "用户原始消息".to_string(),
            "sid-real",
            Some(&injection),
        );

        assert!(message.starts_with("<jishu-runtime-context>"));
        assert!(message.contains("session_id: sid-real"));
        assert!(message.contains("直接使用该 session_id"));
        assert!(message.ends_with("用户原始消息"));
    }

    #[test]
    fn converts_extension_ui_select_to_interaction_request() {
        let event = convert_extension_ui_request(&json!({
            "type": "extension_ui_request",
            "id": "req-uuid-1",
            "method": "select",
            "title": "请选择实现方案",
            "options": ["方案A", "方案B", "方案C"]
        }))
        .expect("select should convert");

        match event {
            NormalizedEvent::InteractionRequest {
                request_id,
                prompt,
                options,
                allow_multiple,
                allow_custom_text,
                required,
                transport,
                origin,
                delivery_hint,
                correlation,
            } => {
                assert_eq!(request_id, "req-uuid-1");
                assert_eq!(prompt, "请选择实现方案");
                assert_eq!(options.len(), 3);
                assert_eq!(options[0].label, "方案A");
                assert!(!allow_multiple);
                assert!(allow_custom_text);
                assert!(required);
                // Pi extension_ui is the production mid-turn baseline.
                assert_eq!(transport, InteractionTransport::PiRpc);
                assert_eq!(origin, InteractionOrigin::ExtensionUi);
                assert_eq!(delivery_hint, InteractionDeliveryHint::MidTurn);
                assert!(correlation.is_none());
            }
            _ => panic!("expected InteractionRequest"),
        }
    }

    #[test]
    fn converts_extension_ui_multi_select_to_interaction_request() {
        let event = convert_extension_ui_request(&json!({
            "type": "extension_ui_request",
            "id": "req-multi-1",
            "method": "multiSelect",
            "title": "选择功能",
            "options": ["登录", "注册"]
        }))
        .expect("multiSelect should convert");

        match event {
            NormalizedEvent::InteractionRequest {
                request_id,
                options,
                allow_multiple,
                ..
            } => {
                assert_eq!(request_id, "req-multi-1");
                assert_eq!(options.len(), 2);
                assert!(allow_multiple);
            }
            _ => panic!("expected InteractionRequest"),
        }
    }

    #[test]
    fn converts_extension_ui_input_to_interaction_request() {
        let event = convert_extension_ui_request(&json!({
            "type": "extension_ui_request",
            "id": "req-uuid-2",
            "method": "input",
            "title": "补充说明",
            "placeholder": "可选"
        }))
        .expect("input should convert");

        match event {
            NormalizedEvent::InteractionRequest {
                request_id,
                prompt,
                options,
                allow_custom_text,
                ..
            } => {
                assert_eq!(request_id, "req-uuid-2");
                assert_eq!(prompt, "补充说明");
                assert!(options.is_empty());
                assert!(allow_custom_text);
            }
            _ => panic!("expected InteractionRequest"),
        }
    }

    #[test]
    fn ignores_fire_and_forget_extension_ui_requests() {
        assert!(convert_extension_ui_request(&json!({
            "type": "extension_ui_request",
            "id": "x",
            "method": "notify",
            "message": "hello"
        }))
        .is_none());
        assert!(convert_extension_ui_request(&json!({
            "type": "extension_ui_request",
            "id": "y",
            "method": "setStatus",
            "statusKey": "progress",
            "statusText": "50%"
        }))
        .is_none());
    }
}
