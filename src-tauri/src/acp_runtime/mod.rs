//! Tauri-internal ACP runtime: manages agent subprocess lifecycle within the
//! desktop app. Uses mpsc channels for in-process communication between the
//! Tauri webview and spawned agent CLIs.
//!
//! This is distinct from `acp/` which implements the stdio JSON-RPC 2.0
//! **external** protocol (per `protocols-spec.md §7`) for editor integrations
//! (Zed, JetBrains). This module is the **internal** consumer that spawns
//! agents and relays their NormalizedEvent streams to the GUI.

use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::agent::normalized::{
    interaction_requests_from_tool_call, is_elicitation_only_tool, InteractionCorrelation,
    InteractionDeliveryHint, InteractionOption, InteractionOrigin, InteractionTransport,
    NormalizedEvent, TurnEndReason, UsageStats,
};
use crate::cli_runtime::AgentStreamChunk;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Commands sent to the persistent ACP connection task.
pub enum AcpCommand {
    Prompt(String),
    /// Steer (mid-turn text injection). Pi RPC: sends {"type":"steer","message":...}.
    /// ACP: sends a follow_up prompt after the current turn.
    Steer(String),
    /// Set the agent's thinking level (v0.7.4 需求1 A7). Only the Pi RPC
    /// runtime translates this (native `set_thinking_level`); the ACP loop
    /// logs-and-drops it — the IPC layer capability-gates the entry for
    /// agents without thinking levels, so it never arrives in practice.
    SetThinkingLevel(String),
    /// Manually compact the session context (v0.7.4 需求1 A3). Only the Pi
    /// RPC runtime implements this (native `compact`, optional custom
    /// summary instructions); the oneshot resolves with the compact result.
    Compact {
        instructions: Option<String>,
        response: tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>,
    },
    /// Toggle/adjust the agent's auto-compaction (v0.7.4 需求1 A3；v0.8.0
    /// 需求9 收尾：两字段均可选——只推送出现的字段，避免热推阈值时误覆盖
    /// enabled 开关）。Pi RPC native `set_auto_compaction`; fire-and-forget.
    SetAutoCompaction {
        enabled: Option<bool>,
        threshold_percent: Option<u32>,
    },
    /// Fork the live session at its current end (v0.8.0 需求1 A5). Only the
    /// Pi RPC runtime implements this (native `clone` RPC: copies the session
    /// tree to a branch file and rebinds the process to it); the oneshot
    /// resolves with `{ "new_session_id": ... }` once the forked id is known.
    ForkSession {
        response: tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>,
    },
    Cancel,
    /// Respond to a structured interaction answer. Routed by the connection loop
    /// to the transport's mid-turn write-back channel:
    /// - PiRpc → `extension_ui_response` (production mid-turn baseline).
    /// - ACP   → a pending `elicitation/create` (claude_code, capability-gated;
    ///           populated in Phase 3). ACP agents without an elicitation channel
    ///           (opencode) have no mid-turn business path and must be answered
    ///           as a follow-up message (handled by the frontend, not here).
    /// `id` is the interaction request id; `value` is the user's choice/input.
    /// `response` carries the write-back outcome so the caller reports an
    /// authoritative `InteractionDelivery` (design R6).
    RespondToInput {
        id: String,
        value: String,
        response: tokio::sync::oneshot::Sender<Result<(), String>>,
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
    pub(crate) supports_interaction_mid_turn: Arc<AtomicBool>,
    /// v0.8.0 需求7：该会话是否有进行中的回合（prompt/turn-start 已发出、
    /// TurnComplete 尚未到达）。连接循环每轮头部与 LoopState 同步，循环退出
    /// 时清零。GUI 的 agent-event 监听随 chat 页卸载移除，卸载期间结束的
    /// 回合其 turn_complete 无法送达前端（streamStore 永远停在 isStreaming），
    /// 前端重挂载时经 `chat_turn_active` 以此标志对账。
    pub(crate) turn_active: Arc<AtomicBool>,
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

    pub fn supports_interaction_mid_turn(&self) -> bool {
        self.supports_interaction_mid_turn.load(Ordering::Relaxed)
    }

    /// 回合是否进行中。无 `AcpControl` 的 CLI 会话（进程即回合，回合结束
    /// 进程即退出）由 `chat_turn_active` 以「进程条目存在」等价判定。
    pub fn turn_active(&self) -> bool {
        self.turn_active.load(Ordering::Relaxed)
    }

    pub async fn send_cancel(&self) {
        let _ = self.tx.send(AcpCommand::Cancel).await;
    }

    /// Steer the in-flight turn (mid-turn text injection). For Pi RPC this
    /// sends the native `steer` command; the agent incorporates the text
    /// while continuing the same turn.
    pub async fn steer(&self, message: String) -> Result<(), String> {
        self.tx
            .send(AcpCommand::Steer(message))
            .await
            .map_err(|_| "ACP connection closed".to_string())
    }

    /// Set the session's thinking level (v0.7.4 需求1 A7). Translated by the
    /// Pi RPC runtime; no-op (logged) on transports without the concept.
    pub async fn set_thinking_level(&self, level: String) -> Result<(), String> {
        self.tx
            .send(AcpCommand::SetThinkingLevel(level))
            .await
            .map_err(|_| "ACP connection closed".to_string())
    }

    /// Manually compact the session context (v0.7.4 需求1 A3). Resolves when
    /// the agent finishes compaction (or with its structured error).
    pub async fn compact(&self, instructions: Option<String>) -> Result<serde_json::Value, String> {
        let (response, receiver) = tokio::sync::oneshot::channel();
        self.tx
            .send(AcpCommand::Compact {
                instructions,
                response,
            })
            .await
            .map_err(|_| "ACP connection closed".to_string())?;
        receiver
            .await
            .map_err(|_| "ACP compact response channel closed".to_string())?
    }

    /// Toggle auto-compaction for the session (v0.7.4 需求1 A3).
    pub async fn set_auto_compaction(
        &self,
        enabled: Option<bool>,
        threshold_percent: Option<u32>,
    ) -> Result<(), String> {
        self.tx
            .send(AcpCommand::SetAutoCompaction {
                enabled,
                threshold_percent,
            })
            .await
            .map_err(|_| "ACP connection closed".to_string())
    }

    /// Fork the live session at its current end (v0.8.0 需求1 A5). Resolves
    /// with `{ "new_session_id": ... }` once the Pi RPC runtime has cloned
    /// the session tree and learned the branch id.
    pub async fn fork_session(&self) -> Result<serde_json::Value, String> {
        let (response, receiver) = tokio::sync::oneshot::channel();
        self.tx
            .send(AcpCommand::ForkSession { response })
            .await
            .map_err(|_| "ACP connection closed".to_string())?;
        receiver
            .await
            .map_err(|_| "ACP fork response channel closed".to_string())?
    }

    /// Respond to a structured interaction answer (PiRpc `extension_ui`, or ACP
    /// `elicitation/create` for claude_code). Returns the write-back outcome so
    /// the caller can take the authoritative delivery decision (design R6).
    pub async fn respond_to_input(&self, id: String, value: String) -> Result<(), String> {
        let (response, receiver) = tokio::sync::oneshot::channel();
        self.tx
            .send(AcpCommand::RespondToInput {
                id,
                value,
                response,
            })
            .await
            .map_err(|_| "ACP connection closed".to_string())?;
        receiver
            .await
            .map_err(|_| "ACP interaction response channel closed".to_string())?
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

// ACP runtime 按职责拆分（v0.7.3 需求1-M4）：连接循环与 LoopState 状态机整体保留在
// mod.rs；协议帧 I/O、审批/提问交互路由、elicitation 解析、事件归一化分属子模块。
mod elicitation;
mod interaction;
mod normalize;
mod protocol;

pub(crate) use self::interaction::{permission_option_id, write_permission_response};
pub(crate) use self::protocol::acp_initialize_params;
pub use self::protocol::{handle_acp_response_line, write_jsonrpc_request, AcpResponse};

use self::elicitation::{extract_ask_user_prompts, parse_acp_elicitation, AcpElicitation};
use self::interaction::{
    cancel_pending_elicitations, elicit_result_payload, parse_sub_request_id,
    permission_request_key, reject_pending_permissions, route_acp_interaction_response,
    AcpInteractionRoute, ElicitAction, PendingElicitation, PendingPermission, KIND_ELICITATION,
};
use self::normalize::{
    acp_unexpected_eof_error, emit_events, flush_buf, is_content_event, normalize_acp_update,
};
use self::protocol::{
    enrich_handshake_error, handle_prompt_response, stdout_reader, wait_for_response, AcpWriter,
};

enum LoopState {
    Idle,
    Prompting {
        prompt_id: i64,
    },
    CancelPending {
        old_prompt_id: i64,
        // The JSON-RPC id of the session/cancel request we issued, so the
        // stdout loop can detect when the agent rejects cancel (some ACP
        // servers, e.g. opencode, do not implement session/cancel and reply
        // with an error). Cleared once the cancel is acknowledged.
        cancel_request_id: Option<i64>,
        pending_prompt: Option<String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum AcpSteerAction {
    SendNow(String),
    Queued,
}

fn queue_acp_steer_follow_up(
    state: &LoopState,
    pending_follow_ups: &mut VecDeque<String>,
    message: String,
) -> AcpSteerAction {
    match state {
        LoopState::Idle => AcpSteerAction::SendNow(message),
        LoopState::Prompting { .. } | LoopState::CancelPending { .. } => {
            pending_follow_ups.push_back(message);
            AcpSteerAction::Queued
        }
    }
}

fn pop_next_acp_follow_up(pending_follow_ups: &mut VecDeque<String>) -> Option<String> {
    pending_follow_ups.pop_front()
}

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

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
    let stderr = child.stderr.take();

    let stdin_arc = Arc::new(TokioMutex::new(stdin));
    let acp_session_id = Arc::new(std::sync::Mutex::new(None::<String>));
    let stderr_buf = Arc::new(TokioMutex::new(String::new()));

    if let Some(stderr_stream) = stderr {
        let stderr_buf_clone = stderr_buf.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr_stream).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::warn!("[acp stderr] {}", line);
                let mut buf = stderr_buf_clone.lock().await;
                buf.push_str(&line);
                buf.push('\n');
            }
        });
    }

    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(8);

    // stdout reader + event sink are constructed here so the connection loop can
    // run against a synthetic line stream / channel sink (tests, orchestrator).
    let (stdout_tx, stdout_rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(stdout_reader(stdout, stdout_tx));
    let emit = tauri_event_emitter(app.clone(), agent_id.clone());

    let control = AcpControl {
        tx: cmd_tx,
        acp_session_id: acp_session_id.clone(),
        supports_interaction_mid_turn: Arc::new(AtomicBool::new(true)),
        // 首回合 prompt 在连接初始化后立即发出，构造时即为 true。
        turn_active: Arc::new(AtomicBool::new(true)),
    };
    let control_clone = control.clone();
    let turn_active_for_loop = control.turn_active.clone();
    let turn_active_for_exit = control.turn_active.clone();

    tauri::async_runtime::spawn(async move {
        let result = acp_connection_loop(
            emit,
            pending_session_id.clone(),
            stdin_arc,
            acp_session_id,
            stdout_rx,
            project_path,
            requested_session_id,
            stderr_buf,
            cmd_rx,
            first_message,
            turn_active_for_loop,
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

        // v0.8.0 需求7：循环已退出（正常或出错），回合必然不再进行。
        turn_active_for_exit.store(false, Ordering::Relaxed);

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
    stderr_buf: Arc<TokioMutex<String>>,
    mut command_rx: tokio::sync::mpsc::Receiver<AcpCommand>,
    first_message: String,
    turn_active: Arc<AtomicBool>,
    on_session_resolved: &(dyn Fn(&str) + Send + Sync),
) -> Result<(), String> {
    let mut writer = AcpWriter::new(stdin_arc);

    // stdout reader is spawned by the caller (spawn_acp_session) so the loop can
    // be driven with a synthetic line stream in tests / by the orchestrator.

    // 2. Handshake: initialize → session/new
    let init_id = writer
        .request("initialize", acp_initialize_params())
        .await?;
    // v0.7.0：握手失败时附带 stderr 内容，帮助诊断 claude-agent-acp 桥为何提前退出。
    if let Err(e) = wait_for_response(&mut stdout_rx, init_id).await {
        return Err(enrich_handshake_error(e, &stderr_buf).await);
    }

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
        match wait_for_response(&mut stdout_rx, resume_id).await {
            Ok(v) => v,
            Err(e) => {
                return Err(enrich_handshake_error(e, &stderr_buf).await);
            }
        }
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
        match wait_for_response(&mut stdout_rx, new_id).await {
            Ok(v) => v,
            Err(e) => {
                return Err(enrich_handshake_error(e, &stderr_buf).await);
            }
        }
    };
    // session/new returns { sessionId, configOptions }; session/resume returns
    // only { configOptions } — opencode does not echo the sessionId back on
    // resume (the client already supplied it). Reuse the requested id for
    // resume; only session/new needs the server-minted id from the response.
    let session_id = match requested_session_id.as_deref() {
        Some(req_id) => req_id.to_string(),
        None => session_result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "ACP session creation did not return sessionId".to_string())?
            .to_string(),
    };

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
    // Pending ACP elicitation/create (claude_code business questions). Kept in a
    // separate table from pending_permissions (R3 分表); Phase 3 populates it
    // when handling incoming elicitation/create.
    let mut pending_elicitations: HashMap<String, PendingElicitation> = HashMap::new();
    let mut pending_follow_up_prompts: VecDeque<String> = VecDeque::new();
    // Track whether the current prompt turn received any visible content
    // (text, thinking, tool calls). Some ACP servers (e.g. opencode) silently
    // return end_turn with zero content when the underlying model API fails.
    // Detecting this lets us surface a meaningful error instead of a blank turn.
    let mut turn_had_content = false;
    // Track call IDs of elicitation-only tools (AskUserQuestion) whose
    // tool_call_start was suppressed, so the matching tool_call_update
    // (result) can also be suppressed even when the tool name is missing
    // from the update event.
    let mut suppressed_acp_calls: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut last_ask_user_prompts: Option<Vec<String>> = None;

    loop {
        // v0.8.0 需求7：每轮头部把回合真值同步到 AcpControl 共享标志——
        // 状态迁移都发生在 select 分支内，此处统一收口，避免逐点翻转移漏。
        turn_active.store(!matches!(state, LoopState::Idle), Ordering::Relaxed);
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
                                turn_had_content = false;
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
                        cancel_pending_elicitations(&writer, &mut pending_elicitations).await;
                        match &state {
                            LoopState::Prompting { prompt_id } => {
                                // Ask the agent to cancel the in-flight prompt.
                                // Some ACP servers (notably opencode) do not
                                // implement session/cancel and reject it with an
                                // error; the stdout loop detects that rejection
                                // and force-terminates the session so output
                                // actually stops. The next message then resumes
                                // the persisted session.
                                let cancel_id = writer
                                    .request(
                                        "session/cancel",
                                        json!({ "sessionId": session_id }),
                                    )
                                    .await
                                    .ok();
                                log::info!(
                                    "ACP cancel sent for prompt_id={} cancel_request_id={:?}",
                                    prompt_id,
                                    cancel_id
                                );
                                state = LoopState::CancelPending {
                                    old_prompt_id: *prompt_id,
                                    cancel_request_id: cancel_id,
                                    pending_prompt: None,
                                };
                            }
                            LoopState::Idle | LoopState::CancelPending { .. } => {}
                        }
                        false
                    }
                    Some(AcpCommand::Steer(msg)) => {
                        match queue_acp_steer_follow_up(
                            &state,
                            &mut pending_follow_up_prompts,
                            msg,
                        ) {
                            AcpSteerAction::SendNow(msg) => {
                                usage = None;
                                turn_had_content = false;
                                let id = writer.request("session/prompt", json!({
                                    "sessionId": session_id,
                                    "prompt": [{ "type": "text", "text": msg }]
                                })).await?;
                                log::info!("ACP sent steer follow-up prompt immediately, id={}", id);
                                state = LoopState::Prompting { prompt_id: id };
                            }
                            AcpSteerAction::Queued => {
                                log::info!(
                                    "ACP queued steer follow-up prompt; queue_len={}",
                                    pending_follow_up_prompts.len()
                                );
                            }
                        }
                        false
                    }
                    Some(AcpCommand::SetThinkingLevel(level)) => {
                        // ACP 协议无 thinking 概念；IPC 层已按 adapter capability
                        // 门控，此分支仅为枚举完备性兜底（log-and-drop）。
                        log::warn!("ACP runtime received SetThinkingLevel({level}) — not supported, dropping");
                        false
                    }
                    Some(AcpCommand::Compact { response, .. }) => {
                        // ACP 协议无 compact 概念（文本透传是否被桥解释未验证）。
                        let _ = response.send(Err(
                            "Context compaction is not supported by this agent".to_string(),
                        ));
                        false
                    }
                    Some(AcpCommand::SetAutoCompaction {
                        enabled,
                        threshold_percent,
                    }) => {
                        log::warn!(
                            "ACP runtime received SetAutoCompaction(enabled={enabled:?}, threshold={threshold_percent:?}) — not supported, dropping"
                        );
                        false
                    }
                    Some(AcpCommand::ForkSession { response }) => {
                        // ACP 协议无会话分支概念（Pi JSONL 树原生能力）；
                        // IPC 层已按 SESSION_FORK capability 门控，此分支仅兜底。
                        let _ = response.send(Err(
                            "Session fork is not supported by this agent".to_string(),
                        ));
                        false
                    }
                    Some(AcpCommand::RespondToInput {
                        id,
                        value,
                        response,
                    }) => {
                        // R7: route the business-interaction answer by pending
                        // table. Consults ONLY pending_elicitations (claude_code,
                        // populated in Phase 3) — never pending_permissions (R3
                        // 分表). ACP agents without an elicitation channel
                        // (opencode) have no mid-turn business path: report
                        // NoChannel so the frontend delivers the answer as a
                        // follow-up message instead.
                        let result = match route_acp_interaction_response(
                            &mut pending_elicitations,
                            &id,
                            &value,
                        ) {
                            AcpInteractionRoute::PendingNext { base_id, next_index } => {
                                if let Some(pending) = pending_elicitations.get(&base_id) {
                                    if let Some(next_q) = pending.questions.get(next_index) {
                                        let next_request_id = format!("{}_{}", base_id, next_index);
                                        buf.push(NormalizedEvent::InteractionRequest {
                                            request_id: next_request_id,
                                            prompt: next_q.prompt.clone(),
                                            options: next_q.options.clone(),
                                            allow_multiple: next_q.is_multi_select,
                                            allow_custom_text: true,
                                            required: true,
                                            transport: InteractionTransport::AcpPreferred,
                                            origin: InteractionOrigin::AcpElicitation,
                                            delivery_hint: InteractionDeliveryHint::MidTurn,
                                            correlation: Some(InteractionCorrelation {
                                                session_id: Some(session_id.clone()),
                                                jsonrpc_id: Some(pending.rpc_id.clone()),
                                                request_kind: Some(KIND_ELICITATION.to_string()),
                                                ..Default::default()
                                            }),
                                        });
                                        flush_buf(&emit, &session_id, &mut buf);
                                        last_flush = std::time::Instant::now();
                                    }
                                }
                                Ok(())
                            }
                            AcpInteractionRoute::Elicit {
                                rpc_id,
                                action,
                                content,
                            } => {
                                let base_id = parse_sub_request_id(&id)
                                    .map(|(bid, _)| bid.to_string())
                                    .unwrap_or_else(|| id.clone());
                                pending_elicitations.remove(&base_id);
                                let payload = elicit_result_payload(action, content);
                                writer.respond(&rpc_id, payload).await
                            }
                            AcpInteractionRoute::NoChannel => {
                                log::warn!(
                                    "ACP RespondToInput for {id} has no pending elicitation; \
                                     this ACP agent has no mid-turn business channel"
                                );
                                Err(format!(
                                     "No pending ACP elicitation for interaction {id}; \
                                      this transport cannot answer mid-turn as a business question"
                                ))
                            }
                        };
                        let _ = response.send(result);
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
                        cancel_pending_elicitations(&writer, &mut pending_elicitations).await;
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

                        let mut force_exit = false;

                        if let Some(pid) = current_prompt_id {
                            // Only treat this message as a prompt response if
                            // it is actually a JSON-RPC *response* (has `result`
                            // or `error`, no `method`). Server-initiated REQUESTs
                            // like `elicitation/create` also carry an `id` field,
                            // and the server's id space is independent from ours —
                            // so a collision would misroute the elicitation as a
                            // prompt response, emit a spurious TurnComplete, and
                            // stall the agent waiting for an answer that never
                            // arrives (see issue: third AskUserQuestion hang).
                            let is_jsonrpc_response = msg.get("method").is_none()
                                && (msg.get("result").is_some() || msg.get("error").is_some());

                            if msg.get("id").and_then(|v| v.as_i64()) == Some(pid)
                                && is_jsonrpc_response
                            {
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
                                    // Detect silent empty turns: the ACP server
                                    // returned end_turn but sent no content events
                                    // (text / thinking / tool calls). Surface an
                                    // error so the user doesn't see a blank screen.
                                    let stop_reason = msg.get("result")
                                        .and_then(|r| r.get("stopReason"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("end_turn");
                                    if !turn_had_content
                                        && stop_reason != "cancelled"
                                        && msg.get("error").is_none()
                                    {
                                        log::warn!(
                                            "ACP prompt id={} completed with stopReason={:?} but zero content events",
                                            pid, stop_reason
                                        );
                                        buf.push(NormalizedEvent::Error {
                                            message: "智能体本轮未返回任何内容，可能是上游异常。请重试或查看日志。".to_string(),
                                            recoverable: true,
                                        });
                                    }
                                    handle_prompt_response(&msg, &mut usage, &mut buf);
                                    flush_buf(&emit, &session_id, &mut buf);
                                }

                                // State transition
                                let buffered_after_cancel = if let LoopState::CancelPending { pending_prompt, .. } = &mut state {
                                    pending_prompt.take()
                                } else {
                                    None
                                };
                                state = if let Some(msg) = buffered_after_cancel {
                                    usage = None;
                                    turn_had_content = false;
                                    let new_id = writer.request("session/prompt", json!({
                                        "sessionId": session_id,
                                        "prompt": [{ "type": "text", "text": msg }]
                                    })).await?;
                                    log::info!("ACP sent buffered prompt after cancel, id={}", new_id);
                                    LoopState::Prompting { prompt_id: new_id }
                                } else if let Some(msg) = pop_next_acp_follow_up(&mut pending_follow_up_prompts) {
                                    usage = None;
                                    turn_had_content = false;
                                    let new_id = writer.request("session/prompt", json!({
                                        "sessionId": session_id,
                                        "prompt": [{ "type": "text", "text": msg }]
                                    })).await?;
                                    log::info!(
                                        "ACP sent queued steer follow-up prompt after turn, id={} queue_len={}",
                                        new_id,
                                        pending_follow_up_prompts.len()
                                    );
                                    LoopState::Prompting { prompt_id: new_id }
                                } else {
                                    log::info!("ACP state -> Idle after prompt response");
                                    LoopState::Idle
                                };
                                continue;
                            }
                        }

                        // Detect the session/cancel response. Some ACP servers
                        // (notably opencode) do not implement session/cancel and
                        // reject it with an error; the agent then keeps streaming,
                        // so force-terminate the session — output stops, and the
                        // next message resumes the persisted session.
                        if let LoopState::CancelPending {
                            cancel_request_id: Some(cancel_id),
                            ..
                        } = &state
                        {
                            if msg.get("id").and_then(|v| v.as_i64()) == Some(*cancel_id) {
                                if msg.get("error").is_some() {
                                    log::warn!(
                                        "ACP session/cancel rejected by agent ({:?}); force-terminating session {}",
                                        msg.get("error"),
                                        session_id
                                    );
                                    buf.push(NormalizedEvent::TurnComplete {
                                        reason: TurnEndReason::Aborted,
                                        usage: usage.take(),
                                    });
                                    flush_buf(&emit, &session_id, &mut buf);
                                    force_exit = true;
                                } else if let LoopState::CancelPending {
                                    cancel_request_id,
                                    ..
                                } = &mut state
                                {
                                    *cancel_request_id = None;
                                }
                            }
                        }

                        // session/update notifications
                        if msg.get("method").and_then(|v| v.as_str()) == Some("session/update") {
                            if let Some(params) = msg.get("params") {
                                // Track suppressed tool_call IDs for elicitation-only tools.
                                // When tool_call_start produces no events (AskUserQuestion),
                                // record the call ID so we can suppress the result too.
                                if let Some(update) = params.get("update") {
                                    if let Some(update_type) = update.get("type").and_then(|v| v.as_str()) {
                                        if update_type == "tool_call" {
                                            if let Some(call_id) = update.get("toolCallId").and_then(|v| v.as_str()) {
                                                let tool = update.get("toolName")
                                                    .or_else(|| update.get("name"))
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or_default();
                                                if is_elicitation_only_tool(tool) {
                                                    suppressed_acp_calls.insert(call_id.to_string());
                                                    last_ask_user_prompts = extract_ask_user_prompts(update);
                                                }
                                            }
                                        }
                                    }
                                }

                                let events = normalize_acp_update(params, &mut usage);

                                // Also suppress tool_call_update (result) by call ID tracking,
                                // in case the tool name is missing from the update event.
                                let events: Vec<NormalizedEvent> = if let Some(update) = params.get("update") {
                                    let update_type = update.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                                    if update_type == "tool_call_update" {
                                        if let Some(call_id) = update.get("toolCallId").and_then(|v| v.as_str()) {
                                            if suppressed_acp_calls.remove(call_id) {
                                                vec![] // Suppress by tracked ID
                                            } else {
                                                events
                                            }
                                        } else {
                                            events
                                        }
                                    } else {
                                        events
                                    }
                                } else {
                                    events
                                };

                                for event in &events {
                                    if is_content_event(event) {
                                        turn_had_content = true;
                                    }
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
                        } else if msg.get("method").and_then(|v| v.as_str())
                            == Some("elicitation/create")
                        {
                            // claude-agent-acp business question (AskUserQuestion),
                            // capability-gated on the `elicitation.form` we advertised
                            // at initialize. A server REQUEST (carries `id`): we must
                            // eventually write back `{action, content}` or the turn
                            // stalls.
                            let Some(rpc_id) = msg.get("id").cloned() else {
                                log::warn!(
                                    "ACP elicitation/create ignored: no id (cannot reply)"
                                );
                                continue;
                            };
                            let params = msg.get("params").cloned().unwrap_or_default();
                            let prompts = last_ask_user_prompts.take();
                            match parse_acp_elicitation(&params, &prompts) {
                                Some(elic) => {
                                    // Register under the same key the frontend will
                                    // echo back as `request_id`, so RespondToInput's
                                    // route_acp_interaction_response lookup matches
                                    // (R3: kept in the DISTINCT elicitations table).
                                    let base_request_id = permission_request_key(&rpc_id);
                                    pending_elicitations.insert(
                                        base_request_id.clone(),
                                        PendingElicitation {
                                            rpc_id: rpc_id.clone(),
                                            questions: elic.questions.clone(),
                                            current_index: 0,
                                            answers: serde_json::Map::new(),
                                        },
                                    );
                                    if let Some(first_q) = elic.questions.first() {
                                        let request_id = format!("{}_0", base_request_id);
                                        buf.push(NormalizedEvent::InteractionRequest {
                                            request_id,
                                            prompt: first_q.prompt.clone(),
                                            options: first_q.options.clone(),
                                            allow_multiple: first_q.is_multi_select,
                                            allow_custom_text: true,
                                            required: true,
                                            transport: InteractionTransport::AcpPreferred,
                                            origin: InteractionOrigin::AcpElicitation,
                                            delivery_hint: InteractionDeliveryHint::MidTurn,
                                            correlation: Some(InteractionCorrelation {
                                                session_id: Some(session_id.clone()),
                                                jsonrpc_id: Some(rpc_id),
                                                request_kind: Some(KIND_ELICITATION.to_string()),
                                                ..Default::default()
                                            }),
                                        });
                                    }
                                    flush_buf(&emit, &session_id, &mut buf);
                                    last_flush = std::time::Instant::now();
                                }
                                None => {
                                    // Unparsable elicitation (url mode, arbitrary MCP
                                    // schema, or no enum) — we have no UI to render it.
                                    // Reply `cancel` immediately so claude-agent-acp
                                    // does not block the turn awaiting an answer that
                                    // will never arrive (design §5.2.1 three-state).
                                    log::warn!(
                                        "ACP elicitation/create (id {:?}) is not a \
                                         renderable single-choice form; replying cancel",
                                        msg.get("id")
                                    );
                                    if let Err(error) = writer
                                        .respond(
                                            &rpc_id,
                                            elicit_result_payload(
                                                ElicitAction::Cancel,
                                                serde_json::Value::Null,
                                            ),
                                        )
                                        .await
                                    {
                                        log::warn!(
                                            "ACP failed to cancel unparsable elicitation: {error}"
                                        );
                                    }
                                }
                            }
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
                        force_exit
                    }
                    None => {
                        log::warn!("ACP stdout EOF for session {}", session_id);
                        let stderr = stderr_buf.lock().await.clone();
                        if let Some(error) =
                            acp_unexpected_eof_error(&state, &session_id, &stderr)
                        {
                            return Err(error);
                        }
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

#[cfg(test)]
mod tests;
