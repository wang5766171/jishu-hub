pub mod rpc;

use crate::agent::AgentRegistry;
use crate::orchestrator::spec::TaskSpec;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct DaemonState {
    pub registry: Arc<AgentRegistry>,
    pub started_at: i64,
    pub active_runs: HashMap<String, String>, // run_id -> task_id
    runs_root: Option<PathBuf>,
}

impl DaemonState {
    pub fn new() -> Self {
        Self::with_runs_root(None)
    }

    #[cfg(test)]
    fn new_with_runs_root(root: PathBuf) -> Self {
        Self::with_runs_root(Some(root))
    }

    fn with_runs_root(runs_root: Option<PathBuf>) -> Self {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        Self {
            registry: Arc::new(AgentRegistry::new()),
            started_at: now_ms,
            active_runs: HashMap::new(),
            runs_root,
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
            Some(rpc::ok_response(
                id,
                serde_json::json!({
                    "pid": pid,
                    "started_at": started_at,
                    "runs_active": runs_active,
                }),
            ))
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
            let spec: Result<TaskSpec, _> = serde_json::from_value(req.params.unwrap_or_default());
            match spec {
                Ok(spec) => match submit_task_for_state(&spec, state) {
                    Ok(submitted) => {
                        let result = match serde_json::to_value(&submitted) {
                            Ok(value) => value,
                            Err(e) => {
                                return Some(rpc::error_response(
                                    id,
                                    -32603,
                                    &format!("Serialize result failed: {e}"),
                                ))
                            }
                        };
                        Some(rpc::ok_response(id, result))
                    }
                    Err(e) => Some(rpc::error_response(id, -32603, &e)),
                },
                Err(e) => Some(rpc::error_response(
                    id,
                    -32602,
                    &format!("Invalid params: {e}"),
                )),
            }
        }
        "task.list" => match list_runs_for_state(state) {
            Ok(runs) => Some(rpc::ok_response(id, serde_json::json!(runs))),
            Err(e) => Some(rpc::error_response(id, -32603, &e)),
        },
        "run.get" => {
            let run_id = match extract_run_id(req.params.as_ref()) {
                Some(run_id) => run_id,
                None => {
                    return Some(rpc::error_response(
                        id,
                        -32602,
                        "Invalid params: missing run_id",
                    ))
                }
            };
            match get_run_for_state(&run_id, state) {
                Ok(record) => Some(rpc::ok_response(id, serde_json::json!(record))),
                Err(e) => Some(rpc::error_response(id, -32603, &e)),
            }
        }
        "task.cancel" => {
            let run_id = match extract_run_id(req.params.as_ref()) {
                Some(run_id) => run_id,
                None => {
                    return Some(rpc::error_response(
                        id,
                        -32602,
                        "Invalid params: missing run_id",
                    ))
                }
            };
            match cancel_run_for_state(&run_id, state) {
                Ok(result) => Some(rpc::ok_response(
                    id,
                    serde_json::json!({ "ok": true, "result": result }),
                )),
                Err(e) => Some(rpc::error_response(id, -32603, &e)),
            }
        }
        _ => Some(rpc::error_response(
            id,
            -32601,
            &format!("Method not found: {}", req.method),
        )),
    }
}

fn submit_task_for_state(
    spec: &TaskSpec,
    state: &Arc<Mutex<DaemonState>>,
) -> Result<crate::orchestrator::TaskSubmitResult, String> {
    let submitted = {
        let s = state.lock().map_err(|e| e.to_string())?;
        match &s.runs_root {
            Some(root) => crate::orchestrator::submit_task_in_root(spec.clone(), root)?,
            None => crate::orchestrator::submit_task(spec.clone())?,
        }
    };

    if let Ok(mut s) = state.lock() {
        s.active_runs
            .insert(submitted.run_id.clone(), submitted.task_id.clone());
    }

    Ok(submitted)
}

fn list_runs_for_state(
    state: &Arc<Mutex<DaemonState>>,
) -> Result<Vec<crate::orchestrator::RunSummary>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    match &s.runs_root {
        Some(root) => crate::orchestrator::list_runs_in_root(root),
        None => crate::orchestrator::list_runs(),
    }
}

fn get_run_for_state(
    run_id: &str,
    state: &Arc<Mutex<DaemonState>>,
) -> Result<crate::orchestrator::RunRecord, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    match &s.runs_root {
        Some(root) => crate::orchestrator::get_run_in_root(root, run_id),
        None => crate::orchestrator::get_run(run_id),
    }
}

fn cancel_run_for_state(
    run_id: &str,
    state: &Arc<Mutex<DaemonState>>,
) -> Result<crate::orchestrator::RunResult, String> {
    let result = {
        let s = state.lock().map_err(|e| e.to_string())?;
        match &s.runs_root {
            Some(root) => crate::orchestrator::cancel_run_in_root(root, run_id)?,
            None => crate::orchestrator::cancel_run(run_id)?,
        }
    };

    if let Ok(mut s) = state.lock() {
        s.active_runs.remove(run_id);
    }

    Ok(result)
}

fn extract_run_id(params: Option<&serde_json::Value>) -> Option<String> {
    match params? {
        serde_json::Value::String(run_id) => Some(run_id.clone()),
        serde_json::Value::Object(obj) => obj
            .get("run_id")
            .and_then(|value| value.as_str())
            .map(|run_id| run_id.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::{RunStatus, TaskKind, TaskSpec};

    fn request(method: &str, params: Option<serde_json::Value>) -> rpc::JsonRpcRequest {
        rpc::JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: serde_json::json!(1),
            method: method.to_string(),
            params,
        }
    }

    #[test]
    fn daemon_rpc_submits_lists_gets_and_cancels_real_runs() {
        let root = std::env::temp_dir().join(format!("jishu_daemon_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let state = Arc::new(Mutex::new(DaemonState::new_with_runs_root(root.clone())));

        let spec = TaskSpec {
            task_id: "td_daemon".into(),
            kind: TaskKind::Plan,
            message: "HUB managed daemon task".into(),
            project_path: None,
            agent_hint: None,
            roles: Vec::new(),
            policy: "default".into(),
            depth: 0,
            parent_task_id: None,
            created_at: 1,
            deadline_ms: None,
            labels: HashMap::new(),
        };

        let submit = handle_rpc(
            request("task.submit", Some(serde_json::to_value(spec).unwrap())),
            &state,
        )
        .unwrap();
        let submit_result = submit.result.unwrap();
        assert_eq!(submit_result["task_id"], "td_daemon");
        assert_ne!(submit_result["run_id"], "r_td_daemon");
        let run_id = submit_result["run_id"].as_str().unwrap().to_string();

        let list = handle_rpc(request("task.list", None), &state)
            .unwrap()
            .result
            .unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["task_id"], "td_daemon");

        let get = handle_rpc(
            request("run.get", Some(serde_json::json!({ "run_id": run_id }))),
            &state,
        )
        .unwrap()
        .result
        .unwrap();
        assert_eq!(get["spec"]["task_id"], "td_daemon");
        assert_eq!(get["result"]["status"], "complete");

        let run_id = get["run_id"].as_str().unwrap().to_string();
        handle_rpc(
            request("task.cancel", Some(serde_json::json!({ "run_id": run_id }))),
            &state,
        )
        .unwrap();
        let get = handle_rpc(
            request(
                "run.get",
                Some(serde_json::json!({ "run_id": get["run_id"].as_str().unwrap() })),
            ),
            &state,
        )
        .unwrap()
        .result
        .unwrap();
        assert_eq!(
            get["result"]["status"],
            serde_json::to_value(RunStatus::Aborted).unwrap()
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
