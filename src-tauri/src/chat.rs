use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;

use crate::agent;
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
    /// 启动签名（agent_runtime::acp_turn_signature；空 = 未知，跳过漂移检测）。
    /// 长驻进程的 --model/--provider/通道 env 在 spawn 时固定，GUI 切换配置
    /// 只落盘不触达旧进程——发送时比对签名，漂移且回合空闲则回收重拉。
    pub spawn_signature: String,
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

/// v0.8.1 需求7：会话启用工具集非空时，把工具说明块作为后缀附加到 prompt。
/// ACP 存活会话早退路径与新回合路径共用（P0 修复：早退路径曾跳过注入，
/// 持久进程第二轮起注入块从未附加）。
/// M0：注入前先把暂存键（新会话输入框勾选）并入本会话键。
/// M6/P2-2：migrate/get 只操作 session-tools.json、不依赖 AppState——
/// 移到 state.lock() 之前，锁内只保留真正需要 s.tool_plugins 的渲染段。
/// v0.9.0 需求3 方案 C：前端不再嵌 [JISHU-TOOLS] 文本标记，净化步骤删除
/// （版本级裁决：手输字面标记亦不防御）；本条消息的工具快照由注入块
/// 随 prompt 持久化、回放经 extract_tool_snapshot 派生。
/// v0.9.5 重构：注入块（图片委派/工具/MCP 提示）统一后缀追加，标记对与
/// 剥离链单源于 agent::internal_prompts。
/** 图片委派提示（需求2→需求5 T9 识图路由）：消息含附件行「图片N（批次 …）
 *  : <路径>」且激活模型 input 不含 image → 注入识图路由话术（识图路由插件
 *  session.image-dispatch 可用 → 其配置生效；不可用 → 内置兜底话术）。
 *  话术按场景路由：简单识别优先 MCP 识图工具、复杂分析优先 subagent，
 *  互为兜底，双败如实告知用户。
 *  v0.9.5 重构：注入位置改**后缀**（追加在用户消息之后，用户裁决），默认
 *  话术经 internal_prompts 版本登记（PROMPT_IMAGE_DISPATCH）。 */
fn append_image_dispatch_hint(message: &str) -> String {
    let has_image_line = message
        .lines()
        .any(|l| l.contains("（批次") && l.contains("图片") && l.contains(':'));
    if !has_image_line {
        return message.to_string();
    }
    if active_model_supports_image() {
        return message.to_string();
    }
    let route = resolve_image_dispatch_route();
    format!(
        "{message}
{}{}{}",
        agent::internal_prompts::IMAGE_DISPATCH_OPEN,
        compose_image_dispatch_hint(&route),
        agent::internal_prompts::IMAGE_DISPATCH_CLOSE,
    )
}

/// T9：识图路由解析结果（话术合成输入）。
pub(crate) struct ImageDispatchRoute {
    /// 自定义话术（插件启用且用户配置非空时）。
    pub custom_prompt: Option<String>,
    /// 解析后的 mcp 识图工具全名（插件id__工具名；空 = 未指定且未声明）。
    pub mcp_tools: Vec<String>,
    /// subagent 识图模型（优先级列表首个可用；None = 无可见识图模型）。
    pub subagent_model: Option<String>,
}

/// 识图路由插件 id（内置组合插件，plugin.rs BUILTIN_COMPOSED_MANIFESTS）。
const IMAGE_DISPATCH_PLUGIN_ID: &str = "session.image-dispatch";

/// T9：路由解析——插件启停（禁用 = 内置兜底话术，自定义配置失效）、
/// 配置值（plugins-config.json）、mcp 工具解析（短名补全/声明自动发现）、
/// subagent 模型优先级校验（全不命中回落自动）。
fn resolve_image_dispatch_route() -> ImageDispatchRoute {
    let disabled = agent::plugin::load_plugin_config().disabled;
    let plugin_enabled = !disabled.iter().any(|d| d == IMAGE_DISPATCH_PLUGIN_ID);
    let config = if plugin_enabled {
        agent::plugin_options::load_all()
            .get(IMAGE_DISPATCH_PLUGIN_ID)
            .cloned()
            .unwrap_or_default()
    } else {
        Default::default()
    };
    let cfg_str = |key: &str| -> String {
        config
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let declared = collect_declared_vision_tools(&disabled);
    ImageDispatchRoute {
        custom_prompt: {
            let p = cfg_str("prompt");
            if p.is_empty() {
                None
            } else {
                Some(p)
            }
        },
        mcp_tools: resolve_mcp_vision_tools(&cfg_str("mcp_tools"), &declared),
        subagent_model: resolve_subagent_vision_model(&cfg_str("subagent_models")),
    }
}

/// 扫描已启用的 [mcp] 插件声明的识图工具（manifest vision_tools 字段，
/// 排除禁用插件），产出 (插件 id, 工具名列表)。仅作用户显式配置
/// 「mcp 识图工具」时的短名补全字典——不用于默认点名（用户裁决
/// 2026-09-30：默认发现交给 agent 经 hub_mcp_list 自选）。
fn collect_declared_vision_tools(disabled: &[String]) -> Vec<(String, Vec<String>)> {
    let (_agents, tools, _errors) = agent::manifest::load_manifests(&[]);
    tools
        .into_iter()
        .filter(|(file, _)| !disabled.contains(&file.info.id))
        .filter_map(|(file, _)| {
            let vision = file
                .mcp
                .as_ref()?
                .vision_tools
                .as_ref()?
                .iter()
                .filter(|t| !t.trim().is_empty())
                .map(|t| t.trim().to_string())
                .collect::<Vec<_>>();
            if vision.is_empty() {
                None
            } else {
                Some((file.info.id.clone(), vision))
            }
        })
        .collect()
}

/// T9 纯函数：mcp 识图工具解析——**配置为空 → 空集（不点名）**（用户裁决
/// 2026-09-30：识图工具不写死，声明自动点名 = 隐性绑定——其他用户未必用
/// 同一个识图插件；发现交给 agent 经 mcp 搜索 / hub_mcp_list 列表自选）。
/// 非空 → 逐项短名补全（在声明里按 `id__工具` 或工具名匹配；补不上保留
/// 原文交模型试）。declared 仅作显式配置的短名补全字典。
pub(crate) fn resolve_mcp_vision_tools(
    configured: &str,
    declared: &[(String, Vec<String>)],
) -> Vec<String> {
    let parse = |raw: &str| -> Vec<String> {
        raw.split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect()
    };
    if configured.is_empty() {
        return Vec::new();
    }
    parse(configured)
        .into_iter()
        .map(|entry| {
            if entry.contains("__") {
                return entry;
            }
            for (id, tools) in declared {
                if tools.contains(&entry) {
                    return format!("{id}__{entry}");
                }
            }
            entry
        })
        .collect()
}

/// T9 纯函数：subagent 识图模型解析——优先级列表逐项校验 models.json 取
/// 首个命中；空/全不命中回落自动（首个可见识图模型）。
fn resolve_subagent_vision_model(configured: &str) -> Option<String> {
    let candidates: Vec<String> = configured
        .split(',')
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .collect();
    for qualified in &candidates {
        if model_exists(qualified) {
            return Some(qualified.clone());
        }
    }
    first_visible_vision_model()
}

/// provider/model 在 models.json 中存在。
fn model_exists(qualified: &str) -> bool {
    let Some((provider_id, model_id)) = qualified.split_once('/') else {
        return false;
    };
    agent::jishu_self::pi_models_config::get_provider(provider_id)
        .ok()
        .flatten()
        .and_then(|p| p.models.map(|ms| ms.iter().any(|m| m.id == model_id)))
        .unwrap_or(false)
}

/// T9：话术合成——自定义话术（支持 {{mcp_tools}}/{{subagent_model}} 占位符）
/// 或内置默认（resources/prompts/image-dispatch.md 模板，场景路由 + 互为
/// 兜底 + 双败如实告知；模板占位符 {{mcp_clause}}/{{subagent_model_note}}
/// 在此填充）。
/// 生产入口：schema 查询走 mcp_server 的进程内缓存（短截止 + 降级）。
pub(crate) fn compose_image_dispatch_hint(route: &ImageDispatchRoute) -> String {
    compose_image_dispatch_hint_with(route, &agent::mcp_server::cached_tool_input_schema)
}

/// 话术合成（schema 查询器可注入——单测用假查询器，不 spawn 真实后端）。
/// v0.9.5 解析器能力对齐直连（用户裁决 2026-09-30）：点名工具给 **pi 可见
/// 名**（`jishu-hub_` 前缀——hub 规范名 pi 不识别，实测 Tool not found），
/// 并**内联参数 schema**——直连时模型在工具清单里即可见 schema，经解析器
/// 点名调用同样要给到，免去 describe 一跳与参数猜测；schema 查不到则降级
/// 为 describe 指引（模型自愈路径不变）。
pub(crate) fn compose_image_dispatch_hint_with(
    route: &ImageDispatchRoute,
    schema_of: &dyn Fn(&str) -> Option<serde_json::Value>,
) -> String {
    // 点名/占位符统一用 pi 可见名（模型可直接调用的名字）。
    let mcp_tools_text = if route.mcp_tools.is_empty() {
        "（未指定——请自行搜索选择识图工具）".to_string()
    } else {
        route
            .mcp_tools
            .iter()
            .map(|t| agent::mcp_server::pi_visible_tool_name(t))
            .collect::<Vec<_>>()
            .join(" / ")
    };
    let model_text = route.subagent_model.clone().unwrap_or_default();
    if let Some(custom) = &route.custom_prompt {
        return custom
            .replace("{{mcp_tools}}", &mcp_tools_text)
            .replace("{{subagent_model}}", &model_text);
    }
    // 默认（未配置工具）不点名任何具体 MCP 服务——识图工具的发现与选择
    // 交给模型自身（用户裁决 2026-09-27：具体工具因人而异，点名即绑定）；
    // 显式配置 mcp_tools 时才钉定直呼其名。
    let mcp_clause = if route.mcp_tools.is_empty() {
        "先自行发现识图工具——用 mcp 工具按关键词搜索（如 mcp 参数 {\"search\":\"image\"}）或调 hub_mcp_list 列出全部可用工具，从中挑一个能分析图片的（拿不准时用 describe 看其参数说明），确认后调用，把上方附件行「图片N（批次 …）」中的图片磁盘路径按其 schema 传入；若搜索后确实没有识图类工具，本条跳过、直接走第二条".to_string()
    } else {
        let mut clause = format!(
            "经 mcp 工具调用 {mcp_tools_text}，把上方附件行「图片N（批次 …）」中的图片磁盘路径传入"
        );
        let mut schemas = String::new();
        for tool in &route.mcp_tools {
            // 查询用 hub 规范名（插件id__工具）——缓存与声明按插件 id 索引。
            if let Some(schema) = schema_of(tool) {
                let params = render_schema_params(&schema);
                if !params.is_empty() {
                    schemas.push_str(&format!(
                        "\n{} 的参数：\n{}\n",
                        agent::mcp_server::pi_visible_tool_name(tool),
                        params
                    ));
                }
            }
        }
        if schemas.is_empty() {
            clause.push_str("；参数以 mcp describe 返回的 schema 为准");
        } else {
            clause.push_str("；参数如下（args 传参数对象的 JSON 字符串）：\n");
            clause.push_str(schemas.trim_end());
        }
        clause
    };
    let model_note = match &route.subagent_model {
        Some(m) => format!("，model 参数填 {m}（识图模型）"),
        None => String::new(),
    };
    agent::internal_prompts::PROMPT_IMAGE_DISPATCH
        .body()
        .replace("{{mcp_clause}}", &mcp_clause)
        .replace("{{subagent_model_note}}", &model_note)
}

/// inputSchema → 参数说明行（`- 名（类型，必填/可选）：说明`）。MCP 工具
/// 参数为第一层扁平对象；无 properties → 空串（调用方视为无 schema 降级）。
fn render_schema_params(schema: &serde_json::Value) -> String {
    let Some(props) = schema.get("properties").and_then(|v| v.as_object()) else {
        return String::new();
    };
    let required: Vec<&str> = schema
        .get("required")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    let mut lines = Vec::new();
    for (name, spec) in props {
        let ty = spec.get("type").and_then(|v| v.as_str()).unwrap_or("any");
        let req = if required.contains(&name.as_str()) {
            "必填"
        } else {
            "可选"
        };
        match spec.get("description").and_then(|v| v.as_str()) {
            Some(desc) if !desc.is_empty() => {
                lines.push(format!("- {name}（{ty}，{req}）：{desc}"));
            }
            _ => lines.push(format!("- {name}（{ty}，{req}）")),
        }
    }
    lines.join("\n")
}

/** 激活模型的图像输入能力（models.json 条目 input 含 "image"）。 */
fn active_model_supports_image() -> bool {
    let Ok(Some(active)) = crate::agent::jishu_self::jishu_settings::get_active() else {
        return false;
    };
    let Ok(Some(provider)) =
        crate::agent::jishu_self::pi_models_config::get_provider(&active.provider)
    else {
        return false;
    };
    provider
        .models
        .as_ref()
        .map(|models| {
            models
                .iter()
                .any(|m| m.id == active.model && m.input.iter().any(|i| i == "image"))
        })
        .unwrap_or(false)
}

/** 首个可见识图模型（provider/model，v0.9.5 需求5 复刻旧 jishu-subagent
 *  autoSelectVisionModel 语义）：models.json 顺序扫描 input 含 image 的
 *  模型，经渠道可见性（jishu-self）过滤；无可见项 → None（提示词退化为
 *  不指定模型，由模型自行决策）。 */
fn first_visible_vision_model() -> Option<String> {
    let config = crate::agent::jishu_self::pi_models_config::load().ok()?;
    let visible = crate::channel_models_store::visible_models_env_value("jishu-self")
        .map(|v| v.split(',').map(str::to_string).collect::<Vec<String>>());
    for (provider, pconf) in &config.providers {
        for model in pconf.models.iter().flatten() {
            if !model.input.iter().any(|i| i == "image") {
                continue;
            }
            let qualified = format!("{provider}/{}", model.id);
            let ok = match &visible {
                Some(list) => list.iter().any(|v| v == &qualified),
                None => true, // 无可见性记录 = 全可见（向后兼容）
            };
            if ok {
                return Some(qualified);
            }
        }
    }
    None
}

fn compose_tool_message(
    state: &tauri::State<'_, Mutex<AppState>>,
    session_id: &str,
    message: String,
) -> String {
    // v0.9.5 重构（用户裁决）：内部提示词一律**后缀**注入——用户消息在最前，
    // 图片委派块紧随其后（直指上方附件行），工具块 / MCP 提示殿后。历史格式
    // （v0.9.5 前的前缀/小写标记）不做剥离兼容（版本级裁决）。
    let message = append_image_dispatch_hint(&message);
    agent::tool_plugin::migrate_session_tools(agent::tool_plugin::STAGING_SESSION_KEY, session_id);
    let tool_ids = agent::tool_plugin::get_session_tools(session_id);
    let Ok(s) = state.lock() else {
        return message;
    };
    let tools = s.tool_plugins.lock().unwrap_or_else(|e| e.into_inner());
    if tool_ids.is_empty() {
        // v0.9.1 需求12：未勾选工具插件的会话也注入 MCP 解析服务提示——
        // 每个智能体每轮消息都能识别 jishu-hub 聚合服务并优先经它调用
        // MCP 工具（存在启用的 [mcp] 插件才有块；无则消息原样返回）。
        let refs: Vec<&agent::tool_plugin::ToolPlugin> = tools.iter().collect();
        let hint = agent::tool_plugin::render_hub_mcp_resolver_hint(&refs);
        if hint.is_empty() {
            return message;
        }
        return format!("{message}\n\n{hint}");
    }
    let matched: Vec<&agent::tool_plugin::ToolPlugin> = tools
        .iter()
        .filter(|t| tool_ids.iter().any(|id| id == t.id()))
        .collect();
    if matched.is_empty() {
        return message;
    }
    let block = agent::tool_plugin::render_tool_block(&matched);
    if block.trim().is_empty() {
        return message;
    }
    format!("{message}\n\n{block}")
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
    session_id: Option<String>,
    message: String,
    model_override: Option<(String, String)>,
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
        if let Some(process) = existing_chat_process(&app, sid, &agent_id) {
            // ── 启动签名漂移检测（临时需求：模型切换不生效修复）──
            // 长驻进程的 --provider/--model、通道 env 在 spawn 时固定；GUI 切换
            // 激活模型/通道只落配置文件，旧进程沿旧值调用（用户实测：FlashX 切
            // flash 后会话仍报 FlashX 无权限）。漂移且回合空闲 → 回收进程按当前
            // 配置重拉（resume 同一会话）；回合进行中不回收（steer 语义优先），
            // 下一空闲发送自愈。
            let drifted = if let Some(acp) = process.acp.as_ref() {
                !acp.turn_active()
                    && !process.spawn_signature.is_empty()
                    && current_spawn_signature(&state, &agent_id, &project_path, sid)
                        .is_some_and(|sig| sig != process.spawn_signature)
            } else {
                false
            };
            if drifted {
                let pid = process.process_id;
                log::info!(
                    "spawn signature drifted for session {sid} (model/channel config changed), recycling process {pid}"
                );
                if let Some(acp) = process.acp.as_ref() {
                    acp.shutdown().await;
                }
                remove_process_entries(&app, Some(pid), Some(sid))?;
            } else if let Some(acp) = process.acp.as_ref() {
                // 工具注入（35ee638a）：早退路径同样附加会话启用工具的说明块。
                let outgoing = compose_tool_message(&state, sid, message.clone());
                match acp.send_prompt(outgoing).await {
                    Ok(()) => {
                        return Ok(ChatSession {
                            agent_id,
                            session_id: sid.clone(),
                            process_id: process.process_id,
                        });
                    }
                    Err(_) => {
                        log::info!("ACP connection closed for session {}, respawning", sid);
                        remove_process_entries(&app, Some(process.process_id), Some(sid))?;
                    }
                }
            }
        }
    }

    let pending_session_id = session_id
        .clone()
        .unwrap_or_else(|| format!("pending-{}", uuid::Uuid::new_v4()));

    // 工具注入：会话启用集合非空 → 说明块前缀附加到 prompt（无头任务路径
    // 不注入——边界：工具插件是 GUI 会话能力）。
    let message = compose_tool_message(&state, &pending_session_id, message);

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
                model_override,
            },
        )?
    };

    let cleanup_pid = Arc::new(Mutex::new(None::<u32>));
    let cleanup_pid_for_finish = cleanup_pid.clone();
    let app_for_finish = app.clone();
    let sid_for_finish = pending_session_id.clone();

    let app_for_resolve = app.clone();
    let sid_for_resolve = pending_session_id.clone();

    let spawn_signature = agent_runtime::acp_turn_signature(&prepared).unwrap_or_default();
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
            // M0：会话工具集随 id 解析搬家（pending-<ts> → 真实 id），第二条
            // 消息起 compose 按真实键命中注入。
            agent::tool_plugin::migrate_session_tools(&sid_for_resolve, real_id);
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
            spawn_signature,
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

/// 按当前配置重建该会话的启动签名（纯构建，无副作用；与进程记录的
/// spawn_signature 比对判定配置漂移）。
fn current_spawn_signature(
    state: &tauri::State<'_, Mutex<crate::AppState>>,
    agent_id: &str,
    project_path: &str,
    session_id: &str,
) -> Option<String> {
    let s = state.lock().ok()?;
    let prepared = agent_runtime::prepare_gui_turn(
        &s.registry,
        AgentTurnRequest {
            agent_id: agent_id.to_string(),
            project_path: project_path.to_string(),
            session_id: Some(session_id.to_string()),
            message: String::new(),
            timeout_secs: 0,
            model_override: None,
        },
    )
    .ok()?;
    agent_runtime::acp_turn_signature(&prepared)
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
                model_override: None,
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
    let spawn_signature = agent_runtime::acp_turn_signature(&prepared).unwrap_or_default();
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
            // M0：会话工具集随 id 解析搬家（pending-<ts> → 真实 id），第二条
            // 消息起 compose 按真实键命中注入。
            agent::tool_plugin::migrate_session_tools(&sid_for_resolve, real_id);
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
        spawn_signature,
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
pub fn get_session_usage(
    session_id: String,
) -> Result<crate::usage_store::SessionUsageRow, String> {
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
    remember: Option<bool>,
) -> Result<(), String> {
    let (acp, _agent_id) = {
        let chat_state = app.state::<Mutex<ChatState>>();
        let state = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        let process = state
            .processes
            .get(&session_id)
            .ok_or_else(|| format!("No active ACP session found for {session_id}"))?;
        (process.acp.clone(), process.agent_id.clone())
    };

    // v0.8.0 需求2 Phase 2：「始终允许」按到达时登记的原始上下文回写 Once
    // 记忆（register_arrival_context / take_arrival_context）——action_key 含
    // tool/kind/payload 键，必须与链评估完全同形状，否则记忆永不命中（此前
    // 宽松兜底 tool=None 导致「始终允许」无效）。任何选择都取回（清理登记）。
    if let Some(arrival) = crate::agent::policy::take_arrival_context(&request_id) {
        if approved && remember == Some(true) {
            crate::agent::policy::remember_for_session(&arrival.session_id, &arrival);
        }
    }
    acp.ok_or_else(|| format!("No active ACP session found for {session_id}"))?
        .resolve_permission(request_id, approved)
        .await
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
            // v0.9.5 需求5 测试期 T1：PiRpc select 的「其他」纯文本应答在挂有
            // 哨兵时改写为哨兵原文回传（扩展协议要求选项原文），用户文本由
            // pi_rpc 侧在哨兵追问 input 到达时自动应答；持久化仍记用户原文。
            // T5：多选题还原卡的应答翻译（选中项 → "1,3" 序号串）优先——
            // 两登记集按 request_id 互斥（T1 键为 select id，T5 键为 input id）。
            let wire_value = if persist_with_session_adapter {
                let translated = crate::pi_rpc_runtime::rewrite_multiselect_response(
                    &request_id,
                    &value,
                    interaction.as_ref(),
                );
                if translated != value {
                    log::info!(
                        "[pi-ext] multi-select response translated to indices (session {session_id})"
                    );
                    translated
                } else {
                    crate::pi_rpc_runtime::rewrite_sentinel_response(
                        &request_id,
                        &session_id,
                        &value,
                        interaction.as_ref(),
                    )
                }
            } else {
                value.clone()
            };
            if let Some(acp) = acp {
                acp.respond_to_input(request_id, wire_value).await?;
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
