//! pi_rpc_runtime 子模块（v0.9.8 评审修复轮 R2 自连接循环纯移出，零逻辑
//! 变更；来源与拆分说明见主文件头 §12 处置说明）：审批型 confirm 的路由。

use super::*;

/// v0.8.0 需求1 P-2：审批型 confirm（jishu-tool-approval 扩展）先过策略链
/// （Phase 2 挂载点的 Pi 版）。标题格式 "[jishu-tool-approval]<mode>|<tool>"。
///
/// - Allow / Deny：直接 `extension_ui_response` 回写引擎，返回 `None`；
/// - Delegate：登记待审批表并返回标准 `ApprovalRequest`（调用方转给前端弹窗，
///   复用 resolve_chat_permission 回写路径）。
pub(crate) async fn route_tool_approval(
    stdin: &Arc<TokioMutex<ChildStdin>>,
    msg: &serde_json::Value,
    agent_id: &str,
    session_id: &str,
    pending_tool_approvals: &mut HashMap<String, PiToolApproval>,
) -> Option<NormalizedEvent> {
    let title = msg.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let request_id = msg
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let meta = title
        .strip_prefix("[jishu-tool-approval]")
        .unwrap_or("");
    let (_mode, tool) = meta.split_once('|').unwrap_or(("", meta));
    let message = msg
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    // 档位选链（v0.8.1 修复：完全访问模式仍弹审批窗）：
    // 权威档位是 hub 侧 per-agent 工具档（前端访问菜单写入
    // hub state，并联动同步 Pi settings），扩展标题里回传的
    // mode 只是参考显示——此前按标题 mode 二分
    // ask_always/其它，完全访问（full）落进智能链导致
    // 插件 bash 仍弹审批。统一走 for_session_tool_mode：
    // full→[AlwaysAllow]、full-approve/readonly→[LowRisk]、
    // smart-approve→[Once, LowRisk]。
    let hub_mode = crate::hub::load_agent_tool_mode(agent_id).unwrap_or_else(|| "full".to_string());
    let approval_ctx = crate::agent::policy::ApprovalContext {
        channel: crate::agent::policy::DecisionChannel::Interactive,
        kind: crate::agent::policy::ApprovalKindWire::Other,
        session_id: session_id.to_string(),
        tool: Some(tool.to_string()),
        payload: serde_json::json!({
            "tool": tool,
            "summary": message,
            "mode": hub_mode,
        }),
        payload_declares: false,
        high_risk: false,
    };
    let approval_chain = crate::agent::policy::for_session_tool_mode(agent_id, session_id);
    match approval_chain.evaluate(&approval_ctx) {
        crate::agent::policy::ChainOutcome::Allow(policy_id) => {
            let _ = send_pi_command(
                stdin,
                &json!({
                    "type": "extension_ui_response",
                    "id": request_id,
                    "confirmed": true
                }),
            )
            .await;
            log::info!(
                "Pi tool approval auto-allowed by policy {policy_id} (session {session_id})"
            );
            None
        }
        crate::agent::policy::ChainOutcome::Deny(policy_id) => {
            let _ = send_pi_command(
                stdin,
                &json!({
                    "type": "extension_ui_response",
                    "id": request_id,
                    "confirmed": false
                }),
            )
            .await;
            log::info!(
                "Pi tool approval auto-denied by policy {policy_id} (session {session_id})"
            );
            None
        }
        crate::agent::policy::ChainOutcome::Delegate => {
            // 登记待审批表（ResolvePermission 回写用）并
            // 转标准 ApprovalRequest 事件给前端弹窗；
            // 到达上下文按 request_id 登记——「始终允许」
            // 取回同形状回写 Once 记忆（见 chat.rs）。
            crate::agent::policy::register_arrival_context(&request_id, &approval_ctx);
            pending_tool_approvals.insert(request_id.clone(), PiToolApproval);
            Some(NormalizedEvent::ApprovalRequest {
                request_id,
                // 审批类型按工具名分类（bash→命令执行，
                // write/edit→文件写入），弹窗显示正确类型。
                approval_kind: crate::agent::normalized::ApprovalKind::for_tool(tool),
                payload: serde_json::json!({
                    "tool": tool,
                    "summary": message,
                    "mode": hub_mode,
                    "origin": "jishu-tool-approval",
                }),
            })
        }
    }
}
