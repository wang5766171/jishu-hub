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
    /// 任务模式下这次发送登记的任务实例（评审修复轮 R3 / P1-1：登记先于首条
    /// prompt）。此刻它挂的会话键是发送用的临时键，会话解析后由后端换成真实
    /// 会话号。非任务模式没有这一项。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_instance: Option<crate::task_launch::TaskLaunchInstance>,
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
    /// v0.9.6 需求4：所属项目编码（encode_project_path；标题栏项目标签据此
    /// 归属——chat_active_sessions 返回给前端）。orchestrator 镜像条目无
    /// 项目上下文，填空串。
    pub project_encoded: String,
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
/// 名**（hub 规范名 pi 不识别，实测 Tool not found），并**内联参数 schema**
///——直连时模型在工具清单里即可见 schema，经解析器点名调用同样要给到，
/// 免去 describe 一跳与参数猜测；schema 查不到则降级为 list 指引（模型
/// 自愈路径不变）。
/// v0.9.5 需求11（pi 1.1.0）：adapter 退役切 pi 原生 MCP——可见名规律
/// `mcp__jishu_hub__插件id__工具`（与其余三家一致），话术中的发现/调用
/// 指引同步改为原生方式（hub_mcp_list 直调，无 mcp 代理工具/describe）。
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
        "先自行发现识图工具——调 hub_mcp_list（mcp__jishu_hub__hub_mcp_list）实时列出全部可用工具与参数说明，从中挑一个能分析图片的，把上方附件行「图片N（批次 …）」中的图片磁盘路径按其参数说明传入；若确实没有识图类工具，本条跳过、直接走第二条".to_string()
    } else {
        let mut clause = format!(
            "调用工具 {mcp_tools_text}，把上方附件行「图片N（批次 …）」中的图片磁盘路径传入"
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
            clause.push_str("；参数以 hub_mcp_list 返回的参数说明为准");
        } else {
            clause.push_str("；参数如下（按各参数说明直接传入）：\n");
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
    project_path: &str,
    message: String,
) -> String {
    // v0.9.5 重构（用户裁决）：内部提示词一律**后缀**注入——用户消息在最前，
    // 图片委派块紧随其后（直指上方附件行），工具块 / MCP 提示殿后。历史格式
    // （v0.9.5 前的前缀/小写标记）不做剥离兼容（版本级裁决）。
    let message = append_image_dispatch_hint(&message);
    // v0.9.8 评审修复轮 R2：此处原有「新会话暂存键 → 本条会话」的工具集迁移，
    // 已删——评审修复轮 R1-5 起「本条消息带哪些工具」由发送入口按消息文本
    // 解析并写入本条会话键（见 commands::agents::apply_turn_tool_set），前端
    // 不再往暂存键 `__new_session__` 写任何东西，那次迁移永远迁不到内容。
    let tool_ids = agent::tool_plugin::get_session_tools(session_id);
    let Ok(s) = state.lock() else {
        return message;
    };
    let tools = s.tool_plugins.lock().unwrap_or_else(|e| e.into_inner());
    // v0.9.8 需求5（合并版）：装备目录注入（L2 信息供给）——总开关+会话卡
    // 链路双开才注入；目录=可装未装件（agent 看任务对照货架的唯一通道）。
    let equip_block = {
        let cfg = crate::hub::equip_recommend_config();
        if !(cfg.enabled && cfg.session_card) {
            String::new()
        } else {
            // 已装判定对齐 plugin_list 真源：registry（组合件/内置 TS 件等
            // 全量）∪ tool_plugins（TOML 工具件）——此前只传 tool_plugins，
            // agent 目录里 session.* 组合件全被误标「未装」（用户实测暴露）。
            let mut installed_curated: Vec<String> =
                s.registry.list_plugins().iter().map(|p| p.id.clone()).collect();
            for t in tools.iter() {
                installed_curated.push(t.id().to_string());
            }
            // 技能台账读不出来 = 已装态不明：不给推荐清单（会把已装的又推荐
            // 一遍），照常发消息（评审修复轮 R3，与「已装清单读不到时推荐区
            // 不出」同一个口径）。
            let installed_skillhub: Vec<String> = match agent::skillhub::skillhub_installed() {
                Ok(installed) => installed.keys().cloned().collect(),
                Err(e) => {
                    log::warn!("[equip-recommend] 技能安装台账读不出来，这一条不带推荐清单: {e}");
                    return String::new();
                }
            };
            let ws_scene =
                agent::workspace_scene::detect_workspace_scene(std::path::Path::new(project_path))
                    .map(|r| r.scene);
            agent::equipment_db::catalog_block(
                &installed_curated,
                &installed_skillhub,
                cfg.third_party,
                ws_scene.as_deref(),
            )
        }
    };
    let mut out = message;
    if tool_ids.is_empty() {
        // v0.9.1 需求12：未勾选工具插件的会话也注入 MCP 解析服务提示——
        // 每个智能体每轮消息都能识别 jishu-hub 聚合服务并优先经它调用
        // MCP 工具（存在启用的 [mcp] 插件才有块；无则消息原样返回）。
        let refs: Vec<&agent::tool_plugin::ToolPlugin> = tools.iter().collect();
        let hint = agent::tool_plugin::render_hub_mcp_resolver_hint(&refs);
        if !hint.is_empty() {
            out = format!("{out}\n\n{hint}");
        }
    } else {
        let matched: Vec<&agent::tool_plugin::ToolPlugin> = tools
            .iter()
            .filter(|t| tool_ids.iter().any(|id| id == t.id()))
            .collect();
        if !matched.is_empty() {
            let block = agent::tool_plugin::render_tool_block(&matched);
            if !block.trim().is_empty() {
                out = format!("{out}\n\n{block}");
            }
        }
    }
    if !equip_block.is_empty() {
        out = format!("{out}\n\n{equip_block}");
    }
    out
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
    // 本条消息的工具集（v0.9.8 评审修复轮 R1-5）。None = 按消息文本里的
    // `@[名]` 引用解析（所有出口的默认）；编辑重发显式传入（文本之外还
    // 带着「编辑态保留的工具」这一意图）。
    tool_ids: Option<Vec<String>>,
    // 任务模式的发送意图（v0.9.8 评审修复轮 R3 / P1-1）：有它，后端在拉起进程
    // 之前就把任务实例建好并挂在本次发送的会话键上，会话解析后换成真实会话号
    // ——登记先于首条 prompt，引擎首轮来查「是不是任务会话」就查得到。
    task_launch: Option<crate::task_launch::TaskLaunchIntent>,
) -> Result<ChatSession, String> {
    // v0.9.7 需求5 E2：project_root 兜底换算（空 → 默认空间；正常路径不受影响）。
    let project_path = crate::project::resolve_project_root_or_default(&project_path);
    // v0.9.7 需求14：会话级模型注入——显式 override（节点/委派链）优先，其次
    // 会话锁定模型（新会话/transient 无记录回落全局 active）。
    let model_override = crate::session_models::resolve_override(
        &session_id.clone().unwrap_or_default(),
        model_override,
    );
    // v0.9.7 需求5 E5：恢复既有会话（真实 id 直传）→ 幂等确保会话子目录
    //（默认空间专属；非默认空间 no-op）。
    if let Some(ref sid) = session_id {
        if !crate::agent::command_config::is_transient_session_id(sid) {
            let _ =
                crate::project::ensure_session_workspace(std::path::Path::new(&project_path), sid);
        }
    }
    // v0.9.6 需求4：项目编码先缓存（project_path 随后 move 进 turn 请求，
    // 进程表条目需要它做项目归属）。
    let spawn_project_encoded = crate::project::encode_project_path(&project_path);
    log::info!(
        "send_message: agent={}, project={}, session={:?}, message_len={}",
        agent_id,
        project_path,
        session_id,
        message.len()
    );

    // v0.7.0 需求一：agent_id 由前端按会话作用域传入，不再从全局 active 读取。
    // 校验 agent_id 合法性（require_agent 返回错误时提前失败）。
    // v0.9.8 评审修复轮 R1-2：丢消息保护按**能力位**生效，不按智能体名字
    // 分支（DEVELOP_READ §7）。PERSISTED_RECEIPT = 该通道会把用户消息落盘
    // 并回报落盘事实，hub 侧的防丢账因此可对账；ACP 通道无落盘回执，记账
    // 会永假「未送达」，故不声明、不记账。
    let tracks_delivery = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        s.registry
            .require_agent(&agent_id)?
            .capabilities()
            .contains(agent::AgentCapabilities::PERSISTED_RECEIPT)
    };

    // v0.9.8 需求2 D2-2 L1（账先行）：发送入口即记 pending 防丢账——prompt
    // 落地前（进程重拉/spawn 竞态）任何阶段挂死，重载后都有「未送达」徽标
    // +删除出口（复用 F2 既有机制，零新 UI）。
    // 评审修复轮 R1-1：记账得到这笔账的**身份**，随发送请求带到引擎侧；
    // prompt 真正写入引擎时按身份把入口账结算为落地账（见
    // pending_messages::confirm_entries）。销账见 pending_messages 模块说明
    //（评审修复轮 R2：按身份与顺序，不比文本）。
    // 同步 Err（进程表/路径等罕见失败）留账——「未送达」事实成立。
    let pending_entry = if tracks_delivery {
        session_id
            .as_ref()
            .and_then(|sid| crate::pending_messages::record(sid, &agent_id, &message))
    } else {
        None
    };
    let pending_entries: Vec<crate::pending_messages::PendingEntryRef> =
        pending_entry.into_iter().collect();

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
                    // v0.9.6 需求6 F4：shutdown 是 fire-and-forget——不等旧进程
                    // 收尾就重拉，新旧进程会短暂并发写同一会话 JSONL（旧进程
                    // flush 大文件/被 5s 超时强杀期间仍在写）。有限等待收尾
                    //（≤8s：child.wait 5s + 杀树余量）再重拉；超时不阻塞
                    //（F1 守卫保证旧 on_finish 不误删新条目，旧进程随后被强杀）。
                    let finished = tokio::time::timeout(
                        std::time::Duration::from_secs(8),
                        acp.wait_finished(),
                    )
                    .await
                    .is_ok();
                    log::info!(
                        "drift recycle: old process {pid} finished={finished}, proceeding to respawn"
                    );
                }
                remove_process_entries(&app, Some(pid), Some(sid))?;
            } else if let Some(acp) = process.acp.as_ref() {
                // 工具注入（35ee638a）：早退路径同样附加会话启用工具的说明块。
                // R1-5：先确定本条消息的工具集（所有出口同此一处）。
                crate::commands::agents::apply_turn_tool_set(
                    &state,
                    sid,
                    &message,
                    tool_ids.clone(),
                );
                let outgoing = compose_tool_message(&state, sid, &project_path, message.clone());
                // 任务模式：会话已经在，登记只需把任务挂到这个会话上（没有
                // 「解析出会话号」这一步，也就不需要改绑）。
                let (task_binding, task_instance) = match &task_launch {
                    Some(intent) => {
                        let (binding, instance) =
                            crate::task_launch::bind_task_session(&project_path, intent, sid)
                                .map_err(|e| format!("任务登记失败：{e}"))?;
                        crate::commands::task::emit_task_instance_changed(&app, &project_path);
                        (Some(binding), Some(instance))
                    }
                    None => (None, None),
                };
                match acp
                    .send_prompt(crate::acp_runtime::PromptPayload::composed(
                        outgoing,
                        message.clone(),
                        pending_entries.clone(),
                    ))
                    .await
                {
                    Ok(()) => {
                        return Ok(ChatSession {
                            agent_id,
                            session_id: sid.clone(),
                            process_id: process.process_id,
                            task_instance,
                        });
                    }
                    Err(_) => {
                        log::info!("ACP connection closed for session {}, respawning", sid);
                        // 这次没发出去、下面改走重新拉起（那里会再登记一次）：先
                        // 撤销这次的登记，不撤的话新任务会建出两份。
                        undo_task_binding(
                            &app,
                            &project_path,
                            crate::task_launch::TaskBindingSlot::new(task_binding, true).abandon(),
                            "这次发送没发出去",
                        );
                        remove_process_entries(&app, Some(process.process_id), Some(sid))?;
                    }
                }
            }
        }
    }

    let pending_session_id = session_id
        .clone()
        .unwrap_or_else(|| format!("pending-{}", uuid::Uuid::new_v4()));

    // 工具注入：会话启用集合非空 → 说明块后缀附加到 prompt（无头任务路径
    // 不注入——边界：工具插件是 GUI 会话能力）。
    // R1-5：先确定本条消息的工具集——「本条带哪些工具」由消息文本决定，
    // 在这个所有出口的必经点解析，自动发送/停止后重发等出口不再各发各的
    // 原文。
    crate::commands::agents::apply_turn_tool_set(&state, &pending_session_id, &message, tool_ids);
    // 用户原文随请求一起带走：组装后的文本是给模型看的，扩展命令要的是原文
    //（见 PromptPayload::user_text）。
    let user_text = message.clone();
    let message = compose_tool_message(&state, &pending_session_id, &project_path, message);

    // v0.9.7 需求5 E5：新会话真实 id 解析回调里确保会话子目录（project_path
    // 稍后 move 进 AgentTurnRequest，先克隆）。
    let project_path_for_resolve = project_path.clone();

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
                pending_entry,
                user_text: Some(user_text),
            },
        )?
    };

    // v0.9.8 评审修复轮 R3（P1-1）：任务模式下**登记先于首条 prompt**。此前任务
    // 实例由前端在 session_resolved 分片到达后才建，hub 这边发完 SessionResolved
    // 紧接着就把首条 prompt 写给引擎——引擎跑 before_agent_start 来查「是不是
    // 任务会话」时登记常常还没落库，首轮的任务锚点、任务纪律、不询问全部落空；
    // 实例不存在，发第一条之前开关也无处可记。现在：
    //   拉起之前  → 以发送用的临时会话键建实例（或把已有任务改绑过来）；
    //   解析回调  → 早于首条 prompt 写出，把会话键换成真实会话号；
    //   拉起失败 / 进程没解析出会话号就退出 → 撤销这次登记，不留没有会话的任务。
    // 登记做不成按发送失败处理——不带任务态硬发首条，比发不出去更糟。
    //
    // 这次登记的去向（改绑 / 撤销）由 TaskBindingSlot 管：只有发送键是临时键
    // （新会话，会话还没诞生）时，进程没解析出会话号才撤销；续接已有会话时
    // 会话早就存在，进程退出时不能撤——进程被空闲回收是常事。
    let (task_binding, task_instance) = match &task_launch {
        Some(intent) => {
            let (binding, instance) = crate::task_launch::bind_task_session(
                &project_path_for_resolve,
                intent,
                &pending_session_id,
            )
            .map_err(|e| format!("任务登记失败：{e}"))?;
            crate::commands::task::emit_task_instance_changed(&app, &project_path_for_resolve);
            (Some(binding), Some(instance))
        }
        None => (None, None),
    };
    let task_binding_slot = Arc::new(crate::task_launch::TaskBindingSlot::new(
        task_binding,
        crate::agent::command_config::is_transient_session_id(&pending_session_id),
    ));
    let task_binding_for_finish = task_binding_slot.clone();
    let task_binding_for_resolve = task_binding_slot.clone();
    let project_path_for_finish = project_path_for_resolve.clone();
    let project_path_for_rollback = project_path_for_resolve.clone();

    let cleanup_pid = Arc::new(Mutex::new(None::<u32>));
    let cleanup_pid_for_finish = cleanup_pid.clone();
    let app_for_finish = app.clone();
    let sid_for_finish = pending_session_id.clone();

    let app_for_resolve = app.clone();
    let sid_for_resolve = pending_session_id.clone();

    let spawn_signature = agent_runtime::acp_turn_signature(&prepared).unwrap_or_default();
    let handle = match agent_runtime::start_gui_turn(
        app.clone(),
        prepared,
        move || {
            let pid = cleanup_pid_for_finish
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .to_owned();
            let _ = remove_process_entries(&app_for_finish, pid, Some(&sid_for_finish));
            // 新会话的进程退出了却始终没解析出会话号：会话没有诞生，撤销这次
            // 任务登记（续接已有会话的发送不撤，见 TaskBindingSlot）。
            undo_task_binding(
                &app_for_finish,
                &project_path_for_finish,
                task_binding_for_finish.finished(),
                "新会话的进程没有解析出会话号",
            );
        },
        move |real_id: &str| {
            // v0.9.8 评审修复轮 R3（P1-1）：这个回调早于首条 prompt 写出，也早于
            // SessionResolved 事件——先把任务挂的会话键换成真实会话号，引擎首轮来
            // 查、前端收到事件来读时都已经按真实会话号登记。号没变（续接已有
            // 会话、引擎没给出号）时它什么都不动。
            match task_binding_for_resolve.resolved(real_id, &sid_for_resolve) {
                Ok(None) => {}
                Ok(Some(_)) => crate::commands::task::emit_task_instance_changed(
                    &app_for_resolve,
                    &project_path_for_resolve,
                ),
                Err(e) => {
                    log::warn!("任务改绑到真实会话号失败: {e}");
                    crate::commands::task::emit_task_instance_changed(
                        &app_for_resolve,
                        &project_path_for_resolve,
                    );
                }
            }
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
            // v0.9.6 需求6 F3：pending 消息记录同点迁移（首条消息以临时 id
            // 记录，ack/加载按真实 id 对账）。
            crate::pending_messages::rename_session(&sid_for_resolve, real_id);
            // v0.9.7 需求5 E5：默认空间会话子目录随真实 id 就位（幂等；
            // 上传/agent 产物的按会话分目录依赖它存在）。
            let _ = crate::project::ensure_session_workspace(
                std::path::Path::new(&project_path_for_resolve),
                real_id,
            );
        },
    )
    .await
    {
        Ok(handle) => handle,
        Err(e) => {
            // 拉起失败：没有会话会诞生，撤销这次任务登记。
            undo_task_binding(
                &app,
                &project_path_for_rollback,
                task_binding_slot.abandon(),
                "拉起失败",
            );
            return Err(e);
        }
    };

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
            project_encoded: spawn_project_encoded,
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
        task_instance,
    })
}

/// 撤销一次任务登记之后的通知（v0.9.8 评审修复轮 R3 / P1-1）：动过登记就广播
/// 一次，让任务列表与页面按 hub 的现状刷新。撤销失败也算动过——登记已经从
/// 待办里取走了，界面手里的快照不能再当真。
fn undo_task_binding(
    app: &tauri::AppHandle,
    project_path: &str,
    undone: Result<bool, String>,
    what: &str,
) {
    let touched = match undone {
        Ok(false) => false,
        Ok(true) => true,
        Err(e) => {
            log::warn!("任务登记撤销失败（{what}）: {e}");
            true
        }
    };
    if touched {
        crate::commands::task::emit_task_instance_changed(app, project_path);
    }
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
            // v0.9.7 需求14：签名基准含会话锁定模型——会话切模型后，空闲
            // 发送的漂移检测才能触发按新模型重拉进程。
            model_override: crate::session_models::get_session_model(session_id),
            pending_entry: None,
            user_text: None,
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
    remove_process_entries_from(&mut state, process_id, session_id);
    Ok(())
}

/// v0.9.6 需求6 F1：从进程表删除条目（纯函数，供单测）。
/// sid 删除带 pid 守卫——仅当该键当前条目确属本次 pid 才删：
/// 漂移回收 spawn 新进程后旧进程 on_finish 晚到（同键已是新条目），
/// 无条件按键删会误删新进程条目 → abort_chat 查无条目（卡死后停止无效）
/// 与 turn_active 失真。`process_id=None` 时维持旧语义（仅按 sid 删）。
pub(crate) fn remove_process_entries_from(
    state: &mut ChatState,
    process_id: Option<u32>,
    session_id: Option<&str>,
) {
    if let Some(pid) = process_id {
        state.processes.retain(|_, item| item.process_id != pid);
    }
    if let Some(sid) = session_id {
        if let Some(pid) = process_id {
            let owns_key = state
                .processes
                .get(sid)
                .is_some_and(|p| p.process_id == pid);
            if !owns_key {
                return;
            }
        }
        state.processes.remove(sid);
    }
}

/// v0.9.8 需求19-D：abort_chat 结果标记。`process_found=false`（进程表无
/// 此会话——pi 已死亡/连接循环已退出）时前端不等 turn_complete(Aborted)
/// 回执（永远等不到），本地直接收口（onAbort 提交后 drop 流）——修复
/// 「僵尸处理中 + 停止无效，仅重启恢复」。
#[derive(serde::Serialize)]
pub struct AbortChatOutcome {
    pub process_found: bool,
}

#[tauri::command]
pub async fn abort_chat(app: AppHandle, session_id: String) -> Result<AbortChatOutcome, String> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let process = {
        let s = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        let Some(process) = s.processes.get(&session_id).cloned() else {
            // 需求19-D：进程已死/未注册——如实告知前端（此前静默 Ok(())，
            // 前端误以为回执将至而永等）。
            log::warn!(
                "abort_chat: no live process for session {} (engine dead?) — frontend will settle locally",
                session_id
            );
            return Ok(AbortChatOutcome { process_found: false });
        };
        process
    };

    // ACP cancel path: send cancel only, keep connection alive.
    if let Some(acp) = &process.acp {
        acp.send_cancel().await;
        log::info!("cancelled ACP prompt in session {}", session_id);
        return Ok(AbortChatOutcome { process_found: true });
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
        return Ok(AbortChatOutcome { process_found: true });
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
            Ok(AbortChatOutcome { process_found: true })
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
            .ok_or_else(|| no_active_session_error())?
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
///
/// 返回口径（v0.9.8 需求7 补充轮）：成功 = 引擎的结果对象；被用户取消 =
/// `{"cancelled": true}`（正常返回，不是失败）；失败 = 错误消息。
///
/// v0.9.6 需求2：历史会话（无活跃进程：重启后/闲置回收后）不再报
/// "No active ACP session found"——先静默拉起仅 resume 的进程（与 fork
/// 同款兜底，「先连接会话再压缩」），连接完成后再压缩。
#[tauri::command]
pub async fn compact_agent_session(
    app: AppHandle,
    agent_id: String,
    project_path: String,
    session_id: String,
    instructions: Option<String>,
) -> Result<serde_json::Value, String> {
    // v0.9.7 需求5 E2：project_root 兜底换算（历史会话静默拉起时要用 cwd）。
    let project_path = crate::project::resolve_project_root_or_default(&project_path);
    let (acp, agent_id) = match existing_chat_process(&app, &session_id, &agent_id) {
        Some(process) => (
            process
                .acp
                .clone()
                .ok_or_else(|| no_active_session_error())?,
            process.agent_id.clone(),
        ),
        // 无进程（重启/闲置回收）→ 先连接：静默拉起仅 resume 的进程再压缩。
        None => {
            let (acp, process) =
                spawn_resume_session_process(&app, &agent_id, &project_path, &session_id).await?;
            (acp, process.agent_id.clone())
        }
    };
    if !agent_supports_compact(&app, &agent_id)? {
        return Err("Context compaction is not supported by this agent".to_string());
    }
    // v0.9.8 需求7 补充轮：不再设时限（v0.9.6 需求2 曾设 180 秒）。压缩何时
    // 结束的事实源头是智能体——它的 compact 响应只在成功、被取消或失败时
    // 到达。写死上限会让界面在引擎仍在压缩时报「压缩失败」并放开「压缩中」
    // 状态（实测 80 万 token 级上下文叠加服务端过载，压缩超过 3 分钟）。
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
    // v0.9.7 需求5 E2：project_root 兜底换算（历史会话静默拉起时要用 cwd）。
    let project_path = crate::project::resolve_project_root_or_default(&project_path);
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
        None => spawn_resume_session_process(&app, &agent_id, &project_path, &session_id).await?,
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

/// 历史会话的静默 resume：拉起一个仅恢复会话、不发首条消息的 PiRpc
/// 进程（start_gui_piresume_session，first_message=None），注册进进程表并
/// 等待会话解析完成后返回。v0.9.6 需求2：由 fork 专属泛化为 fork/compact
/// 共用（「先连接会话再压缩」的连接段）；clone/compact 由调用方经
/// AcpControl 发起。
async fn spawn_resume_session_process(
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
                pending_entry: None,
                user_text: None,
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
            // v0.9.6 需求6 F3：pending 消息记录同点迁移（首条消息以临时 id
            // 记录，ack/加载按真实 id 对账）。
            crate::pending_messages::rename_session(&sid_for_resolve, real_id);
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
        project_encoded: crate::project::encode_project_path(project_path),
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

/// v0.9.6 需求4：全局活跃回合会话清单（标题栏项目标签的数据源）。
/// 遍历进程表返回 turn_active 的条目（含项目归属编码）；turn_active 判据
/// 与 chat_turn_active 同源（ACP/Pi/Codex 连接循环标志；CLI 无 acp 的
/// 条目以「进程存在」等价——回合结束即被 on_finish 移除）。编排器镜像
/// 条目（project_encoded 空）跳过——无项目归属，不参与标签聚合。
#[tauri::command]
pub fn chat_active_sessions(app: AppHandle) -> Vec<ActiveChatSession> {
    let chat_state = app.state::<Mutex<ChatState>>();
    let Ok(state) = chat_state.lock() else {
        return Vec::new();
    };
    state
        .processes
        .iter()
        .filter(|(_, process)| !process.project_encoded.is_empty())
        .filter(|(_, process)| match &process.acp {
            Some(acp) => acp.turn_active(),
            None => true,
        })
        .map(|(session_id, process)| ActiveChatSession {
            // v0.9.6 需求4 补充②：优先真实会话 id（resolve 后）——复用连接的第二
            // 回合不发 session_resolved，进程表只有 pending-* 键，而前端
            // turn-complete 信号带真实 id：两侧不一致会让状态灯反查失败
            //（R3 实测教训）。pending/真实双键条目归并为同一真实 id，前端
            // 按项目聚合天然去重。
            session_id: process
                .acp
                .as_ref()
                .and_then(|acp| acp.resolved_session_id())
                .unwrap_or_else(|| session_id.clone()),
            agent_id: process.agent_id.clone(),
            project_encoded: process.project_encoded.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ActiveChatSession {
    pub session_id: String,
    pub agent_id: String,
    pub project_encoded: String,
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
            .ok_or_else(|| no_active_session_error())?;
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
    acp.ok_or_else(|| no_active_session_error())?
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
            .ok_or_else(|| no_active_session_error())?;
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

// ── v0.9.7 需求13：编辑最近用户消息（截断重发） ──────────────────────────────
//
// 用户语义：编辑会话最后一条用户消息 = 停止进行中的回复（如有）+ 清空该
// 消息及其后的全部内容 + 以编辑后文本重发。pi RPC 无原位编辑命令（fork
// 会产生新会话文件，违背「原会话基础上修改」），故在 hub 侧截断 pi 会话
// JSONL：定位当前路径最后一条 user 消息行，文本校验（防 UI 与文件不同步
// 错删）通过后，备份原文件并截断该行及其后所有行；杀掉会话进程（流式中
// =停止回复，进程内存态随之丢弃）。重发由前端走常规 send_message——resume
// 读截断后的文件，新消息挂回原会话（原位效果）。

/// 截断纯函数（tempdir 单测覆盖）：返回保留行数。
/// 行结构（pi jsonl）：`{"type":"message","message":{"role","content":[…]},…}`。
fn truncate_lines_after_last_user(lines: &[&str], expect_text: &str) -> Result<usize, String> {
    for (i, line) in lines.iter().enumerate().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        // 首 text 块（send 侧单块形态；startsWith 容错工具注入块后缀/任务
        // 前缀包装造成的差异——expect 传的是落盘原文，正常全等命中）。
        let text = msg
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            })
            .and_then(|b| b.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if !text.starts_with(expect_text) {
            return Err(
                "会话最后一条用户消息与预期不一致，已取消编辑（请刷新会话后重试）".to_string(),
            );
        }
        if i == 0 {
            return Err("该消息之前没有可保留的内容（首条消息不可编辑）".to_string());
        }
        return Ok(i);
    }
    Err("会话中未找到用户消息".to_string())
}

/// session_info 行判定（pi jsonl：`{"type":"session_info",…}`——会话命名/
/// 标题条目）。
fn is_session_info_line(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|v| {
            v.get("type")
                .and_then(|t| t.as_str())
                .map(|t| t == "session_info")
        })
        .unwrap_or(false)
}

/// 构造截断后的内容：保留行 + 将删区段中的 session_info 行重新追加。
/// 评审 P1-3b：命名条目落在会话尾部，直接截断会把它们一并删掉，导致标题
/// 反复重生成；截断后回补，使命名幂等闸（已命名不再重命名）持续有效。
/// 修复轮回归收口（评审 P1）：回补行的 parentId 必须重写为截断点前一条
/// 的 id——原样搬运会指向已删条目，pi 侧上下文投影（buildSessionPath 无
/// 孤儿回退）在断链处截停，保留区历史将全部掉出 LLM 上下文。回补多条时
/// 依次链到前一条回补行，保持树链完整。
fn truncated_content(lines: &[&str], keep: usize) -> String {
    // 保留区末条 id（回补链的锚点；解析失败置 null——pi 对 null parentId
    // 视为树根，安全）。
    let kept_tail_id: Option<String> = lines[..keep]
        .iter()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(str::to_string));
    let mut anchor = kept_tail_id;
    let mut out: Vec<String> = lines[..keep].iter().map(|l| l.to_string()).collect();
    for line in &lines[keep..] {
        if !is_session_info_line(line) {
            continue;
        }
        let rewritten = serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .map(|mut v| {
                if let Some(obj) = v.as_object_mut() {
                    match anchor.clone() {
                        Some(id) => {
                            obj.insert("parentId".to_string(), serde_json::json!(id));
                        }
                        None => {
                            obj.remove("parentId");
                        }
                    }
                    // 锚点前移到本行自身 id，维持回补链。
                    anchor = obj.get("id").and_then(|i| i.as_str()).map(str::to_string);
                }
                v.to_string()
            })
            // 解析失败的 session_info 行原样保留（is_session_info_line 已
            // 保证可解析，此处仅防御）。
            .unwrap_or_else(|| line.to_string());
        out.push(rewritten);
    }
    format!("{}\n", out.join("\n"))
}

/// 定位会话 jsonl（root/<项目目录>/<ts>_<sid>.jsonl 两层扫描）并执行截断。
fn truncate_session_after_last_user(
    session_id: &str,
    expect_text: &str,
) -> Result<std::path::PathBuf, String> {
    let root = agent::jishu_self::pi_session::pi_sessions_root()?;
    let suffix = format!("_{session_id}.jsonl");
    let mut found: Option<std::path::PathBuf> = None;
    for dir in std::fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let dir_path = dir.path();
        if !dir_path.is_dir() {
            continue;
        }
        for f in std::fs::read_dir(&dir_path)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            if f.file_name().to_string_lossy().ends_with(&suffix) {
                found = Some(f.path());
                break;
            }
        }
        if found.is_some() {
            break;
        }
    }
    let file = found.ok_or_else(|| format!("会话文件未找到: {session_id}"))?;
    let content = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let keep = truncate_lines_after_last_user(&lines, expect_text)?;
    // 备份（覆盖式单份，恢复路径明确）+ 原子写截断。
    let mut backup = file.clone().into_os_string();
    backup.push(".edit-bak");
    let backup = std::path::PathBuf::from(backup);
    std::fs::copy(&file, &backup).map_err(|e| format!("备份失败: {e}"))?;
    let kept = truncated_content(&lines, keep);
    crate::util::atomic_write(&file, kept.as_bytes())
        .map_err(|e| format!("写入截断会话失败: {e}"))?;
    log::info!(
        "edit_last_user_message: truncated {} to {keep} lines (backup: {})",
        file.display(),
        backup.display()
    );
    Ok(file)
}

/// 编辑最近用户消息：截断会话文件 + 回收该会话进程（agent_id 定位，流式
/// 中即停止回复）。重发由前端走常规发送链（resume 重拉进程）。
#[tauri::command]
pub(crate) async fn edit_last_user_message(
    app: AppHandle,
    agent_id: String,
    session_id: String,
    expect_text: String,
) -> Result<(), String> {
    // 评审 P1-3：先杀进程再截断——顺序对调的取舍：若先截断，进行中的流式
    // 回复仍持有文件句柄继续追加，新写入内容会越过截断点（旧回复「复活」
    // 或 JSONL 半行损坏）。shutdown 无返回值（内部自行收口，无失败面可
    // 告警）；wait_finished 最多等 3s——超时后接受残余写风险继续截断
    // （进程已请求停止，残余窗口远小于旧序「先截断后杀」的敞口）。
    if let Some(process) = existing_chat_process(&app, &session_id, &agent_id) {
        if let Some(acp) = process.acp.as_ref() {
            acp.shutdown().await;
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(3), acp.wait_finished()).await;
        }
        let chat_state = app.state::<Mutex<ChatState>>();
        let mut s = chat_state.lock().map_err(|e| e.to_string())?;
        remove_process_entries_from(&mut s, Some(process.process_id), Some(&session_id));
    }
    // 再截断（数据操作失败即返回；进程已回收，重发走常规发送链）。
    truncate_session_after_last_user(&session_id, &expect_text)?;
    Ok(())
}

/// v0.9.8 需求2：清除一条「未送达」消息（pending_messages 并入渲染的幽灵
/// ——编辑重发失败/投递挂死后永等不到 ack 的行）。按 (session_id, sent_at)
/// 主键精确删除，幂等；前端删除后从本地列表同步移除。
#[tauri::command]
pub fn dismiss_pending_message(session_id: String, sent_at: i64) -> Result<(), String> {
    crate::pending_messages::dismiss(&session_id, sent_at)
}

/// 「没有活动会话」的结构化错误（v0.9.8 评审修复轮 R2 / C5）。会话进程不
/// 在了（闲置回收、崩溃、重启后）时，引导、压缩、分支、审批与交互应答
/// 都从这里报同一个错。前端按前缀 `[no_active_session]` 判断并撤卡、把答案
/// 改走后续消息——此前靠英文子串猜。
///
/// 前缀之后只有一句人话（评审修复轮 R3 / P2-8）：这个错在引导路径上会直接
/// 给用户看，不带英文原文和会话号——内部代号不上界面，同 R-7。显示前把前
/// 缀剥掉是前端的事。
fn no_active_session_error() -> String {
    "[no_active_session] 会话连接已不在，请重新打开会话后再试".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg_line(id: &str, parent: &str, role: &str, text: &str) -> String {
        serde_json::json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "message": { "role": role, "content": [{ "type": "text", "text": text }] },
        })
        .to_string()
    }

    /// v0.9.8 评审修复轮 R2（C5）：「没有活动会话」带机器可读前缀。
    /// 评审修复轮 R3（P2-8）：前缀之后只有一句人话——不带英文原文、不带会话
    /// 号（这句会直接给用户看）。
    #[test]
    fn no_active_session_error_is_prefix_plus_plain_words() {
        let err = no_active_session_error();
        let rest = err
            .strip_prefix("[no_active_session] ")
            .unwrap_or_else(|| panic!("应带结构化前缀：{err}"));
        assert!(!rest.trim().is_empty(), "前缀之后保留人话：{err}");
        assert!(rest.contains("重新打开会话"), "{err}");
        assert!(
            rest.chars().all(|ch| !ch.is_ascii()),
            "人话里不留英文残片：{err}"
        );
        assert!(!err.contains("No active ACP session"), "{err}");
    }

    /// 需求13：截断定位与校验——从尾向前找 user 行、文本 startsWith 校验、
    /// 保留其前全部行；不匹配/首行/无 user 各自报错。
    #[test]
    fn truncate_lines_locates_and_validates() {
        let info = r#"{"type":"session_info","id":"s0"}"#.to_string();
        let u1 = msg_line("a", "s0", "user", "AAA");
        let r1 = msg_line("b", "a", "assistant", "回复");
        let u2 = msg_line("c", "b", "user", "BBB");
        let r2 = msg_line("d", "c", "assistant", "bbb-reply");
        let lines: Vec<&str> = vec![&info, &u1, &r1, &u2, &r2];
        // 正常：截到 BBB 前（保留 3 行）。
        assert_eq!(truncate_lines_after_last_user(&lines, "BBB").unwrap(), 3);
        // 工具注入块后缀差异：startsWith 容错。
        let injected = msg_line(
            "c2",
            "b",
            "user",
            "BBB

[JISHU-TOOLS:x]",
        );
        let lines2: Vec<&str> = vec![&info, &u1, &injected];
        assert_eq!(truncate_lines_after_last_user(&lines2, "BBB").unwrap(), 2);
        // 文本不符：拒绝。
        assert!(truncate_lines_after_last_user(&lines, "XXX").is_err());
        // user 在首行（无可保留内容）：拒绝。
        let first = msg_line("a", "", "user", "AAA");
        let only: Vec<&str> = vec![&first];
        assert!(truncate_lines_after_last_user(&only, "AAA").is_err());
        // 无 user 行：拒绝。
        let a2 = msg_line("b", "s0", "assistant", "x");
        let no_user: Vec<&str> = vec![&info, &a2];
        assert!(truncate_lines_after_last_user(&no_user, "A").is_err());
    }

    /// 评审 P1-3b：尾部 session_info（命名条目）不随截断丢失——构造含命名
    /// 条目的会话，截断后 session_info 必须仍在（命名幂等闸持续有效）。
    #[test]
    fn truncate_keeps_tail_session_info_entries() {
        // 修复轮回归测试（评审 P1）：使用 pi 真实形状——session_info 带
        // name 键且 parentId 指向其前一条（session_title.rs append_session_info
        // 与 pi 侧 appendSessionInfo 均如此）。原夹具用虚构的 title 键且无
        // parentId，恰好测不出「回补行 parentId 悬空→上下文断链」缺陷。
        let info =
            r#"{"type":"session_info","id":"s0","parentId":null,"name":"初始名"}"#.to_string();
        let u1 = msg_line("a", "s0", "user", "AAA");
        let r1 = msg_line("b", "a", "assistant", "回复");
        let u2 = msg_line("c", "b", "user", "BBB");
        let r2 = msg_line("d", "c", "assistant", "bbb-reply");
        // 命名条目落在会话尾部（位于截断将删区段内），parentId 指向将删的 r2。
        let title =
            r#"{"type":"session_info","id":"t9","parentId":"d","timestamp":"2026-11-14T00:00:00Z","name":"标题"}"#.to_string();
        let lines: Vec<&str> = vec![&info, &u1, &r1, &u2, &r2, &title];
        let keep = truncate_lines_after_last_user(&lines, "BBB").unwrap();
        assert_eq!(keep, 3);
        let kept = truncated_content(&lines, keep);
        let kept_lines: Vec<&str> = kept.lines().collect();
        // 消息截断生效：BBB 及其后的回复被删（3 行保留 + 回补 1 条命名）。
        assert_eq!(kept_lines.len(), 4);
        assert!(!kept.contains("bbb-reply"), "被截断的消息必须删除");
        assert!(!kept.contains("\"BBB\""), "被截断的用户消息必须删除");
        // 命名条目回补仍在（含标题内容），且 parentId 重写为保留区末条
        // （r1 的 id="b"）——悬空父链会让 pi 侧上下文投影在断链处截停，
        // 保留区历史全部掉出 LLM 上下文。
        let appended: serde_json::Value = serde_json::from_str(kept_lines[3]).unwrap();
        assert_eq!(appended["type"], "session_info");
        assert_eq!(appended["name"], "标题");
        assert_eq!(
            appended["parentId"], "b",
            "回补行 parentId 必须重写为保留区末条 id（不可指向已删条目）"
        );
    }

    /// 修复轮回归（评审 P1）：回补多条 session_info 时依次链到前一条，
    /// 且保留区无条目（keep=0 场景理论上不存在——首条消息不可编辑——
    /// 此处锁防御行为：parentId 移除=树根，不悬空）。
    #[test]
    fn truncate_rewrites_session_info_parent_chain() {
        let u1 = msg_line("a", "", "user", "AAA");
        let r1 = msg_line("b", "a", "assistant", "回1");
        let u2 = msg_line("c", "b", "user", "BBB");
        let t1 = r#"{"type":"session_info","id":"t1","parentId":"c","name":"名1"}"#.to_string();
        let t2 = r#"{"type":"session_info","id":"t2","parentId":"t1","name":"名2"}"#.to_string();
        let lines: Vec<&str> = vec![&u1, &r1, &u2, &t1, &t2];
        let keep = truncate_lines_after_last_user(&lines, "BBB").unwrap();
        assert_eq!(keep, 2);
        let kept = truncated_content(&lines, keep);
        let kept_lines: Vec<&str> = kept.lines().collect();
        assert_eq!(kept_lines.len(), 4);
        let j1: serde_json::Value = serde_json::from_str(kept_lines[2]).unwrap();
        let j2: serde_json::Value = serde_json::from_str(kept_lines[3]).unwrap();
        assert_eq!(j1["parentId"], "b", "首条回补链到保留区末条");
        assert_eq!(j2["parentId"], "t1", "次条回补链到前一条回补行");
    }
}
