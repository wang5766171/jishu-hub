use std::sync::Mutex;

use tauri::Manager;

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

/// 官方直连认证状态（v0.7.6 需求3，adapter contract 路由）。None = 该
/// agent 无官方认证概念（UI 不渲染认证卡）。
#[tauri::command]
pub(crate) fn agent_official_auth(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Option<agent::OfficialAuthStatus>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s
        .registry
        .get(&agent_id)
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    Ok(agent.official_auth())
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

// ── 权限模式（v0.7.3 需求2 P-1/P-3/P-4）─────────────────────────────────────

/// 读取 agent 工具模式（Hub 全局；jishu-self 的 full/readonly）。
#[tauri::command]
pub(crate) fn get_agent_tool_mode(agent_id: String) -> Option<String> {
    crate::hub::load_agent_tool_mode(&agent_id)
}

/// 设置 agent 工具模式并持久化（合法值以 adapter 声明的 permission_modes 为准）。
/// 工具集经 spawn 参数（--tools）注入，而 PiRpc 会话是持久进程——模式变化时
/// 终止该 agent 的活跃会话进程，下一条消息自动重启（--session-id 恢复历史），
/// 使新模式立即对既有会话生效。
#[tauri::command]
pub(crate) async fn set_agent_tool_mode(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    mode: String,
) -> Result<(), String> {
    let (modes, provider) = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let agent = s.registry.require_agent(&agent_id)?;
        agent
            .permission_modes()
            .ok_or_else(|| format!("Agent {} has no permission modes", agent_id))?
    };
    if provider != crate::agent::PermissionModeProvider::HubToolMode {
        return Err(format!("Agent {} does not use hub tool mode", agent_id));
    }
    if !modes.contains(&mode) {
        return Err(format!("Unknown tool mode: {}", mode));
    }

    // v0.8.0 需求1 P-2 收尾（融入会话工具模式，用户裁决）：full-approve 档
    // 联动写 Pi settings 的 toolApproval=smart（逐次审批扩展读此键）；
    // full 档写 off（原行为）。工具集本身两档相同（full），审批开关是唯一
    // 差异——重启会话使内存设置即时生效（扩展每次评估读内存设置）。
    let tool_approval = match mode.as_str() {
        "full-approve" => "ask_always",
        "smart-approve" => "smart",
        "full" => "off",
        _ => "off", // readonly 工具白名单已限制写操作，审批关闭
    };
    let _ = crate::agent::jishu_self::config::save_jishu_config(&serde_json::json!({
        "toolApproval": tool_approval
    }));

    // 仅当实际生效的模式变化时才重启会话：未配置（None）语义上等同 full，
    // 首次显式选择 full 不触发 shutdown，避免无谓打断进行中的会话。
    let previous =
        crate::hub::load_agent_tool_mode(&agent_id).unwrap_or_else(|| "full".to_string());
    let changed = previous != mode;
    crate::hub::save_agent_tool_mode(&agent_id, &mode)?;

    if changed {
        // 收集并清空该 agent 全部会话条目的 AcpControl（gui id 与 resolved id
        // 可能各持一份克隆，shutdown 幂等），existing_acp_session 随后找不到
        // 可复用进程即触发 respawn。
        let chat_state = app.state::<std::sync::Mutex<crate::chat::ChatState>>();
        let controls: Vec<crate::acp_runtime::AcpControl> = {
            let mut s = chat_state
                .lock()
                .map_err(|_| "Chat state lock poisoned".to_string())?;
            let keys: Vec<String> = s
                .processes
                .iter()
                .filter(|(_, p)| p.agent_id == agent_id)
                .map(|(k, _)| k.clone())
                .collect();
            keys.iter()
                .filter_map(|k| s.processes.get_mut(k).and_then(|p| p.acp.take()))
                .collect()
        };
        for control in controls {
            control.shutdown().await;
        }
    }
    Ok(())
}

/// 读取 agent 配置承载的权限模式（如 codex 的 approval_policy）。
#[tauri::command]
pub(crate) fn get_agent_permission_mode(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Option<String>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.require_agent(&agent_id)?.get_permission_mode()
}

/// 设置 agent 配置承载的权限模式。
#[tauri::command]
pub(crate) fn set_agent_permission_mode(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    mode: String,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .set_permission_mode(&mode)
}
