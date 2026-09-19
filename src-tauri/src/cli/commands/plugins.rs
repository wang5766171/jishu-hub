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
    }
}

fn add(path: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| CliError::InvalidArg(format!("cannot read {path}: {e}")))?;
    let parsed: agent::manifest::schema::AgentManifestFile = toml::from_str(&content)
        .map_err(|e| CliError::InvalidArg(format!("invalid manifest TOML: {e}")))?;
    parsed
        .validate()
        .map_err(|e| CliError::InvalidArg(format!("invalid manifest: {e}")))?;
    // v0.8.1 需求6：落盘通道与 GUI plugin_create 共享（冲突检查 + 写文件）。
    let (id, target) =
        agent::plugin::install_manifest_file(&parsed, &content).map_err(CliError::InvalidArg)?;

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
    let target_dir = agent::manifest::hub_home().join("plugins").join(&id);
    let target_code = target_dir.join("component.js");
    crate::util::atomic_write(&target_code, code.as_bytes())
        .map_err(|e| CliError::InvalidArg(format!("cannot write {}: {e}", target_code.display())))?;

    // 默认禁用（确认卡安全阀）。set_plugin_enabled 的 known-ids 校验不含
    // 组合插件（session-composed 被 manifest 扫描器跳过），对混合 id 恒拒绝
    // ——失败时直写 disabled 集合兜底（同一 plugins.json 通道，语义等同）。
    if agent::plugin::set_plugin_enabled(&id, false).is_err() {
        let mut config = agent::plugin::load_plugin_config();
        if !config.disabled.iter().any(|x| x == &id) {
            config.disabled.push(id.clone());
            config.updated_at = crate::util::now_ms();
            agent::plugin::save_plugin_config(&config)
                .map_err(|e| CliError::InvalidArg(format!("cannot update plugins.json: {e}")))?;
        }
    }

    // 安装确认标记（前端确认卡轮询读它补位跨进程广播）。
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
        println!("Installed hybrid plugin {id} ({})", target_dir.display());
        println!("Disabled by default; enable it via the hub GUI confirmation card.");
    }
    Ok(())
}

/// 打印已装插件的完整 manifest TOML（页面/CLI 能力一致：GUI plugin_get 面）。
fn get(id: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let path = agent::manifest::manifest_dir().join(format!("{id}.toml"));
    if !path.exists() {
        return Err(CliError::InvalidArg(format!(
            "plugin not found: {id} (expected {})",
            path.display()
        )));
    }
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
/// info.id 必须与目标一致；校验后原子写。运行中的 hub GUI 需重新加载生效）。
fn update(id: &str, path_str: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let content = std::fs::read_to_string(path_str)
        .map_err(|e| CliError::InvalidArg(format!("cannot read {path_str}: {e}")))?;
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
        "{:<16} {:<10} {:<8} {:<8} {}",
        "ID", "KIND", "CORE", "ENABLED", "VERSION"
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
        (Some(p), _) => p.source_path.as_ref().map(|s| std::path::PathBuf::from(s)),
        (None, Some(tp)) => Some(tp.source_path.clone()),
        (None, None) => {
            return Err(CliError::InvalidArg(format!("unknown plugin: {id}")));
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
