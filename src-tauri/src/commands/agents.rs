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
}

/// 启停插件并热生效（core 插件拒绝；写 plugins.json 持久化；agent 与 tool
/// 插件共用同一启停集合——known ids 含两类）。
#[tauri::command]
pub(crate) fn plugin_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    agent::plugin::set_plugin_enabled(&plugin_id, enabled)?;
    rebuild_registry(&app, &state);
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
    // 文件名读（<id>.toml），与装载同源。
    let path = agent::manifest::manifest_dir().join(format!("{plugin_id}.toml"));
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let file: agent::manifest::schema::AgentManifestFile =
        toml::from_str(&content).map_err(|e| format!("stored manifest is invalid: {e}"))?;
    serde_json::to_value(&file).map_err(|e| e.to_string())
}

/// 编辑模式：校验 → 覆盖写回原文件 → 热重建。id 不可变（后端防御：
/// manifest.info.id 必须等于 plugin_id——文件名/会话归属/启停配置都以 id
/// 为 key，改名等于换插件，请卸载后新建）。
#[tauri::command]
pub(crate) fn plugin_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    plugin_id: String,
    manifest: serde_json::Value,
) -> Result<PluginCreated, String> {
    let file: agent::manifest::schema::AgentManifestFile =
        serde_json::from_value(manifest).map_err(|e| format!("invalid manifest payload: {e}"))?;
    if file.info.id != plugin_id {
        return Err(format!(
            "plugin id cannot change on edit (file is {plugin_id:?}, manifest declares {:?}) — \
             remove and re-create instead",
            file.info.id
        ));
    }
    file.validate()?;
    let path = agent::manifest::manifest_dir().join(format!("{plugin_id}.toml"));
    if !path.exists() {
        return Err(format!("plugin file not found: {}", path.display()));
    }
    let content_toml =
        toml::to_string_pretty(&file).map_err(|e| format!("cannot serialize manifest: {e}"))?;
    crate::util::atomic_write(&path, content_toml.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    rebuild_registry(&app, &state);
    log::info!("[plugin] updated {} ({})", plugin_id, path.display());
    Ok(PluginCreated {
        id: plugin_id,
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
