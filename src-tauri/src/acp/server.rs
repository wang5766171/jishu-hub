use super::session::AcpSession;
use crate::orchestrator::daemon::rpc;
use std::io::{BufRead, Write};

/// Run the ACP server over stdio, speaking JSON-RPC 2.0.
///
/// Each line on stdin is a JSON-RPC request; each response/notification is
/// written as a single JSON line to stdout.
pub fn run_stdio(cwd: Option<String>, model: Option<String>) -> Result<(), String> {
    let cwd = cwd.unwrap_or_else(|| ".".to_string());
    let mut session = AcpSession::new(cwd, model);

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let reader = std::io::BufReader::new(stdin.lock());

    for line in reader.lines() {
        let line = line.map_err(|e| format!("stdin: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }

        let request: rpc::JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = rpc::JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: serde_json::Value::Null,
                    result: None,
                    error: Some(rpc::JsonRpcError {
                        code: -32700,
                        message: format!("Parse error: {e}"),
                        data: None,
                    }),
                };
                rpc::write_message(&mut stdout, &err_resp)?;
                stdout.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };

        if let Some(resp) = handle_request(request, &mut session, &mut stdout) {
            rpc::write_message(&mut stdout, &resp)?;
        }
        stdout.flush().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Dispatch a single JSON-RPC request, optionally returning a response.
///
/// Notifications (events) are written directly to stdout during processing.
fn handle_request(
    req: rpc::JsonRpcRequest,
    session: &mut AcpSession,
    stdout: &mut std::io::Stdout,
) -> Option<rpc::JsonRpcResponse> {
    let id = req.id.clone();
    match req.method.as_str() {
        "initialize" => Some(rpc::ok_response(
            id,
            serde_json::json!({
                "protocolVersion": "0.1",
                "capabilities": {
                    "tools": true,
                    "streaming": true,
                },
                "serverInfo": {
                    "name": "jishu-hub",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        )),

        "session/create" => {
            let session_id = session.create();
            Some(rpc::ok_response(id, serde_json::json!({ "sessionId": session_id })))
        }

        "session/prompt" => {
            let message = req
                .params
                .as_ref()
                .and_then(|p| p.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();

            let events = session.prompt(message);
            // Emit events as notifications before the final response.
            for event in events {
                let notification = rpc::JsonRpcNotification {
                    jsonrpc: "2.0".to_string(),
                    method: "session/event".to_string(),
                    params: serde_json::to_value(&event).unwrap_or_default(),
                };
                let _ = rpc::write_message(stdout, &notification);
            }
            Some(rpc::ok_response(id, serde_json::json!({ "done": true })))
        }

        "session/cancel" => {
            session.cancel();
            Some(rpc::ok_response(id, serde_json::json!({ "ok": true })))
        }

        "session/close" => {
            session.close();
            Some(rpc::ok_response(id, serde_json::json!({ "ok": true })))
        }

        "tools/list" => Some(rpc::ok_response(id, serde_json::json!({ "tools": [] }))),

        _ => Some(rpc::error_response(
            id,
            -32601,
            &format!("Method not found: {}", req.method),
        )),
    }
}
