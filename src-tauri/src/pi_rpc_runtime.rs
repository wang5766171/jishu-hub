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
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::acp_runtime::{tauri_event_emitter, AcpCommand, AcpControl, AcpEventEmit};
use crate::agent::normalized::{
    interaction_requests_from_tool_call, InteractionDeliveryHint, InteractionOption,
    InteractionOrigin, InteractionTransport, NormalizedEvent, TurnEndReason,
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
    first_message: String,
    resolved_session_prompt_injection: Option<ResolvedSessionPromptInjection>,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    let emit = tauri_event_emitter(app, agent_id);
    spawn_pi_rpc_session_inner(
        emit,
        pending_session_id,
        child,
        first_message,
        resolved_session_prompt_injection,
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
    pending_session_id: String,
    child: tokio::process::Child,
    first_message: String,
    resolved_session_prompt_injection: Option<ResolvedSessionPromptInjection>,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    spawn_pi_rpc_session_inner(
        emit,
        pending_session_id,
        child,
        first_message,
        resolved_session_prompt_injection,
        on_finish,
        on_session_resolved,
    )
}

fn spawn_pi_rpc_session_inner(
    emit: AcpEventEmit,
    pending_session_id: String,
    mut child: tokio::process::Child,
    first_message: String,
    resolved_session_prompt_injection: Option<ResolvedSessionPromptInjection>,
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
    };
    let control_clone = control.clone();

    tauri::async_runtime::spawn(async move {
        let result = pi_rpc_connection_loop(
            emit.clone(),
            pending_session_id.clone(),
            stdin_arc,
            acp_session_id,
            stdout,
            cmd_rx,
            first_message,
            resolved_session_prompt_injection,
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
    pending_session_id: String,
    stdin_arc: Arc<TokioMutex<ChildStdin>>,
    acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    stdout: tokio::process::ChildStdout,
    mut command_rx: tokio::sync::mpsc::Receiver<AcpCommand>,
    first_message: String,
    resolved_session_prompt_injection: Option<ResolvedSessionPromptInjection>,
    on_session_resolved: &(dyn Fn(&str) + Send + Sync),
) -> Result<(), String> {
    // 1. stdout reader sub-task
    let (stdout_tx, mut stdout_rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(stdout_reader(stdout, stdout_tx));

    // 2. Get session ID via get_state command
    send_pi_command(&stdin_arc, &json!({"type": "get_state"})).await?;

    // Read lines until we get the get_state response
    let session_id = loop {
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
    on_session_resolved(&session_id);

    // 3. Send first prompt
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

    // 4. Main loop
    let mut state = LoopState::Prompting;
    // 当前 pending 的 extension_ui_request id（select/input 等待用户响应时）。
    // abort 时用它发 cancelled response 释放 pi 的阻塞，否则 pi 卡在等响应、abort 推进不了。
    let mut pending_interaction_id: Option<String> = None;
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

    loop {
        let cmd_future = command_rx.recv();
        let idle_deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;

        let exit = tokio::select! {
            cmd = cmd_future => {
                match cmd {
                    Some(AcpCommand::Prompt(msg)) => {
                        log::info!("Pi RPC loop received Prompt command");
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
                                state = LoopState::Prompting;
                            }
                            LoopState::Prompting => {
                                log::warn!("Pi RPC prompt ignored: still in Prompting state");
                            }
                            LoopState::CancelPending { pending_prompt } => {
                                *pending_prompt = Some(msg);
                            }
                        }
                        false
                    }
                    Some(AcpCommand::Steer(msg)) => {
                        // Pi RPC native steer: inject text into the current turn.
                        // The agent considers it while continuing — no turn restart.
                        send_pi_command(&stdin_arc, &json!({
                            "type": "steer",
                            "message": msg
                        })).await?;
                        log::debug!("Pi RPC steer sent");
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
                    Some(AcpCommand::ResolvePermission { response, .. }) => {
                        let _ = response.send(Err(
                            "Pi RPC does not use the ACP permission response channel".to_string(),
                        ));
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
                                            log::debug!("Pi RPC response for {}: success=true", response_cmd);
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
                        let events = normalize_pi_agent_event(&msg);

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
                            if matches!(state, LoopState::CancelPending { .. }) {
                                pending_turn_complete = Some(NormalizedEvent::TurnComplete {
                                    reason: TurnEndReason::Aborted,
                                    usage: None,
                                });
                            }
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
pub(crate) fn normalize_pi_agent_event(event: &serde_json::Value) -> Vec<NormalizedEvent> {
    let event_type = match event.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return vec![],
    };

    match event_type {
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
                    vec![NormalizedEvent::ToolUseStart {
                        call_id,
                        tool,
                        input,
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
                usage: None,
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
                vec![]
            } else {
                vec![NormalizedEvent::SteerInjected { content }]
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
        _ => Err(format!("未知 hub_invoke 命令: {command}")),
    }
}

fn pi_prompt_is_settled(event_type: &str) -> bool {
    event_type == "agent_settled"
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
    use super::*;

    #[test]
    fn waits_for_agent_settled_before_completing_prompt() {
        assert!(!pi_prompt_is_settled("agent_end"));
        assert!(!pi_prompt_is_settled("turn_end"));
        assert!(pi_prompt_is_settled("agent_settled"));
    }

    #[test]
    fn ignores_request_user_input_tool_start_until_extension_ui_request_arrives() {
        let events = normalize_pi_agent_event(&json!({
            "type": "tool_execution_start",
            "toolCallId": "call-1",
            "toolName": "request_user_input",
            "args": {
                "question": "请选择发布方式",
                "options": ["A", "B"]
            }
        }));

        assert!(events.is_empty());
    }

    #[test]
    fn detects_custom_role_phase_enter_marker() {
        let events = normalize_pi_agent_event(&json!({
            "type": "message_start",
            "message": {
                "role": "custom",
                "customType": "jishu-conductor:phase-enter:plan",
                "content": "进入流程规划阶段",
                "display": true,
                "timestamp": 0
            }
        }));

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
        // Pi emits this for a queued steer delivered at a tool-call gap.
        let events = normalize_pi_agent_event(&json!({
            "type": "message_start",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "改用 TypeScript 实现" }],
                "timestamp": 0
            }
        }));

        match events.as_slice() {
            [NormalizedEvent::SteerInjected { content }] => {
                assert_eq!(content, "改用 TypeScript 实现");
            }
            other => panic!("expected [SteerInjected], got {other:?}"),
        }
    }

    #[test]
    fn ignores_assistant_role_message_start() {
        // Assistant content arrives via message_update, so the assistant
        // message_start must not be surfaced (it carries no steer).
        let events = normalize_pi_agent_event(&json!({
            "type": "message_start",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "" }],
                "timestamp": 0
            }
        }));
        assert!(events.is_empty());
    }

    #[test]
    fn ignores_message_end_for_steer() {
        // Only message_start is converted; message_end is a duplicate marker.
        let events = normalize_pi_agent_event(&json!({
            "type": "message_end",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "steer text" }],
                "timestamp": 0
            }
        }));
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
