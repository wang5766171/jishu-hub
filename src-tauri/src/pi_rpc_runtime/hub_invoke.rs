//! pi_rpc_runtime 子模块（v0.9.5 三轮评审 C13 拆分：零逻辑变更纯移动，
//! 来源与拆分说明见主文件头 §12 处置说明）。

/// hub_invoke 桥接命令分发（Phase 2：Conductor 扩展 → Hub 后端）。
///
/// 扩展通过带保留标题前缀的 `extension_ui_request(method="select")` 发起同步调用，
/// Hub 直接执行后端函数并通过 extension_ui_response 返回结果，不经过前端。
/// 设计依据：`jishu-task-conductor_实施计划.md` Phase 2 任务 2.2。
/// v0.9.2 测试期：桥接路径（hub_invoke）可用的全局 AppHandle——conductor_revise_plan
/// 成功后向 webview 广播 task-instance-changed（前端据此重载任务图显示新节点）。
/// lib.rs setup 时注册；未注册（测试/无头）时静默跳过。
pub(crate) static HUB_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> =
    std::sync::OnceLock::new();

pub(crate) fn handle_hub_invoke(
    command: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match command {
        "conductor_sync_phase" => {
            let request: crate::task_launch::ConductorSyncPhaseRequest =
                serde_json::from_value(params.clone())
                    .map_err(|e| format!("conductor_sync_phase 参数解析失败: {e}"))?;
            let result = crate::task_launch::conductor_sync_phase(request)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        // v0.9.3 需求13 C4-slice2：/jishu-pipeline 扩展命令按插件 id 取
        // 展开后的阶段声明（模板展开在 Rust 侧，扩展保持薄）。
        "composed_plugin_pipeline" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("composed_plugin_pipeline 参数缺少 id")?;
            crate::agent::plugin::composed_pipeline_by_id(id)
        }
        "conductor_revise_plan" => {
            let request: crate::task_launch::RevisePlanRequest =
                serde_json::from_value(params.clone())
                    .map_err(|e| format!("conductor_revise_plan 参数解析失败: {e}"))?;
            let project_root = request.project_root.clone();
            let task_id = request.task_id.clone();
            let result = crate::task_launch::conductor_revise_plan(request)?;
            // 前端刷新信号：桥接路径无 AppHandle 入参，经全局句柄广播
            //（与 commands/task.rs 的 conductor_sync_phase 同一事件契约）。
            if let Some(app) = HUB_APP_HANDLE.get() {
                use tauri::Emitter;
                let _ = app.emit(
                    "task-instance-changed",
                    serde_json::json!({
                        "project_root": project_root,
                        "task_id": task_id,
                        "current_phase": "execution",
                    }),
                );
            }
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "conductor_dispatch_to_node" => {
            let request: crate::task_launch::DispatchToNodeRequest =
                serde_json::from_value(params.clone())
                    .map_err(|e| format!("conductor_dispatch_to_node 参数解析失败: {e}"))?;
            let result = crate::task_launch::conductor_dispatch_to_node(request)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "conductor_load_task_state" => {
            let project_root = params
                .get("project_root")
                .or_else(|| params.get("projectRoot"))
                .and_then(|v| v.as_str())
                .ok_or("conductor_load_task_state: project_root is required")?;
            let task_id = params
                .get("task_id")
                .or_else(|| params.get("taskId"))
                .and_then(|v| v.as_str())
                .ok_or("conductor_load_task_state: task_id is required")?;
            let result = crate::task_launch::conductor_load_task_state(project_root, task_id)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "orchestrator_validate_proposal" => {
            let request: crate::task_launch::ValidateProposalRequest =
                serde_json::from_value(params.clone())
                    .map_err(|e| format!("orchestrator_validate_proposal 参数解析失败: {e}"))?;
            let result = crate::task_launch::orchestrator_validate_proposal(request)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "orchestrator_start_run_from_revision" => {
            let request: crate::task_launch::StartRunFromRevisionRequest =
                serde_json::from_value(params.clone()).map_err(|e| {
                    format!("orchestrator_start_run_from_revision 参数解析失败: {e}")
                })?;
            let result = crate::task_launch::orchestrator_start_run_from_revision(request)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        // v0.9.2 测试期：preview_html 工具落点——校验文件后向前端广播预览事件
        //（会话插件 session.html-preview 的停靠面板接收渲染并自动展开）。
        // v0.9.3 测试期（前端项目预览）：新增 url 模式——agent 开发前端项目时
        // 先起 dev server（vite/webpack 等），预览应指向 http://localhost:端口
        // （外链 CSS/JS、HMR 均由 dev server 提供；单文件 srcDoc 预览必然丢样
        // 式——用户实测 agent 被迫内联资源）。仅放行本机回环地址。
        "plugin_preview_html" => {
            let session_id = params
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(url) = params
                .get("url")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                validate_loopback_preview_url(url)?;
                if let Some(app) = HUB_APP_HANDLE.get() {
                    use tauri::Emitter;
                    let _ = app.emit(
                        "session-plugin-preview",
                        serde_json::json!({
                            "url": url,
                            "session_id": session_id,
                        }),
                    );
                } else {
                    return Err("Hub 界面未就绪，无法打开预览".to_string());
                }
                return serde_json::to_value(serde_json::json!({ "opened": true, "url": url }))
                    .map_err(|e| e.to_string());
            }
            let file = params
                .get("file")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .ok_or("plugin_preview_html: file is required")?;
            let path = std::path::PathBuf::from(file);
            if !path.is_file() {
                return Err(format!("文件不存在: {file}"));
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            if !matches!(ext.as_deref(), Some("html") | Some("htm")) {
                return Err("仅支持 .html / .htm 文件".to_string());
            }
            let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if size > 2 * 1024 * 1024 {
                return Err(format!("文件 {size} 字节超过 2MB 预览上限"));
            }
            // Windows canonicalize() 产出 \\?\C:\... verbatim 前缀，会被
            // read_text_file 的 validate_path 当 UNC 路径拒绝（用户实测
            // 「UNC paths are not allowed」）——剥前缀还原普通盘符路径。
            let canonical = {
                let s = path
                    .canonicalize()
                    .unwrap_or(path)
                    .to_string_lossy()
                    .into_owned();
                let stripped = s
                    .strip_prefix(r"\\?\UNC\")
                    .map(|rest| format!(r"\\{rest}"))
                    .or_else(|| s.strip_prefix(r"\\?\").map(|rest| rest.to_string()))
                    .unwrap_or(s);
                stripped
            };
            if let Some(app) = HUB_APP_HANDLE.get() {
                use tauri::Emitter;
                let _ = app.emit(
                    "session-plugin-preview",
                    serde_json::json!({
                        "file": canonical,
                        "session_id": session_id,
                    }),
                );
            } else {
                return Err("Hub 界面未就绪，无法打开预览".to_string());
            }
            serde_json::to_value(serde_json::json!({ "opened": true, "file": canonical }))
                .map_err(|e| e.to_string())
        }
        // v0.9.5 需求1（原需求26）6b——方向四：agent 经 plugin-invoke 扩展
        // 触发插件动作。闸门：agent-tools.json 物化清单存在该工具（= 插件
        // 启用且声明过 [[agent-tool]]）；执行：向 webview 广播事件（前端
        // 动作链消费），同步返回受理结果（UI 类动作异步执行——工具返回
        // "已触发"语义，与 preview_html 的受理模式同构）。
        "plugin_invoke" => {
            let tool = params
                .get("tool")
                .and_then(|v| v.as_str())
                .ok_or("plugin_invoke 参数缺少 tool")?;
            let args = params
                .get("args")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let tools = crate::agent::plugin::load_agent_tools();
            let entry = tools
                .iter()
                .find(|e| e.name == tool)
                .ok_or(format!("agent-tool {tool:?} 不存在或插件已停用"))?;
            // 三轮评审 B1（能力诚实）：无 UI 宿主（无头/编排器会话）时明确报错
            // 而非假报成功——与 plugin_preview_html 同款「Hub 界面未就绪」语义，
            // agent 拿到真实失败可如实告知用户。
            let app = HUB_APP_HANDLE
                .get()
                .ok_or("Hub 界面未就绪，无法触发插件动作（无 UI 宿主）")?;
            use tauri::Emitter;
            let _ = app.emit(
                "plugin-tool-invoke",
                serde_json::json!({
                    "pluginId": entry.plugin_id,
                    "tool": entry.name,
                    "args": args,
                }),
            );
            Ok(serde_json::json!({
                "triggered": true,
                "pluginId": entry.plugin_id,
                "tool": entry.name,
            }))
        }
        _ => Err(format!("未知 hub_invoke 命令: {command}")),
    }
}

/// 预览 url 校验：仅放行 http/https 的本机回环地址（localhost / 127.0.0.1 /
/// [::1]）。dev server 预览的安全边界——外网/内网地址一律拒绝（防把 Hub
/// 面板当任意站点浏览器用）。
fn validate_loopback_preview_url(url: &str) -> Result<(), String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or("预览地址需为 http/https URL（dev server 地址，如 http://localhost:5173）")?;
    if scheme != "http" && scheme != "https" {
        return Err("预览地址仅支持 http/https（dev server 地址）".to_string());
    }
    // authority = 端口前的主机部分（截掉路径/查询/锚点；剥 userinfo）。
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = if authority.starts_with('[') {
        authority
            .split(']')
            .next()
            .unwrap_or("")
            .trim_start_matches('[') // IPv6 字面量 [::1]
    } else {
        authority.split(':').next().unwrap_or("")
    };
    match host {
        "localhost" | "127.0.0.1" | "::1" => Ok(()),
        other => Err(format!(
            "仅支持本机回环地址预览（localhost/127.0.0.1），收到: {other}"
        )),
    }
}
