//! 持续编排：向既有节点的子 agent 会话续发内容（v0.9.2 需求2 测试期）。
//!
//! 三条路径（按优先级）：
//! 1. 会话在线 + 回合进行中 → steer 注入
//! 2. 会话在线 + 空闲 → 新回合 prompt
//! 3. 会话离线（应用重启后进程消亡）→ **按需重建**：经 send_message 标准
//!    通道以原 session_id resume + 本次内容作为首条 prompt，事件镜像与
//!    ChatState 注册由标准路径处理，无需手工拼装。

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchToNodeRequest {
    pub task_id: String,
    pub project_root: String,
    pub node_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DispatchToNodeResult {
    pub success: bool,
    pub session_id: Option<String>,
    /// prompt（新回合）/ steer（注入进行中的回合）/ rebuild（重建会话后下发）。
    pub delivered_as: Option<&'static str>,
    pub error: Option<String>,
}

pub fn conductor_dispatch_to_node(
    req: DispatchToNodeRequest,
) -> Result<DispatchToNodeResult, String> {
    use crate::orchestrator::{default_db_path, TaskStore};

    let instance =
        proposal::ti_instance(&req.project_root, &req.task_id)?.ok_or("task instance not found")?;
    let graph_id = instance.graph_id.clone().ok_or("task has no graph")?;

    // 从新到旧遍历该图的 runs，找该节点最近一次带 session 的 attempt
    let store = TaskStore::open(&default_db_path())
        .map_err(|e| format!("open orchestrator store failed: {e}"))?;
    let runs = store
        .list_runs(&graph_id)
        .map_err(|e| format!("list runs failed: {e}"))?;
    let mut found: Option<(String, String, Option<String>)> = None; // (session_id, run_id, agent_id)
    for run in &runs {
        let sessions = store
            .list_node_sessions(&run.run_id)
            .map_err(|e| format!("list node sessions failed: {e}"))?;
        if let Some(summary) = sessions
            .iter()
            .find(|s| s.node_id == req.node_id && s.session_id.is_some())
        {
            found = Some((
                summary.session_id.clone().unwrap(),
                run.run_id.clone(),
                summary.agent_id.clone(),
            ));
            break;
        }
    }
    let (session_id, _run_id, agent_id) = found
        .ok_or("该节点尚无已执行的子会话（新节点请经方案修订加入后执行）")?;

    // 经全局句柄取 ChatState 中的活连接
    let app = crate::pi_rpc_runtime::HUB_APP_HANDLE
        .get()
        .ok_or("Hub 句柄未就绪")?
        .clone();
    use tauri::Manager;
    let control = {
        let chat_state = app.state::<std::sync::Mutex<crate::chat::ChatState>>();
        let chat_state = chat_state
            .lock()
            .map_err(|e| format!("chat state lock failed: {e}"))?;
        chat_state
            .processes
            .get(&session_id)
            .and_then(|p| p.acp.clone())
        // None 不再是错误——走重建路径
    };

    match control {
        Some(control) => {
            // 路径 1/2：会话在线
            let content = req.content;
            let steering = control.turn_active();
            tauri::async_runtime::spawn(async move {
                if steering {
                    let _ = control.steer(content).await;
                } else {
                    let _ = control.send_prompt(content).await;
                }
            });
            Ok(DispatchToNodeResult {
                success: true,
                session_id: Some(session_id),
                delivered_as: Some(if steering { "steer" } else { "prompt" }),
                error: None,
            })
        }
        None => {
            // 路径 3：按需重建——经 send_message 标准通道以原 session_id resume。
            // send_message 内部处理：spawn 进程 + --session-id resume + 首条
            // prompt + 事件镜像 + ChatState 注册 + 工具注入，与 GUI 手动发
            // 消息完全同一管道。project_path 取任务图的项目根（节点原始
            // 派发时的工作目录）。
            let graph = store
                .get_graph(&graph_id)
                .map_err(|e| format!("get graph failed: {e}"))?;
            let project_path = graph.project_root.to_string_lossy().into_owned();
            let agent = agent_id.unwrap_or_else(|| crate::agent::JISHU_SELF_AGENT_ID.to_string());
            let content = req.content;
            let sid = session_id.clone();

            tauri::async_runtime::spawn(async move {
                let state = app.state::<std::sync::Mutex<crate::AppState>>();
                match crate::chat::send_message(
                    app.clone(),
                    state,
                    agent,
                    project_path,
                    Some(sid),
                    content,
                )
                .await
                {
                    Ok(_) => log::info!("[dispatch] node session rebuilt and content dispatched"),
                    Err(e) => log::warn!("[dispatch] node session rebuild failed: {e}"),
                }
            });

            Ok(DispatchToNodeResult {
                success: true,
                session_id: Some(session_id),
                delivered_as: Some("rebuild"),
                error: None,
            })
        }
    }
}
