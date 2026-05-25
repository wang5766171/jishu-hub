use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub session_id: String,
    pub process_id: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamChunk {
    pub session_id: String,
    pub event_type: String,
    pub data: serde_json::Value,
}

pub struct ChatState {
    pub processes: HashMap<String, u32>,
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

    // cmd /C treats newlines as command separators — must escape them
    let escaped_message = message.replace('\r', "").replace('\n', "\\n");

    let mut args: Vec<String> = vec![
        "-p".into(),
        escaped_message,
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
    ];

    if let Some(ref sid) = session_id {
        args.push("--resume".into());
        args.push(sid.clone());
    }

    // On Windows, claude might be a .cmd script — must use cmd /C
    #[cfg(target_os = "windows")]
    let mut child = {
        let mut full_args = vec!["/C".to_string(), "claude".to_string()];
        full_args.extend(args);
        Command::new("cmd")
            .args(&full_args)
            .current_dir(&project_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn claude: {}", e))?
    };

    #[cfg(not(target_os = "windows"))]
    let mut child = Command::new("claude")
        .args(&args)
        .current_dir(&project_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;

    let pid = child.id().unwrap_or(0);
    let sid = session_id.unwrap_or_else(|| format!("pending-{}", pid));

    let state = app.state::<Mutex<ChatState>>();
    if let Ok(mut s) = state.lock() {
        s.processes.insert(sid.clone(), pid);
    }

    let app_clone = app.clone();
    let sid_clone = sid.clone();
    let stdout = child.stdout.take().ok_or("No stdout from claude process")?;
    let stderr = child.stderr.take();
    let reader = BufReader::new(stdout);

    // Drain stderr to prevent pipe buffer deadlock
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[claude stderr] {}", line);
            }
        });
    }

    tauri::async_runtime::spawn(async move {
        let mut lines = reader.lines();
        let mut saw_result = false;
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = match event.get("type").and_then(|v| v.as_str()) {
                    Some("system") => event
                        .get("subtype")
                        .and_then(|v| v.as_str())
                        .unwrap_or("system"),
                    Some("stream_event") => "delta",
                    Some("result") => "result",
                    Some("assistant") => "message",
                    Some(t) => t,
                    None => "unknown",
                }
                .to_string();

                if event_type == "result" {
                    saw_result = true;
                }

                let _ = app_clone.emit(
                    "chat-stream",
                    StreamChunk {
                        session_id: sid_clone.clone(),
                        event_type,
                        data: event,
                    },
                );
            }
        }

        // If process exited without sending a result event, emit a synthetic error
        if !saw_result {
            let _ = app_clone.emit(
                "chat-stream",
                StreamChunk {
                    session_id: sid_clone.clone(),
                    event_type: "result".into(),
                    data: serde_json::json!({
                        "type": "result",
                        "error": "Process exited without result (image path format may not be supported)"
                    }),
                },
            );
        }

        let state = app_clone.state::<Mutex<ChatState>>();
        if let Ok(mut s) = state.lock() {
            s.processes.remove(&sid_clone);
        };
    });

    Ok(ChatSession {
        session_id: sid,
        process_id: pid,
    })
}

#[tauri::command]
pub async fn abort_chat(app: AppHandle, session_id: String) -> Result<(), String> {
    let state = app.state::<Mutex<ChatState>>();
    if let Ok(mut s) = state.lock() {
        if let Some(&pid) = s.processes.get(&session_id) {
            #[cfg(target_os = "windows")]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .output();
            }
            s.processes.remove(&session_id);
        }
    }
    Ok(())
}
