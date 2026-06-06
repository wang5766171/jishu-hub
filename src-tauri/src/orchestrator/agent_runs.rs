use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Pending question/clarification emitted by an agent subprocess.
///
/// When the agent (e.g. claude-code) needs user input, it emits an
/// `approval_request` event. The dispatcher captures it into the
/// `ActiveAgent.pending_approval` slot so the HUB can show it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingApproval {
    /// Unique request id (e.g. tool call id from the agent)
    pub request_id: String,
    /// Type of approval
    pub kind: String,
    /// Question / prompt shown to the user
    pub question: String,
    /// Quick-reply options (parsed from agent payload)
    pub options: Vec<String>,
    /// Surrounding context shown above the question
    pub context: Option<String>,
    /// Original payload for debug / future use
    pub raw_payload: serde_json::Value,
}

/// Live handle to a running agent subprocess. Lets us send follow-up
/// messages back to the agent after it has asked a question.
pub struct ActiveAgent {
    /// For tracing
    pub run_id: String,
    pub step_id: String,
    /// When the step started (ms)
    pub started_at: i64,
    /// Captured from the first SessionResolved event
    pub session_id: Option<String>,
    /// Sender to write messages into the agent's stdin
    pub stdin_tx: mpsc::UnboundedSender<String>,
    /// Most recent pending approval (if any)
    pub pending_approval: Arc<Mutex<Option<PendingApproval>>>,
    /// Cancellation flag — UI can interrupt
    pub cancelled: Arc<Mutex<bool>>,
}

/// Key for the active agent registry. One agent per (run, step) pair.
pub type AgentKey = (String, String);

/// Global registry of running agent subprocesses.
pub type AgentRegistry = Arc<Mutex<HashMap<AgentKey, Arc<ActiveAgent>>>>;

/// Create a new global registry (call once at startup).
pub fn new_registry() -> AgentRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Register a new active agent. Replaces any previous entry for the same key.
pub fn register(registry: &AgentRegistry, agent: Arc<ActiveAgent>) {
    let key: AgentKey = (agent.run_id.clone(), agent.step_id.clone());
    registry.lock().unwrap().insert(key, agent);
}

/// Unregister an active agent. Called when the subprocess exits or is cancelled.
pub fn unregister(registry: &AgentRegistry, run_id: &str, step_id: &str) {
    let key: AgentKey = (run_id.to_string(), step_id.to_string());
    registry.lock().unwrap().remove(&key);
}

/// Look up an active agent by (run_id, step_id). Returns None if not running.
pub fn get(registry: &AgentRegistry, run_id: &str, step_id: &str) -> Option<Arc<ActiveAgent>> {
    let key: AgentKey = (run_id.to_string(), step_id.to_string());
    registry.lock().unwrap().get(&key).cloned()
}

/// Send a user message to a running agent's stdin.
/// Returns Ok(()) if delivered, Err if no such active agent or send failed.
pub fn send_message(
    registry: &AgentRegistry,
    run_id: &str,
    step_id: &str,
    message: &str,
) -> Result<(), String> {
    let agent = get(registry, run_id, step_id)
        .ok_or_else(|| format!("No active agent for run={run_id} step={step_id}"))?;
    agent
        .stdin_tx
        .send(message.to_string())
        .map_err(|e| format!("Failed to send message to agent: {e}"))?;
    // Clear any pending approval (user responded)
    if let Ok(mut pa) = agent.pending_approval.lock() {
        *pa = None;
    }
    Ok(())
}

/// Mark an active agent as cancelled. The dispatcher will pick this up
/// on its next iteration and terminate the subprocess.
pub fn cancel(registry: &AgentRegistry, run_id: &str, step_id: &str) -> Result<(), String> {
    let agent = get(registry, run_id, step_id)
        .ok_or_else(|| format!("No active agent for run={run_id} step={step_id}"))?;
    *agent.cancelled.lock().unwrap() = true;
    Ok(())
}

/// Get the current pending approval for an active agent, if any.
pub fn get_approval(
    registry: &AgentRegistry,
    run_id: &str,
    step_id: &str,
) -> Option<PendingApproval> {
    get(registry, run_id, step_id).and_then(|a| a.pending_approval.lock().unwrap().clone())
}

/// Set the pending approval for an active agent (called by dispatcher
/// when it sees an approval_request event from the subprocess).
pub fn set_approval(
    registry: &AgentRegistry,
    run_id: &str,
    step_id: &str,
    approval: PendingApproval,
) {
    if let Some(agent) = get(registry, run_id, step_id) {
        *agent.pending_approval.lock().unwrap() = Some(approval);
    }
}

/// Static (process-wide) registry. Use this for simplicity since Tauri
/// commands don't share a long-lived AppState handle easily.
use std::sync::OnceLock;
static GLOBAL_REGISTRY: OnceLock<AgentRegistry> = OnceLock::new();

pub fn global() -> &'static AgentRegistry {
    GLOBAL_REGISTRY.get_or_init(new_registry)
}
