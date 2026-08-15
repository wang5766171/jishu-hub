use super::normalize::normalize_acp_update;
use super::*;

pub(super) struct AcpWriter {
    pub(super) stdin: Arc<TokioMutex<ChildStdin>>,
    pub(super) next_id: i64,
}

impl AcpWriter {
    pub(super) fn new(stdin: Arc<TokioMutex<ChildStdin>>) -> Self {
        Self { stdin, next_id: 0 }
    }

    pub(super) async fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<i64, String> {
        let mut stdin = self.stdin.lock().await;
        write_jsonrpc_request(&mut *stdin, &mut self.next_id, method, params).await
    }

    /// Send a JSON-RPC response for a server-initiated request (e.g. tool approval).
    pub(super) async fn respond(
        &self,
        id: &serde_json::Value,
        result: serde_json::Value,
    ) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        });
        let line = format!("{}\n", msg);
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("ACP write error: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("ACP flush error: {e}"))?;
        Ok(())
    }
}

pub enum AcpResponse {
    Update(Vec<NormalizedEvent>),
    PermissionRequest {
        id: serde_json::Value,
        params: serde_json::Value,
    },
    Result(serde_json::Value),
    Error(String),
    Ignored,
}

pub async fn write_jsonrpc_request(
    stdin: &mut (impl tokio::io::AsyncWrite + Unpin),
    next_id: &mut i64,
    method: &str,
    params: serde_json::Value,
) -> Result<i64, String> {
    let id = *next_id;
    *next_id += 1;
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });
    let line = format!("{}\n", msg);
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

pub(crate) fn acp_initialize_params() -> serde_json::Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false,
            // ACP SDK 0.26 models elicitation modes as object capabilities.
            // Sending `form: true` is schema-invalid and gets dropped before
            // claude-agent-acp computes its AskUserQuestion gate.
            "elicitation": { "form": {} }
        },
        "clientInfo": {
            "name": "jishu-hub",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

pub fn handle_acp_response_line(
    line: &str,
    target_id: i64,
    usage: &mut Option<UsageStats>,
) -> Result<AcpResponse, String> {
    if line.trim().is_empty() {
        return Ok(AcpResponse::Ignored);
    }
    let msg: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("ACP JSON parse error: {e}"))?;

    if msg.get("method").and_then(|v| v.as_str()) == Some("session/update") {
        if let Some(params) = msg.get("params") {
            let events = normalize_acp_update(params, usage);
            return Ok(AcpResponse::Update(events));
        }
    } else if msg.get("method").and_then(|v| v.as_str()) == Some("session/request_permission") {
        let id = msg
            .get("id")
            .cloned()
            .ok_or_else(|| "ACP permission request missing id".to_string())?;
        let params = msg.get("params").cloned().unwrap_or_default();
        return Ok(AcpResponse::PermissionRequest { id, params });
    } else if msg.get("id").and_then(|v| v.as_i64()) == Some(target_id) {
        if let Some(err) = msg.get("error") {
            return Ok(AcpResponse::Error(
                err.get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
            ));
        }
        if let Some(res) = msg.get("result") {
            return Ok(AcpResponse::Result(res.clone()));
        }
        return Err("ACP response missing result or error".to_string());
    }
    Ok(AcpResponse::Ignored)
}

// ---------------------------------------------------------------------------
// Internal: connection loop state machine
// ---------------------------------------------------------------------------

pub(super) async fn stdout_reader(
    stdout: tokio::process::ChildStdout,
    tx: tokio::sync::mpsc::Sender<String>,
) {
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if tx.send(line).await.is_err() {
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Internal: prompt response handler
// ---------------------------------------------------------------------------

pub(super) fn handle_prompt_response(
    msg: &serde_json::Value,
    usage: &mut Option<UsageStats>,
    buf: &mut Vec<NormalizedEvent>,
) {
    if let Some(err) = msg.get("error") {
        let err_msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("ACP error");
        buf.push(NormalizedEvent::Error {
            message: err_msg.to_string(),
            recoverable: false,
        });
        buf.push(NormalizedEvent::TurnComplete {
            reason: TurnEndReason::Error,
            usage: None,
        });
    } else {
        let stop_reason = msg
            .get("result")
            .and_then(|r| r.get("stopReason"))
            .and_then(|v| v.as_str())
            .unwrap_or("end_turn");

        if let Some(u) = msg.get("result").and_then(|r| r.get("usage")) {
            *usage = Some(UsageStats {
                input_tokens: u.get("inputTokens").and_then(|v| v.as_u64()),
                output_tokens: u.get("outputTokens").and_then(|v| v.as_u64()),
                total_cost: None,
                context_remaining: None,
                context_window_total: None,
            });
        }

        let reason = match stop_reason {
            "cancelled" => TurnEndReason::Aborted,
            "max_tokens" => TurnEndReason::MaxTokens,
            "refusal" | "error" => TurnEndReason::Error,
            _ => TurnEndReason::Complete,
        };
        buf.push(NormalizedEvent::TurnComplete {
            reason,
            usage: usage.take(),
        });
    }
}

// ---------------------------------------------------------------------------
// Internal: handshake response reader (channel-based with timeout)
// ---------------------------------------------------------------------------

/// v0.7.0：握手失败时附带 stderr 内容（桥提前退出的诊断信息）。
pub(super) async fn enrich_handshake_error(
    e: String,
    stderr_buf: &Arc<TokioMutex<String>>,
) -> String {
    let stderr = stderr_buf.lock().await;
    let stderr_tail = if stderr.len() > 800 {
        &stderr[stderr.len() - 800..]
    } else {
        stderr.as_str()
    };
    if stderr_tail.trim().is_empty() {
        e
    } else {
        format!("{e}\n--- agent stderr ---\n{}", stderr_tail.trim())
    }
}

pub(super) async fn wait_for_response(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<String>,
    expected_id: i64,
) -> Result<serde_json::Value, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut dummy_usage = None;
    loop {
        let line = tokio::select! {
            line = stdout_rx.recv() => {
                line.ok_or_else(|| "ACP process closed before response".to_string())?
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err("ACP handshake timeout (30s)".to_string());
            }
        };

        match handle_acp_response_line(&line, expected_id, &mut dummy_usage)? {
            AcpResponse::Result(val) => return Ok(val),
            AcpResponse::Error(err) => return Err(format!("ACP error: {}", err)),
            _ => continue, // Ignore updates or other messages during handshake
        }
    }
}
