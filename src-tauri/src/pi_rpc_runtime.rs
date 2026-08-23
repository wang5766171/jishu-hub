//! Pi native RPC protocol runtime (adapter for `--mode rpc`).
//!
//! Pi's RPC mode uses simple JSON-line commands/responses rather than
//! JSON-RPC 2.0. This module translates between Pi's native protocol
//! and the `AcpControl` / `NormalizedEvent` interfaces used by the GUI.
//!
//! Protocol:
//! - Commands (stdin):  `{"type":"prompt","message":"..."}`, `{"type":"abort"}`
//! - Responses (stdout): `{"type":"response","command":"prompt","success":true}`
//! - Events (stdout):   AgentEvent objects (`message_update`, `tool_execution_*`, …)

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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Spawn the Pi RPC driver: starts Pi in `--mode rpc`, returns an
/// `AcpControl` that speaks Pi's native protocol internally.
pub fn spawn_pi_rpc_session(
    app: tauri::AppHandle,
    agent_id: String,
    pending_session_id: String,
    mut child: tokio::process::Child,
    _project_path: String,
    _requested_session_id: Option<String>,
    first_message: Option<String>,
    resolved_session_prompt_injection: Option<ResolvedSessionPromptInjection>,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    let emit = tauri_event_emitter(app, agent_id.clone());
    // 需求1 A7：Hub 侧 thinking 档位偏好（state.json），spawn 时应用。
    let thinking_pref = crate::hub::load_agent_thinking_level(&agent_id);
    // 需求1 A3：Hub 侧自动压缩偏好，spawn 时应用。
    let auto_compaction_pref = crate::hub::load_agent_auto_compaction(&agent_id);
    spawn_pi_rpc_session_inner(
        emit,
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
    let stdin = child.stdin.take().expect("Pi RPC process must have stdin");
    let stdout = child
        .stdout
        .take()
        .expect("Pi RPC process must have stdout");
    let stderr = child.stderr.take();

    let stdin_arc = Arc::new(TokioMutex::new(stdin));
    let acp_session_id = Arc::new(std::sync::Mutex::new(None::<String>));

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
        )
        .await;

        if let Err(err) = &result {
            // Enrich error with stderr output
            let stderr_content = stderr_buf.lock().await.clone();
            let enriched_err = if !stderr_content.trim().is_empty() {
                let tail = if stderr_content.len() > 500 {
                    &stderr_content[stderr_content.len() - 500..]
                } else {
                    &stderr_content
                };
                format!("{}\n--- Pi stderr ---\n{}", err, tail.trim())
            } else {
                err.clone()
            };
            log::warn!("Pi RPC connection loop exited with error: {}", enriched_err);
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

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

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
    let mut session_id = loop {
        let line = tokio::time::timeout(Duration::from_secs(30), stdout_rx.recv())
            .await
            .map_err(|_| "Pi RPC get_state timeout (30s)".to_string())?
            .ok_or_else(|| "Pi RPC stdout closed before get_state response. Pi may have crashed during startup.".to_string())?;

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
                                state = LoopState::Prompting;
                            }
                            LoopState::Prompting => {
                                log::warn!("Pi RPC prompt ignored: still in Prompting state");
                            }
                            LoopState::CancelPending { pending_prompt } => {
                                log::warn!("Pi RPC prompt buffered: still CancelPending (awaiting agent_settled after abort)");
                                *pending_prompt = Some(msg);
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
                                let _ = send_pi_command(&stdin_arc, &json!({
                                    "type": "abort"
                                })).await;
                                log::info!("Pi RPC cancel sent");
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

                                match response_cmd {
                                    "prompt" | "steer" | "follow_up" => {
                                        if success {
                                            // Prompt accepted, events will follow
                                            log::info!("Pi RPC response for {}: success=true", response_cmd);
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
                                        }
                                    }
                                    "abort" => {
                                        log::info!("Pi RPC abort acknowledged");
                                        // session.abort() responds after awaited agent_end
                                        // handlers and emits agent_settled, which owns final
                                        // completion and the local Idle transition.
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
                                if buf.len() >= 32 || last_flush.elapsed() >= Duration::from_millis(8) {
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
                                let (mode, tool) = meta.split_once('|').unwrap_or(("smart", meta));
                                let message = msg
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let approval_ctx = crate::agent::policy::ApprovalContext {
                                    channel: crate::agent::policy::DecisionChannel::Interactive,
                                    kind: crate::agent::policy::ApprovalKindWire::Other,
                                    session_id: session_id.clone(),
                                    tool: Some(tool.to_string()),
                                    payload: serde_json::json!({
                                        "tool": tool,
                                        "summary": message,
                                        "mode": mode,
                                    }),
                                    payload_declares: false,
                                    high_risk: false,
                                };
                                // 模式选链：smart=[Once, LowRisk]（读类免打扰，
                                // 「始终允许」经 Once 记忆生效）；ask_always=
                                // [LowRisk]（读类放行，变更类每次弹窗、不记忆）。
                                // 两档的差异只在 Once 记忆是否在链上。
                                let approval_chain = if mode == "ask_always" {
                                    crate::agent::policy::for_ask_always_session(&session_id)
                                } else {
                                    crate::agent::policy::for_interactive_session(&session_id)
                                };
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
                                        pending_tool_approvals.insert(
                                            request_id.clone(),
                                            PiToolApproval {
                                                request_id: request_id.clone(),
                                                tool: tool.to_string(),
                                                summary: message.clone(),
                                            },
                                        );
                                        buf.push(NormalizedEvent::ApprovalRequest {
                                            request_id,
                                            // 审批类型按工具名分类（bash→命令执行，
                                            // write/edit→文件写入），弹窗显示正确类型。
                                            approval_kind:
                                                crate::agent::normalized::ApprovalKind::for_tool(tool),
                                            payload: serde_json::json!({
                                                "tool": tool,
                                                "summary": message,
                                                "mode": mode,
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

                        if matches!(event_type, "agent_start" | "turn_start")
                            && !matches!(state, LoopState::CancelPending { .. })
                        {
                            state = LoopState::Prompting;
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
                                    LoopState::Prompting
                                } else {
                                    LoopState::Idle
                                }
                            } else {
                                LoopState::Idle
                            };
                        } else if buf.len() >= 32
                            || last_flush.elapsed() >= Duration::from_millis(8)
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
                                "Pi process exited unexpectedly (session {}). Check stderr for details.",
                                session_id
                            ));
                        }
                        true
                    }
                }
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                if matches!(state, LoopState::Idle) {
                    log::info!(
                        "Pi RPC idle timeout ({}s), shutting down session {}",
                        IDLE_TIMEOUT.as_secs(),
                        session_id
                    );
                    true
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
        .map_err(|e| format!("Pi RPC stdin write failed (process may have exited): {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Pi RPC stdin flush failed: {e}"))?;
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

// ---------------------------------------------------------------------------
// Pi AgentEvent → NormalizedEvent
// ---------------------------------------------------------------------------

/// Convert Pi's native `AgentEvent` JSON objects to `NormalizedEvent`.
///
/// Pi events (from `@earendil-works/pi-agent-core`):
/// - `agent_start`, `agent_end`
/// - `turn_start`, `turn_end`
/// - `message_start`, `message_update`, `message_end`
/// - `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
/// 从 turn_end 的 message.usage 构造 UsageStats（v0.7.3 需求2：jishu-self 用量与水位）。
/// context_tokens 公式对齐 pi `calculateContextTokens`（totalTokens 优先，否则四项求和）；
/// context_window 来自启动时 get_state 的 model.contextWindow，缺失时仅报 in/out/cost。
fn pi_turn_usage(event: &serde_json::Value, context_window: Option<u64>) -> Option<UsageStats> {
    let usage = event.get("message").and_then(|m| m.get("usage"))?;
    let num = |key: &str| usage.get(key).and_then(|v| v.as_f64()).map(|v| v as u64);
    let input = num("input");
    let output = num("output");
    let cache_read = num("cacheRead");
    let cache_write = num("cacheWrite");
    let total_tokens = num("totalTokens");
    let total_cost = usage
        .get("cost")
        .and_then(|c| c.get("total"))
        .and_then(|v| v.as_f64());
    if input.is_none()
        && output.is_none()
        && total_cost.is_none()
        && total_tokens.is_none()
        && cache_read.is_none()
        && cache_write.is_none()
    {
        return None;
    }
    let context_tokens = total_tokens.filter(|v| *v > 0).or_else(|| {
        Some(
            input.unwrap_or(0)
                + output.unwrap_or(0)
                + cache_read.unwrap_or(0)
                + cache_write.unwrap_or(0),
        )
    });
    let context_remaining = context_window
        .zip(context_tokens)
        .map(|(total, used)| total.saturating_sub(used));
    Some(UsageStats {
        input_tokens: input,
        output_tokens: output,
        total_cost,
        context_remaining,
        context_window_total: context_window,
    })
}

/// v0.8.0 需求10：分段用量 + 内容归因。usage 部分复用 pi_turn_usage（精确）；
/// 归因部分对 turn_end 的 message.content 逐块估算（thinking/text/toolCall），
/// toolResults 估算为工具结果进入后续上下文的规模。
fn pi_segment_usage(event: &serde_json::Value, context_window: Option<u64>) -> Option<crate::usage_store::SegmentUsage> {
    let base = pi_turn_usage(event, context_window)?;
    let mut seg = crate::usage_store::SegmentUsage {
        stop_reason: event
            .get("message")
            .and_then(|m| m.get("stopReason"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        input_tokens: base.input_tokens.unwrap_or(0),
        output_tokens: base.output_tokens.unwrap_or(0),
        cache_read: event
            .get("message")
            .and_then(|m| m.get("usage"))
            .and_then(|u| u.get("cacheRead"))
            .and_then(|v| v.as_f64())
            .map(|v| v as u64)
            .unwrap_or(0),
        cache_write: event
            .get("message")
            .and_then(|m| m.get("usage"))
            .and_then(|u| u.get("cacheWrite"))
            .and_then(|v| v.as_f64())
            .map(|v| v as u64)
            .unwrap_or(0),
        total_tokens: 0,
        total_cost: base.total_cost.unwrap_or(0.0),
        context_remaining: base.context_remaining,
        context_window_total: base.context_window_total,
        ..Default::default()
    };
    seg.total_tokens = event
        .get("message")
        .and_then(|m| m.get("usage"))
        .and_then(|u| u.get("totalTokens"))
        .and_then(|v| v.as_f64())
        .map(|v| v as u64)
        .unwrap_or(0);

    if let Some(blocks) = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for block in blocks {
            let kind = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "thinking" => {
                    seg.est_thinking += est_block_tokens(block.get("thinking"));
                }
                "text" => {
                    seg.est_text += est_block_tokens(block.get("text"));
                }
                "toolCall" => {
                    // pi-mcp-adapter 注册的 MCP 工具在 toolCall 块上无标志
                    // （实测仅 type/id/name/arguments 四字段），按用户裁决统一
                    // 归入工具桶；est_mcp_tool/mcp_calls 列留作前向预留。
                    let _name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let est = est_block_tokens(Some(&serde_json::Value::Null)) +
                        est_block_tokens(block.get("arguments"));
                    seg.est_builtin_tool += est;
                    seg.tool_calls += 1;
                }
                _ => {}
            }
        }
    }
    if let Some(results) = event.get("toolResults").and_then(|v| v.as_array()) {
        for r in results {
            seg.est_tool_results += est_block_tokens(Some(r));
        }
    }
    Some(seg)
}

/// 从 pi compaction_end 事件提取压缩记录（CompactionResult 字段）。
fn pi_compaction_record(event: &serde_json::Value) -> crate::usage_store::CompactionRecord {
    let num = |v: Option<&serde_json::Value>| {
        v.and_then(|x| x.as_f64()).map(|x| x as u64).unwrap_or(0)
    };
    let result = event.get("result");
    let usage = result.and_then(|r| r.get("usage"));
    let cost = usage
        .and_then(|u| u.get("cost"))
        .and_then(|c| c.get("total"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let summary_len = result
        .and_then(|r| r.get("summary"))
        .and_then(|v| v.as_str())
        .map(|s| s.chars().count())
        .unwrap_or(0) as u64;
    crate::usage_store::CompactionRecord {
        reason: event
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        aborted: event.get("aborted").and_then(|v| v.as_bool()).unwrap_or(false),
        tokens_before: num(result.and_then(|r| r.get("tokensBefore"))),
        tokens_after: num(result.and_then(|r| r.get("estimatedTokensAfter"))),
        first_kept_entry_id: result
            .and_then(|r| r.get("firstKeptEntryId"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        summary_input: num(usage.and_then(|u| u.get("input"))),
        summary_output: num(usage.and_then(|u| u.get("output"))),
        summary_cost: cost,
        est_summary: ((summary_len as f64) / 2.5).ceil() as u64,
    }
}

/// 估算口径：≈2.5 字符/token（中英混合粗估，构成对比用，非计费值）。
fn est_block_tokens(value: Option<&serde_json::Value>) -> u64 {
    let text = match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => return 0,
    };
    ((text.chars().count() as f64) / 2.5).ceil() as u64
}

pub(crate) fn normalize_pi_agent_event(
    event: &serde_json::Value,
    context_window: Option<u64>,
    pending_steers: &mut Vec<String>,
) -> Vec<NormalizedEvent> {
    let event_type = match event.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return vec![],
    };

    match event_type {
        // v0.8.0 需求10：上下文压缩生命周期——开始→状态指示；结束→状态清除
        // + phase_divider(compaction) 分隔线（进内容流，turn_complete 时随
        // content 一并提交，重载时由 pi_session 的 compaction 条目重建）。
        "compaction_start" | "compaction_end" => {
            let active = event_type == "compaction_start";
            let reason = event
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            // 分隔线两态：开始即入列「上下文压缩中…」，结束时 store 原地替换
            // 为「上下文已压缩」（见 use-stream-store phase_divider 分支）——
            // 用户可从分隔线本身看出压缩进度。
            if active {
                vec![
                    NormalizedEvent::PhaseDivider {
                        phase: "compaction".to_string(),
                        title: "上下文压缩中…".to_string(),
                    },
                    NormalizedEvent::CompactionStatus { active: true, reason },
                ]
            } else {
                vec![
                    NormalizedEvent::CompactionStatus { active: false, reason },
                    NormalizedEvent::PhaseDivider {
                        phase: "compaction".to_string(),
                        title: "上下文已压缩".to_string(),
                    },
                ]
            }
        }

        // -- Streaming text/thinking from assistant message ---------------
        "message_update" => {
            let ame = match event.get("assistantMessageEvent") {
                Some(v) => v,
                None => return vec![],
            };
            let sub_type = ame.get("type").and_then(|v| v.as_str()).unwrap_or_default();
            match sub_type {
                "text_delta" => {
                    let delta = ame
                        .get("delta")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    if delta.is_empty() {
                        vec![]
                    } else {
                        vec![NormalizedEvent::TextDelta {
                            delta: delta.to_string(),
                        }]
                    }
                }
                "thinking_delta" => {
                    let delta = ame
                        .get("delta")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    if delta.is_empty() {
                        vec![]
                    } else {
                        vec![NormalizedEvent::Thinking {
                            delta: delta.to_string(),
                        }]
                    }
                }
                _ => vec![],
            }
        }

        // -- Tool execution lifecycle -------------------------------------
        "tool_execution_start" => {
            let call_id = event
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let tool = event
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let input = event
                .get("args")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if call_id.is_empty() {
                vec![]
            } else {
                let interactions = interaction_requests_from_tool_call(&call_id, &tool, &input);
                if interactions.is_empty() {
                    let view = crate::agent::tool_view::classify_tool_view(&tool, &input);
                    vec![NormalizedEvent::ToolUseStart {
                        call_id,
                        tool,
                        input,
                        view: Some(view),
                    }]
                } else {
                    // Pi follows this tool start with an extension_ui_request
                    // carrying the real response id. Emitting an interaction
                    // here creates a duplicate, non-answerable question.
                    vec![]
                }
            }
        }
        "tool_execution_end" => {
            let call_id = event
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let is_error = event
                .get("isError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result = event
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if call_id.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::ToolUseResult {
                    call_id,
                    output: result,
                    is_error,
                }]
            }
        }

        // -- Turn lifecycle -----------------------------------------------
        "turn_end" => {
            let stop_reason = event
                .get("message")
                .and_then(|m| m.get("stopReason"))
                .and_then(|v| v.as_str())
                .unwrap_or("end_turn");
            // When stopReason is "toolUse", the turn ended because the LLM
            // requested a tool call.  Pi will execute the tool and continue
            // the conversation (generating more text_delta events).  We must
            // NOT emit TurnComplete here — otherwise the frontend drops the
            // streaming state and discards all subsequent events.
            if stop_reason == "toolUse" {
                return vec![];
            }
            let reason = match stop_reason {
                "aborted" => TurnEndReason::Aborted,
                "max_tokens" => TurnEndReason::MaxTokens,
                "error" => TurnEndReason::Error,
                _ => TurnEndReason::Complete,
            };
            vec![NormalizedEvent::TurnComplete {
                reason,
                usage: pi_turn_usage(event, context_window),
            }]
        }

        // -- Session header (emitted in --mode json print mode) -----------
        "session" => {
            if let Some(sid) = event.get("id").and_then(|v| v.as_str()) {
                vec![NormalizedEvent::SessionResolved {
                    session_id: sid.to_string(),
                }]
            } else {
                vec![]
            }
        }

        // -- Steer injection marker --------------------------------------
        // Pi emits `message_start`/`message_end` with `role=user` for a
        // queued steer at the moment it is delivered (typically at a tool-call
        // gap, mid-turn). Surface the steer text so the frontend can split the
        // accumulated assistant content at the injection point and interleave
        // the steer between the two assistant segments — matching the order Pi
        // persists to the session JSONL. The companion `message_end` carries
        // the same payload; one marker per steer is enough, so only
        // `message_start` is converted. Assistant `message_start`
        // (role=assistant) is still ignored: the assistant content arrives
        // incrementally via `message_update` above.
        "message_start" => {
            // Detect PhaseDivider before checking the message role. Extension
            // sendMessage markers use role=custom, while normal steer markers
            // use role=user.
            let custom_type = event
                .get("message")
                .and_then(|m| m.get("customType"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if custom_type.starts_with("jishu-conductor:phase-enter:") {
                let phase = custom_type
                    .strip_prefix("jishu-conductor:phase-enter:")
                    .unwrap_or("");
                let title = match phase {
                    "discuss" => "需求讨论",
                    "plan" => "流程规划",
                    "execute" => "流程执行",
                    "done" => "已完成",
                    other => other,
                };
                return vec![NormalizedEvent::PhaseDivider {
                    phase: phase.to_string(),
                    title: title.to_string(),
                }];
            }

            let role = event
                .get("message")
                .and_then(|m| m.get("role"))
                .and_then(|v| v.as_str());
            if role != Some("user") {
                return vec![];
            }

            let content = event
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|v| v.as_array())
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|block| {
                            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                block
                                    .get("text")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string)
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if content.is_empty() {
                return vec![];
            }
            // v0.8.0 需求10 修复：pi 对**每条**送达的用户消息都回显
            // message_start(role=user)——含正常 prompt 与压缩前排队的消息；
            // 只有经 Steer 命令注入的文本才是真正的引导（连接循环登记，
            // 此处按文匹配消费），否则会把用户消息误标为「已引导」并重复渲染。
            match pending_steers.iter().position(|s| s == &content) {
                Some(idx) => {
                    pending_steers.remove(idx);
                    vec![NormalizedEvent::SteerInjected { content }]
                }
                None => vec![],
            }
        }

        // 需求1 A7：thinking 级别变更（Pi clamp 后的生效值）。
        "thinking_level_changed" => {
            let level = event
                .get("level")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if level.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::ThinkingLevelChanged { level }]
            }
        }

        // All other event types (agent_start, agent_end, turn_start,
        // message_end, tool_execution_update) are ignored.
        _ => vec![],
    }
}

// ---------------------------------------------------------------------------
// Event emission helpers
// ---------------------------------------------------------------------------

/// Convert a Pi `extension_ui_request` event to a `NormalizedEvent::InteractionRequest`.
///
/// Pi's extension_ui protocol emits requests for select/input/confirm. Only
/// `select` and `input` are converted (they require a user response). Fire-and-
/// forget methods (notify, setStatus, etc.) are ignored.
/// v0.8.0 需求1 P-2：审批型 extension_ui 的待回写登记（Delegate 路径）。
struct PiToolApproval {
    request_id: String,
    tool: String,
    summary: String,
}

fn convert_extension_ui_request(msg: &serde_json::Value) -> Option<NormalizedEvent> {
    let method = msg.get("method").and_then(|v| v.as_str())?;
    let id = msg.get("id").and_then(|v| v.as_str())?.to_string();
    match method {
        "select" | "multiSelect" => {
            let allow_multiple = method == "multiSelect";
            let title = msg
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("请选择")
                .to_string();
            let options = msg
                .get("options")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| {
                            v.as_str().map(|s| InteractionOption {
                                option_id: s.to_string(),
                                label: s.to_string(),
                                description: None,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(NormalizedEvent::InteractionRequest {
                request_id: id,
                prompt: title,
                options,
                allow_multiple,
                allow_custom_text: true,
                required: true,
                // Pi `extension_ui` is the production mid-turn baseline.
                transport: InteractionTransport::PiRpc,
                origin: InteractionOrigin::ExtensionUi,
                delivery_hint: InteractionDeliveryHint::MidTurn,
                correlation: None,
            })
        }
        "input" => {
            let title = msg
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("请输入")
                .to_string();
            Some(NormalizedEvent::InteractionRequest {
                request_id: id,
                prompt: title,
                options: vec![],
                allow_multiple: false,
                allow_custom_text: true,
                required: true,
                transport: InteractionTransport::PiRpc,
                origin: InteractionOrigin::ExtensionUi,
                delivery_hint: InteractionDeliveryHint::MidTurn,
                correlation: None,
            })
        }
        // setStatus with key "jishu-conductor-phase" → PhaseDivider event
        "setStatus" => {
            let status_key = msg.get("statusKey").and_then(|v| v.as_str()).unwrap_or("");
            let status_text = msg.get("statusText").and_then(|v| v.as_str()).unwrap_or("");
            if status_key == "jishu-conductor-phase" && !status_text.is_empty() {
                let title = match status_text {
                    "discuss" => "需求讨论",
                    "plan" => "流程规划",
                    "execute" => "流程执行",
                    "done" => "已完成",
                    other => other,
                };
                Some(NormalizedEvent::PhaseDivider {
                    phase: status_text.to_string(),
                    title: title.to_string(),
                })
            } else {
                None
            }
        }
        // confirm, notify, setWidget, setTitle, set_editor_text:
        // fire-and-forget or not mapped to InteractionRequest.
        _ => None,
    }
}

/// hub_invoke 桥接命令分发（Phase 2：Conductor 扩展 → Hub 后端）。
///
/// 扩展通过带保留标题前缀的 `extension_ui_request(method="select")` 发起同步调用，
/// Hub 直接执行后端函数并通过 extension_ui_response 返回结果，不经过前端。
/// 设计依据：`jishu-task-conductor_实施计划.md` Phase 2 任务 2.2。
fn handle_hub_invoke(
    command: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match command {
        "conductor_sync_phase" => {
            let request: crate::task_launch::ConductorSyncPhaseRequest =
                serde_json::from_value(params.clone())
                    .map_err(|e| format!("conductor_sync_phase 参数解析失败: {e}"))?;
            let result = crate::task_launch::conductor_sync_phase(request)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "conductor_load_task_state" => {
            let project_root = params
                .get("project_root")
                .or_else(|| params.get("projectRoot"))
                .and_then(|v| v.as_str())
                .ok_or("conductor_load_task_state: project_root is required")?;
            let task_id = params
                .get("task_id")
                .or_else(|| params.get("taskId"))
                .and_then(|v| v.as_str())
                .ok_or("conductor_load_task_state: task_id is required")?;
            let result = crate::task_launch::conductor_load_task_state(project_root, task_id)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "orchestrator_validate_proposal" => {
            let request: crate::task_launch::ValidateProposalRequest =
                serde_json::from_value(params.clone())
                    .map_err(|e| format!("orchestrator_validate_proposal 参数解析失败: {e}"))?;
            let result = crate::task_launch::orchestrator_validate_proposal(request)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "orchestrator_start_run_from_revision" => {
            let request: crate::task_launch::StartRunFromRevisionRequest =
                serde_json::from_value(params.clone()).map_err(|e| {
                    format!("orchestrator_start_run_from_revision 参数解析失败: {e}")
                })?;
            let result = crate::task_launch::orchestrator_start_run_from_revision(request)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        _ => Err(format!("未知 hub_invoke 命令: {command}")),
    }
}

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
    #[test]
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
    #[test]
    fn tool_use_turn_end_yields_no_events() {
        let events = normalize_pi_agent_event(
            &json!({
                "type": "turn_end",
                "message": { "stopReason": "toolUse" }
            }),
            None,
            &mut Vec::new(),
 );;
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
 );;
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
 );;

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
 );;

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
        assert!(events.is_empty(), "prompt 回显不应产生 steer 事件: {events:?}");
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
 );;
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
 );;
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
