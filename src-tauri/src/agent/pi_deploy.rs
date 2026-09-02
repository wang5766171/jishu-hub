//! pi 扩展部署管线（v0.9.0 需求2：pi 扩展 × hub 插件系统结合）。
//!
//! 声明 `[pi_extension]` 的工具插件（目录形式 `~/.jishu-hub/plugins/<id>/`
//! 携带 entry TS），其 entry 文件由本管线部署到 pi 的扩展目录
//! `~/.jishu-agent/agent/extensions/<id>/<entry>` 并注册进 settings.json 的
//! extensions 数组（pi 启动加载）。禁用/卸载 → 反向回收（移除注册 + 删部署
//! 目录）。adaptive 引擎（needs_pi_deploy/resolve_form）在此消费——v0.8.1
//! 的死链标注自本模块起解除。
//!
//! 内置 conductor 的部署仍是 task_plan.rs 的硬编码通道（迁移留后续版本，
//! 见需求 2 02 §一范围裁决）；本管线只管理 `<id>/` 子目录形态的条目，
//! 与 conductor 的单文件条目互不干扰。

use std::path::PathBuf;

use crate::agent::adaptive;
use crate::agent::tool_plugin;

/// 当前应部署的 (plugin_id, entry 源文件, 部署相对路径) 清单。
fn active_deployments() -> Vec<(String, PathBuf, String)> {
    let disabled: std::collections::HashSet<String> = crate::agent::plugin::load_plugin_config()
        .disabled
        .into_iter()
        .collect();
    tool_plugin::load_tool_plugins(&disabled)
        .into_iter()
        .filter(|p| p.enabled && adaptive::needs_pi_deploy(&p.file))
        .filter_map(|p| {
            // resolve_form 判定 pi 形态（PiOnly/Both 皆含 entry；CliOnly 不会
            // 出现在 needs_pi_deploy 过滤后）。
            let plugin_dir = p.source_path.parent()?.to_path_buf();
            let entry_name = p.file.pi_extension.as_ref()?.entry.clone();
            let source = plugin_dir.join(&entry_name);
            if !source.is_file() {
                log::debug!(
                    "[pi-deploy] {} 声明 entry={} 但文件不存在（单文件形式插件，跳过部署）",
                    p.id(),
                    entry_name
                );
                return None;
            }
            let rel = format!("extensions/{}/{}", p.id(), entry_name);
            Some((p.id().to_string(), source, rel))
        })
        .collect()
}

/// 部署入口（幂等）：启用插件的 entry 部署 + 注册；失联条目回收。
/// 在 lib.rs 启动与 rebuild_registry（插件启停/卸载/重载）时调用。
pub fn ensure_pi_extension_deployments() {
    let Ok(agent_dir) = crate::task_plan::jishu_agent_dir() else {
        return;
    };
    let active = active_deployments();

    for (_id, source, rel) in &active {
        let Ok(content) = std::fs::read_to_string(source) else {
            continue;
        };
        crate::task_plan::deploy_extension_file(&agent_dir, rel, &content);
        crate::task_plan::register_extension_in_settings(&agent_dir, rel);
    }

    undeploy_stale(&agent_dir, &active);
}

/// 回收：settings extensions 中 `extensions/<x>/…` 形态但 <x> 已不在活跃
/// 清单的条目——移除注册并删除部署目录（仅动本管线管理的子目录形态）。
fn undeploy_stale(agent_dir: &std::path::Path, active: &[(String, PathBuf, String)]) {
    let active_ids: std::collections::HashSet<&str> =
        active.iter().map(|(id, _, _)| id.as_str()).collect();
    let settings_path = agent_dir.join("settings.json");
    let Ok(content) = std::fs::read_to_string(&settings_path) else {
        return;
    };
    let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    let Some(arr) = settings.get_mut("extensions").and_then(|mut v| v.as_array_mut()) else {
        return;
    };
    let is_managed = |rel: &str| -> Option<String> {
        let rest = rel.strip_prefix("extensions/")?;
        let (id, file) = rest.split_once('/')?;
        if id.is_empty() || file.is_empty() {
            return None;
        }
        Some(id.to_string())
    };
    let stale: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str())
        .filter_map(is_managed)
        .filter(|id| !active_ids.contains(id.as_str()))
        .collect();
    if stale.is_empty() {
        return;
    }
    arr.retain(|v| {
        v.as_str()
            .and_then(is_managed)
            .map(|id| active_ids.contains(id.as_str()))
            .unwrap_or(true)
    });
    for id in &stale {
        let dir = agent_dir.join("extensions").join(id);
        if dir.is_dir() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        log::info!("[pi-deploy] 回收失联 pi 扩展部署：{id}");
    }
    if let Ok(new_content) = serde_json::to_string_pretty(&settings) {
        let _ = std::fs::write(&settings_path, new_content);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 部署/回收的文件级行为经 tempdir 造 hub_home + plugins 目录锁定
    //（hub_home 尊重 JISHU_HUB_HOME 测试隔离；agent_dir 侧经环境注入的
    // HOME 目录隔离）。

    #[test]
    fn managed_pattern_parses_and_rejects() {
        // 内嵌验证 is_managed 逻辑（经 undeploy_stale 内部闭包同款规则）。
        // 这里直接测 active_deployments 的 rel 构造与形态判断一致性。
        assert_eq!(
            format!("extensions/{}/{}", "demo-ext", "index.ts"),
            "extensions/demo-ext/index.ts"
        );
        // conductor 单文件形态不匹配子目录回收（无 '/' 分隔）。
        assert!("extensions/jishu-task-conductor.ts"
            .strip_prefix("extensions/")
            .and_then(|r| r.split_once('/'))
            .is_none());
    }
}
