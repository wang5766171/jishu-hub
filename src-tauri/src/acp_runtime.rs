//! Tauri-internal ACP runtime: manages agent subprocess lifecycle within the
//! desktop app. Uses mpsc channels for in-process communication between the
//! Tauri webview and spawned agent CLIs.
//!
//! This is distinct from `acp/` which implements the stdio JSON-RPC 2.0
//! **external** protocol (per `protocols-spec.md §7`) for editor integrations
//! (Zed, JetBrains). This module is the **internal** consumer that spawns
//! agents and relays their NormalizedEvent streams to the GUI.

use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::agent::normalized::{
    interaction_requests_from_tool_call, NormalizedEvent, TurnEndReason, UsageStats,
};
use crate::cli_runtime::AgentStreamChunk;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Commands sent to the persistent ACP connection task.
pub enum AcpCommand {
    Prompt(String),
    Cancel,
    /// Respond to a Pi extension_ui_request (pause-resume for Jishu Agent).
    /// `id` is the extension_ui_request id; `value` is the user's choice/input.
    RespondToInput {
        id: String,
        value: String,
    },
    ResolvePermission {
        request_id: String,
        approved: bool,
        response: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    Shutdown,
}

/// Handle stored in `ChatProcess.acp` for communicating with the connection task.
#[derive(Clone)]
pub struct AcpControl {
    pub(crate) tx: tokio::sync::mpsc::Sender<AcpCommand>,
    pub(crate) acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
}

impl AcpControl {
    pub async fn send_prompt(&self, message: String) -> Result<(), String> {
        self.tx
            .send(AcpCommand::Prompt(message))
            .await
            .map_err(|_| "ACP connection closed".to_string())
    }

    pub fn resolved_session_id(&self) -> Option<String> {
        self.acp_session_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub async fn send_cancel(&self) {
        let _ = self.tx.send(AcpCommand::Cancel).await;
    }

    /// Respond to a Pi extension_ui_request (planning-phase pause-resume).
    pub async fn respond_to_input(&self, id: String, value: String) -> Result<(), String> {
        self.tx
            .send(AcpCommand::RespondToInput { id, value })
            .await
            .map_err(|_| "ACP connection closed".to_string())
    }

    pub async fn resolve_permission(
        &self,
        request_id: String,
        approved: bool,
    ) -> Result<(), String> {
        let (response, receiver) = tokio::sync::oneshot::channel();
        self.tx
            .send(AcpCommand::ResolvePermission {
                request_id,
                approved,
                response,
            })
            .await
            .map_err(|_| "ACP connection closed".to_string())?;
        receiver
            .await
            .map_err(|_| "ACP permission response channel closed".to_string())?
    }

    pub async fn shutdown(&self) {
        let _ = self.tx.send(AcpCommand::Shutdown).await;
    }
}

/// Where the ACP connection loop sends its normalized events. A callback (not an
/// enum) decouples the loop from `tauri::AppHandle`: the GUI/chat path supplies a
/// closure that emits Tauri `agent-event` chunks; the orchestrator (no
/// `AppHandle`, design §3.1/D4) supplies a closure that pushes into a channel.
/// A callback is used instead of an enum-with-a-channel-variant because
/// constructing that enum variant in the test binary triggered a Windows
/// toolchain load-time entry-point failure (STATUS_ENTRYPOINT_NOT_FOUND); a
/// plain closure capturing a channel does not.
pub type AcpEventEmit = Arc<dyn Fn(&[NormalizedEvent], &str) + Send + Sync>;

/// Build the GUI/chat event emitter: emits `agent-event` chunks to the webview.
pub fn tauri_event_emitter(app: tauri::AppHandle, agent_id: String) -> AcpEventEmit {
    Arc::new(move |events: &[NormalizedEvent], session_id: &str| {
        let chunks: Vec<AgentStreamChunk> = events
            .iter()
            .filter_map(|event| {
                let data = serde_json::to_value(event).ok()?;
                Some(AgentStreamChunk {
                    agent_id: agent_id.clone(),
                    session_id: session_id.to_string(),
                    event_type: event.event_type().to_string(),
                    data,
                })
            })
            .collect();
        if !chunks.is_empty() {
            let _ = app.emit("agent-event", &chunks);
        }
    })
}

// ---------------------------------------------------------------------------
// Internal: JSON-RPC writer
// ---------------------------------------------------------------------------

struct AcpWriter {
    stdin: Arc<TokioMutex<ChildStdin>>,
    next_id: i64,
}

impl AcpWriter {
    fn new(stdin: Arc<TokioMutex<ChildStdin>>) -> Self {
        Self { stdin, next_id: 0 }
    }

    async fn request(&mut self, method: &str, params: serde_json::Value) -> Result<i64, String> {
        let mut stdin = self.stdin.lock().await;
        write_jsonrpc_request(&mut *stdin, &mut self.next_id, method, params).await
    }

    /// Send a JSON-RPC response for a server-initiated request (e.g. tool approval).
    async fn respond(
        &self,
        id: &serde_json::Value,
        result: serde_json::Value,
    ) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        });
        let line = format!("{}\n", msg);
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("ACP write error: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("ACP flush error: {e}"))?;
        Ok(())
    }
}

pub enum AcpResponse {
    Update(Vec<NormalizedEvent>),
    PermissionRequest {
        id: serde_json::Value,
        params: serde_json::Value,
    },
    Result(serde_json::Value),
    Error(String),
    Ignored,
}

pub async fn write_jsonrpc_request(
    stdin: &mut (impl tokio::io::AsyncWrite + Unpin),
    next_id: &mut i64,
    method: &str,
    params: serde_json::Value,
) -> Result<i64, String> {
    let id = *next_id;
    *next_id += 1;
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });
    let line = format!("{}\n", msg);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("ACP write error: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("ACP flush error: {e}"))?;
    Ok(id)
}

pub fn handle_acp_response_line(
    line: &str,
    target_id: i64,
    usage: &mut Option<UsageStats>,
) -> Result<AcpResponse, String> {
    if line.trim().is_empty() {
        return Ok(AcpResponse::Ignored);
    }
    let msg: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("ACP JSON parse error: {e}"))?;

    if msg.get("method").and_then(|v| v.as_str()) == Some("session/update") {
        if let Some(params) = msg.get("params") {
            let events = normalize_acp_update(params, usage);
            return Ok(AcpResponse::Update(events));
        }
    } else if msg.get("method").and_then(|v| v.as_str()) == Some("session/request_permission") {
        let id = msg
            .get("id")
            .cloned()
            .ok_or_else(|| "ACP permission request missing id".to_string())?;
        let params = msg.get("params").cloned().unwrap_or_default();
        return Ok(AcpResponse::PermissionRequest { id, params });
    } else if msg.get("id").and_then(|v| v.as_i64()) == Some(target_id) {
        if let Some(err) = msg.get("error") {
            return Ok(AcpResponse::Error(
                err.get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
            ));
        }
        if let Some(res) = msg.get("result") {
            return Ok(AcpResponse::Result(res.clone()));
        }
        return Err("ACP response missing result or error".to_string());
    }
    Ok(AcpResponse::Ignored)
}

// ---------------------------------------------------------------------------
// Internal: connection loop state machine
// ---------------------------------------------------------------------------

enum LoopState {
    Idle,
    Prompting {
        prompt_id: i64,
    },
    CancelPending {
        old_prompt_id: i64,
        pending_prompt: Option<String>,
    },
}

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug)]
struct PendingPermission {
    rpc_id: serde_json::Value,
    allow_option_id: Option<String>,
    reject_option_id: Option<String>,
}

fn permission_request_key(id: &serde_json::Value) -> String {
    id.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string())
}

pub(crate) fn permission_option_id(params: &serde_json::Value, approved: bool) -> Option<String> {
    let options = params.get("options")?.as_array()?;
    options.iter().find_map(|option| {
        let option_id = option.get("optionId").and_then(|value| value.as_str())?;
        let kind = option
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let option_id_lower = option_id.to_ascii_lowercase();
        let matches = if approved {
            kind.contains("allow")
                || kind.contains("approve")
                || option_id_lower.contains("allow")
                || option_id_lower.contains("approve")
        } else {
            kind.contains("reject")
                || kind.contains("deny")
                || option_id_lower.contains("reject")
                || option_id_lower.contains("deny")
        };
        matches.then(|| option_id.to_string())
    })
}

pub(crate) async fn write_permission_response(
    stdin: &mut (impl tokio::io::AsyncWrite + Unpin),
    id: &serde_json::Value,
    option_id: &str,
) -> Result<(), String> {
    let message = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "outcome": {
                "outcome": "selected",
                "optionId": option_id
            }
        }
    });
    stdin
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|error| format!("ACP permission response write error: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("ACP permission response flush error: {error}"))
}

async fn reject_pending_permissions(
    writer: &AcpWriter,
    pending_permissions: &mut HashMap<String, PendingPermission>,
) {
    for (_, pending) in pending_permissions.drain() {
        let Some(option_id) = pending.reject_option_id else {
            log::warn!(
                "ACP permission request {:?} has no reject option; closing without approval",
                pending.rpc_id
            );
            continue;
        };
        if let Err(error) = writer
            .respond(
                &pending.rpc_id,
                json!({
                    "outcome": {
                        "outcome": "selected",
                        "optionId": option_id
                    }
                }),
            )
            .await
        {
            log::warn!("ACP failed to reject pending permission: {error}");
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Spawn the ACP driver: establishes a persistent connection and returns an
/// `AcpControl` for sending prompts, cancels, and shutdowns.
pub fn spawn_acp_session(
    app: tauri::AppHandle,
    agent_id: String,
    pending_session_id: String,
    mut child: tokio::process::Child,
    project_path: String,
    requested_session_id: Option<String>,
    first_message: String,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    let stdin = child.stdin.take().expect("ACP process must have stdin");
    let stdout = child.stdout.take().expect("ACP process must have stdout");

    let stdin_arc = Arc::new(TokioMutex::new(stdin));
    let acp_session_id = Arc::new(std::sync::Mutex::new(None::<String>));

    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(8);

    // stdout reader + event sink are constructed here so the connection loop can
    // run against a synthetic line stream / channel sink (tests, orchestrator).
    let (stdout_tx, stdout_rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(stdout_reader(stdout, stdout_tx));
    let emit = tauri_event_emitter(app.clone(), agent_id.clone());

    let control = AcpControl {
        tx: cmd_tx,
        acp_session_id: acp_session_id.clone(),
    };
    let control_clone = control.clone();

    tauri::async_runtime::spawn(async move {
        let result = acp_connection_loop(
            emit,
            pending_session_id.clone(),
            stdin_arc,
            acp_session_id,
            stdout_rx,
            project_path,
            requested_session_id,
            cmd_rx,
            first_message,
            &on_session_resolved,
        )
        .await;
        // stdin_arc is dropped here along with AcpWriter inside the loop.

        if let Err(err) = &result {
            log::warn!("ACP connection loop exited with error: {}", err);
            let events = vec![
                NormalizedEvent::Error {
                    message: err.clone(),
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
                "ACP connection loop exited normally for session {}",
                pending_session_id
            );
        }

        // Ensure child exits: stdin is already closed (AcpWriter dropped).
        // Wait up to 5s, then force-kill.
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => log::info!("ACP child exited with status: {}", status),
            Ok(Err(e)) => log::warn!("ACP child wait error: {}", e),
            Err(_) => {
                log::warn!("ACP child did not exit in 5s, force-killing");
                let pid = child.id().unwrap_or(0);
                let _ = crate::process_control::terminate_process_tree(pid);
            }
        }

        on_finish();
    });

    control_clone
}

// ---------------------------------------------------------------------------
// Internal: persistent connection loop
// ---------------------------------------------------------------------------

async fn acp_connection_loop(
    emit: AcpEventEmit,
    pending_session_id: String,
    stdin_arc: Arc<TokioMutex<ChildStdin>>,
    acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    mut stdout_rx: tokio::sync::mpsc::Receiver<String>,
    project_path: String,
    requested_session_id: Option<String>,
    mut command_rx: tokio::sync::mpsc::Receiver<AcpCommand>,
    first_message: String,
    on_session_resolved: &(dyn Fn(&str) + Send + Sync),
) -> Result<(), String> {
    let mut writer = AcpWriter::new(stdin_arc);

    // stdout reader is spawned by the caller (spawn_acp_session) so the loop can
    // be driven with a synthetic line stream in tests / by the orchestrator.

    // 2. Handshake: initialize → session/new
    let init_id = writer
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                },
                "clientInfo": {
                    "name": "jishu-hub",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
        .await?;
    wait_for_response(&mut stdout_rx, init_id).await?;

    let session_result = if let Some(session_id) = requested_session_id.as_deref() {
        let resume_id = writer
            .request(
                "session/resume",
                json!({
                    "sessionId": session_id,
                    "cwd": project_path,
                    "mcpServers": []
                }),
            )
            .await?;
        wait_for_response(&mut stdout_rx, resume_id).await?
    } else {
        let new_id = writer
            .request(
                "session/new",
                json!({
                    "cwd": project_path,
                    "mcpServers": []
                }),
            )
            .await?;
        wait_for_response(&mut stdout_rx, new_id).await?
    };
    let session_id = session_result
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "ACP session creation/resume did not return sessionId".to_string())?
        .to_string();

    log::info!(
        "ACP session established: {} (pending: {})",
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

    // 3. Send first message
    let prompt_id = writer
        .request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": first_message }]
            }),
        )
        .await?;
    log::debug!("ACP sent first prompt, id={}", prompt_id);

    // 4. Main loop
    let mut state = LoopState::Prompting { prompt_id };
    let mut usage: Option<UsageStats> = None;
    let mut buf: Vec<NormalizedEvent> = Vec::with_capacity(32);
    let mut last_flush = std::time::Instant::now();
    let mut pending_permissions: HashMap<String, PendingPermission> = HashMap::new();

    loop {
        let cmd_future = command_rx.recv();
        let idle_deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;

        let exit = tokio::select! {
            // Command branch
            cmd = cmd_future => {
                match cmd {
                    Some(AcpCommand::Prompt(msg)) => {
                        log::info!("ACP loop received Prompt command, current state={}", match &state {
                            LoopState::Idle => "Idle",
                            LoopState::Prompting { .. } => "Prompting",
                            LoopState::CancelPending { .. } => "CancelPending",
                        });
                        match &mut state {
                            LoopState::Idle => {
                                usage = None;
                                let id = writer.request("session/prompt", json!({
                                    "sessionId": session_id,
                                    "prompt": [{ "type": "text", "text": msg }]
                                })).await?;
                                log::info!("ACP sent prompt to pi, id={}", id);
                                state = LoopState::Prompting { prompt_id: id };
                            }
                            LoopState::Prompting { .. } => {
                                log::warn!("ACP prompt ignored: still in Prompting state");
                            }
                            LoopState::CancelPending { pending_prompt, .. } => {
                                if pending_prompt.is_some() {
                                    log::warn!("ACP pending prompt overwritten in CancelPending");
                                }
                                log::info!("ACP prompt buffered: waiting for cancel response");
                                *pending_prompt = Some(msg);
                            }
                        }
                        false
                    }
                    Some(AcpCommand::Cancel) => {
                        reject_pending_permissions(&writer, &mut pending_permissions).await;
                        match &state {
                            LoopState::Prompting { prompt_id } => {
                                let _ = writer.request("session/cancel", json!({
                                    "sessionId": session_id
                                })).await;
                                log::info!("ACP cancel sent for prompt_id={}", prompt_id);
                                state = LoopState::CancelPending {
                                    old_prompt_id: *prompt_id,
                                    pending_prompt: None,
                                };
                            }
                            LoopState::Idle | LoopState::CancelPending { .. } => {}
                        }
                        false
                    }
                    Some(AcpCommand::RespondToInput { .. }) => {
                        // ACP protocol does not use extension_ui; only Pi RPC does.
                        log::debug!("ACP RespondToInput ignored (ACP transport)");
                        false
                    }
                    Some(AcpCommand::ResolvePermission {
                        request_id,
                        approved,
                        response,
                    }) => {
                        let result = if let Some(pending) = pending_permissions.remove(&request_id) {
                            let option_id = if approved {
                                pending.allow_option_id
                            } else {
                                pending.reject_option_id
                            };
                            if let Some(option_id) = option_id {
                                writer.respond(
                                    &pending.rpc_id,
                                    json!({
                                        "outcome": {
                                            "outcome": "selected",
                                            "optionId": option_id
                                        }
                                    }),
                                ).await
                            } else {
                                Err(format!(
                                    "ACP permission request {request_id} does not expose a {} option",
                                    if approved { "safe approval" } else { "rejection" }
                                ))
                            }
                        } else {
                            Err(format!("ACP permission request {request_id} is no longer pending"))
                        };
                        let _ = response.send(result);
                        false
                    }
                    Some(AcpCommand::Shutdown) => {
                        reject_pending_permissions(&writer, &mut pending_permissions).await;
                        log::info!("ACP shutdown requested for session {}", session_id);
                        true
                    }
                    None => {
                        log::info!("ACP command channel closed for session {}", session_id);
                        true
                    }
                }
            }
            // Stdout branch
            line = stdout_rx.recv() => {
                match line {
                    Some(line) => {
                        if line.trim().is_empty() { continue; }
                        let msg: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };

                        // Check if this matches the current prompt response
                        let current_prompt_id = match &state {
                            LoopState::Prompting { prompt_id } => Some(*prompt_id),
                            LoopState::CancelPending { old_prompt_id, .. } => Some(*old_prompt_id),
                            LoopState::Idle => None,
                        };

                        if let Some(pid) = current_prompt_id {
                            if msg.get("id").and_then(|v| v.as_i64()) == Some(pid) {
                                log::info!("ACP got prompt response for id={}, state={}", pid, match &state {
                                    LoopState::Idle => "Idle",
                                    LoopState::Prompting { .. } => "Prompting",
                                    LoopState::CancelPending { .. } => "CancelPending",
                                });
                                // Suppress cancel response events when a pending prompt exists
                                // to prevent the TurnComplete from killing the new message's
                                // streamStore state in the frontend.
                                let has_pending = matches!(
                                    &state,
                                    LoopState::CancelPending { pending_prompt: Some(_), .. }
                                );
                                if !has_pending {
                                    handle_prompt_response(&msg, &mut usage, &mut buf);
                                    flush_buf(&emit, &session_id, &mut buf);
                                }

                                // State transition
                                state = if let LoopState::CancelPending { pending_prompt, .. } = &mut state {
                                    let buffered = pending_prompt.take();
                                    if let Some(msg) = buffered {
                                        usage = None;
                                        let new_id = writer.request("session/prompt", json!({
                                            "sessionId": session_id,
                                            "prompt": [{ "type": "text", "text": msg }]
                                        })).await?;
                                        log::info!("ACP sent buffered prompt after cancel, id={}", new_id);
                                        LoopState::Prompting { prompt_id: new_id }
                                    } else {
                                        log::info!("ACP state -> Idle after prompt response");
                                        LoopState::Idle
                                    }
                                } else {
                                    log::info!("ACP state -> Idle after prompt response");
                                    LoopState::Idle
                                };
                                continue;
                            }
                        }

                        // session/update notifications
                        if msg.get("method").and_then(|v| v.as_str()) == Some("session/update") {
                            if let Some(params) = msg.get("params") {
                                let events = normalize_acp_update(params, &mut usage);
                                for event in &events {
                                    buf.push(event.clone());
                                }
                            }
                        } else if msg.get("method").and_then(|v| v.as_str()) == Some("session/request_permission") {
                            let Some(rpc_id) = msg.get("id").cloned() else {
                                log::warn!("ACP permission request ignored because it has no id");
                                continue;
                            };
                            let params = msg.get("params").cloned().unwrap_or_default();
                            let request_id = permission_request_key(&rpc_id);
                            pending_permissions.insert(
                                request_id.clone(),
                                PendingPermission {
                                    rpc_id,
                                    allow_option_id: permission_option_id(&params, true),
                                    reject_option_id: permission_option_id(&params, false),
                                },
                            );
                            buf.push(NormalizedEvent::ApprovalRequest {
                                request_id,
                                approval_kind: crate::agent::normalized::ApprovalKind::Other,
                                payload: params,
                            });
                            flush_buf(&emit, &session_id, &mut buf);
                            last_flush = std::time::Instant::now();
                        } else {
                            log::debug!("ACP stdout ignored msg (no matching id, not session/update): method={:?}", msg.get("method"));
                        }

                        // Periodic flush
                        if buf.len() >= 32
                            || last_flush.elapsed() >= Duration::from_millis(8)
                        {
                            flush_buf(&emit, &session_id, &mut buf);
                            last_flush = std::time::Instant::now();
                        }
                        false
                    }
                    None => {
                        log::warn!("ACP stdout EOF for session {}", session_id);
                        true
                    }
                }
            }
            // Idle timeout
            _ = tokio::time::sleep_until(idle_deadline) => {
                if matches!(state, LoopState::Idle) {
                    log::info!(
                        "ACP idle timeout ({}s), shutting down session {}",
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
// Internal: stdout reader sub-task
// ---------------------------------------------------------------------------

async fn stdout_reader(stdout: tokio::process::ChildStdout, tx: tokio::sync::mpsc::Sender<String>) {
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if tx.send(line).await.is_err() {
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Internal: prompt response handler
// ---------------------------------------------------------------------------

fn handle_prompt_response(
    msg: &serde_json::Value,
    usage: &mut Option<UsageStats>,
    buf: &mut Vec<NormalizedEvent>,
) {
    if let Some(err) = msg.get("error") {
        let err_msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("ACP error");
        buf.push(NormalizedEvent::Error {
            message: err_msg.to_string(),
            recoverable: false,
        });
        buf.push(NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Error,
            usage: None,
        });
    } else {
        let stop_reason = msg
            .get("result")
            .and_then(|r| r.get("stopReason"))
            .and_then(|v| v.as_str())
            .unwrap_or("end_turn");

        if let Some(u) = msg.get("result").and_then(|r| r.get("usage")) {
            *usage = Some(UsageStats {
                input_tokens: u.get("inputTokens").and_then(|v| v.as_u64()),
                output_tokens: u.get("outputTokens").and_then(|v| v.as_u64()),
                total_cost: None,
                context_remaining: None,
            });
        }

        let reason = match stop_reason {
            "cancelled" => TurnEndReason::Aborted,
            "max_tokens" => TurnEndReason::MaxTokens,
            "refusal" | "error" => TurnEndReason::Error,
            _ => TurnEndReason::Complete,
        };
        buf.push(NormalizedEvent::TurnComplete {
            reason,
            usage: usage.take(),
        });
    }
}

// ---------------------------------------------------------------------------
// Internal: handshake response reader (channel-based with timeout)
// ---------------------------------------------------------------------------

async fn wait_for_response(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<String>,
    expected_id: i64,
) -> Result<serde_json::Value, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut dummy_usage = None;
    loop {
        let line = tokio::select! {
            line = stdout_rx.recv() => {
                line.ok_or_else(|| "ACP process closed before response".to_string())?
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err("ACP handshake timeout (30s)".to_string());
            }
        };

        match handle_acp_response_line(&line, expected_id, &mut dummy_usage)? {
            AcpResponse::Result(val) => return Ok(val),
            AcpResponse::Error(err) => return Err(format!("ACP error: {}", err)),
            _ => continue, // Ignore updates or other messages during handshake
        }
    }
}

// ---------------------------------------------------------------------------
// Event helpers (unchanged from original)
// ---------------------------------------------------------------------------

pub(crate) fn normalize_acp_update(
    params: &serde_json::Value,
    usage_acc: &mut Option<UsageStats>,
) -> Vec<NormalizedEvent> {
    let update = match params.get("update") {
        Some(u) => u,
        None => return vec![],
    };

    let update_type = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    match update_type {
        "agent_message_chunk" => {
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if text.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::TextDelta {
                    delta: text.to_string(),
                }]
            }
        }
        "agent_thought_chunk" => {
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if text.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::Thinking {
                    delta: text.to_string(),
                }]
            }
        }
        "tool_call" => {
            let call_id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let tool = update
                .get("toolName")
                .or_else(|| update.get("name"))
                .or_else(|| update.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let input = update
                .get("rawInput")
                .or_else(|| update.get("input"))
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
                    interactions
                }
            }
        }
        "tool_call_update" => {
            let call_id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            if call_id.is_empty() || status != "completed" {
                return vec![];
            }

            let output = update
                .get("content")
                .and_then(|c| {
                    if let Some(arr) = c.as_array() {
                        arr.first()
                            .and_then(|item| item.get("content"))
                            .and_then(|inner| inner.get("text"))
                            .cloned()
                    } else {
                        c.get("text").cloned()
                    }
                })
                .unwrap_or(serde_json::Value::Null);

            vec![NormalizedEvent::ToolUseResult {
                call_id,
                output,
                is_error: false,
            }]
        }
        "usage_update" => {
            *usage_acc = Some(UsageStats {
                input_tokens: None,
                output_tokens: None,
                total_cost: update
                    .get("cost")
                    .and_then(|c| c.get("amount"))
                    .and_then(|v| v.as_f64()),
                context_remaining: update
                    .get("size")
                    .and_then(|v| v.as_u64())
                    .zip(update.get("used").and_then(|v| v.as_u64()))
                    .map(|(size, used)| size.saturating_sub(used)),
            });
            vec![]
        }
        _ => vec![],
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

fn flush_buf(emit: &AcpEventEmit, session_id: &str, buf: &mut Vec<NormalizedEvent>) {
    if buf.is_empty() {
        return;
    }
    emit(buf, session_id);
    buf.clear();
}

// ---------------------------------------------------------------------------
// Tests (unchanged — only test normalize_acp_update)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_agent_message_chunk() {
        let params = json!({
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "messageId": "msg_1",
                "content": { "type": "text", "text": "Hello" }
            }
        });
        let mut usage = None;
        let events = normalize_acp_update(&params, &mut usage);
        assert_eq!(
            events,
            vec![NormalizedEvent::TextDelta {
                delta: "Hello".to_string()
            }]
        );
    }

    #[test]
    fn normalizes_agent_thought_chunk() {
        let params = json!({
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "messageId": "msg_1",
                "content": { "type": "text", "text": "thinking..." }
            }
        });
        let mut usage = None;
        let events = normalize_acp_update(&params, &mut usage);
        assert_eq!(
            events,
            vec![NormalizedEvent::Thinking {
                delta: "thinking...".to_string()
            }]
        );
    }

    #[test]
    fn normalizes_tool_call() {
        let params = json!({
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "call_001",
                "title": "Reading file",
                "kind": "other",
                "status": "pending"
            }
        });
        let mut usage = None;
        let events = normalize_acp_update(&params, &mut usage);
        assert_eq!(
            events,
            vec![NormalizedEvent::ToolUseStart {
                call_id: "call_001".to_string(),
                tool: "Reading file".to_string(),
                input: serde_json::Value::Null,
            }]
        );
    }

    #[test]
    fn normalizes_structured_interaction_tool_call() {
        let params = json!({
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "call_002",
                "toolName": "request_user_input",
                "rawInput": {
                    "prompt": "请选择权限模型",
                    "options": [
                        { "id": "rbac", "label": "RBAC" },
                        { "id": "abac", "label": "ABAC" }
                    ]
                },
                "status": "pending"
            }
        });
        let mut usage = None;
        let events = normalize_acp_update(&params, &mut usage);

        assert!(matches!(
            events.as_slice(),
            [NormalizedEvent::InteractionRequest {
                request_id,
                prompt,
                ..
            }] if request_id == "call_002:1" && prompt == "请选择权限模型"
        ));
    }

    #[test]
    fn normalizes_tool_call_update_completed() {
        let params = json!({
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call_001",
                "status": "completed",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": "file contents here" }
                }]
            }
        });
        let mut usage = None;
        let events = normalize_acp_update(&params, &mut usage);
        assert_eq!(
            events,
            vec![NormalizedEvent::ToolUseResult {
                call_id: "call_001".to_string(),
                output: json!("file contents here"),
                is_error: false,
            }]
        );
    }

    #[test]
    fn normalizes_usage_update() {
        let params = json!({
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "usage_update",
                "used": 5000,
                "size": 200000,
                "cost": { "amount": 0.01, "currency": "USD" }
            }
        });
        let mut usage = None;
        let events = normalize_acp_update(&params, &mut usage);
        assert!(events.is_empty());
        assert_eq!(usage.as_ref().unwrap().context_remaining, Some(195000));
        assert_eq!(usage.as_ref().unwrap().total_cost, Some(0.01));
    }

    #[test]
    fn ignores_unknown_update_types() {
        let params = json!({
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "available_commands_update",
                "availableCommands": []
            }
        });
        let mut usage = None;
        let events = normalize_acp_update(&params, &mut usage);
        assert!(events.is_empty());
    }

    #[test]
    fn selects_permission_options_by_kind_or_id() {
        let params = json!({
            "options": [
                { "optionId": "reject-once", "kind": "reject_once" },
                { "optionId": "allow-once", "kind": "allow_once" }
            ]
        });

        assert_eq!(
            permission_option_id(&params, true).as_deref(),
            Some("allow-once")
        );
        assert_eq!(
            permission_option_id(&params, false).as_deref(),
            Some("reject-once")
        );
    }

    #[test]
    fn never_treats_an_unknown_permission_option_as_approval() {
        let params = json!({
            "options": [
                { "optionId": "custom", "kind": "custom" }
            ]
        });

        assert_eq!(permission_option_id(&params, true), None);
        assert_eq!(permission_option_id(&params, false), None);
    }

    // ---- M1.4 Phase 2: characterize the event-production units that Phase 1
    // rerouted through the callback emitter.
    // NOTE: the emitter is an `Arc<dyn Fn>` (not an enum-with-a-channel-variant)
    // because constructing that enum variant in the test binary triggered a
    // Windows load-time entry-point failure; a plain closure capturing a channel
    // does not.

    #[tokio::test]
    async fn callback_emitter_pushes_events_to_channel() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<NormalizedEvent>();
        let emit: AcpEventEmit = Arc::new(move |events: &[NormalizedEvent], _session_id: &str| {
            for event in events {
                let _ = tx.send(event.clone());
            }
        });
        emit(&[NormalizedEvent::TextDelta { delta: "a".into() }], "ses-1");
        drop(emit);
        let mut collected = Vec::new();
        while let Some(event) = rx.recv().await {
            collected.push(event);
        }
        assert_eq!(collected.len(), 1);
        assert!(matches!(
            &collected[0],
            NormalizedEvent::TextDelta { delta } if delta == "a"
        ));
    }

    #[test]
    fn handle_prompt_response_produces_turn_complete_on_success() {
        let mut buf: Vec<NormalizedEvent> = Vec::new();
        let mut usage = None;
        let msg = json!({ "result": { "stopReason": "end_turn", "usage": { "inputTokens": 5, "outputTokens": 7 } } });
        handle_prompt_response(&msg, &mut usage, &mut buf);
        // handle_prompt_response moves usage into the TurnComplete event (via
        // .take()), so the `usage` local is None afterward — check the event.
        assert_eq!(buf.len(), 1);
        match &buf[0] {
            NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: Some(used),
            } => {
                assert_eq!(used.input_tokens, Some(5));
                assert_eq!(used.output_tokens, Some(7));
            }
            other => panic!("expected TurnComplete(Complete) with usage, got {other:?}"),
        }
    }

    #[test]
    fn handle_prompt_response_produces_error_then_failed_turn_on_error() {
        let mut buf: Vec<NormalizedEvent> = Vec::new();
        let mut usage: Option<UsageStats> = None;
        let msg = json!({ "error": { "message": "boom" } });
        handle_prompt_response(&msg, &mut usage, &mut buf);
        assert_eq!(buf.len(), 2);
        assert!(matches!(&buf[0], NormalizedEvent::Error { .. }));
        assert!(matches!(
            &buf[1],
            NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Error,
                ..
            }
        ));
    }
}
