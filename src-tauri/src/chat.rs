use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;

use crate::agent_runtime::{self, AgentTurnRequest};
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub agent_id: String,
    pub session_id: String,
    pub process_id: u32,
}

#[derive(Clone)]
pub struct ChatProcess {
    pub agent_id: String,
    pub process_id: u32,
    pub stdin: Option<Arc<Mutex<Option<ChildStdin>>>>,
    pub acp: Option<crate::acp_runtime::AcpControl>,
}

pub struct ChatState {
    pub processes: HashMap<String, ChatProcess>,
}

impl ChatState {
    pub fn new() -> Self {
        Self {
            processes: HashMap::new(),
        }
    }
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
    session_id: Option<String>,
    message: String,
) -> Result<ChatSession, String> {
    log::info!(
        "send_message: agent={}, project={}, session={:?}, message_len={}",
        agent_id,
        project_path,
        session_id,
        message.len()
    );

    // v0.7.0 需求一：agent_id 由前端按会话作用域传入，不再从全局 active 读取。
    // 校验 agent_id 合法性（require_agent 返回错误时提前失败）。
    {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        s.registry.require_agent(&agent_id)?;
    }

    if let Some(ref sid) = session_id {
        if let Some((acp, pid)) = existing_acp_session(&app, sid, &agent_id)? {
            match acp.send_prompt(message.clone()).await {
                Ok(()) => {
                    return Ok(ChatSession {
                        agent_id,
                        session_id: sid.clone(),
                        process_id: pid,
                    });
                }
                Err(_) => {
                    log::info!("ACP connection closed for session {}, respawning", sid);
                    remove_process_entries(&app, Some(pid), Some(sid))?;
                }
            }
        }
    }

    let pending_session_id = session_id
        .clone()
        .unwrap_or_else(|| format!("pending-{}", uuid::Uuid::new_v4()));

    let prepared = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        agent_runtime::prepare_gui_turn(
            &s.registry,
            AgentTurnRequest {
                agent_id: agent_id.clone(),
                project_path,
                session_id: Some(pending_session_id.clone()),
                message,
                timeout_secs: 0,
            },
        )?
    };

    let cleanup_pid = Arc::new(Mutex::new(None::<u32>));
    let cleanup_pid_for_finish = cleanup_pid.clone();
    let app_for_finish = app.clone();
    let sid_for_finish = pending_session_id.clone();

    let app_for_resolve = app.clone();
    let sid_for_resolve = pending_session_id.clone();

    let handle = agent_runtime::start_gui_turn(
        app.clone(),
        prepared,
        move || {
            let pid = cleanup_pid_for_finish
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .to_owned();
            let _ = remove_process_entries(&app_for_finish, pid, Some(&sid_for_finish));
        },
        move |real_id: &str| {
            if real_id == sid_for_resolve {
                return;
            }
            let state = app_for_resolve.state::<Mutex<ChatState>>();
            if let Ok(mut s) = state.lock() {
                if let Some(process) = s.processes.get(&sid_for_resolve).cloned() {
                    s.processes.insert(real_id.to_string(), process);
                }
            };
        },
    )
    .await?;

    {
        let mut pid = cleanup_pid.lock().unwrap_or_else(|e| e.into_inner());
        *pid = Some(handle.process_id);
    }

    let chat_state = app.state::<Mutex<ChatState>>();
    if let Ok(mut s) = chat_state.lock() {
        let process = ChatProcess {
            agent_id: handle.agent_id.clone(),
            process_id: handle.process_id,
            stdin: handle.stdin.clone(),
            acp: handle.acp.clone(),
        };
        s.processes
            .insert(handle.session_id.clone(), process.clone());
        if let Some(real_id) = handle
            .acp
            .as_ref()
            .and_then(|acp| acp.resolved_session_id())
        {
            if real_id != handle.session_id {
                s.processes.insert(real_id, process);
            }
        }
    }

    Ok(ChatSession {
        agent_id: handle.agent_id,
        session_id: handle.session_id,
        process_id: handle.process_id,
    })
}

fn existing_acp_session(
    app: &AppHandle,
    session_id: &str,
    agent_id: &str,
) -> Result<Option<(crate::acp_runtime::AcpControl, u32)>, String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let existing = chat_state
        .lock()
        .map_err(|_| "Chat state lock poisoned".to_string())?
        .processes
        .get(session_id)
        .and_then(|process| {
            if process.agent_id == agent_id {
                process
                    .acp
                    .as_ref()
                    .map(|acp| (acp.clone(), process.process_id))
            } else {
                None
            }
        });
    Ok(existing)
}

fn remove_process_entries(
    app: &AppHandle,
    process_id: Option<u32>,
    session_id: Option<&str>,
) -> Result<(), String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let mut state = chat_state
        .lock()
        .map_err(|_| "Chat state lock poisoned".to_string())?;
    if let Some(pid) = process_id {
        state.processes.retain(|_, item| item.process_id != pid);
    }
    if let Some(sid) = session_id {
        state.processes.remove(sid);
    }
    Ok(())
}

#[tauri::command]
pub async fn abort_chat(app: AppHandle, session_id: String) -> Result<(), String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let process = {
        let s = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        let Some(process) = s.processes.get(&session_id).cloned() else {
            return Ok(());
        };
        process
    };

    // ACP cancel path: send cancel only, keep connection alive.
    if let Some(acp) = &process.acp {
        acp.send_cancel().await;
        log::info!("cancelled ACP prompt in session {}", session_id);
        return Ok(());
    }

    {
        let mut s = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        s.processes
            .retain(|_, item| item.process_id != process.process_id);
    }

    let app_state = app.state::<Mutex<AppState>>();

    let (abort_sequence, abort_grace): (Option<Vec<u8>>, std::time::Duration) = {
        let s = app_state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        if let Some(agent) = s.registry.get(&process.agent_id) {
            (
                agent
                    .abort_chat_sequence()
                    .map(|sequence| sequence.to_vec()),
                agent.abort_chat_grace_period(),
            )
        } else {
            (None, std::time::Duration::from_millis(0))
        }
    };

    let mut control_sent = false;
    if let (Some(sequence), Some(stdin)) = (abort_sequence, process.stdin.as_ref()) {
        let mut stdin_handle = stdin
            .lock()
            .map_err(|_| "Chat process stdin lock poisoned".to_string())?
            .take();
        if let Some(mut stdin_handle) = stdin_handle.take() {
            match stdin_handle.write_all(&sequence).await {
                Ok(()) => match stdin_handle.flush().await {
                    Ok(()) => {
                        control_sent = true;
                        log::info!(
                            "sent {} abort control bytes to {} chat process {}",
                            sequence.len(),
                            process.agent_id,
                            process.process_id
                        );
                        tokio::time::sleep(abort_grace).await;
                    }
                    Err(err) => {
                        log::warn!(
                            "failed to flush abort control bytes to {} chat process {}: {}",
                            process.agent_id,
                            process.process_id,
                            err
                        );
                    }
                },
                Err(err) => {
                    log::warn!(
                        "failed to write abort control bytes to {} chat process {}: {}",
                        process.agent_id,
                        process.process_id,
                        err
                    );
                }
            }
        }
    }

    if control_sent && !crate::process_control::is_process_running(process.process_id) {
        log::info!(
            "aborted {} chat session {} via control sequence",
            process.agent_id,
            session_id
        );
        return Ok(());
    }

    let abort_result = {
        let s = app_state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        if let Some(agent) = s.registry.get(&process.agent_id) {
            agent.abort_chat_process(process.process_id)
        } else {
            crate::process_control::terminate_process_tree(process.process_id)
        }
    };

    match abort_result {
        Ok(()) => {
            log::info!("aborted {} chat session {}", process.agent_id, session_id);
            Ok(())
        }
        Err(err) => {
            log::warn!(
                "failed to abort {} chat session {}: {}",
                process.agent_id,
                session_id,
                err
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn steer_chat(app: AppHandle, session_id: String, message: String) -> Result<(), String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let acp = {
        let state = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        state
            .processes
            .get(&session_id)
            .and_then(|process| process.acp.clone())
            .ok_or_else(|| format!("No active ACP session found for {session_id}"))?
    };
    acp.steer(message).await
}

/// Set the agent's thinking level (v0.7.4 需求1 A7). Hub-side persistence
/// (applied at PiRpc spawn) + best-effort immediate push to the live
/// session when one exists. Capability-gated on the adapter's declared
/// `thinking_levels()`.
#[tauri::command]
pub async fn set_agent_thinking_level(
    app: AppHandle,
    session_id: Option<String>,
    agent_id: String,
    level: String,
) -> Result<(), String> {
    // 防御层：UI 已按 capability 隐藏入口，此处再校验声明，避免绕过。
    let app_state = app.state::<Mutex<crate::AppState>>();
    let supported = {
        let s = app_state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        s.registry
            .require_agent(&agent_id)?
            .thinking_levels()
            .contains(&level)
    };
    if !supported {
        return Err(format!(
            "Thinking level '{level}' is not supported by this agent"
        ));
    }

    // 1) Hub 侧持久化（spawn 时应用，Pi 也会把它持久化为默认级别）。
    crate::hub::save_agent_thinking_level(&agent_id, &level)?;

    // 2) 活跃会话即时下发（无活跃进程时仅持久化，下条消息 spawn 生效）。
    if let Some(session_id) = session_id {
        let acp = {
            let chat_state = app.state::<Mutex<ChatState>>();
            let state = chat_state
                .lock()
                .map_err(|_| "Chat state lock poisoned".to_string())?;
            state
                .processes
                .get(&session_id)
                .and_then(|process| process.acp.clone())
        };
        if let Some(acp) = acp {
            acp.set_thinking_level(level).await?;
        }
    }
    Ok(())
}

/// Look up an agent's live AcpControls (v0.7.4 需求1 A3 helper): every
/// session process owned by the agent.
pub(crate) fn live_acp_controls_for_agent(
    app: &AppHandle,
    agent_id: &str,
) -> Vec<crate::acp_runtime::AcpControl> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let state = match chat_state.lock() {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    state
        .processes
        .values()
        .filter(|process| process.agent_id == agent_id)
        .filter_map(|process| process.acp.clone())
        .collect()
}

fn agent_supports_compact(app: &AppHandle, agent_id: &str) -> Result<bool, String> {
    let app_state = app.state::<Mutex<crate::AppState>>();
    let s = app_state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry
        .require_agent(agent_id)?
        .capabilities()
        .contains(crate::agent::AgentCapabilities::CONTEXT_COMPACT))
}

/// Manually compact the session context (v0.7.4 需求1 A3). Capability-gated
/// (CONTEXT_COMPACT); resolves when compaction finishes.
#[tauri::command]
pub async fn compact_agent_session(
    app: AppHandle,
    session_id: String,
    instructions: Option<String>,
) -> Result<serde_json::Value, String> {
    let (acp, agent_id) = {
        let chat_state = app.state::<Mutex<ChatState>>();
        let state = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        let process = state
            .processes
            .get(&session_id)
            .ok_or_else(|| format!("No active ACP session found for {session_id}"))?;
        (
            process
                .acp
                .clone()
                .ok_or_else(|| format!("No active ACP session found for {session_id}"))?,
            process.agent_id.clone(),
        )
    };
    if !agent_supports_compact(&app, &agent_id)? {
        return Err("Context compaction is not supported by this agent".to_string());
    }
    acp.compact(instructions).await
}

/// Fork the live session at its current end (v0.8.0 需求1 A5). The Pi RPC
/// runtime clones the session tree and rebinds its process to the branch;
/// afterwards the process map is re-keyed to the branch id so the next
/// message flows to the forked session. The original session file/entry is
/// untouched and respawns on demand when reopened.
///
/// 历史会话（无活跃进程：本运行期未发过消息、或闲置 >10 分钟被回收）会
/// **静默拉起一个仅 resume 的进程**（`--session-id` 恢复、不发首条消息，
/// 零历史污染）再 clone——用户点「创建分支」直接成功，无需先发消息。
#[tauri::command]
pub async fn fork_agent_session(
    app: AppHandle,
    agent_id: String,
    project_path: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    {
        let app_state = app.state::<Mutex<crate::AppState>>();
        let s = app_state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        if !s
            .registry
            .require_agent(&agent_id)?
            .capabilities()
            .contains(crate::agent::AgentCapabilities::SESSION_FORK)
        {
            return Err("Session fork is not supported by this agent".to_string());
        }
    }

    let (acp, process) = match existing_chat_process(&app, &session_id, &agent_id) {
        Some(process) => (
            process
                .acp
                .clone()
                .ok_or_else(|| "This session has no forkable runtime".to_string())?,
            process,
        ),
        None => spawn_resume_fork_process(&app, &agent_id, &project_path, &session_id).await?,
    };

    let result = tokio::time::timeout(std::time::Duration::from_secs(45), acp.fork_session())
        .await
        .map_err(|_| {
            "Fork timed out — the agent took too long to clone the session".to_string()
        })??;
    let Some(new_session_id) = result
        .get("new_session_id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return Err("Fork finished but the branch session id is missing".to_string());
    };
    // 进程已重绑到分支会话：按 pid 清掉旧键（含 pending 别名/resume 拉起的键），
    // 以分支 id 重新挂载。原会话不再持有进程，重新打开时按需 spawn（既有机制）。
    {
        let chat_state = app.state::<Mutex<ChatState>>();
        let mut state = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        state
            .processes
            .retain(|_, item| item.process_id != process.process_id);
        state.processes.insert(new_session_id.clone(), process);
    }
    log::info!(
        "fork_agent_session: session {session_id} forked; process re-keyed to {new_session_id}"
    );
    Ok(result)
}

fn existing_chat_process(app: &AppHandle, session_id: &str, agent_id: &str) -> Option<ChatProcess> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let state = chat_state.lock().ok()?;
    let process = state.processes.get(session_id)?;
    (process.agent_id == agent_id).then(|| process.clone())
}

/// 历史会话 fork 的静默 resume：拉起一个仅恢复会话、不发首条消息的 PiRpc
/// 进程（start_gui_piresume_session，first_message=None），注册进进程表并
/// 等待会话解析完成后返回。clone 由调用方经 AcpControl 发起。
async fn spawn_resume_fork_process(
    app: &AppHandle,
    agent_id: &str,
    project_path: &str,
    session_id: &str,
) -> Result<(crate::acp_runtime::AcpControl, ChatProcess), String> {
    let prepared = {
        let app_state = app.state::<Mutex<crate::AppState>>();
        let s = app_state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        agent_runtime::prepare_gui_turn(
            &s.registry,
            AgentTurnRequest {
                agent_id: agent_id.to_string(),
                project_path: project_path.to_string(),
                session_id: Some(session_id.to_string()),
                message: String::new(),
                timeout_secs: 0,
            },
        )?
    };

    // 进程退出（含闲置回收）时清理进程表；会话解析别名注册与 send_message
    // 同款（resume 场景 real id 通常等于请求 id，别名分支自然跳过）。
    let cleanup_pid = Arc::new(Mutex::new(None::<u32>));
    let cleanup_pid_for_finish = cleanup_pid.clone();
    let app_for_finish = app.clone();
    let app_for_resolve = app.clone();
    let sid_for_resolve = session_id.to_string();
    let handle = agent_runtime::start_gui_piresume_session(
        app.clone(),
        prepared,
        move || {
            let pid = cleanup_pid_for_finish
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .to_owned();
            let _ = remove_process_entries(&app_for_finish, pid, None);
        },
        move |real_id: &str| {
            if real_id == sid_for_resolve {
                return;
            }
            let state = app_for_resolve.state::<Mutex<ChatState>>();
            if let Ok(mut s) = state.lock() {
                if let Some(process) = s.processes.get(&sid_for_resolve).cloned() {
                    s.processes.insert(real_id.to_string(), process);
                }
            };
        },
    )
    .await?;
    *cleanup_pid.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle.process_id);

    let acp = handle
        .acp
        .clone()
        .ok_or_else(|| "resume-fork spawn returned no runtime control".to_string())?;
    let process = ChatProcess {
        agent_id: agent_id.to_string(),
        process_id: handle.process_id,
        stdin: None,
        acp: Some(acp.clone()),
    };
    {
        let chat_state = app.state::<Mutex<ChatState>>();
        let mut state = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        state
            .processes
            .insert(session_id.to_string(), process.clone());
    }

    // 等待会话解析（resume attach 完成）再放行 clone——同时对齐 get_state
    // 的 30s 超时，进程启动即崩时不至于挂在 clone 上。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while acp.resolved_session_id().is_none() {
        if std::time::Instant::now() > deadline {
            return Err("Resuming the session for fork timed out".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok((acp, process))
}

/// v0.8.0 需求7：查询某会话是否有进行中的回合。GUI 的 agent-event 监听随
/// chat 页卸载而移除，卸载期间结束的回合其 turn_complete 永远无法送达前端
/// （streamStore 停在 isStreaming）。前端重挂载时以本命令对账：返回 false
/// 的流式会话丢弃本地流式状态并重读 JSONL。ACP/Pi/Codex 会话由连接循环维护
/// 的 turn_active 标志回答；CLI 会话（acp=None，进程即回合，回合结束进程即
/// 被 on_finish 移除）以「进程条目存在」等价判定。查无进程（含 fork 重键后
/// 的旧 id）视为不在进行中。
#[tauri::command]
pub fn chat_turn_active(app: AppHandle, session_id: String) -> bool {
    let chat_state = app.state::<Mutex<ChatState>>();
    let Ok(state) = chat_state.lock() else {
        return false;
    };
    match state.processes.get(&session_id) {
        Some(process) => match &process.acp {
            Some(acp) => acp.turn_active(),
            None => true,
        },
        None => false,
    }
}

/// v0.8.0 需求10：读取会话累计用量（SQLite 权威来源；无记录返回全零行）。
/// 记账在 Rust turn_end 侧完成（usage_store），前端只读展示。
#[tauri::command]
pub fn get_session_usage(session_id: String) -> Result<crate::usage_store::SessionUsageRow, String> {
    crate::usage_store::get(&session_id)
}

/// Read the agent's auto-compaction preference (v0.7.4 需求1 A3).
/// None = follow the agent's own default.
#[tauri::command]
pub fn get_agent_auto_compaction(agent_id: String) -> Option<bool> {
    crate::hub::load_agent_auto_compaction(&agent_id)
}

/// Set the agent's auto-compaction preference (v0.7.4 需求1 A3): persist in
/// Hub state + best-effort push to the agent's live sessions.
#[tauri::command]
pub async fn set_agent_auto_compaction(
    app: AppHandle,
    agent_id: String,
    enabled: bool,
) -> Result<(), String> {
    if !agent_supports_compact(&app, &agent_id)? {
        return Err("Context compaction is not supported by this agent".to_string());
    }
    crate::hub::save_agent_auto_compaction(&agent_id, enabled)?;
    for acp in live_acp_controls_for_agent(&app, &agent_id) {
        acp.set_auto_compaction(Some(enabled), None).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn resolve_chat_permission(
    app: AppHandle,
    session_id: String,
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let acp = {
        let state = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        state
            .processes
            .get(&session_id)
            .and_then(|process| process.acp.clone())
            .ok_or_else(|| format!("No active ACP session found for {session_id}"))?
    };

    if approved {
        // v0.8.0 需求2 Phase 2：用户批准入会话 Once 记忆——同会话同动作再次
        // 到达时策略链自动放行（payload 键形状无从重建，记录宽松形状：仅
        // kind+tool 缺省——Once 命中以「会话内批准过审批」为准）。
        crate::agent::policy::remember_for_session(
            &session_id,
            &crate::agent::policy::ApprovalContext {
                channel: crate::agent::policy::DecisionChannel::Interactive,
                kind: crate::agent::policy::ApprovalKindWire::Other,
                session_id: session_id.clone(),
                tool: None,
                payload: serde_json::Value::Null,
                payload_declares: false,
                high_risk: false,
            },
        );
    }
    acp.resolve_permission(request_id, approved).await
}

#[tauri::command]
pub async fn respond_chat_interaction(
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    session_id: String,
    request_id: String,
    value: String,
    interaction: Option<serde_json::Value>,
    // Origin/protocol channel of the interaction being answered. Optional for
    // backward compatibility with older frontends; defaults to the generic
    // text channel (which resolves to follow-up unless overridden by transport).
    origin: Option<crate::agent::normalized::InteractionOrigin>,
) -> Result<crate::agent::interaction::InteractionResponseDto, String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let (acp, agent_id, supports_interaction_mid_turn) = {
        let chat = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        let process = chat
            .processes
            .get(&session_id)
            .ok_or_else(|| format!("No active ACP session found for {session_id}"))?;
        (
            process.acp.clone(),
            process.agent_id.clone(),
            process
                .acp
                .as_ref()
                .map(|acp| acp.supports_interaction_mid_turn())
                .unwrap_or(false),
        )
    };

    // Resolve the process's transport from the registry (design R6: the
    // authoritative delivery decision is taken at answer time from the actual
    // transport capability, never assumed from the event hint alone).
    let transport = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        s.registry
            .get(&agent_id)
            .map(|agent| agent.resolve_transport())
            .unwrap_or(crate::agent::TransportSurface::Cli)
    };

    let origin = origin.unwrap_or_default();
    let persist_with_session_adapter = transport == crate::agent::TransportSurface::PiRpc;
    let delivery = crate::agent::interaction::delivery_for_runtime(
        transport,
        origin,
        supports_interaction_mid_turn,
    );

    let persist_answer = || -> Result<(), String> {
        if !persist_with_session_adapter {
            return Ok(());
        }
        let Some(interaction) = interaction.clone() else {
            return Ok(());
        };
        let app_state = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let agent = app_state
            .registry
            .get(&agent_id)
            .ok_or_else(|| format!("Agent adapter not found: {agent_id}"))?;
        agent.persist_interaction_blocks(None, Some(&session_id), None, vec![interaction])
    };

    match delivery {
        crate::agent::interaction::InteractionDelivery::MidTurn => {
            // Mid-turn write-back for transports with a live pause/resume
            // request (PiRpc extension UI, ACP elicitation, codex app-server
            // requestUserInput). `respond_to_input` is the shared write-back
            // entry point each runtime implements.
            if let Some(acp) = acp {
                acp.respond_to_input(request_id, value).await?;
            }
            if let Err(error) = persist_answer() {
                log::warn!(
                    "interaction answer delivered but immediate persistence failed for session {}: {}",
                    session_id,
                    error
                );
            }
            Ok(
                crate::agent::interaction::InteractionResponseDto::from_delivery(
                    crate::agent::interaction::InteractionDelivery::MidTurn,
                ),
            )
        }
        crate::agent::interaction::InteractionDelivery::FollowUp => {
            // This transport cannot answer mid-turn as a business question.
            // Report follow-up so the frontend sends the answer as a new user
            // message (the design's safety net).
            Ok(
                crate::agent::interaction::InteractionResponseDto::from_delivery(
                    crate::agent::interaction::InteractionDelivery::FollowUp,
                ),
            )
        }
    }
}
