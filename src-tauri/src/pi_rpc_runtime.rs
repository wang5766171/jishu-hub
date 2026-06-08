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
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::acp_runtime::{AcpCommand, AcpControl};
use crate::agent::normalized::{NormalizedEvent, TurnEndReason};
use crate::cli_runtime::{AgentStreamChunk, StreamChunk};

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
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    let stdin = child.stdin.take().expect("Pi RPC process must have stdin");
    let stdout = child.stdout.take().expect("Pi RPC process must have stdout");
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
    };
    let control_clone = control.clone();

    tauri::async_runtime::spawn(async move {
        let result = pi_rpc_connection_loop(
            app.clone(),
            agent_id.clone(),
            pending_session_id.clone(),
            stdin_arc,
            acp_session_id,
            stdout,
            cmd_rx,
            first_message,
            &on_session_resolved,
        )
        .await;

        if let Err(err) = &result {
            // Enrich error with stderr output
            let stderr_content = stderr_buf.lock().await.clone();
            let enriched_err = if !stderr_content.trim().is_empty() {
                // Take last 500 chars of stderr for the error message
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
                NormalizedEvent::Error {
                    message: enriched_err,
                    recoverable: false,
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Error,
                    usage: None,
                },
            ];
            emit_events(&app, &agent_id, &pending_session_id, &events);
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
    CancelPending {
        pending_prompt: Option<String>,
    },
}

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

#[allow(clippy::too_many_arguments)]
async fn pi_rpc_connection_loop(
    app: tauri::AppHandle,
    agent_id: String,
    pending_session_id: String,
    stdin_arc: Arc<TokioMutex<ChildStdin>>,
    acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    stdout: tokio::process::ChildStdout,
    mut command_rx: tokio::sync::mpsc::Receiver<AcpCommand>,
    first_message: String,
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
        let mut guard = acp_session_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *guard = Some(session_id.clone());
    }

    // Emit SessionResolved
    emit_events(
        &app,
        &agent_id,
        &pending_session_id,
        &[NormalizedEvent::SessionResolved {
            session_id: session_id.clone(),
        }],
    );
    on_session_resolved(&session_id);

    // 3. Send first prompt
    send_pi_command(
        &stdin_arc,
        &json!({"type": "prompt", "message": first_message}),
    )
    .await?;
    log::debug!("Pi RPC sent first prompt");

    // 4. Main loop
    let mut state = LoopState::Prompting;
    let mut buf: Vec<StreamChunk> = Vec::with_capacity(32);
    let mut last_flush = std::time::Instant::now();

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
                    Some(AcpCommand::Cancel) => {
                        match &state {
                            LoopState::Prompting => {
                                let _ = send_pi_command(&stdin_arc, &json!({
                                    "type": "abort"
                                })).await;
                                log::info!("Pi RPC cancel sent");
                                state = LoopState::CancelPending {
                                    pending_prompt: None,
                                };
                            }
                            LoopState::Idle | LoopState::CancelPending { .. } => {}
                        }
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
                                        // Prompt accepted, events will follow
                                        log::debug!("Pi RPC response for {}: success={}", response_cmd, success);
                                    }
                                    "abort" => {
                                        log::info!("Pi RPC abort acknowledged");
                                        // Emit TurnComplete for the cancelled turn
                                        let has_pending = matches!(
                                            &state,
                                            LoopState::CancelPending { pending_prompt: Some(_), .. }
                                        );
                                        if !has_pending {
                                            buf.push(make_chunk(&session_id, &NormalizedEvent::TurnComplete {
                                                reason: TurnEndReason::Aborted,
                                                usage: None,
                                            }));
                                            flush_buf(&app, &agent_id, &mut buf);
                                        }

                                        // State transition
                                        state = if let LoopState::CancelPending { pending_prompt } = &mut state {
                                            let buffered = pending_prompt.take();
                                            if let Some(msg) = buffered {
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
                                    buf.push(make_chunk(&session_id, &NormalizedEvent::Error {
                                        message: error_msg.to_string(),
                                        recoverable: false,
                                    }));
                                    buf.push(make_chunk(&session_id, &NormalizedEvent::TurnComplete {
                                        reason: TurnEndReason::Error,
                                        usage: None,
                                    }));
                                    flush_buf(&app, &agent_id, &mut buf);
                                    state = LoopState::Idle;
                                    continue;
                                }

                                // Periodic flush
                                if buf.len() >= 32 || last_flush.elapsed() >= Duration::from_millis(8) {
                                    flush_buf(&app, &agent_id, &mut buf);
                                    last_flush = std::time::Instant::now();
                                }
                                continue;
                            }
                        }

                        // Handle AgentEvent objects
                        let events = normalize_pi_agent_event(&msg);
                        let has_turn_complete = events.iter().any(|e| matches!(e, NormalizedEvent::TurnComplete { .. }));
                        for event in &events {
                            buf.push(make_chunk(&session_id, event));
                        }

                        if has_turn_complete {
                            flush_buf(&app, &agent_id, &mut buf);
                            last_flush = std::time::Instant::now();

                            // Handle cancel-pending with buffered prompt
                            state = if let LoopState::CancelPending { pending_prompt } = &mut state {
                                let buffered = pending_prompt.take();
                                if let Some(msg) = buffered {
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
                        } else {
                            // Periodic flush
                            if buf.len() >= 32 || last_flush.elapsed() >= Duration::from_millis(8) {
                                flush_buf(&app, &agent_id, &mut buf);
                                last_flush = std::time::Instant::now();
                            }
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
        flush_buf(&app, &agent_id, &mut buf);
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

async fn stdout_reader(
    stdout: tokio::process::ChildStdout,
    tx: tokio::sync::mpsc::Sender<String>,
) {
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
fn normalize_pi_agent_event(event: &serde_json::Value) -> Vec<NormalizedEvent> {
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
                    let delta = ame.get("delta").and_then(|v| v.as_str()).unwrap_or_default();
                    if delta.is_empty() {
                        vec![]
                    } else {
                        vec![NormalizedEvent::TextDelta {
                            delta: delta.to_string(),
                        }]
                    }
                }
                "thinking_delta" => {
                    let delta = ame.get("delta").and_then(|v| v.as_str()).unwrap_or_default();
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
            if call_id.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::ToolUseStart {
                    call_id,
                    tool,
                    input: serde_json::Value::Null,
                }]
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
            let result = event.get("result").cloned().unwrap_or(serde_json::Value::Null);
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

        // All other event types (agent_start, agent_end, turn_start,
        // message_start, message_end, tool_execution_update) are ignored.
        _ => vec![],
    }
}

// ---------------------------------------------------------------------------
// Event emission helpers
// ---------------------------------------------------------------------------

fn make_chunk(session_id: &str, event: &NormalizedEvent) -> StreamChunk {
    StreamChunk {
        session_id: session_id.to_string(),
        event_type: event.event_type().to_string(),
        data: serde_json::to_value(event).unwrap_or_default(),
    }
}

fn emit_events(
    app: &tauri::AppHandle,
    agent_id: &str,
    session_id: &str,
    events: &[NormalizedEvent],
) {
    let chunks: Vec<AgentStreamChunk> = events
        .iter()
        .filter_map(|event| {
            let data = serde_json::to_value(event).ok()?;
            Some(AgentStreamChunk {
                agent_id: agent_id.to_string(),
                session_id: session_id.to_string(),
                event_type: event.event_type().to_string(),
                data,
            })
        })
        .collect();
    if !chunks.is_empty() {
        let _ = app.emit("agent-event", &chunks);
    }
}

fn flush_buf(app: &tauri::AppHandle, agent_id: &str, buf: &mut Vec<StreamChunk>) {
    if buf.is_empty() {
        return;
    }
    let chunks: Vec<AgentStreamChunk> = buf
        .iter()
        .map(|chunk| AgentStreamChunk {
            agent_id: agent_id.to_string(),
            session_id: chunk.session_id.clone(),
            event_type: chunk.event_type.clone(),
            data: chunk.data.clone(),
        })
        .collect();
    let _ = app.emit("agent-event", &chunks);
    buf.clear();
}
