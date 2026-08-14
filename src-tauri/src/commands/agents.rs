use std::sync::Mutex;

use crate::{agent, with_app_state, AppState};

#[tauri::command]
pub(crate) fn list_agents(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<agent::AgentInfo>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.list_agents())
}

#[tauri::command]
pub(crate) fn agent_list_statuses(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<agent::AgentStatus>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.list_agent_statuses())
}

#[tauri::command]
pub(crate) async fn agent_refresh_health(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    // v0.7.2 需求 1 / M2.2+M2.3：脱锁取 Arc<registry>，用 spawn_blocking 调
    // refresh_health_blocking（scoped threads 并发 probe_sync）。此前命令持锁顺序
    // probe_sync 4 个 agent，耗时为各项之和且阻塞所有 AppState 命令。
    let __t = std::time::Instant::now();
    let registry = with_app_state(&state, |s| s.registry.clone())?;
    tauri::async_runtime::spawn_blocking(move || registry.refresh_health_blocking())
        .await
        .map_err(|e| e.to_string())?;
    log::info!("[startup] agent_refresh_health: {:?}", __t.elapsed());
    Ok(())
}

/// Check MCP adapter installation status for a specific agent (routed through adapter contract).
#[tauri::command]
pub(crate) fn check_mcp_adapter(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s
        .registry
        .get(&agent_id)
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    agent.check_mcp()
}

/// Install MCP adapter for a specific agent (routed through adapter contract).
/// The MutexGuard is released before .await to keep the future Send-safe.
#[tauri::command]
pub(crate) async fn install_mcp_adapter(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<String, String> {
    // Validate agent supports MCP under the lock (synchronous), then release.
    {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let agent = s
            .registry
            .get(&agent_id)
            .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
        if !agent.supports_mcp() {
            return Err(format!("Agent {} does not support MCP", agent_id));
        }
    }
    // Lock released — delegate to adapter's standalone install helper.
    crate::agent::jishu_self::JishuSelfAgent::install_mcp_standalone().await
}

/// Update MCP adapter for a specific agent (routed through adapter contract).
#[tauri::command]
pub(crate) async fn update_mcp_adapter(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<String, String> {
    {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let agent = s
            .registry
            .get(&agent_id)
            .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
        if !agent.supports_mcp() {
            return Err(format!("Agent {} does not support MCP", agent_id));
        }
    }
    crate::agent::jishu_self::JishuSelfAgent::update_mcp_standalone().await
}

/// Check transport-bridge installation status for a specific agent (routed
/// through adapter contract — e.g. claude_code's claude-agent-acp dependency).
#[tauri::command]
pub(crate) fn check_transport_bridge(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s
        .registry
        .get(&agent_id)
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    agent.check_transport_bridge()
}

/// Install transport bridge for a specific agent (routed through adapter
/// contract). The MutexGuard is released before .await to keep the future
/// Send-safe (mirrors install_mcp_adapter).
#[tauri::command]
pub(crate) async fn install_transport_bridge(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<String, String> {
    // Validate the agent has a transport bridge under the lock, then release.
    {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let agent = s
            .registry
            .get(&agent_id)
            .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
        if !agent.supports_transport_bridge() {
            return Err(format!("Agent {} has no transport bridge", agent_id));
        }
    }
    // Lock released — delegate to claude_code's standalone install helper.
    crate::agent::ClaudeCodeAgent::install_transport_bridge_standalone().await
}
