//! 持续编排：向既有节点的子 agent 会话续发内容（v0.9.2 需求2 测试期，
//! 用户裁决的"主 agent 持续下发"机制）。
//!
//! 节点子会话由 PiRpc 持久保活并镜像进 ChatState（runtime_bridge 双键注册），
//! 因此任务执行中/完成后均可续发：空闲 → 新回合 prompt；回合进行中 → steer。

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
    /// prompt（新回合）或 steer（注入进行中的回合）。
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
    let mut found: Option<(String, String)> = None; // (session_id, run_id)
    for run in &runs {
        let sessions = store
            .list_node_sessions(&run.run_id)
            .map_err(|e| format!("list node sessions failed: {e}"))?;
        if let Some(summary) = sessions
            .iter()
            .find(|s| s.node_id == req.node_id && s.session_id.is_some())
        {
            found = Some((summary.session_id.clone().unwrap(), run.run_id.clone()));
            break;
        }
    }
    let (session_id, _run_id) =
        found.ok_or("该节点尚无已执行的子会话（新节点请经方案修订加入后执行）")?;

    // 经全局句柄取 ChatState 中的活连接（桥接路径无 AppHandle 入参）
    let app = crate::pi_rpc_runtime::HUB_APP_HANDLE
        .get()
        .ok_or("Hub 句柄未就绪")?;
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
            .ok_or_else(|| format!("节点会话不在线（{session_id}，可能已重启应用）"))?
    };

    let content = req.content;
    let steering = control.turn_active();
    // 投递异步化：桥接处理在 pi 连接循环内，不能阻塞等待异步发送。
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
