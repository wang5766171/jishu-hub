//! `jishu-cli plugins` 子命令（v0.8.1 需求4）：manifest 插件的本地生命周期
//! 管理——add（校验安装）/ list / remove / enable / disable。与 GUI 插件页
//! （需求3）共享 plugin.rs 的配置与 manifest 装载逻辑；CLI 是独立进程，
//! 写操作即时落盘，运行中的 GUI 经插件页「重新加载」或重启感知。
//!
//! 边界：add 仅接受本地 TOML 文件（无 URL/远程市场——供应链校验体系缺失，
//! 留后续）；安装即校验（fail loud），坏 manifest 不会进入 agents 目录。

use crate::agent;
use crate::cli::args::PluginAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: PluginAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        PluginAction::Add { path } => add(&path, ctx),
        PluginAction::List => list(ctx),
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
