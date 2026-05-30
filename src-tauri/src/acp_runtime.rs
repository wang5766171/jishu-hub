use serde_json::json;
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::agent::normalized::{NormalizedEvent, TurnEndReason, UsageStats};
use crate::cli_runtime::{AgentStreamChunk, StreamChunk};

/// ACP process control handle stored in ChatProcess for cancel support.
#[derive(Clone)]
pub struct AcpControl {
    pub stdin: Arc<TokioMutex<ChildStdin>>,
    pub acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
}

impl AcpControl {
    pub async fn send_cancel(&self) {
        let session_id = self
            .acp_session_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(sid) = session_id {
            let msg = json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": sid }
            });
            let line = format!("{}\n", msg);
            let mut stdin = self.stdin.lock().await;
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.flush().await;
        }
    }
}

struct AcpWriter {
    stdin: Arc<TokioMutex<ChildStdin>>,
    next_id: i64,
}

impl AcpWriter {
    fn new(stdin: Arc<TokioMutex<ChildStdin>>) -> Self {
        Self { stdin, next_id: 0 }
    }

    async fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<i64, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        let line = format!("{}\n", msg);
        let mut stdin = self.stdin.lock().await;
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
}

/// Spawn the ACP driver: performs handshake then streams events.
/// Returns the AcpControl for cancel support.
pub fn spawn_acp_session(
    app: tauri::AppHandle,
    agent_id: String,
    pending_session_id: String,
    mut child: tokio::process::Child,
    project_path: String,
    message: String,
    on_finish: impl FnOnce() + Send + 'static,
    on_session_resolved: impl Fn(&str) + Send + Sync + 'static,
) -> AcpControl {
    let stdin = child.stdin.take().expect("ACP process must have stdin");
    let stdout = child.stdout.take().expect("ACP process must have stdout");

    let stdin_arc = Arc::new(TokioMutex::new(stdin));
    let acp_session_id = Arc::new(std::sync::Mutex::new(None::<String>));

    let control = AcpControl {
        stdin: stdin_arc.clone(),
        acp_session_id: acp_session_id.clone(),
    };

    let control_clone = control.clone();

    tauri::async_runtime::spawn(async move {
        let result = run_acp_session(
            app.clone(),
            &agent_id,
            &pending_session_id,
            stdin_arc,
            acp_session_id,
            stdout,
            &project_path,
            &message,
            &on_session_resolved,
        )
        .await;

        if let Err(err) = result {
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
        }

        on_finish();
    });

    // Wait for child in background
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });

    control_clone
}

async fn run_acp_session(
    app: tauri::AppHandle,
    agent_id: &str,
    pending_session_id: &str,
    stdin_arc: Arc<TokioMutex<ChildStdin>>,
    acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    stdout: tokio::process::ChildStdout,
    project_path: &str,
    message: &str,
    on_session_resolved: &(dyn Fn(&str) + Send + Sync),
) -> Result<(), String> {
    let mut writer = AcpWriter::new(stdin_arc);
    let mut reader = BufReader::new(stdout).lines();

    // 1. Initialize
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

    // Read until we get the initialize response
    wait_for_response(&mut reader, init_id).await?;

    // 2. session/new
    let new_id = writer
        .request(
            "session/new",
            json!({
                "cwd": project_path,
                "mcpServers": []
            }),
        )
        .await?;

    let new_result = wait_for_response(&mut reader, new_id).await?;
    let session_id = new_result
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "session/new did not return sessionId".to_string())?
        .to_string();

    // Store session id for cancel
    {
        let mut guard = acp_session_id.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(session_id.clone());
    }

    // Emit SessionResolved
    let events = vec![NormalizedEvent::SessionResolved {
        session_id: session_id.clone(),
    }];
    emit_events(&app, agent_id, pending_session_id, &events);
    on_session_resolved(&session_id);

    // 3. session/prompt
    let prompt_id = writer
        .request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": message }]
            }),
        )
        .await?;

    // 4. Stream loop: read notifications and the final response
    let mut usage: Option<UsageStats> = None;
    let mut buf: Vec<StreamChunk> = Vec::with_capacity(32);
    let mut last_flush = std::time::Instant::now();
    let current_session_id = session_id.clone();

    loop {
        let line = match reader.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break, // EOF
            Err(_) => break,
        };

        if line.trim().is_empty() {
            continue;
        }

        let msg: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Check if this is the response to session/prompt
        if msg.get("id").and_then(|v| v.as_i64()) == Some(prompt_id) {
            // Final response
            if let Some(err) = msg.get("error") {
                let err_msg = err
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ACP error");
                buf.push(make_chunk(
                    &current_session_id,
                    &NormalizedEvent::Error {
                        message: err_msg.to_string(),
                        recoverable: false,
                    },
                ));
                buf.push(make_chunk(
                    &current_session_id,
                    &NormalizedEvent::TurnComplete {
                        reason: TurnEndReason::Error,
                        usage: None,
                    },
                ));
            } else {
                let stop_reason = msg
                    .get("result")
                    .and_then(|r| r.get("stopReason"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("end_turn");

                // Extract usage from response if present
                if let Some(u) = msg.get("result").and_then(|r| r.get("usage")) {
                    usage = Some(UsageStats {
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
                buf.push(make_chunk(
                    &current_session_id,
                    &NormalizedEvent::TurnComplete {
                        reason,
                        usage: usage.take(),
                    },
                ));
            }
            flush_buf(&app, agent_id, &mut buf);
            break;
        }

        // Notification (no id field, has method)
        if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
            if method == "session/update" {
                if let Some(params) = msg.get("params") {
                    let events = normalize_acp_update(params, &mut usage);
                    for event in &events {
                        buf.push(make_chunk(&current_session_id, event));
                    }
                }
            }
        }

        // Flush periodically
        if buf.len() >= 32
            || last_flush.elapsed() >= std::time::Duration::from_millis(16)
        {
            flush_buf(&app, agent_id, &mut buf);
            last_flush = std::time::Instant::now();
        }
    }

    // Flush remaining
    if !buf.is_empty() {
        flush_buf(&app, agent_id, &mut buf);
    }

    Ok(())
}

async fn wait_for_response(
    reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    expected_id: i64,
) -> Result<serde_json::Value, String> {
    loop {
        let line = reader
            .next_line()
            .await
            .map_err(|e| format!("ACP read error: {e}"))?
            .ok_or_else(|| "ACP process closed before response".to_string())?;

        if line.trim().is_empty() {
            continue;
        }

        let msg: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| format!("ACP JSON parse error: {e}"))?;

        if msg.get("id").and_then(|v| v.as_i64()) == Some(expected_id) {
            if let Some(err) = msg.get("error") {
                return Err(format!(
                    "ACP error: {}",
                    err.get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                ));
            }
            return msg
                .get("result")
                .cloned()
                .ok_or_else(|| "ACP response missing result".to_string());
        }
        // Skip notifications during handshake
    }
}

fn normalize_acp_update(
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
                .get("title")
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
        assert_eq!(events, vec![NormalizedEvent::TextDelta { delta: "Hello".to_string() }]);
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
        assert_eq!(events, vec![NormalizedEvent::Thinking { delta: "thinking...".to_string() }]);
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
        assert_eq!(events, vec![NormalizedEvent::ToolUseStart {
            call_id: "call_001".to_string(),
            tool: "Reading file".to_string(),
            input: serde_json::Value::Null,
        }]);
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
        assert_eq!(events, vec![NormalizedEvent::ToolUseResult {
            call_id: "call_001".to_string(),
            output: json!("file contents here"),
            is_error: false,
        }]);
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
}
