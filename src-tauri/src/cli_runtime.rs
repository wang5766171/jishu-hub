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
        tauri::async_runtime::spawn(async move {
            drain_stderr(stderr_agent_id, stderr).await;
        });
    }

    tauri::async_runtime::spawn(async move {
        stream_stdout(app, agent_id, session_id, stdout).await;
        on_finish();
    });
}

async fn drain_stderr<R>(agent_id: String, stderr: R)
where
    R: AsyncRead + Unpin,
{
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log::warn!("[{} stderr] {}", agent_id, line);
    }
}

async fn stream_stdout<R>(app: tauri::AppHandle, agent_id: String, session_id: String, stdout: R)
where
    R: AsyncRead + Unpin,
{
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut saw_terminal_event = false;
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
        let events = [
            NormalizedEvent::Error {
                message: "Process exited without a completion event".to_string(),
                recoverable: false,
            },
            NormalizedEvent::TurnComplete {
                reason: TurnEndReason::Error,
                usage: None,
            },
        ];
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
