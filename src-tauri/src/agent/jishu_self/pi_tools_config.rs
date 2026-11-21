//! 需求17（v0.9.8）：工具白名单根因修复——对齐 pi 原生工具管理。
//!
//! 历史问题（四次跌倒）：hub spawn pi 时传 `--tools` 硬白名单，任何不在
//! 名单里的工具（包括扩展工具）都被屏蔽。每次新增工具来源（内置扩展 →
//! runner → agent-tools → npm 扩展）都要手工补白名单。
//!
//! 根本方案（用户裁决 2026-11-21）：
//! 1. 首次启动：往 pi settings.json 写入 `defaultTools`（全量核心工具）
//! 2. spawn 时不传 `--tools`——pi 用 defaultTools 管核心工具，
//!    用 packages 数组管扩展工具（装了就在，停了就不在）
//! 3. 只读模式例外：仍传限制性 `--tools`
//!
//! 本文件职责：defaultTools 的初始化写入（幂等——已有任何显式值不覆盖）。

/// 全量核心工具清单（与 template_default_tools 同源）。
const CORE_TOOLS: &[&str] = &[
    "read",
    "bash",
    "edit",
    "write",
    "update_steps",
    "ask_user",
    "dispatch_to_node",
    // Windows 含 powershell（运行时按平台追加）
];

/// 启动时幂等写入 defaultTools 到 pi settings.json。
///
/// - 已有任何显式 defaultTools → 不动（用户自己配的，尊重）
/// - 未配置 → 写入全量核心工具清单（含平台追加 powershell）
///
/// 由 lib.rs setup 在迁移之后调用（与 ensure_default_retry_settings 同期）。
pub fn ensure_default_tools_config() {
    let Some(path) = pi_settings_path() else {
        log::warn!("[pi-tools-config] cannot resolve pi settings path");
        return;
    };
    let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&content) else {
        log::error!("[pi-tools-config] pi settings.json 解析失败，跳过 defaultTools 写入");
        return;
    };

    // 幂等：已有任何 defaultTools 配置（含空数组）不覆盖。
    if v.get("defaultTools").is_some() {
        return;
    }

    let mut tools: Vec<String> = CORE_TOOLS.iter().map(|s| s.to_string()).collect();
    if cfg!(windows) {
        tools.push("powershell".to_string());
    }
    v["defaultTools"] =
        serde_json::Value::Array(tools.into_iter().map(serde_json::Value::String).collect());

    let body = serde_json::to_string_pretty(&v).unwrap_or_default();
    let tmp = path.with_extension("json.tmp-hub");
    if let Err(e) = std::fs::write(&tmp, &body).and_then(|_| std::fs::rename(&tmp, &path)) {
        log::error!("[pi-tools-config] defaultTools 写入失败: {e}");
        return;
    }
    log::info!("[pi-tools-config] defaultTools 已初始化写入（全量核心工具）");
}

fn pi_settings_path() -> Option<std::path::PathBuf> {
    // 测试隔离：JISHU_PI_SETTINGS 指向临时文件（与 pi_registry 同款）。
    if let Ok(p) = std::env::var("JISHU_PI_SETTINGS") {
        if !p.trim().is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    super::paths::agent_dir()
        .ok()
        .map(|d| std::path::PathBuf::from(d).join("settings.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 幂等写入：首次写入全量核心工具 → 二次调用不覆盖。
    #[test]
    fn ensure_default_tools_idempotent() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_PI_SETTINGS", tmp.path().join("pi.json"));
        std::fs::write(
            tmp.path().join("pi.json"),
            r#"{"packages": ["npm:pi-lens@4.3.0"]}"#,
        )
        .unwrap();

        ensure_default_tools_config();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.path().join("pi.json")).unwrap())
                .unwrap();
        let tools = v["defaultTools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t == "read"));
        assert!(tools.iter().any(|t| t == "update_steps"));
        assert!(tools.iter().any(|t| t == "powershell")); // Windows

        // 二次调用不覆盖（改为单工具后不再被重写）
        std::fs::write(
            tmp.path().join("pi.json"),
            r#"{"defaultTools": ["read"], "packages": []}"#,
        )
        .unwrap();
        ensure_default_tools_config();
        let v2: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.path().join("pi.json")).unwrap())
                .unwrap();
        assert_eq!(v2["defaultTools"].as_array().unwrap().len(), 1);

        std::env::remove_var("JISHU_PI_SETTINGS");
    }
}
