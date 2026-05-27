use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use crate::agent::{
    self,
    normalized::{NormalizedEvent, TurnEndReason},
};

#[derive(Debug, Clone, serde::Serialize)]
pub struct StreamChunk {
    pub session_id: String,
    pub event_type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentStreamChunk {
    pub agent_id: String,
    pub session_id: String,
    pub event_type: String,
    pub data: serde_json::Value,
}

pub fn spawn_stream_reader<R, E>(
    app: tauri::AppHandle,
    agent_id: String,
    session_id: String,
    stdout: R,
    stderr: Option<E>,
    on_finish: impl FnOnce() + Send + 'static,
) where
    R: AsyncRead + Unpin + Send + 'static,
    E: AsyncRead + Unpin + Send + 'static,
{
    if let Some(stderr) = stderr {
        let stderr_agent_id = agent_id.clone();
        let stderr_session_id = session_id.clone();
        let stderr_app = app.clone();
        tauri::async_runtime::spawn(async move {
            drain_stderr(stderr_app, stderr_agent_id, stderr_session_id, stderr).await;
        });
    }

    tauri::async_runtime::spawn(async move {
        stream_stdout(app, agent_id, session_id, stdout).await;
        on_finish();
    });
}

async fn drain_stderr<R>(app: tauri::AppHandle, agent_id: String, session_id: String, stderr: R)
where
    R: AsyncRead + Unpin,
{
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log::warn!("[{} stderr] {}", agent_id, line);
        if agent_id == "opencode" && !line.trim().is_empty() {
            let event = NormalizedEvent::Error {
                message: line,
                recoverable: true,
            };
            if let Ok(data) = serde_json::to_value(event) {
                emit_stream_batch(
                    &app,
                    &agent_id,
                    &[StreamChunk {
                        session_id: session_id.clone(),
                        event_type: "error".to_string(),
                        data,
                    }],
                );
            }
        }
    }
}

async fn stream_stdout<R>(app: tauri::AppHandle, agent_id: String, session_id: String, stdout: R)
where
    R: AsyncRead + Unpin,
{
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut saw_terminal_event = false;
    let mut saw_agent_output = false;
    let mut buf: Vec<StreamChunk> = Vec::with_capacity(32);
    let mut last_flush = std::time::Instant::now();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }

        let events = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(raw) => agent::normalize_stream_event(&agent_id, &raw),
            Err(error) => vec![NormalizedEvent::Error {
                message: format!("Failed to parse {agent_id} JSON stream line: {error}"),
                recoverable: true,
            }],
        };

        for event in events {
            if is_agent_output(&event) {
                saw_agent_output = true;
            }
            if matches!(event, NormalizedEvent::TurnComplete { .. }) {
                saw_terminal_event = true;
            }
            let force = matches!(
                event,
                NormalizedEvent::SessionResolved { .. }
                    | NormalizedEvent::TurnComplete { .. }
                    | NormalizedEvent::Error { .. }
            );
            if let Ok(data) = serde_json::to_value(&event) {
                buf.push(StreamChunk {
                    session_id: session_id.clone(),
                    event_type: event.event_type().to_string(),
                    data,
                });
            }

            if force
                || buf.len() >= 32
                || last_flush.elapsed() >= std::time::Duration::from_millis(16)
            {
                emit_stream_batch(&app, &agent_id, &buf);
                buf.clear();
                last_flush = std::time::Instant::now();
            }
        }
    }

    if !buf.is_empty() {
        emit_stream_batch(&app, &agent_id, &buf);
    }

    if !saw_terminal_event {
        let events = if should_treat_eof_as_complete(&agent_id, saw_agent_output) {
            vec![NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Complete,
                usage: None,
            }]
        } else {
            vec![
                NormalizedEvent::Error {
                    message: "Process exited without a completion event".to_string(),
                    recoverable: false,
                },
                NormalizedEvent::TurnComplete {
                    reason: TurnEndReason::Error,
                    usage: None,
                },
            ]
        };
        let chunks: Vec<StreamChunk> = events
            .into_iter()
            .filter_map(|event| {
                let data = serde_json::to_value(&event).ok()?;
                Some(StreamChunk {
                    session_id: session_id.clone(),
                    event_type: event.event_type().to_string(),
                    data,
                })
            })
            .collect();
        emit_stream_batch(&app, &agent_id, &chunks);
    }
}

fn emit_stream_batch(app: &tauri::AppHandle, agent_id: &str, chunks: &[StreamChunk]) {
    if chunks.is_empty() {
        return;
    }

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
}

fn is_agent_output(event: &NormalizedEvent) -> bool {
    matches!(
        event,
        NormalizedEvent::TextDelta { .. }
            | NormalizedEvent::Message { .. }
            | NormalizedEvent::Thinking { .. }
            | NormalizedEvent::ToolUseStart { .. }
            | NormalizedEvent::ToolUseResult { .. }
    )
}

fn should_treat_eof_as_complete(agent_id: &str, saw_agent_output: bool) -> bool {
    agent_id == "opencode" && saw_agent_output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_eof_after_output_is_complete() {
        assert!(should_treat_eof_as_complete("opencode", true));
    }

    #[test]
    fn eof_without_output_stays_strict() {
        assert!(!should_treat_eof_as_complete("opencode", false));
        assert!(!should_treat_eof_as_complete("claude-code", true));
        assert!(!should_treat_eof_as_complete("codex", true));
    }

    #[test]
    fn text_delta_counts_as_agent_output() {
        assert!(is_agent_output(&NormalizedEvent::TextDelta {
            delta: "hello".to_string(),
        }));
        assert!(!is_agent_output(&NormalizedEvent::SessionResolved {
            session_id: "ses_1".to_string(),
        }));
    }
}
