use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::agent::ChatRequest;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub agent_id: String,
    pub session_id: String,
    pub process_id: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamChunk {
    pub session_id: String,
    pub event_type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentStreamChunk {
    pub agent_id: String,
    pub session_id: String,
    pub event_type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ChatProcess {
    pub agent_id: String,
    pub process_id: u32,
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

    let (agent_id, mut command) = {
        let s = state.lock().map_err(|_| "App state lock poisoned".to_string())?;
        let agent_id = s.registry.active_id().to_string();
        let command = s.registry.active().build_chat_command(ChatRequest {
            project_path: project_path.clone(),
            session_id: session_id.clone(),
            message,
        });
        (agent_id, command)
    };

    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn {agent_id}: {e}"))?;

    let pid = child.id().unwrap_or(0);
    let sid = session_id.unwrap_or_else(|| format!("pending-{}", pid));

    let state = app.state::<Mutex<ChatState>>();
    if let Ok(mut s) = state.lock() {
        s.processes.insert(
            sid.clone(),
            ChatProcess {
                agent_id: agent_id.clone(),
                process_id: pid,
            },
        );
    }

    let app_clone = app.clone();
    let sid_clone = sid.clone();
    let agent_id_clone = agent_id.clone();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("No stdout from {agent_id} process"))?;
    let stderr = child.stderr.take();
    let reader = BufReader::new(stdout);

    // Drain stderr to prevent pipe buffer deadlock
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[{} stderr] {}", agent_id_clone, line);
            }
        });
    }

    let stream_agent_id = agent_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = reader.lines();
        let mut saw_result = false;
        let mut buf: Vec<StreamChunk> = Vec::with_capacity(32);
        let mut last_flush = std::time::Instant::now();

        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = parse_stream_event_type(&stream_agent_id, &event);

                if event_type == "result" {
                    saw_result = true;
                }

                buf.push(StreamChunk {
                    session_id: sid_clone.clone(),
                    event_type: event_type.clone(),
                    data: event,
                });

                let force = event_type == "result" || event_type == "message";
                if force || buf.len() >= 32 || last_flush.elapsed() >= std::time::Duration::from_millis(16) {
                    emit_stream_batch(&app_clone, &stream_agent_id, &buf);
                    buf.clear();
                    last_flush = std::time::Instant::now();
                }
            }
        }

        if !buf.is_empty() {
            emit_stream_batch(&app_clone, &stream_agent_id, &buf);
        }

        // If process exited without sending a result event, emit a synthetic error
        if !saw_result {
            let chunk = StreamChunk {
                session_id: sid_clone.clone(),
                event_type: "result".into(),
                data: serde_json::json!({
                    "type": "result",
                    "error": "Process exited without result (image path format may not be supported)"
                }),
            };
            emit_stream_batch(&app_clone, &stream_agent_id, &[chunk]);
        }

        let state = app_clone.state::<Mutex<ChatState>>();
        if let Ok(mut s) = state.lock() {
            s.processes.remove(&sid_clone);
        };
    });

    Ok(ChatSession {
        agent_id,
        session_id: sid,
        process_id: pid,
    })
}

#[tauri::command]
pub async fn abort_chat(app: AppHandle, session_id: String) -> Result<(), String> {
    let state = app.state::<Mutex<ChatState>>();
    if let Ok(mut s) = state.lock() {
        if let Some(process) = s.processes.get(&session_id).cloned() {
            #[cfg(target_os = "windows")]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &process.process_id.to_string(), "/F"])
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &process.process_id.to_string()])
                    .output();
            }
            log::info!("aborted {} chat session {}", process.agent_id, session_id);
            s.processes.remove(&session_id);
        }
    }
    Ok(())
}

fn emit_stream_batch(app: &AppHandle, agent_id: &str, chunks: &[StreamChunk]) {
    let agent_chunks: Vec<AgentStreamChunk> = chunks
        .iter()
        .map(|chunk| AgentStreamChunk {
            agent_id: agent_id.to_string(),
            session_id: chunk.session_id.clone(),
            event_type: chunk.event_type.clone(),
            data: chunk.data.clone(),
        })
        .collect();
    let _ = app.emit("agent-event", &agent_chunks);

    if agent_id == "claude-code" {
        let _ = app.emit("chat-stream", chunks);
    }
}

fn parse_stream_event_type(agent_id: &str, event: &serde_json::Value) -> String {
    match agent_id {
        "codex" => match event.get("type").and_then(|v| v.as_str()) {
            Some("message_delta") | Some("exec_command_output_delta") => "delta",
            Some("message") => "message",
            Some("result") | Some("turn_complete") => "result",
            Some(t) => t,
            None => "unknown",
        },
        "opencode" => match event.get("type").and_then(|v| v.as_str()) {
            Some("text_delta") | Some("message.delta") => "delta",
            Some("message") | Some("message.completed") => "message",
            Some("result") | Some("session.idle") => "result",
            Some(t) => t,
            None => "unknown",
        },
        _ => match event.get("type").and_then(|v| v.as_str()) {
            Some("system") => event
                .get("subtype")
                .and_then(|v| v.as_str())
                .unwrap_or("system"),
            Some("stream_event") => "delta",
            Some("result") => "result",
            Some("assistant") => "message",
            Some(t) => t,
            None => "unknown",
        },
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::parse_stream_event_type;

    #[test]
    fn parses_claude_stream_event_type() {
        let event = serde_json::json!({ "type": "stream_event" });
        assert_eq!(parse_stream_event_type("claude-code", &event), "delta");
    }

    #[test]
    fn parses_codex_output_delta_as_delta() {
        let event = serde_json::json!({ "type": "exec_command_output_delta" });
        assert_eq!(parse_stream_event_type("codex", &event), "delta");
    }
}
