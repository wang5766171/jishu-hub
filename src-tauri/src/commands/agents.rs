use std::sync::Mutex;
use std::collections::HashMap;

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

    std::fs::remove_file(&source_path).map_err(|e| format!("Cannot remove {source_path}: {e}"))?;
    let _ = agent::plugin::set_plugin_enabled(&plugin_id, true); // 清 disabled 引用（忽略结果：id 即将消失）
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
    /// 到 agent skill 目录，注入提示块）；cli = 传统 [tool] 用法注入。
    pub category: String,
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
    tools
        .iter()
        .filter(|p| p.enabled)
        .map(|p| SessionToolInfo {
            id: p.id().to_string(),
            display_name: p.file.info.display_name.clone(),
            description: p
                .file
                .tool
                .as_ref()
                .map(|t| t.description.clone())
                .unwrap_or_default(),
            usage: p
                .file
                .tool
                .as_ref()
                .map(|t| t.usage.clone())
                .unwrap_or_default(),
            enabled: selected.contains(p.id()),
            injectable: p.file.tool.is_some() || p.file.mcp.is_some() || p.file.skill.is_some(),
            category: if p.file.mcp.is_some() {
                "mcp".to_string()
            } else if p.file.skill.is_some() {
                "skill".to_string()
            } else {
                "cli".to_string()
            },
        })
        .collect()
}

/// 设置会话启用的工具插件集合（prompt 注入依据；空集合移除条目）。
#[tauri::command]
pub(crate) fn session_set_tools(session_id: String, tool_ids: Vec<String>) -> Result<(), String> {
    agent::tool_plugin::set_session_tools(&session_id, &tool_ids)
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
    let s = state
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
    id: String,
    toml: String,
) -> Result<(), String> {
    agent::plugin::save_composed_manifest(&id, &toml)?;
    use tauri::Emitter;
    let _ = app.emit("plugins-changed", ());
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

/// v0.9.3 需求13 C3：删除用户组合插件（内置拒绝）并广播。
#[tauri::command]
pub(crate) fn composed_plugin_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    agent::plugin::delete_composed_plugin(&id)?;
    use tauri::Emitter;
    let _ = app.emit("plugins-changed", ());
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

/// v0.9.3 需求12 P1：插件配置面——全量读取（前端与 defaults 合并）。
#[tauri::command]
pub(crate) fn plugin_config_get_all() -> Result<HashMap<String, HashMap<String, serde_json::Value>>, String> {
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
    use tauri::Emitter;
    let _ = app.emit(
        "plugins-config-changed",
        serde_json::json!({ "pluginId": plugin_id }),
    );
    Ok(())
}

/// manifest.info.id 必须等于 plugin_id——文件名/会话归属/启停配置都以 id
/// 为 key，改名等于换插件，请卸载后新建）。
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
        let root = path.parent().expect("plugin.toml has parent").join("skills");
        for (name, description, body) in decl.entries() {
            let dir_name = name.unwrap_or(&plugin_id);
            let target = root.join(dir_name).join("SKILL.md");
            if !target.exists() {
                continue; // 表单条目对应目录不存在（新建 skill 走创建流程）
            }
            let md = agent::skill_deploy::render_skill_md(dir_name, description, body);
            crate::util::atomic_write(&target, md.as_bytes()).map_err(|e| {
                format!("cannot write {}: {e}", target.display())
            })?;
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
    agent
        .as_mcp()
        .ok_or_else(|| format!("Agent {} does not support MCP", agent_id))?
        .check_mcp()
}

/// Install MCP adapter for a specific agent (routed through adapter contract).
/// The MutexGuard is released before .await to keep the future Send-safe:
/// clone the Arc'd registry out of the lock, then resolve the adapter again
/// outside it (v0.8.1 需求1 M1：原先此处硬编码 JishuSelfAgent 静态方法，属
/// commands 层 agent 具体类型违纪，现经 McpIntegration 角色分发).
#[tauri::command]
pub(crate) async fn install_mcp_adapter(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<String, String> {
    let registry = with_app_state(&state, |s| s.registry.clone())?;
    let agent = registry
        .get(&agent_id)
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    agent
        .as_mcp()
        .ok_or_else(|| format!("Agent {} does not support MCP", agent_id))?
        .install_mcp()
        .await
}

/// Update MCP adapter for a specific agent (routed through adapter contract).
#[tauri::command]
pub(crate) async fn update_mcp_adapter(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<String, String> {
    let registry = with_app_state(&state, |s| s.registry.clone())?;
    let agent = registry
        .get(&agent_id)
        .ok_or_else(|| format!("Agent not found: {}", agent_id))?;
    agent
        .as_mcp()
        .ok_or_else(|| format!("Agent {} does not support MCP", agent_id))?
        .update_mcp()
        .await
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
