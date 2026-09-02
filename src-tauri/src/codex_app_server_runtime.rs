//! Codex app-server runtime (adapter for `codex app-server`).
//!
//! Codex's app-server speaks a newline-delimited JSON-RPC dialect that is **not**
//! true JSON-RPC 2.0: per `codex-rs/app-server-protocol/src/jsonrpc_lite.rs`,
//! "we neither send nor expect the `'jsonrpc':'2.0'` field". Outgoing requests
//! are `{id, method, params?}` and responses to server-initiated requests are
//! `{id, result}` (the `result` key, no `jsonrpc` envelope). This module omits
//! the `jsonrpc` field to stay protocol-faithful.
//!
//! Lifecycle: `initialize` (with `experimentalApi:true`) → `thread/start` (or
//! `thread/resume` to continue a thread) → `turn/start` (first message) → the
//! turn streams `item/*` notifications and ends with `turn/completed`. Server
//! requests (`item/tool/requestUserInput`, `item/*/requestApproval`) block the
//! turn until answered — these are the pause-resume / approval channels.
//!
//! The runtime returns a shared `AcpControl` (same interface as the PiRpc / ACP
//! runtimes), so `respond_chat_interaction` and `resolve_chat_permission` work
//! unchanged: a business-question answer (`RespondToInput`) writes an
//! `{id, result:{answers:{…}}}` response; an approval (`ResolvePermission`)
//! writes `{id, result:{decision:…}}`. See `交互模式通用化设计_20260616.md` §7.2.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::acp_runtime::{tauri_event_emitter, AcpCommand, AcpControl, AcpEventEmit};
use crate::agent::normalized::{
    ApprovalKind, InteractionCorrelation, InteractionDeliveryHint, InteractionOption,
    InteractionOrigin, InteractionTransport, NormalizedEvent, TurnEndReason, UsageStats,
};

/// codex 用量累积器（v0.9.0 需求5）：Arc 包装跨 spawn 边界共享，轮末 take() 填入
/// TurnComplete——对齐 ACP runtime 的 usage_acc 模式（acp_runtime/normalize.rs）。
type UsageCell = std::sync::Mutex<Option<UsageStats>>;

/// v0.9.0 需求5：解析 `thread/tokenUsage/updated`（codex-cli ≥0.148 schema）。
/// 语义（上游 README）：total.inputTokens + total.outputTokens ≈ 已占上下文；
/// cachedInputTokens 已含于 inputTokens，不重复累加；cost 无协议来源保持 None。
fn parse_token_usage(params: &Value) -> Option<UsageStats> {
    let tu = params.get("tokenUsage")?;
    let total = tu.get("total")?;
    let input = total.get("inputTokens").and_then(Value::as_u64);
    let output = total.get("outputTokens").and_then(Value::as_u64);
    let window = tu.get("modelContextWindow").and_then(Value::as_u64);
    let remaining = window
        .zip(input)
        .zip(output)
        .map(|((w, i), o)| w.saturating_sub(i.saturating_add(o)));
    Some(UsageStats {
        input_tokens: input,
        output_tokens: output,
        total_cost: None,
        context_remaining: remaining,
        context_window_total: window,
    })
}

/// v0.9.0 需求5：tokenUsage notification 到达即更新累积器（thread/resume 后的
/// 立即补发同样命中，冷恢复可还原水位）。
fn capture_token_usage(method: &str, params: &Value, cell: &UsageCell) {
    if method == "thread/tokenUsage/updated" {
        if let Some(stats) = parse_token_usage(params) {
            *cell.lock().unwrap_or_else(|e| e.into_inner()) = Some(stats);
        }
    }
}

// ---------------------------------------------------------------------------
// request_kind discriminant (design R3)
// ---------------------------------------------------------------------------
// Stored in `InteractionCorrelation::request_kind` so a business answer's
// correlation can never be confused with an approval's (the two also use
// distinct frontend request-id prefixes: `codex-…` vs `codex-approval-…`).
const KIND_BUSINESS: &str = "codex_tool_request_user_input";

const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Spawn the codex app-server driver. Returns an `AcpControl` that speaks
/// codex's newline-delimited JSON-RPC dialect internally.
#[allow(clippy::too_many_arguments)]
pub fn spawn_codex_app_server_session(
    app: tauri::AppHandle,
    agent_id: String,
    pending_session_id: String,
    child: tokio::process::Child,
    project_path: String,
    requested_session_id: Option<String>,
    first_message: String,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    let policy = crate::agent::policy::for_interactive_session(&pending_session_id);
    let emit = tauri_event_emitter(app, agent_id);
    spawn_codex_app_server_session_inner(
        emit,
        pending_session_id,
        child,
        project_path,
        requested_session_id,
        first_message,
        policy,
        on_finish,
        on_session_resolved,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_codex_app_server_session_with_policy(
    app: tauri::AppHandle,
    agent_id: String,
    pending_session_id: String,
    child: tokio::process::Child,
    project_path: String,
    requested_session_id: Option<String>,
    first_message: String,
    policy: crate::agent::policy::PolicyChain,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    let emit = tauri_event_emitter(app, agent_id);
    spawn_codex_app_server_session_inner(
        emit,
        pending_session_id,
        child,
        project_path,
        requested_session_id,
        first_message,
        policy,
        on_finish,
        on_session_resolved,
    )
}

#[allow(clippy::too_many_arguments)]
fn spawn_codex_app_server_session_inner(
    emit: AcpEventEmit,
    pending_session_id: String,
    mut child: tokio::process::Child,
    project_path: String,
    requested_session_id: Option<String>,
    first_message: String,
    policy: crate::agent::policy::PolicyChain,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    let stdin = child
        .stdin
        .take()
        .expect("codex app-server process must have stdin");
    let stdout = child
        .stdout
        .take()
        .expect("codex app-server process must have stdout");
    let stderr = child.stderr.take();

    let stdin_arc = Arc::new(TokioMutex::new(stdin));
    let acp_session_id = Arc::new(std::sync::Mutex::new(None::<String>));

    // Capture stderr for diagnostics (mirrors the PiRpc runtime).
    let stderr_buf = Arc::new(TokioMutex::new(String::new()));
    if let Some(stderr_stream) = stderr {
        let stderr_buf_clone = stderr_buf.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr_stream).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::warn!("[codex app-server stderr] {}", line);
                let mut buf = stderr_buf_clone.lock().await;
                buf.push_str(&line);
                buf.push('\n');
            }
        });
    }

    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(8);
    let supports_interaction_mid_turn = Arc::new(AtomicBool::new(true));
    // v0.8.0 需求7：codex turn/start 在连接初始化后立即发出（初始即 Prompting）。
    let turn_active = Arc::new(AtomicBool::new(true));

    let control = AcpControl {
        tx: cmd_tx,
        acp_session_id: acp_session_id.clone(),
        supports_interaction_mid_turn: supports_interaction_mid_turn.clone(),
        turn_active: turn_active.clone(),
    };
    let control_clone = control.clone();
    let turn_active_for_exit = turn_active.clone();
    // v0.9.0 需求5：连接循环与错误出口共享的用量累积器。
    let usage_cell = Arc::new(UsageCell::new(None));
    let usage_cell_for_loop = usage_cell.clone();

    tauri::async_runtime::spawn(async move {
        let result = codex_connection_loop(
            emit.clone(),
            pending_session_id.clone(),
            stdin_arc,
            acp_session_id,
            stdout,
            project_path,
            requested_session_id,
            cmd_rx,
            first_message,
            &on_session_resolved,
            supports_interaction_mid_turn,
            policy,
            turn_active,
            usage_cell_for_loop,
        )
        .await;

        if let Err(err) = &result {
            let stderr_content = stderr_buf.lock().await.clone();
            let enriched_err = if !stderr_content.trim().is_empty() {
                let tail = if stderr_content.len() > 500 {
                    &stderr_content[stderr_content.len() - 500..]
                } else {
                    &stderr_content
                };
                format!("{}\n--- codex stderr ---\n{}", err, tail.trim())
            } else {
                err.clone()
            };
            log::warn!(
                "codex app-server connection loop exited with error: {}",
                enriched_err
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
                    // v0.9.0 需求5：连接异常退出也带出最后已知用量（可能为 None）。
                    usage: usage_cell
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take(),
                },
            ];
            emit(&events, &pending_session_id);
            on_session_resolved(&pending_session_id);
        } else {
            log::info!(
                "codex app-server connection loop exited normally for session {}",
                pending_session_id
            );
        }

        // Ensure child exits.
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => {
                log::info!("codex app-server child exited with status: {}", status);
            }
            Ok(Err(e)) => log::warn!("codex app-server child wait error: {}", e),
            Err(_) => {
                log::warn!("codex app-server child did not exit in 5s, force-killing");
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
// Internal: pending registries (design R3 — business 与 approval 分表)
// ---------------------------------------------------------------------------

/// A pending codex business question (`item/tool/requestUserInput`, non-approval
/// payload). Keyed by the frontend-facing request id. Stored in a DISTINCT map
/// from approvals (R3) so a business answer is never mistaken for an approval.
#[allow(dead_code)]
#[derive(Debug, Clone)]
struct PendingUserInput {
    /// Original JSON-RPC id of the server request (echoed in the response).
    rpc_id: Value,
    /// Question id within the requestUserInput (codex groups answers by it).
    question_id: String,
    /// Correlation scope retained for diagnostics (R3): which thread/turn the
    /// request belonged to. Not needed for the write-back itself.
    thread_id: String,
    turn_id: String,
}

/// A pending codex approval. Covers all three sources: the EXPERIMENTAL
/// `item/tool/requestUserInput` carrying an MCP side-effect approval (origin
/// `CodexMcpApproval`) and the `item/*/requestApproval` methods (origin
/// `CodexApproval`). The write-back shape differs by wire method, hence the
/// `writeback` discriminator.
#[allow(dead_code)]
#[derive(Debug, Clone)]
struct PendingApproval {
    rpc_id: Value,
    kind: ApprovalKind,
    /// Correlation scope retained for diagnostics (R3).
    thread_id: String,
    turn_id: String,
    /// How the decision should be encoded on the wire.
    writeback: ApprovalWriteback,
}

/// Two wire shapes for an approval answer:
/// - `Decision`: `{id, result:{decision:"accept"|"decline"}}` for the
///   `item/*/requestApproval` methods.
/// - `AnswerLabel`: `{id, result:{answers:{[qid]:{answers:[label]}}}}` for an
///   MCP approval arriving via the EXPERIMENTAL `item/tool/requestUserInput`
///   channel, where the approval semantics live in the chosen answer label.
#[derive(Debug, Clone)]
enum ApprovalWriteback {
    Decision,
    AnswerLabel {
        question_id: String,
        accept_label: String,
        decline_label: String,
    },
}

// ---------------------------------------------------------------------------
// Internal: connection loop
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum LoopState {
    Idle {
        /// Last known active turn id (retained so a stray steer that races
        /// turn/completed is not lost).
        active_turn_id: Option<String>,
    },
    Prompting {
        active_turn_id: Option<String>,
    },
    /// turn/interrupt was sent; waiting for turn/completed to confirm.
    CancelPending,
}

#[allow(clippy::too_many_arguments)]
async fn codex_connection_loop(
    emit: AcpEventEmit,
    pending_session_id: String,
    stdin_arc: Arc<TokioMutex<ChildStdin>>,
    acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    stdout: tokio::process::ChildStdout,
    project_path: String,
    requested_session_id: Option<String>,
    mut command_rx: tokio::sync::mpsc::Receiver<AcpCommand>,
    first_message: String,
    on_session_resolved: &(dyn Fn(&str) + Send + Sync),
    supports_interaction_mid_turn: Arc<AtomicBool>,
    policy: crate::agent::policy::PolicyChain,
    turn_active: Arc<AtomicBool>,
    usage_cell: Arc<UsageCell>,
) -> Result<(), String> {
    // stdout reader sub-task.
    let (stdout_tx, mut stdout_rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(stdout_reader(stdout, stdout_tx));

    let mut writer = CodexWriter::new(stdin_arc.clone());

    // Pending registries — separate maps (R3 分表).
    let mut pending_user_inputs: HashMap<String, PendingUserInput> = HashMap::new();
    let mut pending_approvals: HashMap<String, PendingApproval> = HashMap::new();

    let mut buf: Vec<NormalizedEvent> = Vec::with_capacity(32);
    let mut last_flush = std::time::Instant::now();

    // 1. initialize. Prefer experimentalApi for requestUserInput; if older
    // codex builds reject that capability, retry a baseline initialize and mark
    // the session as follow-up only for structured business questions.
    let experimental_api_enabled = initialize_codex(
        &mut writer,
        &mut stdout_rx,
        &mut pending_user_inputs,
        &mut pending_approvals,
        &emit,
        &pending_session_id,
        &mut buf,
        &mut last_flush,
    )
    .await?;
    supports_interaction_mid_turn.store(
        experimental_api_enabled,
        std::sync::atomic::Ordering::Relaxed,
    );
    flush_buf(&emit, &pending_session_id, &mut buf);

    // 2. thread/start (new) or thread/resume (continue a known thread).
    let thread_id = if let Some(thread_id) = requested_session_id.as_ref() {
        let id = writer
            .request("thread/resume", json!({ "threadId": thread_id }))
            .await?;
        let resp = wait_for_response(
            &mut stdout_rx,
            &mut pending_user_inputs,
            &mut pending_approvals,
            &emit,
            &pending_session_id,
            &mut buf,
            &mut last_flush,
            id,
            &usage_cell,
        )
        .await
        .map_err(|e| format!("codex thread/resume failed: {e}"))?;
        flush_buf(&emit, &pending_session_id, &mut buf);
        extract_thread_id(&resp).unwrap_or_else(|| thread_id.clone())
    } else {
        let id = writer
            .request("thread/start", json!({ "cwd": project_path }))
            .await?;
        let resp = wait_for_response(
            &mut stdout_rx,
            &mut pending_user_inputs,
            &mut pending_approvals,
            &emit,
            &pending_session_id,
            &mut buf,
            &mut last_flush,
            id,
            &usage_cell,
        )
        .await
        .map_err(|e| format!("codex thread/start failed: {e}"))?;
        flush_buf(&emit, &pending_session_id, &mut buf);
        extract_thread_id(&resp).unwrap_or_else(|| pending_session_id.clone())
    };

    log::info!("codex app-server thread established: {}", thread_id);
    {
        let mut guard = acp_session_id.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(thread_id.clone());
    }
    emit(
        &[NormalizedEvent::SessionResolved {
            session_id: thread_id.clone(),
        }],
        &pending_session_id,
    );
    on_session_resolved(&thread_id);

    // v0.7.6 需求4：thread 建立后事件 envelope 切换为真实 thread id（对齐
    // ACP/PiRpc runtime）。此前全程用 pending id：第一轮结束前端 drop 清掉
    // alias 后，第二轮（复用进程，session id 相同不触发 alias 重建）的全部
    // 事件经 pushTracked 落入无人订阅的孤儿 entry——UI 永远「思考中」、
    // 切回会话后回复成对重复渲染。SessionResolved 之前的握手事件仍用
    // pending id（前端尚未建立 alias）。主循环内的命令/通知 flush 同改。
    let envelope_id = thread_id.clone();

    // 3. turn/start (first message). The response carries the Turn id; the turn
    //    keeps streaming afterwards and ends with turn/completed.
    let turn_start_id = writer
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": first_message }]
            }),
        )
        .await?;
    let turn_resp = wait_for_response(
        &mut stdout_rx,
        &mut pending_user_inputs,
        &mut pending_approvals,
        &emit,
        &pending_session_id,
        &mut buf,
        &mut last_flush,
        turn_start_id,
        &usage_cell,
    )
    .await
    .map_err(|e| format!("codex turn/start failed: {e}"))?;
    let active_turn_id = extract_turn_id(&turn_resp);
    flush_buf(&emit, &pending_session_id, &mut buf);

    let mut state = LoopState::Prompting { active_turn_id };

    // 4. Main loop.
    loop {
        // v0.8.0 需求7：每轮头部把回合真值同步到 AcpControl 共享标志——
        // 状态迁移都发生在各分支内，此处统一收口，避免逐点翻转移漏。
        // CancelPending 期间旧回合尚未收到 TurnComplete，仍算进行中。
        turn_active.store(!matches!(state, LoopState::Idle { .. }), Ordering::Relaxed);
        let idle_deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;

        let exit = tokio::select! {
            cmd = command_rx.recv() => {
                handle_command(
                    cmd,
                    &mut state,
                    &thread_id,
                    &mut writer,
                    &mut pending_user_inputs,
                    &mut pending_approvals,
                    &emit,
                    &envelope_id,
                    &mut buf,
                    &usage_cell,
                )
                .await?
            }
            line = stdout_rx.recv() => match line {
                Some(line) => {
                    handle_line(
                        &line,
                        &mut state,
                        &mut pending_user_inputs,
                        &mut pending_approvals,
                        &emit,
                        &envelope_id,
                        &mut buf,
                        &policy,
                        Some(&writer),
                        &usage_cell,
                    )
                    .await;
                    flush_maybe(&emit, &envelope_id, &mut buf, &mut last_flush);
                    false
                }
                None => {
                    log::warn!("codex app-server stdout EOF (thread {})", thread_id);
                    if matches!(state, LoopState::Prompting { .. }) {
                        return Err(format!(
                            "codex app-server process exited unexpectedly (thread {}). Check stderr for details.",
                            thread_id
                        ));
                    }
                    true
                }
            },
            _ = tokio::time::sleep_until(idle_deadline) => {
                matches!(state, LoopState::Idle { .. })
            }
        };

        if exit {
            break;
        }
    }

    if !buf.is_empty() {
        flush_buf(&emit, &envelope_id, &mut buf);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn initialize_codex(
    writer: &mut CodexWriter,
    stdout_rx: &mut tokio::sync::mpsc::Receiver<String>,
    pending_user_inputs: &mut HashMap<String, PendingUserInput>,
    pending_approvals: &mut HashMap<String, PendingApproval>,
    emit: &AcpEventEmit,
    session_id: &str,
    buf: &mut Vec<NormalizedEvent>,
    last_flush: &mut std::time::Instant,
) -> Result<bool, String> {
    let experimental_id = writer
        .request("initialize", initialize_params(true))
        .await?;
    // 握手期无 thread，tokenUsage 不可能到达——本地空 cell 满足签名。
    let handshake_usage_cell = UsageCell::new(None);
    match wait_for_response(
        stdout_rx,
        pending_user_inputs,
        pending_approvals,
        emit,
        session_id,
        buf,
        last_flush,
        experimental_id,
        &handshake_usage_cell,
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(err) => {
            log::warn!(
                "codex initialize with experimentalApi failed ({err}); retrying without experimentalApi"
            );
            let baseline_id = writer
                .request("initialize", initialize_params(false))
                .await?;
            wait_for_response(
                stdout_rx,
                pending_user_inputs,
                pending_approvals,
                emit,
                session_id,
                buf,
                last_flush,
                baseline_id,
                &handshake_usage_cell,
            )
            .await
            .map_err(|fallback_err| {
                format!(
                    "codex initialize failed: experimentalApi error: {err}; fallback error: {fallback_err}"
                )
            })?;
            Ok(false)
        }
    }
}

/// Read stdout lines until the response matching `expected_id` arrives. Server
/// requests and notifications seen while waiting are processed immediately (so
/// nothing is dropped); other responses are ignored. Returns the `result` of
/// the matched response.
#[allow(clippy::too_many_arguments)]
async fn wait_for_response(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<String>,
    pending_user_inputs: &mut HashMap<String, PendingUserInput>,
    pending_approvals: &mut HashMap<String, PendingApproval>,
    emit: &AcpEventEmit,
    session_id: &str,
    buf: &mut Vec<NormalizedEvent>,
    last_flush: &mut std::time::Instant,
    expected_id: i64,
    usage_cell: &UsageCell,
) -> Result<Value, String> {
    loop {
        let line = tokio::time::timeout(Duration::from_secs(45), stdout_rx.recv())
            .await
            .map_err(|_| "codex app-server response timeout (45s)".to_string())?
            .ok_or_else(|| "codex app-server stdout closed during handshake".to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match classify_line(&msg) {
            LineKind::Response { id, result, error } => {
                if id == Value::from(expected_id) {
                    if let Some(err) = error {
                        let message = err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("codex app-server request failed")
                            .to_string();
                        return Err(message);
                    }
                    return Ok(result.unwrap_or(Value::Null));
                }
                // Unmatched response — ignore.
            }
            LineKind::ServerRequest { id, method, params } => {
                // 握手/首回合等待窗内的审批请求：空链（直接注册弹 UI），
                // 行为与改造前一致；主循环（handle_line）才是策略链主场。
                register_server_request(
                    &id,
                    &method,
                    &params,
                    session_id,
                    pending_user_inputs,
                    pending_approvals,
                    emit,
                    session_id,
                    buf,
                    &crate::agent::policy::PolicyChain::empty(),
                    None,
                )
                .await;
                flush_buf(emit, session_id, buf);
            }
            LineKind::Notification { method, params } => {
                // v0.9.0 需求5：等待窗内的 tokenUsage（thread/resume 补发）同样捕获。
                capture_token_usage(&method, &params, usage_cell);
                for event in normalize_notification(&method, &params) {
                    buf.push(event);
                }
                flush_maybe(emit, session_id, buf, last_flush);
            }
            LineKind::Other => {}
        }
    }
}

#[derive(Debug)]
enum LineKind {
    /// Response to one of OUR requests: `{id, result?}` or `{id, error}`.
    Response {
        id: Value,
        result: Option<Value>,
        error: Option<Value>,
    },
    /// Notification: `{method, params?}` (no id).
    Notification {
        method: String,
        params: Value,
    },
    /// Server-initiated request: `{id, method, params?}` (needs a response).
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
    Other,
}

fn classify_line(msg: &Value) -> LineKind {
    let id = msg.get("id").cloned();
    let method = msg
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);
    match (id, method) {
        (Some(id), Some(method)) => LineKind::ServerRequest {
            id,
            method,
            params: msg.get("params").cloned().unwrap_or(Value::Null),
        },
        (Some(id), None) => {
            // Response to our request: has result and/or error, no method.
            let result = msg.get("result").cloned();
            let error = msg.get("error").cloned();
            LineKind::Response { id, result, error }
        }
        (None, Some(method)) => LineKind::Notification {
            method,
            params: msg.get("params").cloned().unwrap_or(Value::Null),
        },
        (None, None) => LineKind::Other,
    }
}

// ---------------------------------------------------------------------------
// Internal: line + command handling
// ---------------------------------------------------------------------------

/// Process one stdout line. Sync because it runs in the select branch; the only
/// stdin writes happen later when the user answers (command path).
#[allow(clippy::too_many_arguments)]
async fn handle_line(
    line: &str,
    state: &mut LoopState,
    pending_user_inputs: &mut HashMap<String, PendingUserInput>,
    pending_approvals: &mut HashMap<String, PendingApproval>,
    emit: &AcpEventEmit,
    session_id: &str,
    buf: &mut Vec<NormalizedEvent>,
    policy: &crate::agent::policy::PolicyChain,
    writer: Option<&CodexWriter>,
    usage_cell: &UsageCell,
) {
    if line.trim().is_empty() {
        return;
    }
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    match classify_line(&msg) {
        LineKind::Response { result, .. } => {
            // The handshake consumes the first turn/start response. Subsequent
            // turn/start responses (later turns) arrive here carrying the new
            // turn id — capture it so steer/interrupt target the right turn.
            if let Some(turn_id) = result.as_ref().and_then(extract_turn_id) {
                set_active_turn_id(state, Some(turn_id));
            }
        }
        LineKind::Notification { method, params } => match method.as_str() {
            "turn/completed" => {
                let reason = params
                    .get("turn")
                    .and_then(|t| t.get("status"))
                    .and_then(Value::as_str)
                    .map(turn_status_to_reason)
                    .unwrap_or(TurnEndReason::Complete);
                buf.push(NormalizedEvent::TurnComplete {
                    reason,
                    // v0.9.0 需求5：轮末带出累积用量（tokenUsage 累积器 take）。
                    usage: usage_cell
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take(),
                });
                // v0.7.0：turn/completed 是 turn 的最后一条消息，之后 codex 进入 idle，
                // 没有更多事件触发 flush_maybe。必须强制 flush，否则 TurnComplete 留在
                // buf 里永远不发出，前端流式永不结束（一直显示"处理中"）。
                flush_buf(emit, session_id, buf);
                match state {
                    LoopState::Prompting { active_turn_id } => {
                        *state = LoopState::Idle {
                            active_turn_id: active_turn_id.take(),
                        };
                    }
                    LoopState::CancelPending => {
                        *state = LoopState::Idle {
                            active_turn_id: None,
                        };
                    }
                    LoopState::Idle { .. } => {}
                }
            }
            "turn/started" => {
                // Some servers emit the turn id as a notification too.
                if let Some(id) = extract_turn_id_from_params(&params) {
                    set_active_turn_id(state, Some(id));
                }
            }
            // v0.9.0 需求5：turn 进行中每个模型响应后到达；到达即更新累积器，
            // 轮末由 turn/completed 带出（与 ACP usage_acc 同模式）。
            "thread/tokenUsage/updated" => {
                capture_token_usage(&method, &params, usage_cell);
            }
            _ => {
                for event in normalize_notification(&method, &params) {
                    buf.push(event);
                }
            }
        },
        LineKind::ServerRequest { id, method, params } => {
            let thread = params
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            register_server_request(
                &id,
                &method,
                &params,
                &thread,
                pending_user_inputs,
                pending_approvals,
                emit,
                session_id,
                buf,
                policy,
                writer,
            )
            .await;
        }
        LineKind::Other => {}
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_command(
    cmd: Option<AcpCommand>,
    state: &mut LoopState,
    thread_id: &str,
    writer: &mut CodexWriter,
    pending_user_inputs: &mut HashMap<String, PendingUserInput>,
    pending_approvals: &mut HashMap<String, PendingApproval>,
    emit: &AcpEventEmit,
    session_id: &str,
    buf: &mut Vec<NormalizedEvent>,
    usage_cell: &UsageCell,
) -> Result<bool, String> {
    match cmd {
        Some(AcpCommand::Prompt(msg)) => match state {
            LoopState::Idle { .. } => {
                // Fire turn/start; the turn id is captured when the response
                // (or a turn/started notification) arrives in the stdout pump,
                // and turn/completed flips state back to Idle.
                writer
                    .request(
                        "turn/start",
                        json!({
                            "threadId": thread_id,
                            "input": [{ "type": "text", "text": msg }]
                        }),
                    )
                    .await?;
                *state = LoopState::Prompting {
                    active_turn_id: None,
                };
            }
            LoopState::Prompting { .. } | LoopState::CancelPending => {
                log::warn!("codex turn/start ignored: a turn is already in progress");
            }
        },
        Some(AcpCommand::Steer(msg)) => {
            let active_turn_id = active_turn_of(state);
            if let Some(turn_id) = active_turn_id {
                writer
                    .request(
                        "turn/steer",
                        json!({
                            "threadId": thread_id,
                            "input": [{ "type": "text", "text": msg }],
                            "expectedTurnId": turn_id
                        }),
                    )
                    .await?;
                log::debug!("codex turn/steer sent");
            } else {
                log::warn!("codex turn/steer ignored: no active turn to steer");
            }
        }
        Some(AcpCommand::SetThinkingLevel(level)) => {
            // codex app-server 协议无 thinking 概念（reasoning effort 参数位
            // 未实测）；IPC 层已按 capability 门控，此分支仅兜底。
            log::warn!(
                "codex runtime received SetThinkingLevel({level}) — not supported, dropping"
            );
        }
        Some(AcpCommand::Compact { response, .. }) => {
            // codex app-server 协议未见 compact 方法（TUI 有 /compact 但协议未暴露）。
            let _ = response.send(Err(
                "Context compaction is not supported by this agent".to_string()
            ));
        }
        Some(AcpCommand::SetAutoCompaction {
            enabled,
            threshold_percent,
        }) => {
            log::warn!(
                "codex runtime received SetAutoCompaction(enabled={enabled:?}, threshold={threshold_percent:?}) — not supported, dropping"
            );
        }
        Some(AcpCommand::ForkSession { response }) => {
            // codex thread 无会话分支概念；IPC 层已按 SESSION_FORK capability
            // 门控（v0.8.0 需求1 A5 已回收 codex 的虚假声明），此分支仅兜底。
            let _ = response.send(Err(
                "Session fork is not supported by this agent".to_string()
            ));
        }
        Some(AcpCommand::Cancel) => {
            let active_turn_id = active_turn_of(state);
            if let Some(turn_id) = active_turn_id.as_ref() {
                let _ = writer
                    .request(
                        "turn/interrupt",
                        json!({ "threadId": thread_id, "turnId": turn_id }),
                    )
                    .await;
                log::info!("codex turn/interrupt sent");
            }
            // Best-effort: answer in-flight server requests so codex does not
            // block on a request that will never get a real answer.
            drain_pending_on_cancel(writer, pending_user_inputs, pending_approvals).await;
            *state = LoopState::CancelPending;
            // If there is no active turn, nothing else will emit turn/completed,
            // so emit TurnComplete(Aborted) directly.
            if active_turn_id.is_none() {
                buf.push(NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Aborted,
                    // v0.9.0 需求5：无活跃回合取消时带出最后已知用量（对齐 ACP cancel）。
                    usage: usage_cell
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take(),
                });
                flush_buf(emit, session_id, buf);
                *state = LoopState::Idle {
                    active_turn_id: None,
                };
            }
        }
        Some(AcpCommand::RespondToInput {
            id,
            value,
            response,
        }) => {
            let result = respond_to_user_input(&id, &value, writer, pending_user_inputs).await;
            match &result {
                Ok(()) => log::debug!("codex RespondToInput write-back sent for {}", id),
                Err(error) => {
                    log::error!("codex RespondToInput write-back failed for {}: {error}", id)
                }
            }
            let _ = response.send(result);
        }
        Some(AcpCommand::ResolvePermission {
            request_id,
            approved,
            response,
        }) => {
            let result =
                resolve_codex_approval(&request_id, approved, writer, pending_approvals).await;
            match &result {
                Ok(()) => {
                    log::debug!("codex ResolvePermission write-back sent for {}", request_id)
                }
                Err(error) => log::error!(
                    "codex ResolvePermission write-back failed for {}: {error}",
                    request_id
                ),
            }
            let _ = response.send(result);
        }
        Some(AcpCommand::Shutdown) => {
            log::info!("codex app-server shutdown requested (thread {})", thread_id);
            drain_pending_on_cancel(writer, pending_user_inputs, pending_approvals).await;
            return Ok(true);
        }
        None => {
            log::info!(
                "codex app-server command channel closed (thread {})",
                thread_id
            );
            return Ok(true);
        }
    }
    Ok(false)
}

/// Register a server request and emit the matching NormalizedEvent. No stdin
/// write — the write-back happens when the user later answers (command path).
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
async fn register_server_request(
    id: &Value,
    method: &str,
    params: &Value,
    thread: &str,
    pending_user_inputs: &mut HashMap<String, PendingUserInput>,
    pending_approvals: &mut HashMap<String, PendingApproval>,
    emit: &AcpEventEmit,
    session_id: &str,
    buf: &mut Vec<NormalizedEvent>,
    policy: &crate::agent::policy::PolicyChain,
    writer: Option<&CodexWriter>,
) {
    let turn = params
        .get("turnId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    match method {
        "item/tool/requestUserInput" => {
            // R8: split by payload. Options that are all Accept/Decline/Cancel
            // indicate an MCP/connector side-effect approval; anything else is a
            // genuine business question.
            match classify_request_user_input(params) {
                RequestUserInputKind::Business(questions) => {
                    for q in questions {
                        let request_id = business_request_id(id, &q.id);
                        let correlation = InteractionCorrelation {
                            thread_id: (!thread.is_empty()).then(|| thread.to_string()),
                            turn_id: (!turn.is_empty()).then(|| turn.to_string()),
                            server_request_id: Some(rpc_id_str(id)),
                            jsonrpc_id: Some(id.clone()),
                            request_kind: Some(KIND_BUSINESS.to_string()),
                            ..Default::default()
                        };
                        pending_user_inputs.insert(
                            request_id.clone(),
                            PendingUserInput {
                                rpc_id: id.clone(),
                                question_id: q.id.clone(),
                                thread_id: thread.to_string(),
                                turn_id: turn.clone(),
                            },
                        );
                        buf.push(NormalizedEvent::InteractionRequest {
                            request_id,
                            prompt: q.prompt,
                            options: q.options,
                            allow_multiple: false,
                            allow_custom_text: q.allow_custom_text,
                            required: true,
                            transport: InteractionTransport::CodexAppServer,
                            origin: InteractionOrigin::CodexToolRequestUserInput,
                            delivery_hint: InteractionDeliveryHint::MidTurn,
                            correlation: Some(correlation),
                        });
                    }
                    flush_buf(emit, session_id, buf);
                }
                RequestUserInputKind::McpApproval(accept_label, decline_label, question_id) => {
                    let request_id = approval_request_id(id);
                    pending_approvals.insert(
                        request_id.clone(),
                        PendingApproval {
                            rpc_id: id.clone(),
                            kind: ApprovalKind::Other,
                            thread_id: thread.to_string(),
                            turn_id: turn.clone(),
                            writeback: ApprovalWriteback::AnswerLabel {
                                question_id,
                                accept_label,
                                decline_label,
                            },
                        },
                    );
                    buf.push(NormalizedEvent::ApprovalRequest {
                        request_id,
                        approval_kind: ApprovalKind::Other,
                        payload: params.clone(),
                    });
                    flush_buf(emit, session_id, buf);
                }
            }
        }
        "item/commandExecution/requestApproval" => try_policy_or_register(
            id,
            params,
            thread,
            &turn,
            ApprovalKind::Command,
            ApprovalWriteback::Decision,
            pending_approvals,
            emit,
            session_id,
            buf,
            policy,
            writer,
        )
        .await,
        "item/fileChange/requestApproval" => try_policy_or_register(
            id,
            params,
            thread,
            &turn,
            ApprovalKind::FileWrite,
            ApprovalWriteback::Decision,
            pending_approvals,
            emit,
            session_id,
            buf,
            policy,
            writer,
        )
        .await,
        "item/permissions/requestApproval" => try_policy_or_register(
            id,
            params,
            thread,
            &turn,
            ApprovalKind::Other,
            ApprovalWriteback::Decision,
            pending_approvals,
            emit,
            session_id,
            buf,
            policy,
            writer,
        )
        .await,
        other => {
            // Unhandled server request (e.g. mcpServer/elicitation/request).
            // We cannot answer it correctly without the schema; left unregistered
            // so it is never mistaken for an answerable approval/question. The
            // turn may stall on these — logged for diagnostics.
            log::warn!(
                "codex app-server: unhandled server request `{}` (id {:?})",
                other,
                id
            );
        }
    }
}


/// v0.8.0 需求2 Phase 2 挂载点 1（codex）：审批到达先过策略链——
/// Allow/Deny 直接 `respond` 回写不打扰用户；Delegate 走 register_approval
/// 弹 UI。回写结果形状对齐 codex 协议（decision: approved/denied）。
async fn try_policy_or_register(
    id: &Value,
    params: &Value,
    thread: &str,
    turn: &str,
    kind: ApprovalKind,
    writeback: ApprovalWriteback,
    pending_approvals: &mut HashMap<String, PendingApproval>,
    emit: &AcpEventEmit,
    session_id: &str,
    buf: &mut Vec<NormalizedEvent>,
    policy: &crate::agent::policy::PolicyChain,
    writer: Option<&CodexWriter>,
) {
    let ctx = crate::agent::policy::ApprovalContext {
        channel: crate::agent::policy::DecisionChannel::Interactive,
        kind: crate::agent::policy::ApprovalKindWire::Other,
        session_id: session_id.to_string(),
        tool: None,
        payload: params.clone(),
        payload_declares: false,
        high_risk: false,
    };
    let decision = policy.evaluate(&ctx);
    let approved = match decision {
        crate::agent::policy::ChainOutcome::Allow(policy_id) => Some((true, policy_id)),
        crate::agent::policy::ChainOutcome::Deny(policy_id) => Some((false, policy_id)),
        crate::agent::policy::ChainOutcome::Delegate => None,
    };
    if let Some((allow, policy_id)) = approved {
        let result = serde_json::json!({ "decision": if allow { "approved" } else { "denied" } });
        if let Some(writer) = writer {
            let _ = writer.respond(id, result).await;
        }
        log::info!(
            "codex approval auto-{} by policy {policy_id} (session {session_id})",
            if allow { "allowed" } else { "denied" }
        );
        return;
    }
    // 到达上下文按 request_id 登记——「始终允许」取回同形状回写 Once 记忆
    //（见 chat.rs）。request_id 与 register_approval 内部生成的键同源（同 id）。
    crate::agent::policy::register_arrival_context(&approval_request_id(id), &ctx);
    register_approval(
        id,
        params,
        thread,
        turn,
        kind,
        writeback,
        pending_approvals,
        emit,
        session_id,
        buf,
    );
}

#[allow(clippy::too_many_arguments)]
fn register_approval(
    id: &Value,
    params: &Value,
    thread: &str,
    turn: &str,
    kind: ApprovalKind,
    writeback: ApprovalWriteback,
    pending_approvals: &mut HashMap<String, PendingApproval>,
    emit: &AcpEventEmit,
    session_id: &str,
    buf: &mut Vec<NormalizedEvent>,
) {
    let request_id = approval_request_id(id);
    pending_approvals.insert(
        request_id.clone(),
        PendingApproval {
            rpc_id: id.clone(),
            kind: kind.clone(),
            thread_id: thread.to_string(),
            turn_id: turn.to_string(),
            writeback,
        },
    );
    buf.push(NormalizedEvent::ApprovalRequest {
        request_id,
        approval_kind: kind,
        payload: params.clone(),
    });
    flush_buf(emit, session_id, buf);
}

// ---------------------------------------------------------------------------
// Internal: write-backs
// ---------------------------------------------------------------------------

async fn respond_to_user_input(
    request_id: &str,
    value: &str,
    writer: &CodexWriter,
    pending_user_inputs: &mut HashMap<String, PendingUserInput>,
) -> Result<(), String> {
    let pending = pending_user_inputs
        .remove(request_id)
        .ok_or_else(|| format!("no pending codex business question for {request_id}"))?;
    let result = user_input_result(&pending.question_id, value);
    writer.respond(&pending.rpc_id, result).await
}

async fn resolve_codex_approval(
    request_id: &str,
    approved: bool,
    writer: &CodexWriter,
    pending_approvals: &mut HashMap<String, PendingApproval>,
) -> Result<(), String> {
    let pending = pending_approvals
        .remove(request_id)
        .ok_or_else(|| format!("no pending codex approval for {request_id}"))?;
    let result = match pending.writeback {
        ApprovalWriteback::Decision => decision_result(approved),
        ApprovalWriteback::AnswerLabel {
            question_id,
            accept_label,
            decline_label,
        } => user_input_result(
            &question_id,
            if approved {
                &accept_label
            } else {
                &decline_label
            },
        ),
    };
    writer.respond(&pending.rpc_id, result).await
}

/// Answer all in-flight server requests on cancel/shutdown so codex never blocks
/// on a request that will never receive a real answer.
async fn drain_pending_on_cancel(
    writer: &CodexWriter,
    pending_user_inputs: &mut HashMap<String, PendingUserInput>,
    pending_approvals: &mut HashMap<String, PendingApproval>,
) {
    for (_, pending) in pending_user_inputs.drain() {
        if let Err(error) = writer
            .respond(&pending.rpc_id, user_input_result(&pending.question_id, ""))
            .await
        {
            log::warn!("codex: failed to drain pending user input on cancel: {error}");
        }
    }
    for (_, pending) in pending_approvals.drain() {
        let result = match pending.writeback {
            ApprovalWriteback::Decision => decision_result(false),
            ApprovalWriteback::AnswerLabel {
                question_id,
                decline_label,
                ..
            } => user_input_result(&question_id, &decline_label),
        };
        if let Err(error) = writer.respond(&pending.rpc_id, result).await {
            log::warn!("codex: failed to drain pending approval on cancel: {error}");
        }
    }
}

// ---------------------------------------------------------------------------
// Internal: notification normalization
// ---------------------------------------------------------------------------

fn normalize_notification(method: &str, params: &Value) -> Vec<NormalizedEvent> {
    match method {
        "item/agentMessage/delta" => {
            let delta = params
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if delta.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::TextDelta {
                    delta: delta.to_string(),
                }]
            }
        }
        // v0.7.0：codex 可能不发 delta 而是直接发 item/completed（完整回复）。
        // 提取 item.text 作为 TextDelta；streamStore 的 snapshot-echo guard 会
        // 去重（如果 delta 已经发过同样的文本）。
        "item/completed" => {
            let text = params
                .get("item")
                .and_then(|i| i.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if text.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::TextDelta {
                    delta: text.to_string(),
                }]
            }
        }
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            let delta = params
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if delta.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::Thinking {
                    delta: delta.to_string(),
                }]
            }
        }
        // v0.8.0 需求2 Phase 1：codex 工具事件投影——commandExecution /
        // fileChange item 的 started/updated/completed 生命周期映射为
        // ToolUseStart/ToolUseResult（带渲染意图 view），让 codex 会话出现
        // 工具卡片（此前完全没有，01 §2）。payload 结构按 codex app-server
        // 协议（itemId / command / exitCode / stdout / changeType / path）。
        "item/commandExecution/started" | "item/commandExecution/updated" => {
            let item = params.get("item");
            let call_id = item
                .and_then(|i| i.get("id").or_else(|| params.get("itemId")))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if call_id.is_empty() {
                return vec![];
            }
            let command = item
                .and_then(|i| i.get("command"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let cwd = item
                .and_then(|i| i.get("cwd"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let input = serde_json::json!({ "command": command, "cwd": cwd });
            let view = crate::agent::tool_view::classify_tool_view("bash", &input);
            vec![NormalizedEvent::ToolUseStart {
                call_id,
                tool: "bash".to_string(),
                input,
                view: Some(view),
            }]
        }
        "item/commandExecution/completed" => {
            let item = params.get("item");
            let call_id = item
                .and_then(|i| i.get("id").or_else(|| params.get("itemId")))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if call_id.is_empty() {
                return vec![];
            }
            let exit_code = item
                .and_then(|i| i.get("exitCode"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let stdout = item
                .and_then(|i| i.get("stdout"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let output = serde_json::json!({
                "exitCode": exit_code,
                "stdout": truncate_str(&stdout, 2000),
            });
            vec![NormalizedEvent::ToolUseResult {
                call_id,
                output,
                is_error: exit_code != 0,
            }]
        }
        "item/fileChange/started" | "item/fileChange/updated" => {
            let item = params.get("item");
            let call_id = item
                .and_then(|i| i.get("id").or_else(|| params.get("itemId")))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if call_id.is_empty() {
                return vec![];
            }
            let change_type = item
                .and_then(|i| i.get("changeType"))
                .and_then(Value::as_str)
                .unwrap_or("modify")
                .to_string();
            let path = item
                .and_then(|i| i.get("path").or_else(|| i.get("file")))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            // 变更类型 → 工具方言名：create→write / delete→bash 删档展示 / 其他→edit。
            let tool_name = match change_type.as_str() {
                "create" => "write",
                "delete" => "edit",
                _ => "edit",
            };
            let input = serde_json::json!({ "path": path, "changeType": change_type });
            let view = crate::agent::tool_view::classify_tool_view(tool_name, &input);
            vec![NormalizedEvent::ToolUseStart {
                call_id,
                tool: tool_name.to_string(),
                input,
                view: Some(view),
            }]
        }
        "item/fileChange/completed" => {
            let item = params.get("item");
            let call_id = item
                .and_then(|i| i.get("id").or_else(|| params.get("itemId")))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if call_id.is_empty() {
                return vec![];
            }
            let path = item
                .and_then(|i| i.get("path").or_else(|| i.get("file")))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            vec![NormalizedEvent::ToolUseResult {
                call_id,
                output: serde_json::json!({ "path": path, "status": "done" }),
                is_error: false,
            }]
        }
        // thread/started and turn/started carry only state we track directly in
        // handle_line (session already resolved at handshake; turn id captured).
        _ => vec![],
    }
}

/// 截断长输出（工具结果摘要用）。
fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{truncated}…")
    }
}

fn turn_status_to_reason(status: &str) -> TurnEndReason {
    match status {
        "interrupted" => TurnEndReason::Aborted,
        "failed" => TurnEndReason::Error,
        _ => TurnEndReason::Complete,
    }
}

// ---------------------------------------------------------------------------
// Internal: pure helpers (unit-tested)
// ---------------------------------------------------------------------------

fn initialize_params(experimental_api: bool) -> Value {
    let mut params = json!({
        "clientInfo": { "name": "jishu-hub", "version": "0.6.0" }
    });
    if experimental_api {
        params["capabilities"] = json!({ "experimentalApi": true });
    }
    params
}

/// Extract the turn id from a `turn/start` response result `{turn:{id,…}}`,
/// tolerant of `id` vs `turnId`.
fn extract_turn_id(resp: &Value) -> Option<String> {
    resp.get("turn").or_else(|| Some(resp)).and_then(id_like)
}

fn extract_turn_id_from_params(params: &Value) -> Option<String> {
    params
        .get("turn")
        .or_else(|| Some(params))
        .and_then(id_like)
}

/// Extract the thread id from a `thread/start` response result `{thread:{id,…}}`,
/// tolerant of `id` vs `threadId`.
fn extract_thread_id(resp: &Value) -> Option<String> {
    resp.get("thread").or_else(|| Some(resp)).and_then(id_like)
}

fn id_like(obj: &Value) -> Option<String> {
    obj.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            obj.get("turnId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            obj.get("threadId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

/// A business question parsed out of `item/tool/requestUserInput` params.
struct ParsedQuestion {
    id: String,
    prompt: String,
    options: Vec<InteractionOption>,
    allow_custom_text: bool,
}

enum RequestUserInputKind {
    /// Genuine business questions.
    Business(Vec<ParsedQuestion>),
    /// An MCP/connector side-effect approval (Accept/Decline/Cancel options).
    /// Carries the answer labels + the question id to populate on write-back.
    McpApproval(String, String, String),
}

impl RequestUserInputKind {
    #[cfg(test)]
    fn is_business(&self) -> bool {
        matches!(self, RequestUserInputKind::Business(_))
    }
}

/// R8 origin split: if a question's options are all Accept/Decline/Cancel, the
/// request is an MCP approval — not a business question. Mirrors the wire-format
/// spike (`.tmp/interaction-feasibility/spike.mjs`).
fn classify_request_user_input(params: &Value) -> RequestUserInputKind {
    let questions = match params.get("questions").and_then(Value::as_array) {
        Some(arr) => arr,
        None => return RequestUserInputKind::Business(Vec::new()),
    };

    // MCP approval: ANY question whose options are entirely Accept/Decline/Cancel.
    for q in questions {
        if let Some(options) = q.get("options").and_then(Value::as_array) {
            if !options.is_empty()
                && options.iter().all(|o| {
                    let label = o.get("label").and_then(Value::as_str).unwrap_or_default();
                    APPROVAL_LABELS.contains(&label)
                })
            {
                let qid = question_id_of(q);
                let (accept, decline) = approval_labels(options);
                return RequestUserInputKind::McpApproval(accept, decline, qid);
            }
        }
    }

    let parsed = questions
        .iter()
        .filter_map(|q| {
            let prompt = q
                .get("question")
                .or_else(|| q.get("header"))
                .or_else(|| q.get("prompt"))
                .and_then(Value::as_str)?
                .trim()
                .to_string();
            if prompt.is_empty() {
                return None;
            }
            let id = question_id_of(q);
            let options = q
                .get("options")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|option| {
                            let label = option
                                .get("label")
                                .or_else(|| option.get("title"))
                                .and_then(Value::as_str)?
                                .trim()
                                .to_string();
                            if label.is_empty() {
                                return None;
                            }
                            Some(InteractionOption {
                                option_id: label.clone(),
                                label,
                                description: option
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let allow_custom_text = q
                .get("isOther")
                .and_then(Value::as_bool)
                .unwrap_or(options.is_empty());
            Some(ParsedQuestion {
                id,
                prompt,
                options,
                allow_custom_text,
            })
        })
        .collect();
    RequestUserInputKind::Business(parsed)
}

const APPROVAL_LABELS: [&str; 3] = ["Accept", "Decline", "Cancel"];

fn question_id_of(question: &Value) -> String {
    question
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "q".to_string())
}

/// Find the Accept/Decline labels in an all-approval option set.
fn approval_labels(options: &[Value]) -> (String, String) {
    let accept = options
        .iter()
        .find_map(|o| {
            let label = o.get("label").and_then(Value::as_str).unwrap_or_default();
            (label == "Accept").then(|| label.to_string())
        })
        .unwrap_or_else(|| "Accept".to_string());
    let decline = options
        .iter()
        .find_map(|o| {
            let label = o.get("label").and_then(Value::as_str).unwrap_or_default();
            (label == "Decline").then(|| label.to_string())
        })
        .unwrap_or_else(|| "Decline".to_string());
    (accept, decline)
}

/// Frontend-facing request ids. Distinct prefixes keep the business / approval
/// maps from colliding even if codex reuses a JSON-RPC id.
fn business_request_id(rpc_id: &Value, question_id: &str) -> String {
    format!("codex-{}-{}", rpc_id_str(rpc_id), question_id)
}

fn approval_request_id(rpc_id: &Value) -> String {
    format!("codex-approval-{}", rpc_id_str(rpc_id))
}

fn rpc_id_str(rpc_id: &Value) -> String {
    rpc_id
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| rpc_id.to_string())
}

/// `{answers:{[question_id]:{answers:[value]}}}` — the codex
/// `item/tool/requestUserInput` result shape.
fn user_input_result(question_id: &str, value: &str) -> Value {
    let mut answers = serde_json::Map::new();
    answers.insert(question_id.to_string(), json!({ "answers": [value] }));
    json!({ "answers": Value::Object(answers) })
}

/// `{decision:"accept"|"decline"}` — the `item/*/requestApproval` result shape.
/// `accept`/`decline` are valid in every codex approval decision enum
/// (commandExecution / fileChange / permissions).
fn decision_result(approved: bool) -> Value {
    json!({ "decision": if approved { "accept" } else { "decline" } })
}

fn set_active_turn_id(state: &mut LoopState, id: Option<String>) {
    match state {
        LoopState::Idle { active_turn_id } => *active_turn_id = id,
        LoopState::Prompting { active_turn_id } => *active_turn_id = id,
        LoopState::CancelPending => {}
    }
}

fn active_turn_of(state: &LoopState) -> Option<String> {
    match state {
        LoopState::Idle { active_turn_id } => active_turn_id.clone(),
        LoopState::Prompting { active_turn_id } => active_turn_id.clone(),
        LoopState::CancelPending => None,
    }
}

fn flush_buf(emit: &AcpEventEmit, session_id: &str, buf: &mut Vec<NormalizedEvent>) {
    if buf.is_empty() {
        return;
    }
    emit(buf, session_id);
    buf.clear();
}

fn flush_maybe(
    emit: &AcpEventEmit,
    session_id: &str,
    buf: &mut Vec<NormalizedEvent>,
    last_flush: &mut std::time::Instant,
) {
    if buf.len() >= 32 || last_flush.elapsed() >= Duration::from_millis(8) {
        flush_buf(emit, session_id, buf);
        *last_flush = std::time::Instant::now();
    }
}

// ---------------------------------------------------------------------------
// Internal: writer (newline-delimited JSON-RPC, NO jsonrpc field)
// ---------------------------------------------------------------------------

struct CodexWriter {
    stdin: Arc<TokioMutex<ChildStdin>>,
    next_id: i64,
}

impl CodexWriter {
    fn new(stdin: Arc<TokioMutex<ChildStdin>>) -> Self {
        Self { stdin, next_id: 1 }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<i64, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "id": id, "method": method, "params": params });
        write_line(&self.stdin, &msg).await?;
        Ok(id)
    }

    /// Write a response to a server-initiated request: `{id, result}`.
    async fn respond(&self, id: &Value, result: Value) -> Result<(), String> {
        let msg = json!({ "id": id, "result": result });
        write_line(&self.stdin, &msg).await
    }
}

async fn write_line(stdin: &Arc<TokioMutex<ChildStdin>>, msg: &Value) -> Result<(), String> {
    let mut stdin = stdin.lock().await;
    let line = format!("{}\n", msg);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("codex app-server stdin write failed: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("codex app-server stdin flush failed: {e}"))?;
    Ok(())
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
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_business_question() {
        let params = json!({
            "threadId": "t1", "turnId": "tu1", "itemId": "i1",
            "questions": [{
                "id": "architecture",
                "header": "方案",
                "question": "请选择架构",
                "options": [
                    { "label": "A", "description": "单体" },
                    { "label": "B", "description": "前后端分离" }
                ]
            }]
        });
        match classify_request_user_input(&params) {
            RequestUserInputKind::Business(qs) => {
                assert_eq!(qs.len(), 1);
                assert_eq!(qs[0].id, "architecture");
                assert_eq!(qs[0].prompt, "请选择架构");
                assert_eq!(qs[0].options.len(), 2);
                assert!(!qs[0].allow_custom_text);
            }
            RequestUserInputKind::McpApproval(..) => panic!("expected Business"),
        }
    }

    #[test]
    fn classify_free_text_business_question_has_custom_text() {
        let params = json!({
            "questions": [{ "id": "q1", "question": "补充说明" }]
        });
        match classify_request_user_input(&params) {
            RequestUserInputKind::Business(qs) => {
                assert_eq!(qs.len(), 1);
                assert!(qs[0].options.is_empty());
                assert!(qs[0].allow_custom_text);
            }
            RequestUserInputKind::McpApproval(..) => panic!("expected Business"),
        }
    }

    #[test]
    fn classify_mcp_approval_via_request_user_input() {
        let params = json!({
            "questions": [{
                "id": "approve_run",
                "question": "Allow this command?",
                "options": [
                    { "label": "Accept" },
                    { "label": "Decline" },
                    { "label": "Cancel" }
                ]
            }]
        });
        match classify_request_user_input(&params) {
            RequestUserInputKind::McpApproval(accept, decline, qid) => {
                assert_eq!(accept, "Accept");
                assert_eq!(decline, "Decline");
                assert_eq!(qid, "approve_run");
            }
            RequestUserInputKind::Business(_) => panic!("expected McpApproval"),
        }
    }

    #[test]
    fn user_input_result_shape() {
        let result = user_input_result("architecture", "A");
        assert_eq!(
            result,
            json!({ "answers": { "architecture": { "answers": ["A"] } } })
        );
    }

    #[test]
    fn user_input_result_empty_value_drains_as_single_empty_answer() {
        // The cancel-drain path writes an empty-string answer. codex's answer
        // shape is a Vec<String>, so even an empty value is a one-element array
        // (the discard is harmless — turn/interrupt was already sent).
        let result = user_input_result("q1", "");
        assert_eq!(result, json!({ "answers": { "q1": { "answers": [""] } } }));
    }

    #[test]
    fn decision_result_accept_decline() {
        assert_eq!(decision_result(true), json!({ "decision": "accept" }));
        assert_eq!(decision_result(false), json!({ "decision": "decline" }));
    }

    #[test]
    fn extract_turn_and_thread_ids_tolerant() {
        assert_eq!(
            extract_turn_id(&json!({ "turn": { "id": "tu-1" } })),
            Some("tu-1".to_string())
        );
        assert_eq!(
            extract_thread_id(&json!({ "thread": { "id": "t-1" } })),
            Some("t-1".to_string())
        );
    }

    #[test]
    fn classify_line_distinguishes_kinds() {
        assert!(matches!(
            classify_line(
                &json!({ "id": 1, "method": "item/tool/requestUserInput", "params": {} })
            ),
            LineKind::ServerRequest { .. }
        ));
        assert!(matches!(
            classify_line(&json!({ "id": 1, "result": {} })),
            LineKind::Response { .. }
        ));
        assert!(matches!(
            classify_line(&json!({ "method": "turn/completed", "params": {} })),
            LineKind::Notification { .. }
        ));
    }

    #[test]
    fn request_ids_are_distinct_for_business_and_approval() {
        let rpc = json!(7);
        assert_eq!(business_request_id(&rpc, "arch"), "codex-7-arch");
        assert_eq!(approval_request_id(&rpc), "codex-approval-7");
    }

    #[test]
    fn turn_status_maps_to_end_reason() {
        assert_eq!(turn_status_to_reason("completed"), TurnEndReason::Complete);
        assert_eq!(turn_status_to_reason("interrupted"), TurnEndReason::Aborted);
        assert_eq!(turn_status_to_reason("failed"), TurnEndReason::Error);
    }

    #[test]
    fn business_kind_helper() {
        let params = json!({ "questions": [{ "id": "q", "question": "x" }] });
        assert!(classify_request_user_input(&params).is_business());
    }

    #[test]
    fn initialize_params_can_omit_experimental_api() {
        assert_eq!(
            initialize_params(true)["capabilities"]["experimentalApi"],
            true
        );
        assert!(initialize_params(false).get("capabilities").is_none());
    }

    // v0.9.0 需求5：tokenUsage 解析（schema 见 01-分析与实施方案 §二.3）。

    #[test]
    fn parse_token_usage_full_payload() {
        let params = json!({
            "threadId": "t1", "turnId": "tu1",
            "tokenUsage": {
                "last": { "inputTokens": 100, "cachedInputTokens": 80,
                          "cacheWriteInputTokens": 0, "outputTokens": 50,
                          "reasoningOutputTokens": 10, "totalTokens": 150 },
                "total": { "inputTokens": 12000, "cachedInputTokens": 9000,
                           "cacheWriteInputTokens": 0, "outputTokens": 3000,
                           "reasoningOutputTokens": 500, "totalTokens": 15000 },
                "modelContextWindow": 200000
            }
        });
        let stats = parse_token_usage(&params).expect("usage");
        assert_eq!(stats.input_tokens, Some(12000));
        assert_eq!(stats.output_tokens, Some(3000));
        assert_eq!(stats.context_window_total, Some(200000));
        // remaining = window - (input + output)；cached 已含于 input，不重复累加。
        assert_eq!(stats.context_remaining, Some(200000 - 15000));
        assert_eq!(stats.total_cost, None);
    }

    #[test]
    fn parse_token_usage_null_window() {
        let params = json!({
            "tokenUsage": {
                "total": { "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 },
                "modelContextWindow": null
            }
        });
        let stats = parse_token_usage(&params).expect("usage");
        assert_eq!(stats.input_tokens, Some(10));
        assert_eq!(stats.output_tokens, Some(5));
        assert_eq!(stats.context_window_total, None);
        assert_eq!(stats.context_remaining, None);
    }

    #[test]
    fn parse_token_usage_missing_total_is_none() {
        assert!(parse_token_usage(&json!({ "tokenUsage": { "last": {} } })).is_none());
        assert!(parse_token_usage(&json!({})).is_none());
    }

    #[test]
    fn capture_token_usage_updates_cell() {
        let cell = UsageCell::new(None);
        let payload = json!({
            "tokenUsage": {
                "total": { "inputTokens": 7, "outputTokens": 3, "totalTokens": 10 },
                "modelContextWindow": 100
            }
        });
        capture_token_usage("thread/tokenUsage/updated", &payload, &cell);
        assert_eq!(
            cell.lock().unwrap().as_ref().and_then(|u| u.context_remaining),
            Some(90)
        );
        // 非目标方法不触碰 cell。
        capture_token_usage("item/completed", &json!({}), &cell);
        assert!(cell.lock().unwrap().is_some());
    }
}
