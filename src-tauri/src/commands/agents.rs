use std::collections::HashMap;
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

/// manifest 加载失败清单（v0.8.1 需求1 M2）：环境检测页渲染警示条，
/// 让坏 manifest（未知字段/非法模板/id 冲突）对用户可见而非仅 log。
#[tauri::command]
pub(crate) fn agent_manifest_errors(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Vec<(String, String)> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    s.registry.manifest_errors.clone()
}

// ── 插件管理（v0.8.1 需求2/3：统一插件模型的管理面）─────────────────────────

/// 插件清单（含 manifest 加载错误，插件页一并渲染）。v0.8.1 需求7：
/// 合并工具插件（kind = "tool"，不进 AgentRegistry，经 AppState 装载快照）。
#[derive(serde::Serialize)]
pub(crate) struct PluginListResult {
    pub plugins: Vec<agent::plugin::PluginDescriptor>,
    pub manifest_errors: Vec<(String, String)>,
}

#[tauri::command]
pub(crate) fn plugin_list(state: tauri::State<'_, Mutex<AppState>>) -> PluginListResult {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    let mut plugins = s.registry.list_plugins();
    plugins.extend(
        s.tool_plugins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(agent::plugin::tool_descriptor),
    );
    PluginListResult {
        plugins,
        manifest_errors: s.registry.manifest_errors.clone(),
    }
}

/// 锁内热重建 registry（启停/删除/重载/创建的生效通道）：Arc 替换原子完成，
/// 在途命令用旧实例完成请求（最终一致）；运行中会话进程表在 ChatState
/// 不受影响。重建后保留旧健康缓存并广播 `plugins-changed`——前端
/// AgentContext 据此重拉智能体列表并把仍指向已禁用智能体的记忆选择
/// 迁移到可用项（GUI 反馈 3：禁用后全局选择面必须同步收口）。
/// 需求7：工具插件装载快照（AppState.tool_plugins）随同一 plugins.json
/// 启停集合同步重载。
fn rebuild_registry(app: &tauri::AppHandle, state: &tauri::State<'_, Mutex<AppState>>) {
    // v0.8.1 M6：装载与探测预热在拿 AppState 锁**之前**完成——工具插件的
    // installed() 首次探测会同步 spawn where/--version，放锁内会阻塞所有命令。
    let disabled: std::collections::HashSet<String> = agent::plugin::load_plugin_config()
        .disabled
        .iter()
        .cloned()
        .collect();
    let reloaded_tools = agent::tool_plugin::load_tool_plugins(&disabled);
    for p in &reloaded_tools {
        let _ = p.installed();
    }
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    let previous = s.registry.clone();
    let rebuilt = std::sync::Arc::new(agent::AgentRegistry::new());
    rebuilt.retain_health_from(&previous);
    s.registry = rebuilt;
    *s.tool_plugins.lock().unwrap_or_else(|e| e.into_inner()) = reloaded_tools;
    use tauri::Emitter;
    let _ = app.emit("plugins-changed", ());
    // v0.9.0 需求1 P2：插件集变化后同步四家 MCP 条目（注入/回收，锁外执行）。
    let _ = crate::agent::mcp_inject::sync_hub_mcp_entries();
    // v0.9.0 需求20：skill 分发随插件启停同步。
    let _ = crate::agent::skill_deploy::sync_skill_deployments(false);
    // v0.9.0 需求2：pi 扩展部署随插件启停同步。
    crate::agent::pi_deploy::ensure_pi_extension_deployments();
    // v0.9.5 需求5：npm 扩展包注册（settings.json packages）随插件启停
    // 对齐——禁用即摘条目（扩展不装载，含事件钩子），启用即补钉定源。
    crate::agent::plugin::sync_pi_packages_with_plugins();
    // 需求4 D4-8：扩展统一登记簿随插件/启停/装卸变化对账（注册面∪
    // [[adapt]] 关系表∪级联停用——索引层，失败不阻断装载）。
    crate::agent::extensions_db::sync_all();
}

/// 启停插件并热生效（core 插件拒绝；写 plugins.json 持久化；agent 与 tool
/// 插件共用同一启停集合——known ids 含两类）。
/// 需求25 P2：混合插件确认卡「启用/暂不」复用本命令——成功后顺带清除
/// `<id>/.pending-confirm` 安装标记（幂等，非混合插件无该文件则无操作）。
#[tauri::command]
pub(crate) fn plugin_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    agent::plugin::set_plugin_enabled(&plugin_id, enabled)?;
    rebuild_registry(&app, &state);
    agent::plugin::clear_pending_confirm_marker(&plugin_id);
    // v0.9.7 需求12：预连接插件开关联动（禁用即杀池/启用即重建）——非该
    // 插件的启停也可能间接影响（registry 重建），统一走一次联动（幂等）。
    let _ = with_app_state(&state, |s| {
        crate::preconnect::on_settings_changed(&s.registry)
    });
    log::info!(
        "[plugin] {} {}d (registry rebuilt)",
        plugin_id,
        if enabled { "enable" } else { "disable" }
    );
    Ok(())
}

/// 卸载 manifest 插件（删除其 toml 文件 + 清理启停配置 + 热重建）。
/// 内建插件拒绝；系统插件拒绝（v0.9.0 需求1 二期——随包分发、启动幂等
/// 重部署，卸载是无操作）；有活跃会话的插件拒绝（避免进程孤儿化——先结束会话）。
#[tauri::command]
pub(crate) fn plugin_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
) -> Result<(), String> {
    // 解析来源文件路径（agent 与 tool 两类 manifest 插件均可卸载；内建拒绝）。
    let source_path = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let mut descriptors = s.registry.list_plugins();
        descriptors.extend(
            s.tool_plugins
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .map(agent::plugin::tool_descriptor),
        );
        let descriptor = descriptors
            .into_iter()
            .find(|p| p.id == plugin_id)
            .ok_or_else(|| format!("Unknown plugin: {plugin_id}"))?;
        if descriptor.core {
            return Err(format!(
                "Plugin {plugin_id} is the core engine and cannot be removed"
            ));
        }
        if agent::plugin::is_system_plugin(&plugin_id) {
            return Err(format!(
                "Plugin {plugin_id} is a system plugin and cannot be removed"
            ));
        }
        descriptor
            .source_path
            .ok_or_else(|| format!("Plugin {plugin_id} is builtin and cannot be removed"))?
    };

    // 活跃会话检查：agent 插件的进程仍在运行时拒绝卸载（tool 插件无进程）。
    {
        use tauri::Manager;
        let chat_state = app.state::<Mutex<crate::chat::ChatState>>();
        let s = chat_state
            .lock()
            .map_err(|_| "Chat state lock poisoned".to_string())?;
        let active = s
            .processes
            .values()
            .filter(|p| p.agent_id == plugin_id)
            .count();
        if active > 0 {
            return Err(format!(
                "Plugin {plugin_id} has {active} active session(s); stop them before removing"
            ));
        }
    }

    // 需求14 测试期修复（T14R，同 CLI remove）：目录形态删整目录防附带文件
    //（bridge.js 等）孤儿残留；单文件形态维持删文件。
    let source = std::path::Path::new(&source_path);
    let is_dir_form = source
        .file_name()
        .map(|n| n == "plugin.toml")
        .unwrap_or(false)
        && source
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n == plugin_id.as_str())
            .unwrap_or(false);
    if is_dir_form {
        let dir = source.parent().expect("plugin.toml has parent");
        std::fs::remove_dir_all(dir)
            .map_err(|e| format!("Cannot remove {}: {e}", dir.display()))?;
    } else {
        std::fs::remove_file(source).map_err(|e| format!("Cannot remove {source_path}: {e}"))?;
    }
    agent::plugin::forget_plugin_disabled(&plugin_id); // 清 disabled 引用（T16 同款）
                                                       // 04-R3：卸载后刷新 agent-tool 物化清单——load_agent_tools 读物化文件
                                                       //（非即时扫描），不刷新会残留幽灵工具名（spawn 白名单脏 + 直呼报
                                                       // unknown，直到下次启停/重启）。三卸载链（本处/market_uninstall/CLI
                                                       // remove）同收口。
    agent::plugin::materialize_agent_tools();
    rebuild_registry(&app, &state);
    log::info!("[plugin] removed {} ({})", plugin_id, source_path);
    Ok(())
}

// ── 会话工具插件（v0.8.1 需求7：+ 菜单勾选 → prompt 注入）──────────────────

/// 会话已启用的工具插件（+ 菜单渲染选中态；仅返回已装载且未禁用的）。
#[derive(serde::Serialize)]
pub(crate) struct SessionToolInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub usage: String,
    pub enabled: bool,
    /// M3：是否可参与 CLI 注入（有 [tool] 段）。false = 仅 pi 扩展形态
    /// （PiOnly 自适应插件）——前端 + 菜单区分展示，勾选后不会注入说明块。
    pub injectable: bool,
    /// v0.9.0 需求20 第二轮：能力类别（+ 菜单两级分组）——mcp = [mcp] 声明
    ///（经 jishu-hub 结构化通道，注入提示块）；skill = [skill] 声明（已分发
    /// 到 agent skill 目录，注入提示块）；cli = 传统 [tool] 用法注入；
    /// extension = 已装 pi 扩展（v0.9.8 需求5：+ 菜单可引用/消息可点名）。
    pub category: String,
    /// v0.9.8 需求5：@[名] 引用时是否保留消息原文（true=扩展：点名即信息，
    /// 无 hub 侧说明块可注入；false=传统件：剥离原文并注入用法说明块）。
    pub keep_text: bool,
}

#[tauri::command]
pub(crate) fn session_tool_list(
    state: tauri::State<'_, Mutex<AppState>>,
    session_id: String,
) -> Vec<SessionToolInfo> {
    let selected: std::collections::HashSet<String> =
        agent::tool_plugin::get_session_tools(&session_id)
            .into_iter()
            .collect();
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    let tools = s.tool_plugins.lock().unwrap_or_else(|e| e.into_inner());
    session_tool_entries(&tools, &selected)
}

/// 会话挂载清单（session_tool_list 命令体；v0.9.8 评审修复轮 R1-5：发送
/// 入口的工具引用解析 [`resolve_tool_refs`] 同源复用——「显示名 → 工具 id」
/// 的归一口径只此一份）。
fn session_tool_entries(
    tools: &[agent::tool_plugin::ToolPlugin],
    selected: &std::collections::HashSet<String>,
) -> Vec<SessionToolInfo> {
    // v0.9.8 需求5（合并版，用户裁决「推荐效果一致」）：已装 pi 扩展进
    // 挂载清单（category=extension）——+ 菜单可引用、消息可 @[点名]，
    // 与 Skill 引用同款体验。keep_text=true：@[扩展名] 保留原文不剥离
    //（pi 扩展无 hub 侧工具说明文档可注入，点名本身就是要传给 agent 的
    // 信息——工具可用性由 pi 原生 packages 机制保证，装了就在）。
    let mut list = tools
        .iter()
        .filter(|p| p.enabled)
        .map(|p| {
            let dir_root = p
                .source_path
                .parent()
                .filter(|r| r.file_name().is_some_and(|n| n == p.id()));
            let dir_skills = dir_root
                .map(|r| agent::skill_deploy::dir_source_skills(r, p.id()))
                .unwrap_or_default();
            let has_dir_skill = !dir_skills.is_empty();
            let description = p
                .file
                .tool
                .as_ref()
                .map(|t| t.description.clone())
                .unwrap_or_else(|| {
                    dir_skills
                        .first()
                        .map(|d| d.description.clone())
                        .unwrap_or_default()
                });
            SessionToolInfo {
                id: p.id().to_string(),
                display_name: p.file.info.display_name.clone(),
                description,
                usage: p
                    .file
                    .tool
                    .as_ref()
                    .map(|t| t.usage.clone())
                    .unwrap_or_default(),
                enabled: selected.contains(p.id()),
                injectable: p.file.tool.is_some()
                    || p.file.mcp.is_some()
                    || p.file.skill.is_some()
                    || has_dir_skill,
                category: if p.file.mcp.is_some() {
                    "mcp".to_string()
                } else if p.file.skill.is_some() || has_dir_skill {
                    "skill".to_string()
                } else {
                    "cli".to_string()
                },
                keep_text: false,
            }
        })
        .collect::<Vec<_>>();
    if let Ok(entries) = agent::extensions_db::registry_list() {
        for e in entries.iter().filter(|e| e.state == "active") {
            list.push(SessionToolInfo {
                id: e.pkg_key.clone(),
                display_name: e.display.clone(),
                description: "pi 扩展（能力随安装自动注入，点名后 agent 优先使用）".to_string(),
                usage: String::new(),
                enabled: selected.contains(&e.pkg_key),
                injectable: true,
                category: "extension".to_string(),
                keep_text: true,
            });
        }
    }
    // 需求7 补充四：混合件 [[agent-tool]] 进挂载清单（插件级聚合）。
    list.extend(agent_tool_session_entries(selected));

    list
}

/// 内联工具引用 `@[显示名]`（v0.8.1 需求7；与前端 TOOL_TOKEN_RE 同式）。
fn tool_ref_names(message: &str) -> impl Iterator<Item = &str> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"@\[([^\]]+)\]").expect("valid tool ref regex"));
    re.captures_iter(message)
        .map(|cap| cap.get(1).map(|m| m.as_str()).unwrap_or(""))
}

/// 解析一条消息点名的工具（纯函数）：`@[显示名]` 归一为工具 id（清单里
/// 首个同名者；未匹配的引用原样保留在文本里，不产生 id）。
///
/// v0.9.8 评审修复轮 R1-5：路线甲下「本条消息带哪些工具」**完全由消息
/// 文本里的 `@[名]` 决定**——所以它是文本的纯函数，放在所有用户消息出口
/// 的必经点（send_message）解析，任何出口（手动发送 / 回合结束自动发送 /
/// 停止后重发 / 引导补发）都不可能再绕过。此前只有手动发送的出口解析并
/// 写入会话工具集，其余出口直接发原文：文本里带着 `@[工具B]`，B 的说明
/// 块却不注入（注入的仍是上一条消息的工具集）。
pub(crate) fn resolve_tool_refs(message: &str, entries: &[SessionToolInfo]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for name in tool_ref_names(message) {
        if let Some(tool) = entries.iter().find(|e| e.display_name == name) {
            if !ids.contains(&tool.id) {
                ids.push(tool.id.clone());
            }
        }
    }
    ids
}

/// 发送入口确定并写入「本条消息的工具集」（send_message 在组装消息前
/// 调用——见 [`resolve_tool_refs`]）。
///
/// `explicit`：出口显式声明的工具集（编辑重发——文本之外还带着「编辑态
/// 保留的工具」这一意图）；None = 按消息文本解析。
pub(crate) fn apply_turn_tool_set(
    state: &Mutex<AppState>,
    session_id: &str,
    message: &str,
    explicit: Option<Vec<String>>,
) {
    let tool_ids = explicit.unwrap_or_else(|| {
        let s = state.lock().unwrap_or_else(|e| e.into_inner());
        let tools = s.tool_plugins.lock().unwrap_or_else(|e| e.into_inner());
        resolve_tool_refs(message, &session_tool_entries(&tools, &Default::default()))
    });
    if let Err(e) = session_set_tools(session_id.to_string(), tool_ids) {
        log::warn!("[send_message] 写入会话工具集失败（本条消息工具不注入）: {e}");
    }
}

/// 需求7 补充四（用户裁决 2026-11-22「自己加的无 UI 工具插件如何引用」）：
/// 启用态 [[agent-tool]] 混合件 → 插件级挂载条目（一件多工具聚合展示工具
/// 名清单）；keep_text=true（工具已由 pi 原生可用，@点名=本轮优先用，同
/// 扩展语义）。数据源=物化清单 agent-tools.json（启用态已过滤），显示名
/// 回退 plugin.toml [plugin].name。
fn agent_tool_session_entries(selected: &std::collections::HashSet<String>) -> Vec<SessionToolInfo> {
    let tools = agent::plugin::load_agent_tools();
    let manifests = agent::plugin::composed_session_manifests();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for t in &tools {
        if !seen.insert(t.plugin_id.clone()) {
            continue; // 一件多工具 → 插件级一行
        }
        let (display, desc) = manifests
            .iter()
            .find(|(id, _)| *id == t.plugin_id)
            .map(|(_, m)| {
                let name = m
                    .get("plugin")
                    .and_then(|p| p.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(t.plugin_id.as_str())
                    .to_string();
                let tool_names: Vec<String> = tools
                    .iter()
                    .filter(|x| x.plugin_id == t.plugin_id)
                    .map(|x| x.name.clone())
                    .collect();
                (name, format!("插件工具：{}", tool_names.join(" / ")))
            })
            .unwrap_or_else(|| (t.plugin_id.clone(), "插件工具".to_string()));
        let id = format!("plugin:{}", t.plugin_id);
        out.push(SessionToolInfo {
            id: id.clone(),
            display_name: display,
            description: desc,
            usage: String::new(),
            enabled: selected.contains(&id),
            injectable: true,
            category: "agent-tool".to_string(),
            keep_text: true,
        });
    }
    out
}

#[cfg(test)]
mod agent_tool_entry_tests {
    use super::*;

    /// 需求7 补充四：物化清单+plugin.toml 名称 → 插件级条目（聚合+keep_text）。
    /// 环境隔离：JISHU_HUB_HOME 指临时目录。
    #[test]
    fn aggregates_plugin_level_entry_with_tool_names() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        std::fs::write(
            tmp.path().join("agent-tools.json"),
            r#"[{"plugin_id":"video-pipeline","name":"video_pipeline","description":"d"},
                {"plugin_id":"video-pipeline","name":"storyboard","description":"d"},
                {"plugin_id":"other","name":"x_tool","description":"d"}]"#,
        )
        .unwrap();
        let pdir = tmp.path().join("plugins").join("video-pipeline");
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(
            pdir.join("plugin.toml"),
            r#"[plugin]
id = "video-pipeline"
name = "视频流水线"
"#,
        )
        .unwrap();

        let entries = agent_tool_session_entries(&Default::default());
        assert_eq!(entries.len(), 2, "插件级聚合：两件两行");
        let first = entries.iter().find(|e| e.id == "plugin:video-pipeline").unwrap();
        assert_eq!(first.display_name, "视频流水线", "显示名取 plugin.toml");
        assert_eq!(first.category, "agent-tool");
        assert!(first.keep_text, "点名保留原文（同扩展语义）");
        assert!(first.description.contains("video_pipeline / storyboard"));
        let second = entries.iter().find(|e| e.id == "plugin:other").unwrap();
        assert_eq!(second.display_name, "other", "无 toml 回退插件 id");
        std::env::remove_var("JISHU_HUB_HOME");
    }
}

/// 设置会话启用的工具插件集合（prompt 注入依据；空集合移除条目）。
#[tauri::command]
pub(crate) fn session_set_tools(session_id: String, tool_ids: Vec<String>) -> Result<(), String> {
    // v0.9.8 需求5：tool_ids 可含 pi 扩展 pkg_key（消息点名 @[扩展] 的
    // 归一产物——pill 渲染/编辑重发走 tool_ids 快照）。扩展非 tool_plugins
    // 注册表成员，set_session_tools 的 known 校验会拒——会话启用集记录
    // 点名即可（compose 侧 tool_plugins 匹配自然滤掉，无说明块注入），
    // 此处拆分放行。
    let (extension_ids, plugin_ids): (Vec<String>, Vec<String>) = tool_ids
        .into_iter()
        .partition(|id| {
            // 需求7 补充一：pi 扩展 pkg_key；补充四：agent-tool 混合件
            // plugin:<id>——两者都是 keep_text 点名形态（会话集记录点名，
            // compose 侧 tool_plugins 匹配自然滤掉）。
            id.starts_with("plugin:")
                || (id.starts_with("npm:")
                    && agent::extensions_db::registry_list()
                        .map(|l| l.iter().any(|e| e.pkg_key == *id && e.state == "active"))
                        .unwrap_or(false))
        });
    let _ = extension_ids;
    agent::tool_plugin::set_session_tools(&session_id, &plugin_ids)
}

/// 重扫描 manifest 目录并热重建（手工放置/删除文件后的刷新入口）。
#[tauri::command]
pub(crate) fn plugin_reload(app: tauri::AppHandle, state: tauri::State<'_, Mutex<AppState>>) {
    rebuild_registry(&app, &state);
}

/// 可视化创建 manifest 插件（v0.8.1 需求6）：前端表单 → manifest JSON →
/// 校验 → 后端生成 TOML（转义由 serde 承担，前端零拼 TOML）→ 安装 → 热重建。
#[derive(serde::Serialize)]
pub(crate) struct PluginCreated {
    pub id: String,
    pub path: String,
}

#[tauri::command]
pub(crate) fn plugin_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    manifest: serde_json::Value,
) -> Result<PluginCreated, String> {
    let file: agent::manifest::schema::AgentManifestFile =
        serde_json::from_value(manifest).map_err(|e| format!("invalid manifest payload: {e}"))?;
    file.validate()?;
    let content_toml =
        toml::to_string_pretty(&file).map_err(|e| format!("cannot serialize manifest: {e}"))?;
    let (id, path) = agent::plugin::install_manifest_file(&file, &content_toml)?;
    rebuild_registry(&app, &state);
    Ok(PluginCreated {
        id,
        path: path.to_string_lossy().to_string(),
    })
}

/// 编辑模式：读取已装 manifest 插件的当前 manifest（表单预填数据源）。
#[tauri::command]
pub(crate) fn plugin_get(
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    let _s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    // agent 与 tool 两类 manifest 插件都在 ~/.jishu-hub/agents/ 下——直接按
    // 文件名读（<id>.toml），与装载同源。v0.9.4 需求3：目录形式插件
    //（plugins/<id>/plugin.toml，文件夹式 skill 等）回退读该处，并把
    // skills/<name>/SKILL.md 注入为 [[skill]] 条目——表单可编辑（保存时
    // plugin_update 目录形式路径写回，见下）。
    let single = agent::manifest::manifest_dir().join(format!("{plugin_id}.toml"));
    let dir_form = agent::manifest::hub_home()
        .join("plugins")
        .join(&plugin_id)
        .join("plugin.toml");
    let (path, is_dir_form) = if single.is_file() {
        (single, false)
    } else if dir_form.is_file() {
        (dir_form, true)
    } else {
        return Err(format!("cannot read {}: file not found", single.display()));
    };
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut file: agent::manifest::schema::AgentManifestFile =
        toml::from_str(&content).map_err(|e| format!("stored manifest is invalid: {e}"))?;
    if is_dir_form && file.skill.is_none() {
        let root = path.parent().expect("plugin.toml has parent");
        let entries: Vec<agent::manifest::schema::SkillEntry> =
            agent::skill_deploy::dir_source_skills(root, &plugin_id)
                .into_iter()
                .map(|e| {
                    // dir_name = <pid>__<name> → 还原 skill 名；content 重析
                    // frontmatter（name/description/body 三字段回填表单）。
                    let name = e
                        .dir_name
                        .strip_prefix(&format!("{plugin_id}__"))
                        .unwrap_or(&e.dir_name)
                        .to_string();
                    let parsed = crate::commands::skill_import::parse_skill_md(&e.content, &name);
                    agent::manifest::schema::SkillEntry {
                        name,
                        description: parsed.description,
                        body: parsed.body,
                    }
                })
                .collect();
        if !entries.is_empty() {
            file.skill = Some(agent::manifest::schema::SkillDecl::Many(entries));
        }
    }
    serde_json::to_value(&file).map_err(|e| e.to_string())
}

/// 编辑模式：校验 → 覆盖写回原文件 → 热重建。id 不可变（后端防御：
/// v0.9.3 需求13 C3：新建组合插件向导落点——保存清单并广播 plugins-changed
///（前端 loader 热重建，新插件即时出现在插件中心与会话区）。
#[tauri::command]
pub(crate) fn composed_plugin_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    id: String,
    toml: String,
) -> Result<(), String> {
    agent::plugin::save_composed_manifest(&id, &toml)?;
    // 需求14 补齐：保存后重建 registry——plugin_list 才能看到新插件
    //（外观页 enabledIds 过滤依赖 plugin_list；不重建则新装主题不可见）。
    rebuild_registry(&app, &state);
    Ok(())
}

/// 需求25 P2 安全阀：混合插件安装待确认清单——扫描 `plugins/*/.pending-confirm`
/// 标记（CLI `plugins add-hybrid` 落盘；CLI 是独立进程发不了广播，标记文件即
/// 跨进程信箱）。前端确认卡轮询读取；「启用/暂不」经 plugin_set_enabled
/// 落地并顺带清除标记。无待确认项返回空数组（轮询轻量）。
#[tauri::command]
pub(crate) fn plugin_confirm_pending() -> Vec<agent::plugin::PendingHybridPlugin> {
    agent::plugin::pending_confirm_list()
}

/// v0.9.8 需求10-①：CLI 启停变更跨进程信箱消费（D3 用户裁决）——读
/// `.cli-plugin-changed` 标记（CLI set_enabled 落盘）并**删除**（一次性
/// 消费语义）。返回 None = 无变更（轮询轻量）。GUI 确认卡展示变更清单，
/// 点「同步」走 plugin_reload（读新 plugins.json 热重建 + emit
/// plugins-changed），「暂不」仅关卡片（状态留待下次手动重载）。
#[tauri::command]
pub(crate) fn cli_plugin_changed_poll() -> Option<serde_json::Value> {
    let marker = agent::manifest::hub_home().join(".cli-plugin-changed");
    let content = std::fs::read_to_string(&marker).ok()?;
    let _ = std::fs::remove_file(&marker);
    serde_json::from_str::<serde_json::Value>(&content).ok()
}

/// CLI plugins validate 的跨进程信箱（v0.9.5 需求1（原需求26）1c）：读请求
/// 标记（CLI 写入的 .cli-validate-req-<nonce>.json——manifest JSON + componentJs
/// 源码自包含，前端零任意路径访问）。返回 None 表示无待处理请求。
/// 三轮评审信箱并发修复：请求/响应文件名带 nonce 后缀——多终端并发
/// validate 不再共用单一文件互相覆盖（修前第二个 CLI 覆盖第一个的请求，
/// nonce 不匹配各自超时）。取最早写入的请求（FIFO）。
#[tauri::command]
pub(crate) fn cli_validate_poll() -> Option<serde_json::Value> {
    let hub = agent::manifest::hub_home();
    let mut oldest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    let Ok(entries) = std::fs::read_dir(&hub) else {
        return None;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(".cli-validate-req-") || !name.ends_with(".json") {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        // MSRV 1.79：is_none_or 需 1.82，用 map_or 等价表达。
        if oldest.as_ref().map_or(true, |(t, _)| mtime < *t) {
            oldest = Some((mtime, entry.path()));
        }
    }
    let (_, req_path) = oldest?;
    let Ok(content) = std::fs::read_to_string(&req_path) else {
        return None;
    };
    // 同 nonce 的旧响应残留——清掉避免本次误配（nonce 匹配在 CLI 侧）。
    if let Some(nonce) = serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| v.get("nonce").and_then(|n| n.as_u64()))
    {
        let resp_path = hub.join(format!(".cli-validate-resp-{nonce}.json"));
        if resp_path.exists() {
            let _ = std::fs::remove_file(&resp_path);
        }
    }
    serde_json::from_str(&content).ok()
}

/// CLI validate 信箱回写：前端校验器（validateManifest/validatePipeline——
/// 与 GUI 向导同一份 TS 实现）跑完写 .cli-validate-resp-<nonce>.json，CLI
/// 轮询匹配 nonce 取结果（并发隔离，见 poll 注释）。
#[tauri::command]
pub(crate) fn cli_validate_submit(response: serde_json::Value) -> Result<(), String> {
    let nonce = response
        .get("nonce")
        .and_then(|n| n.as_u64())
        .ok_or("cli_validate_submit 响应缺少 nonce")?;
    let resp_path = agent::manifest::hub_home().join(format!(".cli-validate-resp-{nonce}.json"));
    crate::util::atomic_write(&resp_path, response.to_string().as_bytes())
        .map_err(|e| format!("cannot write validate response: {e}"))
}

/// 混合插件预览代码写入（v0.9.5 需求1（原需求26）2b）：向导编辑器源码 →
/// `plugins/.preview/component.js`（assetProtocol scope 内的隐藏目录，
/// 无 plugin.toml 不会破插件扫描；原子写）→ 返回指纹（内容长度+毫秒时戳，
/// 前端 loadHybridComponent 按指纹热更重注入）。预览链完全复用正式装载
/// 链（非沙箱——评审 P1-6：iframe 沙箱与 CSP/assetProtocol 冲突）。
#[tauri::command]
pub(crate) fn hybrid_preview_write(source: String) -> Result<String, String> {
    let dir = agent::plugin::composed_plugins_dir().join(".preview");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create preview dir: {e}"))?;
    let fingerprint = format!("{}-{}", source.len(), crate::util::now_ms());
    let target = dir.join("component.js");
    crate::util::atomic_write(&target, source.as_bytes())
        .map_err(|e| format!("cannot write preview component: {e}"))?;
    Ok(fingerprint)
}

/// v0.9.3 需求13 C3：删除用户组合插件（内置拒绝）并广播。
/// 用户实测补修（2026-11-15「删除后卡片残留」）：补 rebuild_registry——
/// 修前只删盘+emit，registry 仍含已删件，插件页 refresh 读旧数据卡片
/// 不消失（plugin_remove 同位置有 rebuild，本命令漏配对）。
#[tauri::command]
pub(crate) fn composed_plugin_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    id: String,
) -> Result<(), String> {
    agent::plugin::delete_composed_plugin(&id)?;
    rebuild_registry(&app, &state);
    Ok(())
}

/// v0.9.3 需求13 C1：组合式清单扫描（toml→JSON，前端组合引擎装配）。
/// 形状契约：`[{ id, manifest }]` 对象数组（元组会序列化成 `[id, manifest]`
/// 数组——前端 loader 形状不匹配致组合清单全军覆没，测试期用户实测踩坑）。
#[tauri::command]
pub(crate) fn composed_plugin_manifests() -> Result<Vec<serde_json::Value>, String> {
    Ok(agent::plugin::composed_session_manifests()
        .into_iter()
        .map(|(id, manifest)| serde_json::json!({ "id": id, "manifest": manifest }))
        .collect())
}

/// v0.9.7 需求3 补充：Pi Index 在线目录检索（awesome-pi 清单，本地过滤）。
#[tauri::command]
pub(crate) async fn piindex_search(
    keyword: Option<String>,
) -> Result<Vec<agent::piindex::PiindexEntry>, String> {
    agent::piindex::piindex_search(keyword.as_deref()).await
}

/// 扩展包检测更新（settings.json 钉定版本 vs npm latest）。
#[tauri::command]
pub(crate) async fn extension_check_updates(
) -> Result<Vec<agent::piindex::ExtensionUpdateStatus>, String> {
    agent::piindex::extension_check_updates().await
}

/// 扩展包批量更新（空=全部有更新的；改写钉定版本，pi 启动自装）。
/// 评审 P2：返回 {updated, failed} 双列报告——partial failure 仍完成可
/// 完成的项，失败项带原因如实上报（跨端契约字段名冻结 updated/failed）。
#[tauri::command]
pub(crate) async fn extension_update(
    packages: Option<Vec<String>>,
) -> Result<agent::piindex::BatchUpdateReport, String> {
    agent::piindex::extension_update(packages).await
}

/// Pi Index 强制刷新（「重新加载」按钮——清两级缓存重拉写盘）。
#[tauri::command]
pub(crate) async fn piindex_refresh() -> Result<Vec<agent::piindex::PiindexEntry>, String> {
    agent::piindex::piindex_refresh().await
}

/// 单包/单技能检测更新（已安装页卡片独立检查）。
#[tauri::command]
pub(crate) async fn extension_check_update(
    package: String,
) -> Result<agent::piindex::ExtensionUpdateStatus, String> {
    agent::piindex::extension_check_update(&package).await
}

#[tauri::command]
pub(crate) async fn skillhub_check_update(
    slug: String,
) -> Result<agent::piindex::SkillUpdateStatus, String> {
    agent::piindex::skillhub_check_update(&slug).await
}

/// 技能检测更新（SkillHub 台账 vs 市场 latest）。
#[tauri::command]
pub(crate) async fn skillhub_check_updates(
) -> Result<Vec<agent::piindex::SkillUpdateStatus>, String> {
    agent::piindex::skillhub_check_updates().await
}

/// 技能批量更新（空=全部有更新的；覆盖安装+台账刷新）。
/// 评审 P2：与 extension_update 同形状返回 {updated, failed}。
#[tauri::command]
pub(crate) async fn skillhub_update(
    slugs: Option<Vec<String>>,
) -> Result<agent::piindex::BatchUpdateReport, String> {
    agent::piindex::skillhub_update(slugs).await
}

/// v0.9.3 需求12 P1：插件配置面——全量读取（前端与 defaults 合并）。
#[tauri::command]
pub(crate) fn plugin_config_get_all(
) -> Result<HashMap<String, HashMap<String, serde_json::Value>>, String> {
    Ok(agent::plugin_options::load_all())
}

/// v0.9.3 需求12 P1：覆写某插件配置组（原子落盘 + 广播 plugins-config-changed，
/// 前端订阅即时生效）。值合法性由前端按 configSchema 校验。
#[tauri::command]
pub(crate) fn plugin_config_set(
    app: tauri::AppHandle,
    plugin_id: String,
    values: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    agent::plugin_options::set_values(&plugin_id, values)?;
    // v0.9.7 需求12：预连接池深配置变更即时生效（补/缩/关）。
    if let Some(state) = app.try_state::<Mutex<AppState>>() {
        let _ = with_app_state(&state, |s| {
            crate::preconnect::on_settings_changed(&s.registry)
        });
    }
    use tauri::Emitter;
    let _ = app.emit(
        "plugins-config-changed",
        serde_json::json!({ "pluginId": plugin_id }),
    );
    Ok(())
}

/// v0.9.7 需求12：预连接焦点声明（前端启动/切标签触发，幂等）——对当前
/// 焦点标签项目维持 jishu agent 预连接池（深浅/开关跟随插件配置）。
#[tauri::command]
pub(crate) fn plugin_preconnect_focus(
    state: tauri::State<'_, Mutex<AppState>>,
    project_path: String,
) -> Result<(), String> {
    if project_path.trim().is_empty() {
        return Ok(());
    }
    with_app_state(&state, |s| {
        crate::preconnect::ensure_focus(&s.registry, &project_path);
    })
}

/// v0.9.7 需求12 补充（用户裁决）：关闭标签/无焦点项目时显式清空预连接池
///（幂等——随后的焦点切换会按新标签重建；主路径已由切换链覆盖，此处为
/// 显式释放语义+空态兜底）。
#[tauri::command]
pub(crate) fn plugin_preconnect_clear() -> Result<(), String> {
    crate::preconnect::shutdown_all("tab-closed");
    Ok(())
}

/// manifest.info.id 必须等于 plugin_id——文件名/会话归属/启停配置都以 id
/// 为 key，改名等于换插件，请卸载后新建）。
/// 源码读取结果（需求14 M4 R8：前端 fetch 插件文件会被 CSP connect-src 拦
///——无 asset 源，IPC 读取是唯一通路且顺带做目录越界校验）。
#[derive(Debug, serde::Serialize)]
pub(crate) struct PluginReadFile {
    pub path: String,
    pub content: String,
}

/// 读取插件源码文件（需求14 M4 G9 源码视图/编辑数据源）。
/// 需求14 补齐：保存主题资产文件（背景图等）——base64 解码写入插件目录。
#[tauri::command]
pub(crate) fn plugin_save_theme_asset(
    app: tauri::AppHandle,
    plugin_id: String,
    file_name: String,
    base64: String,
) -> Result<(), String> {
    let dir = agent::plugin::composed_plugins_dir().join(&plugin_id);
    if !dir.is_dir() {
        return Err(format!("plugin directory not found: {}", dir.display()));
    }
    // 安全校验：仅允许常见图片扩展名，拒绝路径分隔。
    let ext = file_name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["jpg", "jpeg", "png", "webp", "gif", "svg"].contains(&ext.as_str()) {
        return Err(format!(
            "unsupported asset type: .{ext} (allowed: jpg/png/webp/gif/svg)"
        ));
    }
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("invalid file name".to_string());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("asset too large (max 10MB)".to_string());
    }
    crate::util::atomic_write(&dir.join(&file_name), &bytes)
        .map_err(|e| format!("cannot write {file_name}: {e}"))?;
    // 需求14 修复：广播让 loader 重扫目录——背景图写入后 _files 清单才会
    // 包含它，主题 CSS 的 url(@file:) 才能被展开。
    use tauri::Emitter;
    let _ = app.emit("plugins-changed", ());
    Ok(())
}

/// 需求14 补齐（GUI 主题向导）：写插件目录内的 theme.css——向导产出的
/// 颜色配置落盘（与 hybrid_plugin_save 配合：先 save 存 TOML，再此写 CSS）。
#[tauri::command]
pub(crate) fn plugin_write_theme_css(
    app: tauri::AppHandle,
    plugin_id: String,
    css: String,
) -> Result<(), String> {
    let dir = agent::plugin::composed_plugins_dir().join(&plugin_id);
    if !dir.is_dir() {
        return Err(format!("plugin directory not found: {}", dir.display()));
    }
    crate::util::atomic_write(&dir.join("theme.css"), css.as_bytes())
        .map_err(|e| format!("cannot write theme.css: {e}"))?;
    use tauri::Emitter;
    let _ = app.emit("plugins-changed", ());
    Ok(())
}

/// 寻址双落点同 plugin_update：目录形态 plugins/<id>/<file> 优先；单文件
/// 形态 agents/<id>.toml 仅接受虚拟名 "plugin.toml"。安全边界：file 只允许
/// 浅层普通文件名（拒绝路径分隔/父目录段/点开头），不越出插件自身目录。
#[tauri::command]
pub(crate) fn plugin_read_file(plugin_id: String, file: String) -> Result<PluginReadFile, String> {
    if file.is_empty()
        || file.contains('/')
        || file.contains('\\')
        || file.contains("..")
        || file.starts_with('.')
    {
        return Err(format!("非法文件名: {file}（仅限插件目录内文件）"));
    }
    let read = |path: std::path::PathBuf| -> Result<PluginReadFile, String> {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        Ok(PluginReadFile {
            path: path.to_string_lossy().to_string(),
            content,
        })
    };
    // 目录形态（组合/混合/目录式 A 家族）：plugins/<id>/<file>。
    let composed = agent::plugin::composed_plugins_dir()
        .join(&plugin_id)
        .join(&file);
    if composed.is_file() {
        return read(composed);
    }
    // 单文件形态（agents/<id>.toml）：仅清单本体，虚拟名 plugin.toml。
    if file == "plugin.toml" {
        let single = agent::manifest::manifest_dir().join(format!("{plugin_id}.toml"));
        if single.is_file() {
            return read(single);
        }
    }
    Err(format!("文件不存在：{plugin_id}/{file}"))
}

#[tauri::command]
pub(crate) fn plugin_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
    manifest: serde_json::Value,
) -> Result<PluginCreated, String> {
    let mut file: agent::manifest::schema::AgentManifestFile =
        serde_json::from_value(manifest).map_err(|e| format!("invalid manifest payload: {e}"))?;
    if file.info.id != plugin_id {
        return Err(format!(
            "plugin id cannot change on edit (file is {plugin_id:?}, manifest declares {:?}) — \
             remove and re-create instead",
            file.info.id
        ));
    }
    file.validate()?;
    // v0.9.4 需求3：目录形式插件（agents/ 无、plugins/<id>/plugin.toml 有）
    // → 写回该处并剥离 [skill] 段（目录源文件即权威）；表单 skill 条目
    // 逐个渲染覆写 skills/<name>/SKILL.md（附件不动）。
    let single = agent::manifest::manifest_dir().join(format!("{plugin_id}.toml"));
    let dir_toml = agent::manifest::hub_home()
        .join("plugins")
        .join(&plugin_id)
        .join("plugin.toml");
    let (path, dir_form) = if single.exists() {
        (single, false)
    } else if dir_toml.exists() {
        (dir_toml, true)
    } else {
        return Err(format!("plugin file not found: {}", single.display()));
    };
    let skill_entries = if dir_form { file.skill.take() } else { None };
    let content_toml =
        toml::to_string_pretty(&file).map_err(|e| format!("cannot serialize manifest: {e}"))?;
    crate::util::atomic_write(&path, content_toml.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    if let Some(decl) = skill_entries {
        let root = path
            .parent()
            .expect("plugin.toml has parent")
            .join("skills");
        for (name, description, body) in decl.entries() {
            let dir_name = name.unwrap_or(&plugin_id);
            let target = root.join(dir_name).join("SKILL.md");
            if !target.exists() {
                continue; // 表单条目对应目录不存在（新建 skill 走创建流程）
            }
            let md = agent::skill_deploy::render_skill_md(dir_name, description, body);
            crate::util::atomic_write(&target, md.as_bytes())
                .map_err(|e| format!("cannot write {}: {e}", target.display()))?;
        }
    }
    rebuild_registry(&app, &state);
    log::info!("[plugin] updated {} ({})", plugin_id, path.display());
    Ok(PluginCreated {
        id: plugin_id,
        path: path.to_string_lossy().to_string(),
    })
}

/// v0.9.4 需求3：文件夹形式创建 skill 插件——manifest（含表单 skill 条目，
/// 校验后剥离 [skill] 段）落 `plugins/<id>/plugin.toml`；skill_dir 整目录
/// 复制到 `plugins/<id>/skills/<skill_name>/`，SKILL.md 以首条 skill 条目
/// 渲染覆写（表单可编辑语义）。分发走目录形式源镜像同步（含附属文件）。
#[tauri::command]
pub(crate) fn plugin_create_skill_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    manifest: serde_json::Value,
    skill_dir: String,
    skill_name: String,
) -> Result<PluginCreated, String> {
    let mut file: agent::manifest::schema::AgentManifestFile =
        serde_json::from_value(manifest).map_err(|e| format!("invalid manifest payload: {e}"))?;
    file.validate()?;
    // 首条 skill 条目 → SKILL.md 渲染（name 空则用插件 id，对齐单数形态
    // 部署目录名语义）；随后剥离 [skill] 段（目录源文件即权威，避免双源）。
    let skill_md = file.skill.as_ref().and_then(|decl| {
        decl.entries().into_iter().next().map(|(name, desc, body)| {
            agent::skill_deploy::render_skill_md(name.unwrap_or(&file.info.id), desc, body)
        })
    });
    file.skill = None;
    let content_toml =
        toml::to_string_pretty(&file).map_err(|e| format!("cannot serialize manifest: {e}"))?;
    let skill_src = std::path::PathBuf::from(&skill_dir);
    if !skill_src.is_dir() {
        return Err(format!("skill folder not found: {skill_dir}"));
    }
    let (id, path) = agent::plugin::install_skill_folder_plugin(
        &file,
        &content_toml,
        &skill_src,
        &skill_name,
        &skill_md.ok_or("folder skill manifest must declare the [skill] entry")?,
    )?;
    rebuild_registry(&app, &state);
    Ok(PluginCreated {
        id,
        path: path.to_string_lossy().to_string(),
    })
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
    agent
        .as_transport_bridge()
        .ok_or_else(|| format!("Agent {} has no transport bridge", agent_id))?
        .check_transport_bridge()
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
/// Send-safe (mirrors install_mcp_adapter; v0.8.1 需求1 M1 经
/// TransportBridgeDependency 角色分发，消除对 ClaudeCodeAgent 的硬编码).
#[tauri::command]
pub(crate) async fn install_transport_bridge(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<String, String> {
    let registry = with_app_state(&state, |s| s.registry.clone())?;
    let agent = registry
        .get(&agent_id)
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    agent
        .as_transport_bridge()
        .ok_or_else(|| format!("Agent {} has no transport bridge", agent_id))?
        .install_transport_bridge()
        .await
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
    // 重启判定以 Pi 侧 toolApproval 新旧值为准（v0.8.1 GUI 实测修复）：
    // 此前按 hub 档位对比且 None 视同 full——首次显式选择 full 不重启会话，
    // 但从未配置时 Pi 扩展的内存默认值是 smart（≠ off），旧进程继续逐次审批，
    // 完全访问档照样弹窗。凡 Pi 侧生效值变化（含 None→off）都重启。
    let old_approval = crate::agent::jishu_self::config::load_jishu_config()
        .ok()
        .and_then(|cfg| {
            cfg.get("toolApproval")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
    let approval_changed = old_approval.as_deref() != Some(tool_approval);
    let _ = crate::agent::jishu_self::config::save_jishu_config(&serde_json::json!({
        "toolApproval": tool_approval
    }));

    // hub 档位变化（驱动 GUI 选择态与策略链）同样触发重启；两判据取或，
    // hub 档位未变但 Pi 侧值变化时也要刷新（上面 approval_changed）。
    let previous =
        crate::hub::load_agent_tool_mode(&agent_id).unwrap_or_else(|| "full".to_string());
    let changed = previous != mode || approval_changed;
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
    match s
        .registry
        .require_agent(&agent_id)?
        .as_permission_mode_config()
    {
        Some(cfg) => cfg.get_permission_mode(),
        None => Ok(None),
    }
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
        .as_permission_mode_config()
        .ok_or_else(|| {
            format!(
                "Agent {} does not back permission mode by its config",
                agent_id
            )
        })?
        .set_permission_mode(&mode)
}

/// 预览目录绝对路径（2b：前端 loadHybridComponent 的 dir 参数——拼 asset URL）。
#[tauri::command]
pub(crate) fn hybrid_preview_dir() -> Result<String, String> {
    Ok(agent::plugin::composed_plugins_dir()
        .join(".preview")
        .to_string_lossy()
        .into_owned())
}

/// 混合插件 GUI 保存（v0.9.5 需求1（原需求26）3b）：向导产物落盘
/// plugins/<id>/（plugin.toml + component.js）——TOML 走 save_composed_manifest
/// 守卫，代码原子写；默认禁用 + `.pending-confirm` 标记（对齐 add-hybrid
/// 安全哲学：含代码的插件经确认卡启用，预览过也要确认）；广播热重建。
#[tauri::command]
pub(crate) fn hybrid_plugin_save(
    app: tauri::AppHandle,
    id: String,
    toml: String,
    component_js: String,
) -> Result<(), String> {
    agent::plugin::save_composed_manifest(&id, &toml)?;
    let dir = agent::plugin::composed_plugins_dir().join(&id);
    crate::util::atomic_write(&dir.join("component.js"), component_js.as_bytes())
        .map_err(|e| format!("cannot write component.js: {e}"))?;
    // 默认禁用（确认卡安全阀——GUI 亲手创建同样走确认，与 CLI 通道一致）。
    let _ = agent::plugin::set_plugin_enabled(&id, false);
    let toml_value: toml::Value = toml.parse().map_err(|e| format!("TOML 解析失败: {e}"))?;
    // 需求14 M1（02 §7 确认卡增强）：与 CLI finalize 同源计算资产清单与
    // 语言接管摘要（pending_confirm_extras 共用），两通道确认卡同形。
    let (assets, takeover) = agent::plugin::pending_confirm_extras(&dir, &toml_value);
    let pending = serde_json::json!({
        "id": id,
        "name": toml_value.get("plugin").and_then(|p| p.get("name")).and_then(|v| v.as_str()).unwrap_or(&id),
        "mount": toml_value.get("render").and_then(|r| r.get("mount")).and_then(|v| v.as_str()).unwrap_or("unknown"),
        "codeLines": component_js.lines().count(),
        "dir": dir.to_string_lossy(),
        "assets": assets,
        "takeover": takeover,
    });
    crate::util::atomic_write(
        &dir.join(".pending-confirm"),
        pending.to_string().as_bytes(),
    )
    .map_err(|e| format!("cannot write pending-confirm marker: {e}"))?;
    use tauri::Emitter;
    let _ = app.emit("plugins-changed", ());
    Ok(())
}

// ── pi 扩展导入（v0.9.5 需求1（原需求26）V4-P7）：扫描/导入/启用/忽略 ──

#[tauri::command]
pub(crate) fn pi_extension_scan() -> Vec<agent::pi_extension_import::UnregisteredExtension> {
    agent::pi_extension_import::scan_unregistered_extensions()
}

/// 摘要展示所需的安全声明常量（前端确认卡一并展示——评审 P1-7）。
#[tauri::command]
pub(crate) fn pi_extension_safety_notes() -> serde_json::Value {
    serde_json::json!({
        "arbitraryCodeWarning": agent::pi_extension_import::ARBITRARY_CODE_WARNING,
        "knownBypassSurface": agent::pi_extension_import::KNOWN_BYPASS_SURFACE,
    })
}

#[tauri::command]
pub(crate) fn pi_extension_import(path: String) -> Result<String, String> {
    agent::pi_extension_import::import_pi_extension(&path)
}

/// 8d：成套导入（extension.ts + plugin.toml + renderer.toml 三件一次装）。
#[tauri::command]
pub(crate) fn pi_extension_import_bundle(
    path: String,
) -> Result<agent::pi_extension_import::ExtensionBundleReport, String> {
    agent::pi_extension_import::import_extension_bundle(&path)
}

#[tauri::command]
pub(crate) fn pi_extension_enable(file_name: String) -> Result<(), String> {
    agent::pi_extension_import::enable_pi_extension(&file_name)
}

#[tauri::command]
pub(crate) fn pi_extension_ignore(file_name: String) -> Result<(), String> {
    agent::pi_extension_import::ignore_pi_extension(&file_name)
}

// ── v0.9.7 需求3 C2：插件市场三源 IPC ─────────────────────────────────────

/// C2-① 精选（内置市场化）：curated.json 单一真源（19 件 required + 可选件
/// + scenes）。`scene` 过滤（None=全量）。
#[tauri::command]
pub(crate) fn market_list_curated(
    scene: Option<String>,
) -> Result<Vec<agent::plugin::market::MarketEntry>, String> {
    Ok(agent::plugin::market::market_list_curated(scene.as_deref()))
}

/// v0.9.8 需求5：场景套装清单（curated: 引用启动期校验；skillhub: 安装期解析）。
#[tauri::command]
pub(crate) fn market_list_bundles() -> Result<Vec<agent::plugin::market::MarketBundle>, String> {
    Ok(agent::plugin::market::market_list_bundles())
}

// ── v0.9.8 需求5（合并版）：装备推荐数据面（equipment.db 四表） ──

/// 标签库整表（前端拉取后本地算 L0/L1；官方件档案由 curated 侧另行合并）。
#[tauri::command]
pub(crate) fn equipment_tags_list() -> Result<Vec<agent::equipment_db::EquipmentTagRow>, String> {
    agent::equipment_db::tags_list()
}

/// 需求7 补充（v0.9.8）：pi（TUI）真实 / 命令集（get_commands 探针拉取
/// ——扩展/提示模板/技能三源，10 分钟缓存；builtin 子集由前端执行映射承载）。
#[tauri::command]
pub(crate) async fn pi_slash_commands() -> Result<Vec<agent::jishu_self::slash_commands::PiSlashCommand>, String> {
    Ok(agent::jishu_self::slash_commands::fetch_pi_slash_commands().await)
}

/// 需求5（合并版）：工作区场景分析（顶层文件标记零推理；无定论 None——
/// 前端回落画像/草稿/入门）。basis 是用户可读依据（透明可解释）。
#[derive(serde::Serialize)]
pub(crate) struct WorkspaceSceneView {
    pub scene: String,
    pub basis: Vec<String>,
}

#[tauri::command]
pub(crate) fn workspace_scene(project_path: String) -> Result<Option<WorkspaceSceneView>, String> {
    // 兼容编码项目名（--C--…--形态）：市场等无真实路径的调用方传
    // load_last_project 的编码名，此处统一解码。
    let decoded = if project_path.starts_with("--") {
        crate::project::decode_project_path(&project_path)
    } else {
        project_path
    };
    Ok(agent::workspace_scene::detect_workspace_scene(std::path::Path::new(&decoded)).map(
        |r| WorkspaceSceneView {
            scene: r.scene,
            basis: r.basis,
        },
    ))
}

/// 标签 upsert（懒固化/tags_hint 回写共用；空字段不覆盖已有值）。
#[tauri::command]
pub(crate) fn equipment_tag_upsert(
    r#ref: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
    stars: Option<u8>,
    source: Option<String>,
) -> Result<(), String> {
    agent::equipment_db::tag_upsert(&r#ref, title.as_deref(), tags.as_deref(), stars, source.as_deref())
}

/// 最近一份任务画像（L1 消费：市场推荐区/输入框建议条）。
#[tauri::command]
pub(crate) fn task_profile_latest() -> Result<Option<agent::equipment_db::TaskProfileRow>, String> {
    agent::equipment_db::profile_latest()
}

/// 画像落盘（L2 推荐块解析时调用；同会话覆盖 + LRU 20）。
#[tauri::command]
pub(crate) fn task_profile_upsert(
    session_id: String,
    scene: String,
    keywords: Vec<String>,
) -> Result<(), String> {
    agent::equipment_db::profile_upsert(&session_id, &scene, &keywords)
}

/// 该会话已推 ref 清单（防重复推过滤）。
#[tauri::command]
pub(crate) fn equip_recommended_list(session_id: String) -> Result<Vec<String>, String> {
    agent::equipment_db::recommended_list(&session_id)
}

/// 该会话已推荐批次计数（限次硬闸判定）。
#[tauri::command]
pub(crate) fn equip_recommended_count(session_id: String) -> Result<i64, String> {
    agent::equipment_db::recommended_batch_count(&session_id)
}

/// 推荐记录（推荐卡首次渲染时调用；幂等）。
#[tauri::command]
pub(crate) fn equip_recommended_add(
    session_id: String,
    refs: Vec<String>,
) -> Result<(), String> {
    agent::equipment_db::recommended_add(&session_id, &refs)
}

/// 重置推荐记忆（设置页动作）。
#[tauri::command]
pub(crate) fn equip_recommended_clear() -> Result<(), String> {
    agent::equipment_db::recommended_clear()
}

/// 来源台账（诊断/版本前运行报告）。
#[tauri::command]
pub(crate) fn equip_origins_list() -> Result<Vec<agent::equipment_db::OriginRow>, String> {
    agent::equipment_db::origins_list()
}

/// 装备推荐配置（六键；默认值 hub.rs 单源）。
#[derive(serde::Serialize)]
pub(crate) struct EquipConfigView {
    pub enabled: bool,
    pub session_card: bool,
    pub session_limit: u32,
    pub input_bar: bool,
    pub market_zone: bool,
    pub third_party: bool,
}

#[tauri::command]
pub(crate) fn equip_config_get() -> Result<EquipConfigView, String> {
    let c = crate::hub::equip_recommend_config();
    Ok(EquipConfigView {
        enabled: c.enabled,
        session_card: c.session_card,
        session_limit: c.session_limit,
        input_bar: c.input_bar,
        market_zone: c.market_zone,
        third_party: c.third_party,
    })
}

/// 配置局部更新（None 字段不动）。
#[tauri::command]
pub(crate) fn equip_config_set(
    enabled: Option<bool>,
    session_card: Option<bool>,
    session_limit: Option<u32>,
    input_bar: Option<bool>,
    market_zone: Option<bool>,
    third_party: Option<bool>,
) -> Result<(), String> {
    crate::hub::set_equip_recommend_config(
        enabled,
        session_card,
        session_limit,
        input_bar,
        market_zone,
        third_party,
    )
}

/// C2-① 安装（幂等；pi-package 形态含 npm 包安装）。评审 P1-8：成功后
/// rebuild_registry 热生效——清单/分发/settings.json packages 即时刷新
/// （对齐 skillhub_install 既有写法，装完不用重启/手动刷新）。
/// v0.9.8 需求5（合并版）：meta 携带推荐链路来源（via）与 agent 推荐理由
/// 标签（tags）——安装收尾挂进 equipment.db（来源台账+标签固化）。
#[tauri::command]
pub(crate) async fn market_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
    meta: Option<agent::equipment_db::InstallMeta>,
) -> Result<String, String> {
    let result = agent::plugin::market::market_install(&plugin_id).await?;
    let meta = meta.unwrap_or_default();
    let _ = agent::equipment_db::record_install(
        &format!("curated:{plugin_id}"),
        meta.via_or_manual(),
        None,
        meta.tags.as_deref(),
    );
    rebuild_registry(&app, &state);
    Ok(result)
}

/// C2-① 卸载（还原未部署态；required 拒绝）。评审 P1-8：成功后
/// rebuild_registry 热生效（对齐 skillhub_uninstall 的统一卸载链）。
#[tauri::command]
pub(crate) async fn market_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
) -> Result<String, String> {
    let result = agent::plugin::market::market_uninstall(&plugin_id).await?;
    // 04-R3：同 plugin_remove——卸载后刷新 agent-tool 物化清单（防幽灵
    // 工具残留，三卸载链同收口）。
    agent::plugin::materialize_agent_tools();
    rebuild_registry(&app, &state);
    Ok(result)
}

/// C2-② 扩展生态：pi npm 扩展包目录（首批 = 钉版 5 包静态清单；在线
/// registry 检索二期评估）。
#[derive(serde::Serialize)]
pub(crate) struct PiPackageEntry {
    pub plugin_id: String,
    pub name: String,
    pub source: String,
    pub version: String,
    pub description: String,
    pub installed: bool,
}

#[tauri::command]
pub(crate) fn pi_package_catalog() -> Result<Vec<PiPackageEntry>, String> {
    fn describe(pkg: &str) -> &'static str {
        match pkg {
            "pi-subagents" => "子代理委派工具的底层包（subagent/bg_wait）",
            "@juicesharp/rpiv-ask-user-question" => "选项式提问工具包（ask_user_question）",
            "@juicesharp/rpiv-todo" => "待办清单工具包（todo）",
            "pi-lens" => "写后诊断工具包（lens_diagnostics/ast_grep 等 13 工具）",
            "pi-web-access" => "联网搜索抓取工具包（web_search/fetch_content 等）",
            _ => "pi 扩展包",
        }
    }
    let base = agent::jishu_self::pi_config_dir()
        .map(|d| std::path::PathBuf::from(d).join("npm").join("node_modules"))
        .unwrap_or_default();
    let mut out = Vec::new();
    for (plugin_id, pkg) in agent::plugin::PI_PACKAGE_PLUGIN_MAP {
        let Some(source) = agent::jishu_self::JishuSelfAgent::pinned_source_for_package(pkg) else {
            continue;
        };
        let version = source.rsplit('@').next().unwrap_or_default().to_string();
        out.push(PiPackageEntry {
            plugin_id: plugin_id.to_string(),
            name: pkg.to_string(),
            source: source.to_string(),
            version,
            description: describe(pkg).to_string(),
            installed: base.join(pkg).is_dir(),
        });
    }
    Ok(out)
}

/// C2-③ 技能市场：列表（场景分组/搜索/分页）。
#[tauri::command]
pub(crate) async fn skillhub_list(
    scene: Option<String>,
    keyword: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<agent::skillhub::SkillhubListResult, String> {
    agent::skillhub::skillhub_list(
        scene.as_deref(),
        keyword.as_deref(),
        page.unwrap_or(1),
        page_size.unwrap_or(20),
    )
    .await
}

/// C2-③ 技能市场：详情。
#[tauri::command]
pub(crate) async fn skillhub_detail(
    slug: String,
) -> Result<agent::skillhub::SkillhubEntry, String> {
    agent::skillhub::skillhub_detail(&slug).await
}

/// C2-③ 技能市场：安装台账（市场「已安装」态）。
#[tauri::command]
pub(crate) fn skillhub_installed() -> Result<std::collections::BTreeMap<String, String>, String> {
    Ok(agent::skillhub::skillhub_installed())
}

/// C2-③ 技能市场：安装（下载→校验→注册为 hub 目录形式插件→分发→记台账；
/// 2026-11-14 用户裁决：安装导入 jishu hub 已安装，走 hub 插件链）。
/// v0.9.8 需求5（合并版）：meta 携带 via/title/tags——安装收尾挂 equipment.db。
#[tauri::command]
pub(crate) async fn skillhub_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    slug: String,
    meta: Option<agent::equipment_db::InstallMeta>,
) -> Result<String, String> {
    let result = agent::skillhub::skillhub_install(&slug).await?;
    let meta = meta.unwrap_or_default();
    let _ = agent::equipment_db::record_install(
        &format!("skillhub:{slug}"),
        meta.via_or_manual(),
        meta.title.as_deref(),
        meta.tags.as_deref(),
    );
    // 插件清单/分发即时刷新（对齐 plugin_create_skill_folder 的安装后处理）。
    rebuild_registry(&app, &state);
    Ok(result)
}

/// C2-③ 技能市场：卸载（hub 插件形态走统一卸载链，另清台账）。
#[tauri::command]
pub(crate) fn skillhub_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    slug: String,
) -> Result<String, String> {
    if agent::skillhub::hub_plugin_root(&slug).is_some() {
        plugin_remove(app, state, slug.clone())?;
    }
    agent::skillhub::skillhub_uninstall(&slug)
}

// ── 需求7 修1a：扩展生态在线库（pi.dev 画廊同源约定 = npm registry
//    `keywords:pi-package` 检索；安装走 pi install npm:<spec> 通道）──

#[derive(serde::Serialize)]
pub(crate) struct PiOnlinePackage {
    pub name: String,
    pub version: String,
    pub description: String,
    pub publisher: String,
    pub date: String,
}

/// npm registry 检索 pi-package 关键字包（keyword 为空 = 全量按相关度）。
#[tauri::command]
pub(crate) async fn pi_package_search(
    keyword: Option<String>,
) -> Result<Vec<PiOnlinePackage>, String> {
    let text = match keyword.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(kw) => format!("keywords:pi-package {kw}"),
        None => "keywords:pi-package".to_string(),
    };
    let url = format!(
        "https://registry.npmjs.org/-/v1/search?text={}&size=30",
        urlencode(&text)
    );
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("jishu-hub/0.9.7")
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("网络不可用: {e}"))?;
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    let objects = body
        .get("objects")
        .and_then(|v| v.as_array())
        .ok_or("npm registry 响应结构异常")?;
    let mut out = Vec::new();
    for obj in objects {
        let pkg = match obj.get("package") {
            Some(p) => p,
            None => continue,
        };
        // 双保险：部分包描述词不全，只在 keywords 含 pi-package 时入选。
        let keywords = pkg
            .get("keywords")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|k| k.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !keywords.iter().any(|k| k == "pi-package") {
            continue;
        }
        out.push(PiOnlinePackage {
            name: pkg
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            version: pkg
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            description: pkg
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .chars()
                .take(120)
                .collect(),
            publisher: pkg
                .get("publisher")
                .and_then(|p| p.get("username"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            date: obj
                .get("date")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .chars()
                .take(10)
                .collect(),
        });
    }
    out.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 已装在线扩展的**实装版本**（v0.9.7 需求3 十七轮⑧：市场件版本号显示
/// 真源）——读 npm 装载目录 node_modules/<pkg>/package.json 的 version。
/// settings.json packages 的 `@version` 后缀是安装意图快照：浮动安装
///（pi install npm:pkg 不带版本）无后缀、更新后不回写——均显示不出
/// 真实版本；实装目录才是权威。读不到返回空表（前端兜底走源解析）。
#[tauri::command]
pub(crate) async fn pi_package_installed_versions(
) -> Result<std::collections::HashMap<String, String>, String> {
    // 第三轮评审修复：同步命令在主线程遍历全 node_modules（实测 218 包，
    // 含传递依赖）逐包读文件+解析 JSON——包多时可感知卡顿。下沉
    // spawn_blocking（对齐 piindex_search 等重 IO 命令的分层惯例）。
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(agent_dir) = agent::jishu_self::paths::agent_dir() else {
            return Ok(std::collections::HashMap::new());
        };
        let modules_dir = agent_dir.join("npm").join("node_modules");
        let mut out = std::collections::HashMap::new();
        let Ok(entries) = std::fs::read_dir(&modules_dir) else {
            return Ok(out);
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // scoped 包（@scope/pkg）在两级子目录——scope 目录本身无清单。
            let dirs: Vec<std::path::PathBuf> = if name.starts_with('@') {
                std::fs::read_dir(entry.path())
                    .map(|sub| sub.flatten().map(|e| e.path()).collect())
                    .unwrap_or_default()
            } else {
                vec![entry.path()]
            };
            for dir in dirs {
                let manifest = dir.join("package.json");
                let Ok(content) = std::fs::read_to_string(&manifest) else {
                    continue;
                };
                let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) else {
                    continue;
                };
                let (Some(name), Some(version)) = (
                    pkg.get("name").and_then(|v| v.as_str()),
                    pkg.get("version").and_then(|v| v.as_str()),
                ) else {
                    continue;
                };
                if !version.is_empty() {
                    out.insert(name.to_string(), version.to_string());
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("scan node_modules failed: {e}"))?
}

/// 当前 settings.json packages 数组（在线包「已安装」判定真源）。
#[tauri::command]
pub(crate) fn pi_package_installed_sources() -> Result<Vec<String>, String> {
    let Ok(agent_dir) = agent::jishu_self::paths::agent_dir() else {
        return Ok(Vec::new());
    };
    let content = std::fs::read_to_string(agent_dir.join("settings.json")).unwrap_or_default();
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Ok(Vec::new());
    };
    Ok(settings
        .get("packages")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

/// 内置 pi 扩展钉版清单（v0.9.7 需求3 已安装统一页）：hub 分发时的版本
/// 快照——「还原系统原生版本」的锚点（编译期常量随包走，升级即新快照）。
/// 第三轮评审修复：删 rename_all="camelCase"（§4 跨端序列化一律
/// snake_case——三字段恰为单词无实际影响，但声明给后续加多词字段埋雷）。
#[derive(serde::Serialize)]
pub(crate) struct BuiltinPin {
    pub source: String,
    pub package: String,
    pub version: String,
}

#[tauri::command]
pub(crate) fn pi_package_builtin_pins() -> Result<Vec<BuiltinPin>, String> {
    Ok(agent::jishu_self::builtin_extensions()
        .iter()
        .map(|(source, _dir, _display)| {
            // 第三轮评审修复：换 parse_npm_source（rsplit 对 scoped 无版本
            // 源会解出空包名 + 乱码版本——还原锚点失真）。
            let (package, version) = agent::jishu_self::parse_npm_source(source);
            BuiltinPin {
                source: source.to_string(),
                package,
                version,
            }
        })
        .collect())
}

/// 在线包安装/卸载（npm/git 源直达；不走 curated 插件闸门——装的是 pi
/// 扩展包本体，非 hub 插件条目）。git 源形如 git:github.com/owner/repo
/// （piindex 目录 GitHub 直装卡）。
/// 需求15 方案 A：单条冲突信息（确认卡呈现）。
#[derive(serde::Serialize)]
pub(crate) struct PiConflictInfo {
    /// 冲突工具名（如 web_search）。
    pub tool: String,
    /// 对手完整注册串（如 npm:pi-web-access@0.32.0；停用/恢复按此寻址）。
    pub opponent_source: String,
    /// 对手展示名（内置→中文名；用户装→包名）。
    pub opponent_display: String,
    /// 对手是否内置包（内置只能停用不可删除；卡上显示替代提示）。
    pub opponent_builtin: bool,
}

/// 需求15 方案 A：在线安装结果（结构化——前端据 status 分流：冲突弹
/// 确认卡，用户「停用并安装」后调 pi_package_install_confirmed）。
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum PiInstallOutcome {
    /// 安装成功且引擎健康。
    Installed,
    /// 工具名冲突——已自动卸载回滚，等用户决断（取消=保持未装；继续=
    /// confirmed 命令重装并停用对手）。
    Conflict { conflicts: Vec<PiConflictInfo> },
}

/// 从冲突对组装对手信息（方向过滤：非目标包的一方=对手；对手注册串经
/// pi settings 反查；展示名：内置→固定映射，用户装→包目录名）。
fn conflict_infos_from_pairs(
    pairs: Vec<agent::jishu_self::ConflictPair>,
    target_pkg: &str,
) -> Vec<PiConflictInfo> {
    pairs
        .into_iter()
        .filter_map(|p| {
            let opponent_pkg = if p.self_pkg == target_pkg {
                p.opponent_pkg
            } else if p.opponent_pkg == target_pkg {
                p.self_pkg
            } else {
                return None;
            };
            let builtin =
                agent::jishu_self::pi_registry::builtin_pi_display_name(&opponent_pkg).is_some();
            let opponent_source =
                agent::jishu_self::pi_registry::registered_source_of(&opponent_pkg)
                    .unwrap_or_else(|| format!("npm:{opponent_pkg}"));
            let opponent_display =
                agent::jishu_self::pi_registry::builtin_pi_display_name(&opponent_pkg)
                    .unwrap_or_else(|| opponent_pkg.clone());
            Some(PiConflictInfo {
                tool: p.tool,
                opponent_source,
                opponent_display,
                opponent_builtin: builtin,
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn pi_package_install_online(
    source: String,
    meta: Option<agent::equipment_db::InstallMeta>,
) -> Result<PiInstallOutcome, String> {
    let source = source.trim().to_string();
    if !(source.starts_with("npm:") || source.starts_with("git:")) {
        return Err("仅支持 npm:/git: 前缀源（如 npm:pi-fireworks@0.1.2）".to_string());
    }
    // 需求15 方案 A v2（用户裁决：「装的时候判断工具是否已存在，而不是
    // 判断报错」）——npm 源走**注册前预检**：npm 装文件到池（settings
    // 全程不动）→ `pi -e <入口>` 装载试运行（装载器权威判定冲突）→
    // 无冲突才 pi install 补注册；有冲突返回结构化清单（环境零残留）。
    if let Some(pkg) = source.strip_prefix("npm:") {
        let pkg = match pkg.rsplit_once('@') {
            Some((n, v)) if !n.is_empty() && !v.is_empty() && !n.ends_with('/') => n.to_string(),
            _ => pkg.to_string(),
        };
        return match agent::jishu_self::JishuSelfAgent::precheck_extension(&pkg).await {
            Err(e) => Err(e),
            Ok(None) => {
                // 预检通过（文件已在池）——补注册 + 终验兜底。
                agent::jishu_self::JishuSelfAgent::run_pi_package_command("install", &source)
                    .await
                    .map_err(|e| format!("安装失败：{e}"))?;
                match agent::jishu_self::JishuSelfAgent::verify_engine_boot().await {
                    Ok(()) => {
                        record_pi_install(&source, &meta);
                        Ok(PiInstallOutcome::Installed)
                    }
                    Err(f) => {
                        agent::jishu_self::JishuSelfAgent::run_pi_package_command(
                            "remove", &source,
                        )
                        .await
                        .ok();
                        agent::jishu_self::JishuSelfAgent::rollback_npm_files(&pkg).await;
                        Err(format!(
                            "「{source}」安装后自检未通过（{}），已回滚。可换版本重试或反馈给插件作者。",
                            f.reason
                        ))
                    }
                }
            }
            Ok(Some(pairs)) => {
                let conflicts = conflict_infos_from_pairs(pairs, &pkg);
                if conflicts.is_empty() {
                    agent::jishu_self::JishuSelfAgent::rollback_npm_files(&pkg).await;
                    return Err("预检异常：冲突未指向本包，已回滚。".to_string());
                }
                // 冲突：文件保留（确认流复用；取消时前端无法清理——由
                // confirmed/下次预检幂等覆盖；settings 未动 = 引擎健康）。
                Ok(PiInstallOutcome::Conflict { conflicts })
            }
        };
    }
    // git 源：无独立文件层可预装（pi install 装载+注册一体）——回落装后
    // 探针流（冲突解析同语义，检出即回滚转确认）。
    agent::jishu_self::JishuSelfAgent::run_pi_package_command("install", &source)
        .await
        .map_err(|e| format!("安装失败：{e}"))?;
    match agent::jishu_self::JishuSelfAgent::verify_engine_boot().await {
        Ok(()) => {
            record_pi_install(&source, &meta);
            Ok(PiInstallOutcome::Installed)
        }
        Err(failure) => {
            let pkg = source.replace("git:", "");
            let conflicts = conflict_infos_from_pairs(
                agent::jishu_self::extract_conflict_pairs(&failure.stderr_tail),
                &pkg,
            );
            let rollback =
                agent::jishu_self::JishuSelfAgent::run_pi_package_command("remove", &source).await;
            if !conflicts.is_empty() {
                return Ok(PiInstallOutcome::Conflict { conflicts });
            }
            let rollback_note = match rollback {
                Ok(_) => "已自动卸载".to_string(),
                Err(_) => "自动卸载未成功，请到插件市场手动卸载".to_string(),
            };
            Err(format!(
                "「{source}」与当前运行环境不兼容（{}），{rollback_note}。可换版本重试或反馈给插件作者。",
                failure.reason
            ))
        }
    }
}

/// 需求5（合并版）：pi 扩展安装成功收尾挂 equipment.db（来源台账+标签
/// 固化；ref 用 `pi:<去版本 source>` 归一——同包升级不堆行）。
fn record_pi_install(source: &str, meta: &Option<agent::equipment_db::InstallMeta>) {
    let meta = meta.clone().unwrap_or_default();
    // npm:pkg@1.2 → pi:npm:pkg（去版本，与 equipment ref 语法一致）。
    let base = source.rsplit_once('@').map(|(n, _)| n.to_string()).unwrap_or_else(|| source.to_string());
    let _ = agent::equipment_db::record_install(
        &format!("pi:{base}"),
        meta.via_or_manual(),
        meta.title.as_deref(),
        meta.tags.as_deref(),
    );
}

/// 需求15 方案 A：冲突确认后的「停用并安装」。流程（服务端自证，不信任
/// 前端传参）：确保文件在池（预检保留/复装）→ 停用全部对手（仅移 pi
/// 注册不删文件 + 台账）→ pi install 补注册 → 终验探针 → 仍失败则全
/// 回滚（恢复对手注册与台账 + 卸载新装）。成功返回被停用清单。
#[derive(serde::Serialize)]
pub(crate) struct PiInstallConfirmed {
    pub disabled: Vec<PiConflictInfo>,
}

#[tauri::command]
pub(crate) async fn pi_package_install_confirmed(
    source: String,
) -> Result<PiInstallConfirmed, String> {
    let source = source.trim().to_string();
    let pkg = source
        .strip_prefix("npm:")
        .map(|rest| match rest.rsplit_once('@') {
            Some((n, v)) if !n.is_empty() && !v.is_empty() && !n.ends_with('/') => n.to_string(),
            _ => rest.to_string(),
        });
    // 文件保障：预检可能因取消被回滚（或从未预检）——复装（幂等）。
    if let Some(pkg) = &pkg {
        let Some(agent_dir) = agent::jishu_self::pi_config_dir() else {
            return Err("无法定位 pi 运行数据目录".to_string());
        };
        let pkg_dir = std::path::Path::new(&agent_dir)
            .join("npm")
            .join("node_modules")
            .join(pkg);
        if !pkg_dir.exists() {
            if let Err(e) = agent::jishu_self::JishuSelfAgent::precheck_extension(pkg).await {
                return Err(e);
            }
        }
    }
    // 注册 + 终验（先探针后停用？不——冲突仍在必失败。顺序：装载探测
    // 冲突对手（服务端自证）→ 停用 → 终验）。
    agent::jishu_self::JishuSelfAgent::run_pi_package_command("install", &source)
        .await
        .map_err(|e| format!("安装失败：{e}"))?;
    let target_pkg = pkg.clone().unwrap_or_else(|| source.replace("git:", ""));
    let conflicts = match agent::jishu_self::JishuSelfAgent::verify_engine_boot().await {
        Ok(()) => {
            // 对手已被用户先行处置（如手动卸载）——无冲突直接成功。
            return Ok(PiInstallConfirmed {
                disabled: Vec::new(),
            });
        }
        Err(f) => {
            let list = conflict_infos_from_pairs(
                agent::jishu_self::extract_conflict_pairs(&f.stderr_tail),
                &target_pkg,
            );
            if list.is_empty() {
                agent::jishu_self::JishuSelfAgent::run_pi_package_command("remove", &source)
                    .await
                    .ok();
                if let Some(p) = &pkg {
                    agent::jishu_self::JishuSelfAgent::rollback_npm_files(p).await;
                }
                return Err(format!(
                    "「{source}」安装后自检失败（{}），已回滚。可反馈给插件作者。",
                    f.reason
                ));
            }
            list
        }
    };
    // 停用全部对手（移注册不删文件）。
    for c in &conflicts {
        if let Err(e) = agent::jishu_self::pi_registry::disable_extension(
            &c.opponent_source,
            &c.opponent_display,
            &source,
        ) {
            log::warn!("[pi-registry] 停用 {} 失败: {e}", c.opponent_source);
        }
    }
    // 终验：引擎应健康（冲突对手已下线）。
    if let Err(f2) = agent::jishu_self::JishuSelfAgent::verify_engine_boot().await {
        // 全回滚：恢复对手注册/台账，卸载新装——任何落盘状态必须健康。
        for c in &conflicts {
            let pkg = agent::jishu_self::pi_registry::package_dir_of(&c.opponent_source)
                .unwrap_or_else(|| c.opponent_source.clone());
            let _ = agent::jishu_self::pi_registry::enable_extension(&pkg);
        }
        agent::jishu_self::JishuSelfAgent::run_pi_package_command("remove", &source)
            .await
            .ok();
        if let Some(p) = &pkg {
            agent::jishu_self::JishuSelfAgent::rollback_npm_files(p).await;
        }
        return Err(format!(
            "「{source}」停用冲突项后自检仍未通过（{}），已全部回滚。",
            f2.reason
        ));
    }
    Ok(PiInstallConfirmed {
        disabled: conflicts,
    })
}

/// 需求15 方案 A：停用台账查询（市场卡呈现「已停用（被 XX 替代）」）。
#[tauri::command]
pub(crate) fn pi_extension_overrides_list() -> Vec<agent::jishu_self::pi_registry::PiOverrideEntry>
{
    agent::jishu_self::pi_registry::load_overrides()
}

// ── 需求4 D4-8/D4-8b：扩展统一登记簿查询与判定落档 ──

/// 全量扩展清单（含 adapters 反查）——已装页「扩展包」tab 与市场已装卡
/// 的「界面」行消费（gui_verdict=adapted 为派生值）。
#[tauri::command]
pub(crate) fn extension_registry_list(
) -> Result<Vec<agent::extensions_db::ExtensionEntryView>, String> {
    agent::extensions_db::ensure_schema()?;
    agent::extensions_db::registry_list()
}

/// 插件依赖视图——适配件「基于」行消费（plugin_id → deps）。
#[tauri::command]
pub(crate) fn plugin_extension_deps() -> Result<Vec<agent::extensions_db::PluginDepView>, String> {
    agent::extensions_db::ensure_schema()?;
    agent::extensions_db::plugin_deps()
}

/// D4-7 第 0 步判定结果落档（pending|noneeded；adapted 为派生不落库）。
/// 与 CLI `jishu-cli extensions verdict` 共用实现——agent 在会话中经 CLI
/// 直写登记簿，GUI 即时可见。
#[tauri::command]
pub(crate) fn extension_gui_verdict_set(
    pkg_key: String,
    verdict: String,
    note: Option<String>,
) -> Result<(), String> {
    agent::extensions_db::set_verdict(&pkg_key, &verdict, note.as_deref())
}

// ── 需求16：迁移状态查询与重试（前端阻断卡/进度呈现） ──

#[tauri::command]
pub(crate) fn migration_status() -> serde_json::Value {
    crate::migrations::status()
}

#[tauri::command]
pub(crate) fn migration_retry(app: tauri::AppHandle) -> Result<(), String> {
    crate::migrations::run_pending(Some(app))
}

/// 在线包卸载源归一（评审追加·「在线扩展补卸载」后端半边）：签名统一接受
/// `source`（npm:pkg / git:github.com/... 形态，与安装源同源）；兼容既有
/// 裸包名调用（npm 兜底——历史前端传 {name}）。返回 (归一 source, npm 包名)。
fn normalize_uninstall_source(source: &str) -> (String, Option<String>) {
    let trimmed = source.trim();
    if trimmed.starts_with("npm:") {
        // 去版本尾段取包名（scoped 包 @org/name 的首 @ 不受 rsplit 影响）。
        let name = trimmed
            .strip_prefix("npm:")
            .and_then(|rest| match rest.rsplit_once('@') {
                Some((n, v)) if !n.is_empty() && !v.is_empty() => Some(n.to_string()),
                _ => Some(rest.to_string()),
            })
            .filter(|n| !n.is_empty());
        (trimmed.to_string(), name)
    } else if trimmed.starts_with("git:") {
        (trimmed.to_string(), None) // git 源无 npm 包名
    } else {
        (format!("npm:{trimmed}"), Some(trimmed.to_string()))
    }
}

/// 卸载守卫：pi_package_catalog 内置 5 包（PI_PACKAGE_PLUGIN_MAP 全集）与
/// curated required（默认安装集）pi-package 件拒绝卸载——默认安装集不可
/// 拆，误卸会破坏开箱能力（用户裁决「在线扩展补卸载」的边界）。
fn guard_uninstall_target(pkg: Option<&str>) -> Result<(), String> {
    let Some(pkg) = pkg else {
        return Ok(()); // git 源不在内置/required 名单语义内
    };
    if agent::plugin::PI_PACKAGE_PLUGIN_MAP
        .iter()
        .any(|(_, p)| *p == pkg)
    {
        return Err("系统内置/必装扩展不可卸载".to_string());
    }
    // curated required 名单件按插件 id 比对（历史调用可能传 id 形态）。
    if agent::plugin::market::required_pi_package_ids()
        .iter()
        .any(|id| *id == pkg)
    {
        return Err("系统内置/必装扩展不可卸载".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn pi_package_uninstall_online(source: String) -> Result<String, String> {
    let (source, pkg) = normalize_uninstall_source(&source);
    guard_uninstall_target(pkg.as_deref())?;
    agent::jishu_self::JishuSelfAgent::run_pi_package_command("remove", &source).await?;
    // 需求15 方案 A 恢复链：
    // ①被停用者自身删除 → 清台账条目；
    // ②替代者卸载 → 自动恢复被它顶掉的扩展（注册加回，零网络——文件
    //   未删）。恢复后探针验证引擎健康；不健康（理论不该发生）则回退
    //   恢复并如实记日志，不阻塞卸载结果。
    if let Some(pkg_dir) = pkg.as_deref() {
        agent::jishu_self::pi_registry::forget_disabled(pkg_dir)?;
    }
    let restored = agent::jishu_self::pi_registry::restore_replaced_by(&source);
    // 需求4 D4-8b（R2-T2 实测抓到的卸载级联缺口）：扩展卸载后依赖它的
    // 适配件**联动停用**（数据来源没了不该半死不活地跑——与停用路径同
    // 语义；台账记行，扩展重装后经 reconcile 恢复）。
    let cascaded = pkg
        .as_deref()
        .and_then(|dir| agent::extensions_db::pkg_key_of(dir))
        .map(|pkg_key| agent::extensions_db::cascade_disable_adapters(&pkg_key))
        .unwrap_or_default();
    let mut note = format!("{source} 已卸载");
    if !cascaded.is_empty() {
        note.push_str(&format!("；已停用界面插件 {}", cascaded.join("、")));
    }
    if !restored.is_empty() {
        if agent::jishu_self::JishuSelfAgent::verify_engine_boot()
            .await
            .is_ok()
        {
            let names: Vec<&str> = restored.iter().map(|e| e.display.as_str()).collect();
            note.push_str(&format!("；已恢复 {}", names.join("、")));
        } else {
            // 恢复后引擎不健康——回退恢复（注册再移回+台账补记）保健康态。
            for e in &restored {
                if let Some(dir) = agent::jishu_self::pi_registry::package_dir_of(&e.source) {
                    let _ = agent::jishu_self::pi_registry::disable_extension(
                        &e.source, &e.display, &source,
                    );
                    log::warn!("[pi-registry] 恢复 {} 后自检未通过，已回退停用", dir);
                }
            }
        }
    }
    Ok(note)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(id: &str, display_name: &str) -> SessionToolInfo {
        SessionToolInfo {
            id: id.to_string(),
            display_name: display_name.to_string(),
            description: String::new(),
            usage: String::new(),
            enabled: false,
            injectable: true,
            category: "cli".to_string(),
            keep_text: false,
        }
    }

    /// v0.9.8 评审修复轮 R1-5：发送入口统一解析工具引用——`@[显示名]`
    /// 归一为工具 id（按出现顺序，重复只算一次）；未匹配的引用不产生 id；
    /// 没有引用 = 本条不带工具（所见即所得）。
    #[test]
    fn resolve_tool_refs_matches_display_names_in_order() {
        let entries = [tool("tool-a", "甲工具"), tool("npm:ext-b", "乙扩展")];
        assert_eq!(
            resolve_tool_refs("请用 @[甲工具] 和 @[乙扩展]", &entries),
            vec!["tool-a".to_string(), "npm:ext-b".to_string()]
        );
        assert_eq!(
            resolve_tool_refs("@[甲工具] 再 @[甲工具] 还有 @[不存在的]", &entries),
            vec!["tool-a".to_string()]
        );
        assert_eq!(
            resolve_tool_refs("这条消息没有引用", &entries),
            Vec::<String>::new()
        );
    }

    /// 评审追加：卸载源归一——npm:/git: 原样透传（npm 带版本取包名），
    /// 裸包名 npm 兜底（历史前端传 {name}）。
    #[test]
    fn normalize_uninstall_source_forms() {
        let (src, pkg) = normalize_uninstall_source("npm:pi-fireworks@0.1.2");
        assert_eq!(src, "npm:pi-fireworks@0.1.2");
        assert_eq!(pkg.as_deref(), Some("pi-fireworks"));
        let (_, pkg) = normalize_uninstall_source("npm:@scope/pkg@1.0.0");
        assert_eq!(pkg.as_deref(), Some("@scope/pkg"));
        let (src, pkg) = normalize_uninstall_source("some-pkg");
        assert_eq!(src, "npm:some-pkg");
        assert_eq!(pkg.as_deref(), Some("some-pkg"));
        // git 源无 npm 包名。
        let (src, pkg) = normalize_uninstall_source("git:github.com/owner/repo");
        assert_eq!(src, "git:github.com/owner/repo");
        assert_eq!(pkg, None);
    }

    /// 评审追加：卸载守卫——内置 5 包与 curated required 名单件拒绝，
    /// 普通在线包/git 源放行。
    #[test]
    fn guard_uninstall_target_rejects_builtin_and_required() {
        // 内置 5 包（PI_PACKAGE_PLUGIN_MAP 全集抽两样代表：裸名与 scoped）。
        for builtin in ["pi-lens", "pi-web-access", "@juicesharp/rpiv-todo"] {
            let err = guard_uninstall_target(Some(builtin)).unwrap_err();
            assert!(
                err.contains("系统内置/必装扩展不可卸载"),
                "{builtin} → {err}"
            );
        }
        // curated required 名单件按 id 形态（如历史传 id）同样拒绝。
        assert!(guard_uninstall_target(Some("jishu-subagent")).is_err());
        // 普通在线包与 git 源放行。
        assert!(guard_uninstall_target(Some("pi-fireworks")).is_ok());
        assert!(guard_uninstall_target(Some("npm:any-pkg@2.0")).is_ok());
        assert!(guard_uninstall_target(None).is_ok());
    }
}
