use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;

use crate::agent::ChatRequest;
use crate::cli_runtime;
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

    let (agent_id, mut command, pipe_stdin) = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let agent_id = s.registry.active_id().to_string();
        let active = s.registry.active();
        let command = active.build_chat_command(ChatRequest {
            project_path: project_path.clone(),
            session_id: session_id.clone(),
            message,
        });
        (agent_id, command, active.pipe_chat_stdin())
    };

    if pipe_stdin {
        command.stdin(std::process::Stdio::piped());
    }

    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn {agent_id}: {e}"))?;

    let pid = child.id().unwrap_or(0);
    let sid = session_id.unwrap_or_else(|| format!("pending-{}", pid));
    let stdin = child
        .stdin
        .take()
        .map(|handle| Arc::new(Mutex::new(Some(handle))));

    let state = app.state::<Mutex<ChatState>>();
    if let Ok(mut s) = state.lock() {
        s.processes.insert(
            sid.clone(),
            ChatProcess {
                agent_id: agent_id.clone(),
                process_id: pid,
                stdin: stdin.clone(),
            },
        );
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("No stdout from {agent_id} process"))?;
    let stderr = child.stderr.take();
    let app_clone = app.clone();
    let app_resolve = app.clone();
    let sid_clone = sid.clone();
    let sid_resolve = sid.clone();
    cli_runtime::spawn_stream_reader(
        app.clone(),
        agent_id.clone(),
        sid.clone(),
        stdout,
        stderr,
        move || {
            let state = app_clone.state::<Mutex<ChatState>>();
            if let Ok(mut s) = state.lock() {
                s.processes.remove(&sid_clone);
            };
        },
        move |real_id: &str| {
            // When the CLI reveals its real session id, mirror the process
            // entry under that id too — so abort_chat works regardless of
            // whether the caller still has the pending id or only the real id.
            if real_id == sid_resolve {
                return;
            }
            let state = app_resolve.state::<Mutex<ChatState>>();
            if let Ok(mut s) = state.lock() {
                if let Some(process) = s.processes.get(&sid_resolve).cloned() {
                    s.processes.insert(real_id.to_string(), process);
                }
            };
        },
    );
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });

    Ok(ChatSession {
        agent_id,
        session_id: sid,
        process_id: pid,
    })
}

#[tauri::command]
pub async fn abort_chat(app: AppHandle, session_id: String) -> Result<(), String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let process = {
        let mut s = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        let Some(process) = s.processes.get(&session_id).cloned() else {
            return Ok(());
        };
        s.processes
            .retain(|_, item| item.process_id != process.process_id);
        process
    };

    let app_state = app.state::<Mutex<AppState>>();
    let (abort_sequence, abort_grace) = {
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

    if control_sent {
        log::info!(
            "sent abort control sequence to {} chat session {}",
            process.agent_id,
            session_id
        );
        return Ok(());
    }

    log::warn!(
        "no abort control sequence was sent to {} chat session {}",
        process.agent_id,
        session_id
    );
    Ok(())
}
