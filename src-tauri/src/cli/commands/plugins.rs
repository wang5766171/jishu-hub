//! `jishu-cli plugins` 子命令（v0.8.1 需求4）：manifest 插件的本地生命周期
//! 管理——add（校验安装）/ add-hybrid（需求25 P2：混合插件目录包，默认禁用
//! + 确认标记）/ list / remove / enable / disable。与 GUI 插件页（需求3）
//! 共享 plugin.rs 的配置与 manifest 装载逻辑；CLI 是独立进程，写操作即时
//! 落盘，运行中的 GUI 经插件页「重新加载」或重启感知。
//!
//! 边界：add 仅接受本地 TOML 文件、add-hybrid 仅接受本地目录（无 URL/远程
//! 市场——供应链校验体系缺失，留后续）；安装即校验（fail loud），坏
//! manifest 不会进入 agents 目录。

use crate::agent;
use crate::cli::args::PluginAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: PluginAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        PluginAction::Add { path } => add(&path, ctx),
        PluginAction::AddHybrid { path } => add_hybrid(&path, ctx),
        PluginAction::List => list(ctx),
        PluginAction::Get { id } => get(&id, ctx),
        PluginAction::Update { id, path } => update(&id, &path, ctx),
        PluginAction::Remove { id } => remove(&id, ctx),
        PluginAction::Enable { id } => set_enabled(&id, true, ctx),
        PluginAction::Disable { id } => set_enabled(&id, false, ctx),
        PluginAction::Validate { path } => validate(&path, ctx),
        PluginAction::ImportExtension { path } => import_extension(&path, ctx),
    }
}

fn add(path: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| CliError::InvalidArg(format!("cannot read {path}: {e}")))?;
    // 1b（v0.9.5 需求1，原需求26）先判别后解析：读 TOML 为 toml::Value 检查
    // 顶层段——[plugin].id → 组合式/流水线（落 plugins/<id>/）；[info]/[schema]
    // → 智能体/工具清单（落 agents/）。**不采用 try-parse 回退**：
    // AgentManifestFile 带 deny_unknown_fields 且 schema/info 必填，组合式
    // 清单先走 agent 解析会抛 "missing field `schema`"/"unknown field
    // `plugin`" 等误导性错误（评审 V2 P1'-2）。
    let value: toml::Value = content
        .parse()
        .map_err(|e| CliError::InvalidArg(format!("invalid TOML: {e}")))?;
    if value
        .get("plugin")
        .and_then(|p| p.get("id"))
        .and_then(|v| v.as_str())
        .is_some()
    {
        return add_composed(&content, ctx);
    }
    if value.get("info").is_some() || value.get("schema").is_some() {
        let parsed: agent::manifest::schema::AgentManifestFile = toml::from_str(&content)
            .map_err(|e| CliError::InvalidArg(format!("invalid manifest TOML: {e}")))?;
        parsed
            .validate()
            .map_err(|e| CliError::InvalidArg(format!("invalid manifest: {e}")))?;
        // v0.8.1 需求6：落盘通道与 GUI plugin_create 共享（冲突检查 + 写文件）。
        let (id, target) = agent::plugin::install_manifest_file(&parsed, &content)
            .map_err(CliError::InvalidArg)?;

        if ctx.json {
            println!(
                "{}",
                serde_json::json!({
                    "installed": true,
                    "id": id,
                    "path": target.to_string_lossy(),
                })
            );
        } else {
            println!("Installed plugin {} ({})", id, target.display());
            println!("Restart the GUI (or use its plugin page's Reload) to load it.");
        }
        return Ok(());
    }
    Err(CliError::InvalidArg(
        "unrecognized manifest format: composed/pipeline manifests need a [plugin].id table; \
         agent/tool manifests need an [info] table"
            .to_string(),
    ))
}

/// 安装组合式/流水线清单（1b 统一寻址组合臂）：经
/// [`agent::plugin::save_composed_manifest`] 落盘 plugins/<id>/plugin.toml
///（session. 前缀/内置保护/id 一致/原子写守卫同源复用），默认禁用 + 确认卡
/// 标记（热生效链与 add-hybrid 同构）。
fn add_composed(content: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let value: toml::Value = content
        .parse()
        .map_err(|e| CliError::InvalidArg(format!("invalid plugin TOML: {e}")))?;
    let (id, name, mount) = composed_manifest_meta(&value)?;
    agent::plugin::save_composed_manifest(&id, content).map_err(CliError::InvalidArg)?;
    finalize_composed_install(&id, &name, &mount, 0, ctx)
}

/// 组合式清单元数据提取（plugin.id 必填；name/mount 兜底——纯流水线无
/// render 段时 mount 用 "pipeline"，确认卡可区分形态）。
fn composed_manifest_meta(value: &toml::Value) -> Result<(String, String, String), CliError> {
    let id = value
        .get("plugin")
        .and_then(|p| p.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| CliError::InvalidArg("manifest missing [plugin].id".to_string()))?
        .to_string();
    let name = value
        .get("plugin")
        .and_then(|p| p.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let mount = value
        .get("render")
        .and_then(|r| r.get("mount"))
        .and_then(|v| v.as_str())
        .unwrap_or("pipeline")
        .to_string();
    Ok((id, name, mount))
}

/// 组合式安装公共尾部（1b 从 add_hybrid 抽出共用）：默认禁用（确认卡安全
/// 阀）+ `.pending-confirm` 标记（CLI 是独立进程发不了 plugins-changed 广播，
/// 标记文件即跨进程信箱，确认卡轮询读取补位热更链）+ 输出。
fn finalize_composed_install(
    id: &str,
    name: &str,
    mount: &str,
    code_lines: u64,
    ctx: &ExecutionContext,
) -> Result<(), CliError> {
    // 默认禁用（确认卡安全阀）。set_plugin_enabled 的 known-ids 已含组合式
    //（known_plugin_ids ← composed_session_manifests），失败时直写 disabled
    // 集合兜底（同一 plugins.json 通道，语义等同）。
    if agent::plugin::set_plugin_enabled(id, false).is_err() {
        let mut config = agent::plugin::load_plugin_config();
        if !config.disabled.iter().any(|x| x == id) {
            config.disabled.push(id.to_string());
            config.updated_at = crate::util::now_ms();
            agent::plugin::save_plugin_config(&config)
                .map_err(|e| CliError::InvalidArg(format!("cannot update plugins.json: {e}")))?;
        }
    }
    let target_dir = agent::plugin::composed_plugins_dir().join(id);
    let pending = serde_json::json!({
        "id": id,
        "name": name,
        "mount": mount,
        "codeLines": code_lines,
        "dir": target_dir.to_string_lossy(),
    });
    crate::util::atomic_write(
        &target_dir.join(".pending-confirm"),
        pending.to_string().as_bytes(),
    )
    .map_err(|e| CliError::InvalidArg(format!("cannot write pending-confirm marker: {e}")))?;

    if ctx.json {
        println!(
            "{}",
            serde_json::json!({
                "installed": true,
                "id": id,
                "dir": target_dir.to_string_lossy(),
                "codeLines": code_lines,
            })
        );
    } else {
        println!("Installed composed plugin {id} ({})", target_dir.display());
        println!("Disabled by default; enable it via the hub GUI confirmation card.");
    }
    Ok(())
}

/// 安装混合插件目录包（需求25 P2）：`<dir>/plugin.toml`（组合式清单，非
/// AgentManifestFile 同形）+ `<dir>/component.js`（自定义代码组件）。清单
/// 经 [`agent::plugin::save_composed_manifest`] 落盘（session. 前缀/内置
/// 保护/原子写守卫同源复用），代码文件写同一插件目录；默认禁用（安全阀：
/// 前端确认卡点「启用」后才装载注入）。CLI 是独立进程发不了 plugins-changed
/// 广播——改写 `.pending-confirm` 标记文件，确认卡轮询读取补位热更链。
fn add_hybrid(dir_path: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let dir = std::path::Path::new(dir_path);
    let toml_path = dir.join("plugin.toml");
    let toml_content = std::fs::read_to_string(&toml_path)
        .map_err(|e| CliError::InvalidArg(format!("cannot read {}: {e}", toml_path.display())))?;
    // 组合式清单与 save_composed_manifest 同规则：toml::Value 提取 plugin.id
    //（deny_unknown_fields 的 AgentManifestFile 解析不了 [plugin]/[render] 段）。
    let value: toml::Value = toml_content
        .parse()
        .map_err(|e| CliError::InvalidArg(format!("invalid plugin.toml: {e}")))?;
    let id = value
        .get("plugin")
        .and_then(|p| p.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| CliError::InvalidArg("plugin.toml missing [plugin].id".to_string()))?
        .to_string();
    // 确认卡展示元数据（name/mount 兜底同 composed_session_plugin_specs）。
    let name = value
        .get("plugin")
        .and_then(|p| p.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let mount = value
        .get("render")
        .and_then(|r| r.get("mount"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    // 代码契约校验：非空 + JishuPlugin.register 注册调用（安装即 fail loud）。
    let code_path = dir.join("component.js");
    let code = std::fs::read_to_string(&code_path)
        .map_err(|e| CliError::InvalidArg(format!("cannot read {}: {e}", code_path.display())))?;
    let code_lines = code.lines().count();
    if code_lines == 0 {
        return Err(CliError::InvalidArg(
            "component.js is empty (expected JishuPlugin.register)".to_string(),
        ));
    }
    if !code.contains("JishuPlugin.register") {
        return Err(CliError::InvalidArg(
            "component.js missing \"JishuPlugin.register\" (code contract)".to_string(),
        ));
    }

    // 落盘两文件：清单走 save_composed_manifest（继承全部守卫并建目录），
    // 代码文件随后写入同一目录（~/.jishu-hub/plugins/<id>/）。
    agent::plugin::save_composed_manifest(&id, &toml_content).map_err(CliError::InvalidArg)?;
    let target_dir = agent::plugin::composed_plugins_dir().join(&id);
    let target_code = target_dir.join("component.js");
    crate::util::atomic_write(&target_code, code.as_bytes()).map_err(|e| {
        CliError::InvalidArg(format!("cannot write {}: {e}", target_code.display()))
    })?;

    // 默认禁用 + 确认标记 + 输出（1b：与 add 组合臂共用公共尾部）。
    finalize_composed_install(&id, &name, &mount, code_lines as u64, ctx)
}

/// 打印已装插件的完整 manifest TOML（页面/CLI 能力一致：GUI plugin_get 面；
/// 1b 统一寻址：agents/ 与 plugins/ 双落点查找）。
fn get(id: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    // 1b 统一寻址：先查 agents/<id>.toml，未命中再查 plugins/<id>/plugin.toml。
    let agents_path = agent::manifest::manifest_dir().join(format!("{id}.toml"));
    let composed_path = agent::plugin::composed_plugins_dir()
        .join(id)
        .join("plugin.toml");
    let path = if agents_path.exists() {
        agents_path
    } else if composed_path.exists() {
        composed_path
    } else {
        return Err(CliError::InvalidArg(format!(
            "plugin not found: {id} (searched {} and {})",
            agents_path.display(),
            composed_path.display()
        )));
    };
    let content = std::fs::read_to_string(&path)
        .map_err(|e| CliError::InvalidArg(format!("cannot read {}: {e}", path.display())))?;
    if ctx.json {
        println!(
            "{}",
            serde_json::json!({"id": id, "path": path.to_string_lossy(), "manifest": content})
        );
    } else {
        print!("{content}");
    }
    Ok(())
}

/// 覆盖更新既有插件（页面/CLI 能力一致：GUI plugin_update 面——manifest 的
/// info.id 必须与目标一致；校验后原子写。1b 统一寻址：组合式清单走
/// plugins/<id>/plugin.toml 覆盖 + 确认卡热生效链；agents/ 分支需重载生效）。
fn update(id: &str, path_str: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let content = std::fs::read_to_string(path_str)
        .map_err(|e| CliError::InvalidArg(format!("cannot read {path_str}: {e}")))?;
    // 1b 统一寻址：组合式清单（[plugin] 段）走 plugins/<id>/ 覆盖 + 确认卡
    // 热生效链；agent/tool 清单走 agents/ 原路径。先判别后解析（同 add）。
    let probe: toml::Value = content
        .parse()
        .map_err(|e| CliError::InvalidArg(format!("invalid TOML: {e}")))?;
    if probe
        .get("plugin")
        .and_then(|p| p.get("id"))
        .and_then(|v| v.as_str())
        .is_some()
    {
        let (decl_id, name, mount) = composed_manifest_meta(&probe)?;
        if decl_id != id {
            return Err(CliError::InvalidArg(format!(
                "plugin id cannot change on update (target {id:?}, manifest declares {decl_id:?}) — remove and re-add instead"
            )));
        }
        let target = agent::plugin::composed_plugins_dir()
            .join(id)
            .join("plugin.toml");
        if !target.exists() {
            return Err(CliError::InvalidArg(format!(
                "composed plugin not found: {id} (expected {}) — add it first",
                target.display()
            )));
        }
        agent::plugin::save_composed_manifest(id, &content).map_err(CliError::InvalidArg)?;
        // 热生效：更新即新内容需重新确认——落确认卡标记（用户点「启用」→
        // set_enabled 幂等 + plugins-changed → loader 热重建读新清单）。
        // 保持当前启用态（禁用态插件更新后仍禁用，与 add 行为一致）。
        let enabled_now = !agent::plugin::load_plugin_config()
            .disabled
            .iter()
            .any(|x| x == id);
        finalize_composed_install(id, &name, &mount, 0, ctx)?;
        if enabled_now {
            let _ = agent::plugin::set_plugin_enabled(id, true);
        }
        return Ok(());
    }
    let parsed: agent::manifest::schema::AgentManifestFile = toml::from_str(&content)
        .map_err(|e| CliError::InvalidArg(format!("invalid manifest TOML: {e}")))?;
    if parsed.info.id != id {
        return Err(CliError::InvalidArg(format!(
            "plugin id cannot change on update (target {id:?}, manifest declares {:?}) — remove and re-add instead",
            parsed.info.id
        )));
    }
    parsed
        .validate()
        .map_err(|e| CliError::InvalidArg(format!("invalid manifest: {e}")))?;
    let target = agent::manifest::manifest_dir().join(format!("{id}.toml"));
    if !target.exists() {
        return Err(CliError::InvalidArg(format!(
            "plugin file not found: {}",
            target.display()
        )));
    }
    crate::util::atomic_write(&target, content.as_bytes())
        .map_err(|e| CliError::InvalidArg(format!("cannot write {}: {e}", target.display())))?;
    if ctx.json {
        println!(
            "{}",
            serde_json::json!({"updated": true, "id": id, "path": target.to_string_lossy()})
        );
    } else {
        println!(
            "Updated plugin {id} ({}); reload the hub app to apply.",
            target.display()
        );
    }
    Ok(())
}

fn list(ctx: &ExecutionContext) -> Result<(), CliError> {
    let registry = agent::AgentRegistry::new();
    // v0.8.1 需求7：合并工具插件（kind = "tool"，不进 registry）。
    let mut plugins = registry.list_plugins();
    plugins.extend(
        agent::tool_plugin::load_tool_plugins(&Default::default())
            .iter()
            .map(agent::plugin::tool_descriptor),
    );
    let errors = &registry.manifest_errors;

    if ctx.json {
        for p in &plugins {
            println!(
                "{}",
                serde_json::json!({
                    "id": p.id,
                    "display_name": p.display_name,
                    "kind": p.kind,
                    "version": p.version,
                    "source_path": p.source_path,
                    "core": p.core,
                    "enabled": p.enabled,
                })
            );
        }
        for (file, reason) in errors {
            println!(
                "{}",
                serde_json::json!({"id": null, "error_file": file, "error": reason})
            );
        }
        return Ok(());
    }

    println!(
        "{:<16} {:<10} {:<8} {:<8} VERSION",
        "ID", "KIND", "CORE", "ENABLED"
    );
    for p in &plugins {
        println!(
            "{:<16} {:<10} {:<8} {:<8} {}",
            p.id,
            match p.kind {
                agent::plugin::PluginKind::Builtin => "builtin",
                agent::plugin::PluginKind::Manifest => "manifest",
                agent::plugin::PluginKind::Tool => "tool",
                agent::plugin::PluginKind::Session => "session",
            },
            if p.core { "yes" } else { "-" },
            if p.enabled { "yes" } else { "no" },
            p.version.as_deref().unwrap_or("-"),
        );
    }
    if !errors.is_empty() {
        println!("\nFailed manifests:");
        for (file, reason) in errors {
            println!("  {file}: {reason}");
        }
    }
    Ok(())
}

fn remove(id: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    // 与 GUI 的 plugin_remove 同规则：agent manifest + 工具插件均可卸载
    // （评审 III：修前只查 registry.list_plugins()——tool 插件不在其中，
    // CLI remove 找不到 → 与 GUI「支持卸载工具插件」不对称）。活跃会话
    // 检查不适用于 CLI（看不到 GUI 进程的会话表）——删除后 GUI 侧活跃
    // 会话行为同禁用。
    let registry = agent::AgentRegistry::new();
    let registry_plugin = registry.list_plugins().into_iter().find(|p| p.id == id);
    let tool_plugin = if registry_plugin.is_none() {
        agent::tool_plugin::load_tool_plugins(&Default::default())
            .into_iter()
            .find(|p| p.id() == id)
    } else {
        None
    };
    let source: Option<std::path::PathBuf> = match (&registry_plugin, &tool_plugin) {
        (Some(p), _) if p.core => {
            return Err(CliError::InvalidArg(format!(
                "plugin {id} is the core engine and cannot be removed"
            )));
        }
        // 1b 统一寻址组合臂：组合式/流水线/混合插件（kind Session、无
        // agents/ 落点）→ 删除 plugins/<id>/ 目录。
        (Some(p), _) if p.kind == agent::plugin::PluginKind::Session && p.source_path.is_none() => {
            if agent::plugin::is_builtin_composed(id) {
                return Err(CliError::InvalidArg(format!(
                    "plugin {id} is a built-in composed plugin and cannot be removed"
                )));
            }
            let dir = agent::plugin::composed_plugins_dir().join(id);
            // 先清 disabled 引用再删目录（known_plugin_ids 扫描 plugins/，
            // 目录删除后 id 不可知 → set_plugin_enabled 会拒）。
            let _ = agent::plugin::set_plugin_enabled(id, true);
            std::fs::remove_dir_all(&dir).map_err(|e| {
                CliError::InvalidArg(format!("cannot remove {}: {e}", dir.display()))
            })?;
            if ctx.json {
                println!(
                    "{}",
                    serde_json::json!({"removed": true, "id": id, "path": dir})
                );
            } else {
                println!("Removed composed plugin {id} ({})", dir.display());
            }
            return Ok(());
        }
        (Some(p), _) => p.source_path.as_ref().map(std::path::PathBuf::from),
        (None, Some(tp)) => Some(tp.source_path.clone()),
        (None, None) => {
            // 1b 统一寻址组合臂：plugins/<id>/ 目录（组合式/流水线/混合）。
            let composed_dir = agent::plugin::composed_plugins_dir().join(id);
            if !composed_dir.exists() {
                return Err(CliError::InvalidArg(format!("unknown plugin: {id}")));
            }
            if agent::plugin::is_builtin_composed(id) {
                return Err(CliError::InvalidArg(format!(
                    "plugin {id} is a built-in composed plugin and cannot be removed"
                )));
            }
            let _ = agent::plugin::set_plugin_enabled(id, true); // 清 disabled 引用（先于删目录）
            std::fs::remove_dir_all(&composed_dir).map_err(|e| {
                CliError::InvalidArg(format!("cannot remove {}: {e}", composed_dir.display()))
            })?;
            if ctx.json {
                println!(
                    "{}",
                    serde_json::json!({"removed": true, "id": id, "path": composed_dir})
                );
            } else {
                println!("Removed composed plugin {id} ({})", composed_dir.display());
            }
            return Ok(());
        }
    };
    // 系统插件拒绝（v0.9.0 需求1 二期，与 GUI plugin_remove 同规则）：
    // 随包分发、启动幂等重部署——卸载是无操作。
    if agent::plugin::is_system_plugin(id) {
        return Err(CliError::InvalidArg(format!(
            "plugin {id} is a system plugin and cannot be removed"
        )));
    }
    let source = source.ok_or_else(|| {
        CliError::InvalidArg(format!("plugin {id} is builtin and cannot be removed"))
    })?;
    std::fs::remove_file(&source)
        .map_err(|e| CliError::InvalidArg(format!("cannot remove {}: {e}", source.display())))?;
    let _ = agent::plugin::set_plugin_enabled(id, true); // 清 disabled 引用

    if ctx.json {
        println!(
            "{}",
            serde_json::json!({"removed": true, "id": id, "path": source})
        );
    } else {
        println!("Removed plugin {id} ({})", source.display());
    }
    Ok(())
}

fn set_enabled(id: &str, enabled: bool, ctx: &ExecutionContext) -> Result<(), CliError> {
    agent::plugin::set_plugin_enabled(id, enabled)
        .map_err(|e| CliError::InvalidArg(format!("cannot update plugins.json: {e}")))?;
    if ctx.json {
        println!("{}", serde_json::json!({"id": id, "enabled": enabled}));
    } else {
        println!(
            "Plugin {id} {}d (restart the GUI or reload its plugin page to apply).",
            if enabled { "enable" } else { "disable" }
        );
    }
    Ok(())
}

/// 导入 pi 扩展（7c 层三）：安全摘要输出 + 复制到 extensions/（默认不启用
/// ——显式启用走 hub GUI 提示卡或下次会话手动注册 settings.json）。
fn import_extension(path: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    // 8d：目录路径走成套导入（三件一次装）；单文件回落普通扩展导入。
    if std::path::Path::new(path).is_dir() {
        let report = crate::agent::pi_extension_import::import_extension_bundle(path)
            .map_err(CliError::InvalidArg)?;
        if ctx.json {
            println!(
                "{}",
                serde_json::json!({
                    "kind": report.kind,
                    "extension": report.extension,
                    "toolPlugin": report.tool_plugin,
                    "rendererPlugin": report.renderer_plugin,
                })
            );
        } else {
            println!("Imported extension bundle ({}):", report.kind);
            if let Some(ext) = &report.extension {
                println!("  extension  → {ext}（默认不启用）");
            }
            if let Some(id) = &report.tool_plugin {
                println!("  tool plugin → agents/{id}.toml");
            }
            if let Some(id) = &report.renderer_plugin {
                println!("  renderer    → plugins/{id}（确认卡启用）");
            }
        }
        return Ok(());
    }
    let source = std::fs::read_to_string(path)
        .map_err(|e| CliError::InvalidArg(format!("cannot read {path}: {e}")))?;
    let summary = crate::agent::pi_extension_import::parse_extension_summary(&source);
    let target = crate::agent::pi_extension_import::import_pi_extension(path)
        .map_err(CliError::InvalidArg)?;
    if ctx.json {
        println!(
            "{}",
            serde_json::json!({
                "imported": true,
                "path": target,
                "enabled": false,
                "summary": {
                    "tools": summary.tools,
                    "commands": summary.commands,
                    "events": summary.events,
                    "fileOps": summary.file_ops,
                    "network": summary.network,
                    "subprocess": summary.subprocess,
                    "arbitraryCodeWarning": crate::agent::pi_extension_import::ARBITRARY_CODE_WARNING,
                },
            })
        );
    } else {
        println!("Imported pi extension → {target}");
        println!("Disabled by default; enable via the hub GUI extension card.");
        if !summary.tools.is_empty() {
            println!("  tools: {}", summary.tools.join(", "));
        }
        if !summary.commands.is_empty() {
            println!("  commands: {}", summary.commands.join(", "));
        }
        if !summary.events.is_empty() {
            println!("  events: {}", summary.events.join(", "));
        }
        if summary.file_ops || summary.network || summary.subprocess {
            println!(
                "  ⚠ fileOps={} network={} subprocess={}",
                summary.file_ops, summary.network, summary.subprocess
            );
        }
        println!(
            "  ⚠ {}",
            crate::agent::pi_extension_import::ARBITRARY_CODE_WARNING
        );
    }
    Ok(())
}

/// 校验插件目录/清单（1c，v0.9.5 需求1（原需求26））：基础结构检查（Rust
/// 本地）+ 经标记文件调运行中 hub 前端的 TS 校验器（validateManifest /
/// validatePipeline——与 GUI 向导同一份实现，单一校验真源）。hub 未运行
/// （响应超时）时降级：仅输出基础校验结果 + ⚠ 提示，不静默失败。
///
/// 标记协议（CLI ↔ hub 前端的跨进程信箱，同 .pending-confirm 模式）：
/// - 请求 `.cli-validate-req-<nonce>.json`：{nonce, dir, manifest, componentJs}——
///   manifest 为 toml→JSON 转换值（前端校验器直接消费），componentJs 为
///   目录内 component.js 源码（前端做契约检查，无任意路径文件访问）；
///   nonce 后缀支持多终端并发互不踩（三轮评审信箱并发修复）；
/// - 响应 `.cli-validate-resp-<nonce>.json`：{nonce, valid, errors}——前端校
///   验完成后经 cli_validate_submit 命令写回，CLI 轮询匹配 nonce 取结果。
fn validate(path: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let input = std::path::Path::new(path);
    let (dir, toml_path) = if input.is_dir() {
        (input.to_path_buf(), input.join("plugin.toml"))
    } else if input.extension().is_some_and(|e| e == "toml") {
        (
            input.parent().unwrap_or(input).to_path_buf(),
            input.to_path_buf(),
        )
    } else {
        return Err(CliError::InvalidArg(
            "expected a plugin directory (holding plugin.toml) or a plugin.toml file".to_string(),
        ));
    };
    if !toml_path.exists() {
        return Err(CliError::InvalidArg(format!(
            "plugin.toml not found: {}",
            toml_path.display()
        )));
    }
    let content = std::fs::read_to_string(&toml_path)
        .map_err(|e| CliError::InvalidArg(format!("cannot read {}: {e}", toml_path.display())))?;

    // ── 基础校验（Rust 结构检查——hub 未运行时的降级面）──
    let value: toml::Value = content
        .parse()
        .map_err(|e| CliError::InvalidArg(format!("invalid TOML: {e}")))?;
    let mut basic_errors: Vec<String> = Vec::new();
    let id = value
        .get("plugin")
        .and_then(|p| p.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| CliError::InvalidArg("manifest missing [plugin].id".to_string()))?
        .to_string();
    if !id.starts_with("session.") {
        basic_errors.push(format!(
            "[plugin] id 须以 session. 开头（安装通道要求），got {id:?}"
        ));
    }
    if let Some(component) = value
        .get("render")
        .and_then(|r| r.get("component"))
        .and_then(|v| v.as_str())
    {
        if let Some(rel) = component.strip_prefix("@file:") {
            let file = dir.join(rel);
            if !file.exists() {
                basic_errors.push(format!("[render] @file: 引用的文件不存在: {rel}"));
            }
        }
    }
    if let Some(stages) = value.get("pipeline").and_then(|p| p.get("stages")) {
        if stages.as_array().map_or(true, |a| a.is_empty()) {
            basic_errors.push("[pipeline] stages 为空（流水线至少需要一个阶段）".to_string());
        }
    }
    let component_js = match std::fs::read_to_string(dir.join("component.js")) {
        Ok(code) => {
            if !code.contains("JishuPlugin.register") {
                basic_errors.push(
                    "component.js missing \"JishuPlugin.register\" (code contract)".to_string(),
                );
            }
            if !code.contains("version: 1") && !code.contains("version:1") {
                basic_errors
                    .push("component.js 应声明 version: 1（当前 PLUGIN_API_VERSION）".to_string());
            }
            Some(code)
        }
        Err(_) => None,
    };

    // ── 完整校验（hub 运行中）：写请求标记 → 轮询响应 ──
    let manifest_json = serde_json::to_value(&value)
        .map_err(|e| CliError::InvalidArg(format!("manifest 转换失败: {e}")))?;
    let nonce = crate::util::now_ms() as u64;
    let req = serde_json::json!({
        "nonce": nonce,
        "dir": dir.to_string_lossy(),
        "manifest": manifest_json,
        "componentJs": component_js,
    });
    let hub = agent::manifest::hub_home();
    // 三轮评审信箱并发修复：请求/响应文件名带 nonce——多终端并发 validate
    // 不共用单一文件（hub 侧 poll/submit 按同名约定联动）。
    let req_path = hub.join(format!(".cli-validate-req-{nonce}.json"));
    let resp_path = hub.join(format!(".cli-validate-resp-{nonce}.json"));
    crate::util::atomic_write(&req_path, req.to_string().as_bytes())
        .map_err(|e| CliError::InvalidArg(format!("cannot write validate request: {e}")))?;

    let mut hub_errors: Option<Vec<String>> = None;
    for _ in 0..24 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Ok(resp_content) = std::fs::read_to_string(&resp_path) {
            if let Ok(resp) = serde_json::from_str::<serde_json::Value>(&resp_content) {
                if resp.get("nonce").and_then(|n| n.as_u64()) == Some(nonce) {
                    hub_errors = Some(
                        resp.get("errors")
                            .and_then(|e| e.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    );
                    let _ = std::fs::remove_file(&resp_path);
                    break;
                }
            }
        }
    }

    let (valid, all_errors, hub_live) = match hub_errors {
        Some(hub_errs) => {
            let mut errs = basic_errors.clone();
            errs.extend(hub_errs);
            (errs.is_empty(), errs, true)
        }
        None => (basic_errors.is_empty(), basic_errors.clone(), false),
    };
    let _ = std::fs::remove_file(&req_path);

    if ctx.json {
        println!(
            "{}",
            serde_json::json!({
                "id": id,
                "path": toml_path.to_string_lossy(),
                "valid": valid,
                "hubFullValidation": hub_live,
                "errors": all_errors,
            })
        );
    } else {
        if valid {
            println!("✓ valid: {id} ({})", toml_path.display());
        } else {
            println!("✗ invalid: {id}");
            for e in &all_errors {
                println!("  - {e}");
            }
        }
        if !hub_live {
            println!("⚠ hub 未运行，仅完成基础校验；完整校验需启动 hub 后重试");
        }
    }
    if !valid {
        // 校验失败以非零码退出（脚本可判）——std::process::exit 由 main 层统一，
        // 这里返回 InvalidArg 语义化（json 模式已打印结果）。
        return Err(CliError::InvalidArg(format!(
            "validation failed with {} error(s)",
            all_errors.len()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::agent::manifest::env_test_lock;

    /// 1b（v0.9.5 需求1，原需求26）统一寻址：先判别后解析 + 双落点寻址。
    /// 开发机可能设 JISHU_HUB_HOME（shell env 优先于 cfg(test) 隔离），用例
    /// 显式 set_var 到 tempdir + crate 级共享 env 锁（plugin.rs 测试同款）。
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        env_test_lock().lock().unwrap_or_else(|e| e.into_inner())
    }

    fn composed_toml(id: &str, name: &str) -> String {
        format!(
            r#"
[plugin]
id = "{id}"
name = "{name}"
kind = "session-composed"

[source]
type = "messages"

[render]
component = "render.list"
mount = "dock-panel"
"#
        )
    }

    fn ctx() -> ExecutionContext {
        ExecutionContext::new(true)
    }

    fn composed_dir(id: &str) -> std::path::PathBuf {
        agent::plugin::composed_plugins_dir().join(id)
    }

    #[test]
    fn add_dispatches_composed_manifest_to_plugins_dir() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        let dir = tempfile::tempdir().unwrap();
        let toml_path = dir.path().join("panel.toml");
        std::fs::write(
            &toml_path,
            composed_toml("session.cli-test-panel", "CLI 测试面板"),
        )
        .unwrap();
        add(toml_path.to_str().unwrap(), &ctx()).expect("add composed");
        // 1b-1：落在 plugins/<id>/plugin.toml（不是 agents/）。
        let target = composed_dir("session.cli-test-panel").join("plugin.toml");
        assert!(
            target.exists(),
            "composed manifest should land in plugins/, got {target:?}"
        );
        assert!(!agent::manifest::manifest_dir()
            .join("session.cli-test-panel.toml")
            .exists());
        // 热生效链：.pending-confirm 标记就位（前端确认卡轮询数据源）。
        assert!(composed_dir("session.cli-test-panel")
            .join(".pending-confirm")
            .exists());
        // 默认禁用（确认卡安全阀）。
        assert!(agent::plugin::load_plugin_config()
            .disabled
            .iter()
            .any(|x| x == "session.cli-test-panel"));
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn get_resolves_composed_plugin_from_plugins_dir() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // 1b-2：get 统一寻址——组合式插件可从 plugins/<id>/ 读回完整 TOML。
        agent::plugin::save_composed_manifest(
            "session.cli-test-get",
            &composed_toml("session.cli-test-get", "面板"),
        )
        .unwrap();
        get("session.cli-test-get", &ctx()).expect("get composed");
        // agents/ 优先：同 id 不存在时组合式命中（上面已证）；双缺失给双路径提示。
        let err = get("session.no-such-plugin", &ctx()).unwrap_err();
        let msg = match err {
            CliError::InvalidArg(m) => m,
            other => format!("{other:?}"),
        };
        assert!(msg.contains("searched"), "got: {msg}");
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn update_composed_overwrites_and_keeps_marker_chain() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // 1b-3：组合式 update——id 一致校验 + 覆盖写回 + 确认卡标记。
        agent::plugin::save_composed_manifest(
            "session.cli-test-upd",
            &composed_toml("session.cli-test-upd", "v1"),
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let toml_path = dir.path().join("panel-v2.toml");
        std::fs::write(&toml_path, composed_toml("session.cli-test-upd", "面板 v2")).unwrap();
        update("session.cli-test-upd", toml_path.to_str().unwrap(), &ctx())
            .expect("update composed");
        let content =
            std::fs::read_to_string(composed_dir("session.cli-test-upd").join("plugin.toml"))
                .unwrap();
        assert!(
            content.contains("面板 v2"),
            "update should overwrite manifest"
        );
        // 热生效链：更新后确认标记在位。
        assert!(composed_dir("session.cli-test-upd")
            .join(".pending-confirm")
            .exists());
        // id 不一致拒绝。
        let err = update("session.other-id", toml_path.to_str().unwrap(), &ctx()).unwrap_err();
        let msg = match err {
            CliError::InvalidArg(m) => m,
            other => format!("{other:?}"),
        };
        assert!(msg.contains("cannot change on update"), "got: {msg}");
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn remove_composed_deletes_directory() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // 1b-4：组合式 remove——删除 plugins/<id>/ 目录 + 清 disabled 引用。
        agent::plugin::save_composed_manifest(
            "session.cli-test-rm",
            &composed_toml("session.cli-test-rm", "面板"),
        )
        .unwrap();
        let _ = agent::plugin::set_plugin_enabled("session.cli-test-rm", false);
        remove("session.cli-test-rm", &ctx()).expect("remove composed");
        assert!(!composed_dir("session.cli-test-rm").exists());
        assert!(!agent::plugin::load_plugin_config()
            .disabled
            .iter()
            .any(|x| x == "session.cli-test-rm"));
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn remove_rejects_builtin_composed_plugin() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // 内置（随包）组合插件不可卸载——先部署内置清单使 registry 可见。
        agent::plugin::ensure_builtin_composed_manifests();
        let err = remove("session.video-maker", &ctx()).unwrap_err();
        let msg = match err {
            CliError::InvalidArg(m) => m,
            other => format!("{other:?}"),
        };
        assert!(msg.contains("cannot be removed"), "got: {msg}");
        std::env::remove_var("JISHU_HUB_HOME");
    }

    #[test]
    fn add_rejects_unrecognized_manifest_shape() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // 既无 [plugin].id 也无 [info]/[schema]——判别失败给明确指引。
        let dir = tempfile::tempdir().unwrap();
        let toml_path = dir.path().join("mystery.toml");
        std::fs::write(
            &toml_path,
            "[whatever]
key = 1
",
        )
        .unwrap();
        let err = add(toml_path.to_str().unwrap(), &ctx()).unwrap_err();
        let msg = match err {
            CliError::InvalidArg(m) => m,
            other => format!("{other:?}"),
        };
        assert!(msg.contains("unrecognized manifest format"), "got: {msg}");
        std::env::remove_var("JISHU_HUB_HOME");
    }
}
