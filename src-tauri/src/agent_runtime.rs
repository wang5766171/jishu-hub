use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::ChildStdin;

use crate::acp_runtime::AcpControl;
use crate::agent::normalized::{TurnEndReason, UsageStats};
use crate::agent::{
    AcpCommandSpec, AgentPlugin, AgentRegistry, ChatRequest, NormalizedEvent, TransportSurface,
};

pub struct AgentTurnRequest {
    pub agent_id: String,
    pub project_path: String,
    pub session_id: Option<String>,
    pub message: String,
    pub timeout_secs: u64,
}

pub struct RuntimeStdinBridge {
    pub receiver: tokio::sync::mpsc::UnboundedReceiver<String>,
    pub cancelled: Arc<Mutex<bool>>,
}

#[derive(Debug, Clone)]
pub struct AgentTurnOutput {
    pub events: Vec<NormalizedEvent>,
    pub exit_success: bool,
    pub exit_code: Option<i32>,
}

pub enum PreparedGuiTurn {
    Cli(PreparedCliTurn),
    Acp(PreparedAcpTurn),
}

pub struct PreparedCliTurn {
    pub agent_id: String,
    pub session_id: Option<String>,
    pub message: String,
    pub command: tokio::process::Command,
    pub pipe_stdin: bool,
    pub consumes_stdin: bool,
    pub normalizer: crate::agent::StreamEventNormalizer,
    pub stderr_relay: bool,
    pub eof_is_complete: bool,
}

pub struct PreparedAcpTurn {
    pub agent_id: String,
    pub project_path: String,
    pub gui_session_id: Option<String>,
    pub native_session_id: Option<String>,
    pub message: String,
    pub command: AcpCommandSpec,
    pub transport: TransportSurface,
}

pub struct GuiTurnHandle {
    pub agent_id: String,
    pub session_id: String,
    pub process_id: u32,
    pub stdin: Option<Arc<Mutex<Option<ChildStdin>>>>,
    pub acp: Option<AcpControl>,
}

pub fn transport_for_agent(
    registry: &AgentRegistry,
    agent_id: &str,
) -> Result<TransportSurface, String> {
    registry
        .get(agent_id)
        .map(|agent| agent.resolve_transport())
        .ok_or_else(|| format!("Agent not found: {agent_id}"))
}

/// Emit a diagnostic event recording the transport a GUI turn **actually**
/// dispatched over — i.e. the subprocess genuinely spawned (a CLI child vs. an
/// ACP/PiRPC/CodexAppServer JSON-RPC process). This is the runtime ground
/// truth, NOT the probe/declarative surface: it only fires after a successful
/// spawn, so what the F12 console sees is the real command path. The frontend
/// listens on `agent-dispatch` and logs it. Only the GUI (chat) path emits;
/// the orchestrator blocking path has no `AppHandle`.
fn emit_dispatch(
    app: &AppHandle,
    agent_id: &str,
    session_id: &str,
    transport: &TransportSurface,
    program: Option<&str>,
    pid: u32,
) {
    let payload = json!({
        "agent_id": agent_id,
        "session_id": session_id,
        // Serializes to snake_case ("acp_preferred" / "pi_rpc" / "cli" / ...),
        // matching the transport field the frontend already consumes.
        "transport": transport,
        "program": program,
        "pid": pid,
    });
    if let Err(e) = app.emit("agent-dispatch", &payload) {
        log::warn!("failed to emit agent-dispatch diagnostic: {e}");
    }
}

pub fn prepare_gui_turn(
    registry: &AgentRegistry,
    request: AgentTurnRequest,
) -> Result<PreparedGuiTurn, String> {
    let agent = registry
        .get(&request.agent_id)
        .ok_or_else(|| format!("Agent not found: {}", request.agent_id))?;
    let transport = transport_for_agent(registry, &request.agent_id)?;
    let gui_session_id = request.session_id.clone();
    let native_session_id = request
        .session_id
        .clone()
        .filter(|session_id| !crate::agent::command_config::is_transient_session_id(session_id));

    match transport {
        TransportSurface::AcpPreferred | TransportSurface::PiRpc | TransportSurface::CodexAppServer => {
            let req = ChatRequest {
                project_path: request.project_path.clone(),
                session_id: native_session_id.clone(),
                message: request.message.clone(),
            };
            let command = agent.build_acp_command(&req)?;
            Ok(PreparedGuiTurn::Acp(PreparedAcpTurn {
                agent_id: request.agent_id,
                project_path: request.project_path,
                gui_session_id,
                native_session_id,
                message: request.message,
                command,
                transport,
            }))
        }
        TransportSurface::Cli | TransportSurface::Embedded => {
            let req = ChatRequest {
                project_path: request.project_path.clone(),
                session_id: native_session_id,
                message: request.message.clone(),
            };
            Ok(PreparedGuiTurn::Cli(PreparedCliTurn {
                agent_id: request.agent_id,
                session_id: gui_session_id,
                message: request.message,
                command: agent.build_chat_command(req),
                pipe_stdin: agent.pipe_chat_stdin(),
                consumes_stdin: agent.consumes_stdin_message(),
                normalizer: agent.stream_event_normalizer(),
                stderr_relay: agent.stderr_relay_as_events(),
                eof_is_complete: agent.treat_eof_as_complete_after_output(),
            }))
        }
    }
}

pub async fn start_gui_turn<Finish, Resolve>(
    app: AppHandle,
    prepared: PreparedGuiTurn,
    on_finish: Finish,
    on_session_resolved: Resolve,
) -> Result<GuiTurnHandle, String>
where
    Finish: FnOnce() + Send + 'static,
    Resolve: Fn(&str) + Send + Sync + 'static,
{
    match prepared {
        PreparedGuiTurn::Cli(turn) => {
            start_gui_cli_turn(app, turn, on_finish, on_session_resolved).await
        }
        PreparedGuiTurn::Acp(turn) => start_gui_acp_turn(app, turn, on_finish, on_session_resolved),
    }
}

async fn start_gui_cli_turn<Finish, Resolve>(
    app: AppHandle,
    mut turn: PreparedCliTurn,
    on_finish: Finish,
    on_session_resolved: Resolve,
) -> Result<GuiTurnHandle, String>
where
    Finish: FnOnce() + Send + 'static,
    Resolve: Fn(&str) + Send + Sync + 'static,
{
    if turn.pipe_stdin {
        turn.command.stdin(std::process::Stdio::piped());
    }
    turn.command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = turn
        .command
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {e}", turn.agent_id))?;
    let pid = child.id().unwrap_or(0);
    let sid = turn
        .session_id
        .clone()
        .unwrap_or_else(|| format!("pending-{pid}"));

    // Record the real dispatch path (CLI subprocess) for F12 inspection.
    emit_dispatch(&app, &turn.agent_id, &sid, &TransportSurface::Cli, None, pid);

    if turn.consumes_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(turn.message.as_bytes())
                .await
                .map_err(|e| format!("Failed to write prompt to {} stdin: {e}", turn.agent_id))?;
            if let Err(e) = stdin.shutdown().await {
                log::warn!("Failed to shutdown {} stdin: {}", turn.agent_id, e);
            }
        }
    }

    let stdin = child
        .stdin
        .take()
        .map(|handle| Arc::new(Mutex::new(Some(handle))));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("No stdout from {} process", turn.agent_id))?;
    let stderr = child.stderr.take();

    crate::cli_runtime::spawn_stream_reader(
        app,
        turn.agent_id.clone(),
        sid.clone(),
        turn.normalizer,
        stdout,
        stderr,
        on_finish,
        on_session_resolved,
        turn.stderr_relay,
        turn.eof_is_complete,
    );
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });

    Ok(GuiTurnHandle {
        agent_id: turn.agent_id,
        session_id: sid,
        process_id: pid,
        stdin,
        acp: None,
    })
}

fn start_gui_acp_turn<Finish, Resolve>(
    app: AppHandle,
    turn: PreparedAcpTurn,
    on_finish: Finish,
    on_session_resolved: Resolve,
) -> Result<GuiTurnHandle, String>
where
    Finish: FnOnce() + Send + 'static,
    Resolve: Fn(&str) + Send + Sync + 'static,
{
    let mut command = tokio::process::Command::new(&turn.command.program);
    command
        .args(&turn.command.args)
        .current_dir(&turn.project_path);
    for (key, value) in &turn.command.envs {
        command.env(key, value);
    }
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    // Transport selection based on adapter surface, not hardcoded agent id.
    #[cfg(target_os = "windows")]
    {
        crate::process_command::tokio_no_window(&mut command);
    }

    let child = command.spawn().map_err(|e| {
        format!(
            "Failed to spawn {} {}: {e}",
            turn.agent_id,
            turn.transport.as_str()
        )
    })?;
    let pid = child.id().unwrap_or(0);
    let sid = turn
        .gui_session_id
        .clone()
        .unwrap_or_else(|| format!("pending-{pid}"));

    // Record the real dispatch path (ACP/PiRPC/CodexAppServer JSON-RPC
    // subprocess, plus the actual launched program) for F12 inspection.
    emit_dispatch(
        &app,
        &turn.agent_id,
        &sid,
        &turn.transport,
        Some(turn.command.program.as_str()),
        pid,
    );

    log::info!(
        "Spawning {} session: agent={}, pid={}, project_path={}",
        turn.transport.as_str(),
        turn.agent_id,
        pid,
        turn.project_path
    );

    // Dispatch to the transport's runtime:
    // - PiRpc         → Pi native `--mode rpc` protocol (JSON-line).
    // - CodexAppServer → codex `app-server` (newline-delimited JSON-RPC, turn model).
    // - AcpPreferred  → ACP JSON-RPC 2.0.
    let acp = match turn.transport {
        TransportSurface::PiRpc => crate::pi_rpc_runtime::spawn_pi_rpc_session(
            app,
            turn.agent_id.clone(),
            sid.clone(),
            child,
            turn.project_path,
            turn.native_session_id,
            turn.message,
            on_finish,
            on_session_resolved,
        ),
        TransportSurface::CodexAppServer => {
            crate::codex_app_server_runtime::spawn_codex_app_server_session(
                app,
                turn.agent_id.clone(),
                sid.clone(),
                child,
                turn.project_path,
                turn.native_session_id,
                turn.message,
                on_finish,
                on_session_resolved,
            )
        }
        _ => crate::acp_runtime::spawn_acp_session(
            app,
            turn.agent_id.clone(),
            sid.clone(),
            child,
            turn.project_path,
            turn.native_session_id,
            turn.message,
            on_finish,
            on_session_resolved,
        ),
    };

    Ok(GuiTurnHandle {
        agent_id: turn.agent_id,
        session_id: sid,
        process_id: pid,
        stdin: None,
        acp: Some(acp),
    })
}

pub fn run_turn_blocking(
    registry: &AgentRegistry,
    request: AgentTurnRequest,
    stdin_bridge: Option<RuntimeStdinBridge>,
) -> Result<AgentTurnOutput, String> {
    run_turn_blocking_cancellable(registry, request, stdin_bridge, None)
}

pub fn run_turn_blocking_cancellable(
    registry: &AgentRegistry,
    request: AgentTurnRequest,
    stdin_bridge: Option<RuntimeStdinBridge>,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<AgentTurnOutput, String> {
    let agent = registry
        .get(&request.agent_id)
        .ok_or_else(|| format!("Agent not found: {}", request.agent_id))?;
    let transport = transport_for_agent(registry, &request.agent_id)?;

    match transport {
        TransportSurface::AcpPreferred => run_acp_turn_blocking(agent, request, cancellation),
        TransportSurface::PiRpc => run_pi_rpc_turn_blocking(agent, request, cancellation),
        TransportSurface::Cli | TransportSurface::Embedded => {
            run_cli_turn_blocking(agent, request, stdin_bridge, cancellation)
        }
        // The autonomous (task-orchestrator) path keeps using codex exec (CLI)
        // rather than the app-server turn model — interaction generalization
        // targets the interactive GUI path (design §5.5).
        TransportSurface::CodexAppServer => {
            run_cli_turn_blocking(agent, request, stdin_bridge, cancellation)
        }
    }
}

fn run_pi_rpc_turn_blocking(
    agent: &(dyn AgentPlugin + Send + Sync),
    request: AgentTurnRequest,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<AgentTurnOutput, String> {
    let native_session_id = request
        .session_id
        .clone()
        .filter(|session_id| !crate::agent::command_config::is_transient_session_id(session_id));
    let req = ChatRequest {
        project_path: request.project_path.clone(),
        session_id: native_session_id,
        message: request.message.clone(),
    };
    let spec = agent.build_acp_command(&req)?;
    let mut cmd = tokio::process::Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&request.project_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (key, value) in &spec.envs {
        cmd.env(key, value);
    }
    cmd.kill_on_drop(true);
    crate::process_command::tokio_no_window(&mut cmd);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Runtime: {error}"))?;

    rt.block_on(async move {
        let inner = async move {
            let mut child = cmd
                .spawn()
                .map_err(|error| format!("Spawn PiRPC {}: {error}", request.agent_id))?;
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "PiRPC process missing stdin".to_string())?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "PiRPC process missing stdout".to_string())?;
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            let mut events = Vec::new();

            write_pi_rpc_command(&mut stdin, json!({"type": "get_state"})).await?;
            let session_id = loop {
                let line = read_process_line(&mut lines, cancellation.as_ref(), "PiRPC")
                    .await?
                    .ok_or_else(|| "PiRPC stdout closed during initialization".to_string())?;
                let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if message.get("type").and_then(|value| value.as_str()) == Some("response")
                    && message.get("command").and_then(|value| value.as_str()) == Some("get_state")
                {
                    break message
                        .get("data")
                        .and_then(|value| value.get("sessionId"))
                        .and_then(|value| value.as_str())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("pending-{}", child.id().unwrap_or_default()));
                }
            };
            events.push(NormalizedEvent::SessionResolved { session_id });

            write_pi_rpc_command(
                &mut stdin,
                json!({"type": "prompt", "message": request.message}),
            )
            .await?;

            let mut completed = false;
            let mut awaiting_interaction = false;
            while let Some(line) =
                read_process_line(&mut lines, cancellation.as_ref(), "PiRPC").await?
            {
                let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if message.get("type").and_then(|value| value.as_str()) == Some("response")
                    && message.get("command").and_then(|value| value.as_str()) == Some("prompt")
                    && message.get("success").and_then(|value| value.as_bool()) == Some(false)
                {
                    let error = message
                        .get("error")
                        .and_then(|value| value.as_str())
                        .unwrap_or("PiRPC prompt failed");
                    events.push(NormalizedEvent::Error {
                        message: error.to_string(),
                        recoverable: false,
                    });
                    events.push(NormalizedEvent::TurnComplete {
                        reason: TurnEndReason::Error,
                        usage: None,
                    });
                    completed = true;
                    break;
                }

                let normalized = crate::pi_rpc_runtime::normalize_pi_agent_event(&message);
                completed = normalized
                    .iter()
                    .any(|event| matches!(event, NormalizedEvent::TurnComplete { .. }));
                awaiting_interaction = normalized
                    .iter()
                    .any(|event| matches!(event, NormalizedEvent::InteractionRequest { .. }));
                events.extend(normalized);
                if completed || awaiting_interaction {
                    break;
                }
            }

            drop(stdin);
            let exit_code =
                match tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await {
                    Ok(Ok(status)) => status.code(),
                    Ok(Err(error)) => return Err(format!("PiRPC wait: {error}")),
                    Err(_) => {
                        let _ = child.kill().await;
                        None
                    }
                };
            Ok(AgentTurnOutput {
                events,
                exit_success: completed || awaiting_interaction,
                exit_code,
            })
        };

        tokio::time::timeout(std::time::Duration::from_secs(request.timeout_secs), inner)
            .await
            .map_err(|_| format!("Agent dispatch timed out ({}s)", request.timeout_secs))?
    })
}

async fn write_pi_rpc_command(
    stdin: &mut ChildStdin,
    command: serde_json::Value,
) -> Result<(), String> {
    stdin
        .write_all(format!("{command}\n").as_bytes())
        .await
        .map_err(|error| format!("PiRPC write: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("PiRPC flush: {error}"))
}

fn run_cli_turn_blocking(
    agent: &(dyn AgentPlugin + Send + Sync),
    request: AgentTurnRequest,
    stdin_bridge: Option<RuntimeStdinBridge>,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<AgentTurnOutput, String> {
    let req = ChatRequest {
        project_path: request.project_path.clone(),
        session_id: request.session_id.clone(),
        message: request.message.clone(),
    };
    let mut cmd = agent.build_chat_command(req);
    let pipe_stdin = agent.pipe_chat_stdin();
    let consumes_stdin = agent.consumes_stdin_message();

    if pipe_stdin {
        cmd.stdin(std::process::Stdio::piped());
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Runtime: {e}"))?;

    rt.block_on(async move {
        let inner = async move {
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Spawn {}: {e}", request.agent_id))?;

            if pipe_stdin {
                if let Some(mut stdin) = child.stdin.take() {
                    stdin
                        .write_all(request.message.as_bytes())
                        .await
                        .map_err(|e| format!("Write stdin: {e}"))?;
                    if consumes_stdin {
                        stdin
                            .shutdown()
                            .await
                            .map_err(|e| format!("Close stdin: {e}"))?;
                    } else {
                        stdin
                            .write_all(b"\n")
                            .await
                            .map_err(|e| format!("Write stdin newline: {e}"))?;
                        stdin
                            .flush()
                            .await
                            .map_err(|e| format!("Flush stdin: {e}"))?;
                        if let Some(mut bridge) = stdin_bridge {
                            tokio::spawn(async move {
                                while let Some(msg) = bridge.receiver.recv().await {
                                    if *bridge.cancelled.lock().unwrap_or_else(|e| e.into_inner()) {
                                        break;
                                    }
                                    let _ = stdin.write_all(msg.as_bytes()).await;
                                    let _ = stdin.write_all(b"\n").await;
                                    let _ = stdin.flush().await;
                                }
                            });
                        }
                    }
                }
            }

            let mut events = Vec::new();
            let mut awaiting_interaction = false;
            if let Some(stdout) = child.stdout.take() {
                let reader = tokio::io::BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Some(line) =
                    read_process_line(&mut lines, cancellation.as_ref(), "CLI").await?
                {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let normalized = parse_agent_line(agent, &request.agent_id, &line);
                    awaiting_interaction = normalized
                        .iter()
                        .any(|event| matches!(event, NormalizedEvent::InteractionRequest { .. }));
                    events.extend(normalized);
                    if awaiting_interaction {
                        break;
                    }
                }
            }

            if awaiting_interaction {
                let _ = child.kill().await;
                return Ok::<_, String>(AgentTurnOutput {
                    events,
                    exit_success: true,
                    exit_code: None,
                });
            }
            let status = child.wait().await.map_err(|e| format!("Wait: {e}"))?;
            Ok::<_, String>(AgentTurnOutput {
                events,
                exit_success: status.success(),
                exit_code: status.code(),
            })
        };

        tokio::time::timeout(std::time::Duration::from_secs(request.timeout_secs), inner)
            .await
            .map_err(|_| format!("Agent dispatch timed out ({}s)", request.timeout_secs))?
    })
}

fn parse_agent_line(
    agent: &(dyn AgentPlugin + Send + Sync),
    agent_id: &str,
    line: &str,
) -> Vec<NormalizedEvent> {
    if let Ok(event) = serde_json::from_str::<NormalizedEvent>(line) {
        return vec![event];
    }

    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(raw) => agent.normalize_stream_event(&raw),
        Err(error) => vec![NormalizedEvent::Error {
            message: format!("Failed to parse {agent_id} JSON stream line: {error}"),
            recoverable: true,
        }],
    }
}

fn run_acp_turn_blocking(
    agent: &(dyn AgentPlugin + Send + Sync),
    request: AgentTurnRequest,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<AgentTurnOutput, String> {
    let native_session_id = request
        .session_id
        .clone()
        .filter(|session_id| !crate::agent::command_config::is_transient_session_id(session_id));
    let req = ChatRequest {
        project_path: request.project_path.clone(),
        session_id: native_session_id.clone(),
        message: request.message.clone(),
    };
    let spec = agent.build_acp_command(&req)?;
    let mut cmd = tokio::process::Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&request.project_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (key, value) in &spec.envs {
        cmd.env(key, value);
    }
    cmd.kill_on_drop(true);
    crate::process_command::tokio_no_window(&mut cmd);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Runtime: {e}"))?;

    rt.block_on(async move {
        let inner = async move {
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Spawn ACP {}: {e}", request.agent_id))?;
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "ACP process missing stdin".to_string())?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "ACP process missing stdout".to_string())?;
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            let mut next_id = 0_i64;
            let mut events = Vec::new();
            let mut usage: Option<UsageStats> = None;

            let init_id = crate::acp_runtime::write_jsonrpc_request(
                &mut stdin,
                &mut next_id,
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
            acp_wait_for_response(
                &mut stdin,
                &mut lines,
                init_id,
                &mut events,
                &mut usage,
                cancellation.as_ref(),
            )
            .await?;

            let session_method = if native_session_id.is_some() {
                "session/resume"
            } else {
                "session/new"
            };
            let mut session_params = json!({
                "cwd": request.project_path,
                "mcpServers": []
            });
            if let Some(session_id) = native_session_id.as_deref() {
                session_params["sessionId"] = json!(session_id);
            }
            let session_request_id = crate::acp_runtime::write_jsonrpc_request(
                &mut stdin,
                &mut next_id,
                session_method,
                session_params,
            )
            .await?;
            let session_result = acp_wait_for_response(
                &mut stdin,
                &mut lines,
                session_request_id,
                &mut events,
                &mut usage,
                cancellation.as_ref(),
            )
            .await?;
            let acp_session_id = session_result
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "ACP session creation/resume did not return sessionId".to_string())?
                .to_string();
            events.push(NormalizedEvent::SessionResolved {
                session_id: acp_session_id.clone(),
            });

            let prompt_id = crate::acp_runtime::write_jsonrpc_request(
                &mut stdin,
                &mut next_id,
                "session/prompt",
                json!({
                    "sessionId": acp_session_id,
                    "prompt": [{ "type": "text", "text": request.message }]
                }),
            )
            .await?;
            let prompt_result = acp_wait_for_response(
                &mut stdin,
                &mut lines,
                prompt_id,
                &mut events,
                &mut usage,
                cancellation.as_ref(),
            )
            .await;
            let awaiting_interaction = matches!(
                prompt_result.as_ref(),
                Err(error) if error == TASK_INTERACTION_PENDING
            );
            let success = prompt_result.is_ok() || awaiting_interaction;
            if let Err(error) = prompt_result {
                if !awaiting_interaction {
                    events.push(NormalizedEvent::Error {
                        message: error,
                        recoverable: false,
                    });
                    events.push(NormalizedEvent::TurnComplete {
                        reason: TurnEndReason::Error,
                        usage,
                    });
                }
            } else if !awaiting_interaction {
                events.push(NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Complete,
                    usage,
                });
            }

            drop(stdin);
            let status =
                match tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await {
                    Ok(Ok(status)) => status,
                    Ok(Err(error)) => return Err(format!("ACP wait: {error}")),
                    Err(_) => {
                        let _ = child.kill().await;
                        return Ok(AgentTurnOutput {
                            events,
                            exit_success: success,
                            exit_code: None,
                        });
                    }
                };

            Ok(AgentTurnOutput {
                events,
                exit_success: success && status.success(),
                exit_code: status.code(),
            })
        };

        tokio::time::timeout(std::time::Duration::from_secs(request.timeout_secs), inner)
            .await
            .map_err(|_| format!("Agent dispatch timed out ({}s)", request.timeout_secs))?
    })
}

const TASK_INTERACTION_PENDING: &str = "task interaction pending";

async fn acp_wait_for_response(
    stdin: &mut tokio::process::ChildStdin,
    lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    target_id: i64,
    events: &mut Vec<NormalizedEvent>,
    usage: &mut Option<UsageStats>,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<serde_json::Value, String> {
    loop {
        let line = read_process_line(lines, cancellation, "ACP")
            .await?
            .ok_or_else(|| "ACP stdout closed".to_string())?;

        match crate::acp_runtime::handle_acp_response_line(&line, target_id, usage)? {
            crate::acp_runtime::AcpResponse::Update(new_events) => {
                let awaiting_interaction = new_events
                    .iter()
                    .any(|event| matches!(event, NormalizedEvent::InteractionRequest { .. }));
                events.extend(new_events);
                if awaiting_interaction {
                    return Err(TASK_INTERACTION_PENDING.to_string());
                }
            }
            crate::acp_runtime::AcpResponse::PermissionRequest { id, params } => {
                let request_id = id
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| id.to_string());
                events.push(NormalizedEvent::ApprovalRequest {
                    request_id,
                    approval_kind: crate::agent::normalized::ApprovalKind::Other,
                    payload: params.clone(),
                });
                if let Some(option_id) = crate::acp_runtime::permission_option_id(&params, false) {
                    crate::acp_runtime::write_permission_response(stdin, &id, &option_id).await?;
                }
                return Err(
                    "ACP tool permission denied because task execution has no interactive approval channel"
                        .to_string(),
                );
            }
            crate::acp_runtime::AcpResponse::Result(val) => return Ok(val),
            crate::acp_runtime::AcpResponse::Error(err) => {
                return Err(format!("ACP response error: {}", err))
            }
            crate::acp_runtime::AcpResponse::Ignored => continue,
        }
    }
}

async fn read_process_line(
    lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    cancellation: Option<&Arc<AtomicBool>>,
    transport: &str,
) -> Result<Option<String>, String> {
    if cancellation.is_some_and(|token| token.load(Ordering::Acquire)) {
        return Err("Agent dispatch cancelled".into());
    }

    let next_line = lines.next_line();
    tokio::pin!(next_line);
    loop {
        tokio::select! {
            result = &mut next_line => {
                return result.map_err(|error| format!("{transport} read: {error}"));
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(25)),
                if cancellation.is_some() =>
            {
                if cancellation.is_some_and(|token| token.load(Ordering::Acquire)) {
                    return Err("Agent dispatch cancelled".into());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::agent::{AgentRegistry, TransportSurface};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[test]
    fn runtime_transport_uses_adapter_contract_not_bridge_wrapping() {
        let registry = AgentRegistry::new();

        assert_eq!(
            super::transport_for_agent(&registry, "opencode").unwrap(),
            TransportSurface::AcpPreferred
        );
        assert_eq!(
            super::transport_for_agent(&registry, "codex").unwrap(),
            TransportSurface::CodexAppServer
        );
        assert_eq!(
            super::transport_for_agent(&registry, "jishu-self").unwrap(),
            TransportSurface::PiRpc
        );
    }

    #[tokio::test]
    async fn process_line_reader_observes_cancellation_without_waiting_for_eof() {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = tokio::process::Command::new("cmd");
            command.args(["/C", "ping -n 6 127.0.0.1 >nul & echo done"]);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = tokio::process::Command::new("sh");
            command.args(["-c", "sleep 5; echo done"]);
            command
        };
        command
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut lines = tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(stdout));
        let cancellation = Arc::new(AtomicBool::new(false));
        let signal = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            signal.store(true, Ordering::Release);
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            super::read_process_line(&mut lines, Some(&cancellation), "test"),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err(), "Agent dispatch cancelled");
        let _ = child.kill().await;
    }
}
