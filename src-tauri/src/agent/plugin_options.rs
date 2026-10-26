//! 插件配置面存储（v0.9.3 需求12 P1：配置驱动的插件体系）。
//!
//! 每插件的用户配置值（键 → JSON 值），统一存 `~/.jishu-hub/plugins-config.json`：
//! ```json
//! { "session.mermaid-render": { "inlineScalePct": 50 } }
//! ```
//! 语义约定：
//! - **只存用户显式改过的键**（未改键不落盘，前端 default 合并）；
//! - 文件缺失/损坏 → 空配置（安全方向：一切按代码默认值）；
//! - 写入原子（tempfile 替换），读改写整文件（单用户桌面场景无并发压力）。
//! 值的合法性（min/max 等）由前端按 configSchema 校验后提交；后端只做
//! JSON 形状透传——配置键的语义属于各插件。

use std::collections::HashMap;
use std::path::PathBuf;

#[cfg(test)]
use crate::agent::manifest::env_test_lock;

type PluginValues = HashMap<String, serde_json::Value>;
type AllConfigs = HashMap<String, PluginValues>;

fn config_path() -> PathBuf {
    super::manifest::hub_home().join("plugins-config.json")
}

/// 全量读取；缺失/损坏 → 空（按默认值）。
pub fn load_all() -> AllConfigs {
    let Ok(content) = std::fs::read_to_string(config_path()) else {
        return AllConfigs::new();
    };
    match serde_json::from_str(&content) {
        Ok(configs) => configs,
        Err(e) => {
            log::warn!("[plugin-config] invalid plugins-config.json ({e}), ignoring");
            AllConfigs::new()
        }
    }
}

/// 覆写某插件的配置值（整组替换——前端表单提交的是全量合并结果）。
pub fn set_values(plugin_id: &str, values: PluginValues) -> Result<(), String> {
    if plugin_id.trim().is_empty() {
        return Err("plugin_id is required".to_string());
    }
    let mut all = load_all();
    if values.is_empty() {
        all.remove(plugin_id);
    } else {
        all.insert(plugin_id.to_string(), values);
    }
    let content = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    crate::util::atomic_write(&config_path(), content.as_bytes())
        .map_err(|e| format!("write plugins-config.json failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JISHU_HUB_HOME 隔离下的往返 + 只存显式键语义（空组移除条目）。
    #[test]
    fn roundtrip_and_empty_group_removal() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", home.path());

        assert!(load_all().is_empty(), "missing file => empty");

        set_values(
            "session.mermaid-render",
            HashMap::from([("inlineScalePct".to_string(), serde_json::json!(65))]),
        )
        .unwrap();
        let all = load_all();
        assert_eq!(
            all.get("session.mermaid-render").and_then(|v| v.get("inlineScalePct")),
            Some(&serde_json::json!(65))
        );

        // 覆写同插件整组；清空组 → 条目移除。
        set_values("session.mermaid-render", HashMap::new()).unwrap();
        assert!(!load_all().contains_key("session.mermaid-render"));

        // 损坏文件 → 空配置不 panic。
        std::fs::write(config_path(), "{invalid").unwrap();
        assert!(load_all().is_empty());

    }
}
