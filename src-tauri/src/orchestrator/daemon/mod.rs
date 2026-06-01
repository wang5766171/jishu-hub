pub mod rpc;

use crate::agent::AgentRegistry;
use crate::orchestrator::spec::TaskSpec;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

pub struct DaemonState {
    pub registry: Arc<AgentRegistry>,
    pub started_at: i64,
    pub active_runs: HashMap<String, String>, // run_id -> task_id
}

impl DaemonState {
    pub fn new() -> Self {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        Self {
            registry: Arc::new(AgentRegistry::new()),
            started_at: now_ms,
            active_runs: HashMap::new(),
        }
    }
}

/// Run the daemon's main loop, reading JSON-RPC from stdin and writing to stdout.
pub fn run_daemon() -> Result<(), String> {
    let state = Arc::new(Mutex::new(DaemonState::new()));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let reader = std::io::BufReader::new(stdin.lock());

    // Write startup notification
    let startup = rpc::JsonRpcNotification {
        jsonrpc: "2.0".to_string(),
        method: "daemon.started".to_string(),
        params: serde_json::json!({
            "pid": std::process::id(),
            "started_at": state.lock().map_err(|e| e.to_string())?.started_at,
        }),
    };
    rpc::write_message(&mut stdout, &startup)?;
    stdout.flush().map_err(|e| e.to_string())?;

    for line in reader.lines() {
        let line = line.map_err(|e| format!("stdin read error: {e}"))?;
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

        let response = handle_rpc(request, &state);
        if let Some(resp) = response {
            rpc::write_message(&mut stdout, &resp)?;
        }

        stdout.flush().map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn handle_rpc(
    req: rpc::JsonRpcRequest,
    state: &Arc<Mutex<DaemonState>>,
) -> Option<rpc::JsonRpcResponse> {
    let id = req.id.clone();
    match req.method.as_str() {
        "daemon.status" => {
            let s = state.lock().ok();
            let pid = std::process::id();
            let started_at = s.as_ref().map(|s| s.started_at).unwrap_or(0);
            let runs_active = s.as_ref().map(|s| s.active_runs.len()).unwrap_or(0);
            Some(rpc::ok_response(id, serde_json::json!({
                "pid": pid,
                "started_at": started_at,
                "runs_active": runs_active,
            })))
        }
        "daemon.shutdown" => {
            let resp = rpc::ok_response(id, serde_json::json!({"ok": true}));
            // In a real implementation, we'd signal shutdown here
            Some(resp)
        }
        "agent.list" => {
            let s = state.lock().ok();
            let agents = s
                .as_ref()
                .map(|s| s.registry.list_agents())
                .unwrap_or_default();
            Some(rpc::ok_response(id, serde_json::json!(agents)))
        }
        "task.submit" => {
            // Parse TaskSpec from params
            let spec: Result<TaskSpec, _> =
                serde_json::from_value(req.params.unwrap_or_default());
            match spec {
                Ok(spec) => {
                    let run_id = format!("r_{}", spec.task_id);
                    if let Ok(mut s) = state.lock() {
                        s.active_runs
                            .insert(run_id.clone(), spec.task_id.clone());
                    }
                    Some(rpc::ok_response(
                        id,
                        serde_json::json!({
                            "task_id": spec.task_id,
                            "run_id": run_id,
                        }),
                    ))
                }
                Err(e) => Some(rpc::error_response(
                    id,
                    -32602,
                    &format!("Invalid params: {e}"),
                )),
            }
        }
        "task.list" => Some(rpc::ok_response(id, serde_json::json!([]))),
        "task.cancel" => Some(rpc::ok_response(id, serde_json::json!({"ok": true}))),
        _ => Some(rpc::error_response(
            id,
            -32601,
            &format!("Method not found: {}", req.method),
        )),
    }
}
