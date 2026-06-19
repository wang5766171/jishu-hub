use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;

use crate::agent_runtime::{self, AgentTurnRequest};
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub agent_id: String,
    pub session_id: String,
    pub process_id: u32,
}

#[derive(Clone)]
pub struct ChatProcess {
    pub agent_id: String,
    pub process_id: u32,
    pub stdin: Option<Arc<Mutex<Option<ChildStdin>>>>,
    pub acp: Option<crate::acp_runtime::AcpControl>,
}

pub struct ChatState {
    pub processes: HashMap<String, ChatProcess>,
}

impl ChatState {
    pub fn new() -> Self {
        Self {
            processes: HashMap::new(),
        }
    }
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
    session_id: Option<String>,
    message: String,
) -> Result<ChatSession, String> {
    log::info!(
        "send_message: project={}, session={:?}, message_len={}",
        project_path,
        session_id,
        message.len()
    );

    let agent_id = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        s.registry.active_id().to_string()
    };

    if let Some(ref sid) = session_id {
        if let Some((acp, pid)) = existing_acp_session(&app, sid, &agent_id)? {
            match acp.send_prompt(message.clone()).await {
                Ok(()) => {
                    return Ok(ChatSession {
                        agent_id,
                        session_id: sid.clone(),
                        process_id: pid,
                    });
                }
                Err(_) => {
                    log::info!("ACP connection closed for session {}, respawning", sid);
                    remove_process_entries(&app, Some(pid), Some(sid))?;
                }
            }
        }
    }

    let pending_session_id = session_id
        .clone()
        .unwrap_or_else(|| format!("pending-{}", uuid::Uuid::new_v4()));

    let prepared = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        agent_runtime::prepare_gui_turn(
            &s.registry,
            AgentTurnRequest {
                agent_id: agent_id.clone(),
                project_path,
                session_id: Some(pending_session_id.clone()),
                message,
                timeout_secs: 0,
            },
        )?
    };

    let cleanup_pid = Arc::new(Mutex::new(None::<u32>));
    let cleanup_pid_for_finish = cleanup_pid.clone();
    let app_for_finish = app.clone();
    let sid_for_finish = pending_session_id.clone();

    let app_for_resolve = app.clone();
    let sid_for_resolve = pending_session_id.clone();

    let handle = agent_runtime::start_gui_turn(
        app.clone(),
        prepared,
        move || {
            let pid = cleanup_pid_for_finish
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .to_owned();
            let _ = remove_process_entries(&app_for_finish, pid, Some(&sid_for_finish));
        },
        move |real_id: &str| {
            if real_id == sid_for_resolve {
                return;
            }
            let state = app_for_resolve.state::<Mutex<ChatState>>();
            if let Ok(mut s) = state.lock() {
                if let Some(process) = s.processes.get(&sid_for_resolve).cloned() {
                    s.processes.insert(real_id.to_string(), process);
                }
            };
        },
    )
    .await?;

    {
        let mut pid = cleanup_pid.lock().unwrap_or_else(|e| e.into_inner());
        *pid = Some(handle.process_id);
    }

    let chat_state = app.state::<Mutex<ChatState>>();
    if let Ok(mut s) = chat_state.lock() {
        let process = ChatProcess {
            agent_id: handle.agent_id.clone(),
            process_id: handle.process_id,
            stdin: handle.stdin.clone(),
            acp: handle.acp.clone(),
        };
        s.processes
            .insert(handle.session_id.clone(), process.clone());
        if let Some(real_id) = handle
            .acp
            .as_ref()
            .and_then(|acp| acp.resolved_session_id())
        {
            if real_id != handle.session_id {
                s.processes.insert(real_id, process);
            }
        }
    }

    Ok(ChatSession {
        agent_id: handle.agent_id,
        session_id: handle.session_id,
        process_id: handle.process_id,
    })
}

fn existing_acp_session(
    app: &AppHandle,
    session_id: &str,
    agent_id: &str,
) -> Result<Option<(crate::acp_runtime::AcpControl, u32)>, String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let existing = chat_state
        .lock()
        .map_err(|_| "Chat state lock poisoned".to_string())?
        .processes
        .get(session_id)
        .and_then(|process| {
            if process.agent_id == agent_id {
                process
                    .acp
                    .as_ref()
                    .map(|acp| (acp.clone(), process.process_id))
            } else {
                None
            }
        });
    Ok(existing)
}

fn remove_process_entries(
    app: &AppHandle,
    process_id: Option<u32>,
    session_id: Option<&str>,
) -> Result<(), String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let mut state = chat_state
        .lock()
        .map_err(|_| "Chat state lock poisoned".to_string())?;
    if let Some(pid) = process_id {
        state.processes.retain(|_, item| item.process_id != pid);
    }
    if let Some(sid) = session_id {
        state.processes.remove(sid);
    }
    Ok(())
}

#[tauri::command]
pub async fn abort_chat(app: AppHandle, session_id: String) -> Result<(), String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let process = {
        let s = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        let Some(process) = s.processes.get(&session_id).cloned() else {
            return Ok(());
        };
        process
    };

    // ACP cancel path: send cancel only, keep connection alive.
    if let Some(acp) = &process.acp {
        acp.send_cancel().await;
        log::info!("cancelled ACP prompt in session {}", session_id);
        return Ok(());
    }

    {
        let mut s = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        s.processes
            .retain(|_, item| item.process_id != process.process_id);
    }

    let app_state = app.state::<Mutex<AppState>>();

    let (abort_sequence, abort_grace): (Option<Vec<u8>>, std::time::Duration) = {
        let s = app_state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        if let Some(agent) = s.registry.get(&process.agent_id) {
            (
                agent
                    .abort_chat_sequence()
                    .map(|sequence| sequence.to_vec()),
                agent.abort_chat_grace_period(),
            )
        } else {
            (None, std::time::Duration::from_millis(0))
        }
    };

    let mut control_sent = false;
    if let (Some(sequence), Some(stdin)) = (abort_sequence, process.stdin.as_ref()) {
        let mut stdin_handle = stdin
            .lock()
            .map_err(|_| "Chat process stdin lock poisoned".to_string())?
            .take();
        if let Some(mut stdin_handle) = stdin_handle.take() {
            match stdin_handle.write_all(&sequence).await {
                Ok(()) => match stdin_handle.flush().await {
                    Ok(()) => {
                        control_sent = true;
                        log::info!(
                            "sent {} abort control bytes to {} chat process {}",
                            sequence.len(),
                            process.agent_id,
                            process.process_id
                        );
                        tokio::time::sleep(abort_grace).await;
                    }
                    Err(err) => {
                        log::warn!(
                            "failed to flush abort control bytes to {} chat process {}: {}",
                            process.agent_id,
                            process.process_id,
                            err
                        );
                    }
                },
                Err(err) => {
                    log::warn!(
                        "failed to write abort control bytes to {} chat process {}: {}",
                        process.agent_id,
                        process.process_id,
                        err
                    );
                }
            }
        }
    }

    if control_sent && !crate::process_control::is_process_running(process.process_id) {
        log::info!(
            "aborted {} chat session {} via control sequence",
            process.agent_id,
            session_id
        );
        return Ok(());
    }

    let abort_result = {
        let s = app_state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        if let Some(agent) = s.registry.get(&process.agent_id) {
            agent.abort_chat_process(process.process_id)
        } else {
            crate::process_control::terminate_process_tree(process.process_id)
        }
    };

    match abort_result {
        Ok(()) => {
            log::info!("aborted {} chat session {}", process.agent_id, session_id);
            Ok(())
        }
        Err(err) => {
            log::warn!(
                "failed to abort {} chat session {}: {}",
                process.agent_id,
                session_id,
                err
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn steer_chat(app: AppHandle, session_id: String, message: String) -> Result<(), String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let acp = {
        let state = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        state
            .processes
            .get(&session_id)
            .and_then(|process| process.acp.clone())
            .ok_or_else(|| format!("No active ACP session found for {session_id}"))?
    };
    acp.steer(message).await
}

#[tauri::command]
pub async fn resolve_chat_permission(
    app: AppHandle,
    session_id: String,
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let acp = {
        let state = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        state
            .processes
            .get(&session_id)
            .and_then(|process| process.acp.clone())
            .ok_or_else(|| format!("No active ACP session found for {session_id}"))?
    };

    acp.resolve_permission(request_id, approved).await
}

#[tauri::command]
pub async fn respond_chat_interaction(
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    session_id: String,
    request_id: String,
    value: String,
    // Origin/protocol channel of the interaction being answered. Optional for
    // backward compatibility with older frontends; defaults to the generic
    // text channel (which resolves to follow-up unless overridden by transport).
    origin: Option<crate::agent::normalized::InteractionOrigin>,
) -> Result<crate::agent::interaction::InteractionResponseDto, String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let (acp, agent_id, supports_interaction_mid_turn) = {
        let chat = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        let process = chat
            .processes
            .get(&session_id)
            .ok_or_else(|| format!("No active ACP session found for {session_id}"))?;
        (
            process.acp.clone(),
            process.agent_id.clone(),
            process
                .acp
                .as_ref()
                .map(|acp| acp.supports_interaction_mid_turn())
                .unwrap_or(false),
        )
    };

    // Resolve the process's transport from the registry (design R6: the
    // authoritative delivery decision is taken at answer time from the actual
    // transport capability, never assumed from the event hint alone).
    let transport = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        s.registry
            .get(&agent_id)
            .map(|agent| agent.resolve_transport())
            .unwrap_or(crate::agent::TransportSurface::Cli)
    };

    let origin = origin.unwrap_or_default();
    let delivery = crate::agent::interaction::delivery_for_runtime(
        transport,
        origin,
        supports_interaction_mid_turn,
    );

    match delivery {
        crate::agent::interaction::InteractionDelivery::MidTurn => {
            // Mid-turn write-back for transports with a live pause/resume
            // request (PiRpc extension UI, ACP elicitation, codex app-server
            // requestUserInput). `respond_to_input` is the shared write-back
            // entry point each runtime implements.
            if let Some(acp) = acp {
                acp.respond_to_input(request_id, value).await?;
            }
            Ok(
                crate::agent::interaction::InteractionResponseDto::from_delivery(
                    crate::agent::interaction::InteractionDelivery::MidTurn,
                ),
            )
        }
        crate::agent::interaction::InteractionDelivery::FollowUp => {
            // This transport cannot answer mid-turn as a business question.
            // Report follow-up so the frontend sends the answer as a new user
            // message (the design's safety net).
            Ok(
                crate::agent::interaction::InteractionResponseDto::from_delivery(
                    crate::agent::interaction::InteractionDelivery::FollowUp,
                ),
            )
        }
    }
}
