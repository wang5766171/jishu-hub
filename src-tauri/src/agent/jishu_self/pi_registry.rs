//! v0.9.8 需求15 方案 A：pi 扩展注册与冲突停用台账（hub 侧冲突治理）。
//!
//! 产品语义（用户裁决 2026-11-20）：
//! - 拥抱 pi 原生 fail-loud（工具名冲突拒绝启动），hub 负责让用户永远
//!   进不了崩态：安装探针检出冲突 → 说明「与已装能力重叠」→ 用户选择
//!   继续安装（停用对手）/取消（不装）。
//! - 冲突治理**对所有扩展一致**（内置 vs 用户装、用户 A vs 用户 B 同规）；
//!   差别只在处置面：内置只能停用（不可删除），自建可停用也可删除。
//! - 「停用」= 仅从 pi settings.json `packages` 移除注册（文件保留）——
//!   ensure_pi_extensions_installed 只按文件版本判定（不看注册），天然
//!   不会把停用的内置装回来；「恢复」= 注册加回（零网络）。

use std::path::PathBuf;

/// 内置 pi 扩展展示名（市场卡/确认卡文案用；与钉版清单一一对应）。
pub(crate) fn builtin_pi_display_name(pkg_dir_name: &str) -> Option<&'static str> {
    Some(match pkg_dir_name {
        "pi-subagents" => "子代理",
        "@juicesharp/rpiv-ask-user-question" => "选项式提问",
        "@juicesharp/rpiv-todo" => "待办清单",
        "pi-web-access" => "联网搜索",
        "pi-lens" => "写后诊断",
        _ => return None,
    })
}

/// 停用台账条目：被停用者是谁、被谁替代（替代者卸载时自动恢复）。
#[derive(serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub(crate) struct PiOverrideEntry {
    /// 被停用者的完整注册串（settings.json packages 条目原样，如
    /// `npm:pi-web-access@0.32.0`）。
    pub source: String,
    /// 被停用者是否内置包（内置不可删除，卡上只显示替代提示）。
    pub builtin: bool,
    /// 展示名（恢复/提示文案用）。
    pub display: String,
    /// 替代者注册串（其卸载时触发本条目恢复）。
    pub replaced_by: String,
}

fn overrides_path() -> Option<PathBuf> {
    Some(crate::agent::manifest::hub_home().join("pi-extension-overrides.json"))
}

fn pi_settings_path() -> Option<PathBuf> {
    // 测试隔离：JISHU_PI_SETTINGS 指向临时文件（agent_dir 无既有重定向，
    // 直接写会碰开发机真实 pi 配置）。
    if let Ok(p) = std::env::var("JISHU_PI_SETTINGS") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    super::paths::agent_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

/// 读停用台账（文件缺失/损坏 → 空表）。
pub(crate) fn load_overrides() -> Vec<PiOverrideEntry> {
    let Some(path) = overrides_path() else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn save_overrides(entries: &[PiOverrideEntry]) -> Result<(), String> {
    let path = overrides_path().ok_or("cannot resolve hub home")?;
    let body = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

/// 当前 pi settings.json 的 packages 注册表（读失败 → 空表）。
pub(crate) fn registered_packages() -> Vec<String> {
    let Some(path) = pi_settings_path() else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| {
            v.get("packages").and_then(|p| p.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// 编辑 pi settings.json 的 packages 数组（保留其他字段；原子写）。
fn mutate_packages(keep: impl Fn(&str) -> bool, add: Vec<String>) -> Result<(), String> {
    let path = pi_settings_path().ok_or("cannot resolve pi settings")?;
    let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut v: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("pi settings 损坏: {e}"))?;
    let arr = v
        .get_mut("packages")
        .and_then(|p| p.as_array_mut())
        .ok_or("pi settings 缺 packages 数组")?;
    arr.retain(|x| x.as_str().map(&keep).unwrap_or(true));
    for s in add {
        if !arr.iter().any(|x| x.as_str() == Some(s.as_str())) {
            arr.push(serde_json::Value::String(s));
        }
    }
    let body = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp-hub");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 注册串 → npm 包目录名（`npm:@scope/pkg@1.0` → `@scope/pkg`；
/// `npm:pkg` → `pkg`；git 源返回 None）。
pub(crate) fn package_dir_of(source: &str) -> Option<String> {
    let rest = source.strip_prefix("npm:")?;
    // rsplit 版本段（scoped 包首 @ 不受影响；无版本串原样）。
    let name = match rest.rsplit_once('@') {
        Some((n, v)) if !n.is_empty() && !v.is_empty() && !n.ends_with('/') => n,
        _ => rest,
    };
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// 在注册表中按包目录名找该包的完整注册串（`pi-web-access` →
/// `npm:pi-web-access@0.32.0`；同包多注册取首条——实际环境一包一注册）。
pub(crate) fn registered_source_of(pkg_dir: &str) -> Option<String> {
    registered_packages()
        .into_iter()
        .find(|s| package_dir_of(s).as_deref() == Some(pkg_dir))
}

/// 停用一个扩展（移注册不删文件）并记台账。幂等（已停用则仅补台账）。
pub(crate) fn disable_extension(
    source: &str,
    display: &str,
    replaced_by: &str,
) -> Result<(), String> {
    let pkg_dir = package_dir_of(source).ok_or("仅支持 npm: 源停用")?;
    let builtin = builtin_pi_display_name(&pkg_dir).is_some();
    mutate_packages(
        |s| package_dir_of(s).as_deref() != Some(pkg_dir.as_str()),
        Vec::new(),
    )?;
    let mut entries = load_overrides();
    entries.retain(|e| package_dir_of(&e.source).as_deref() != Some(pkg_dir.as_str()));
    entries.push(PiOverrideEntry {
        source: source.to_string(),
        builtin,
        display: display.to_string(),
        replaced_by: replaced_by.to_string(),
    });
    save_overrides(&entries)
}

/// 恢复一个被停用的扩展（注册加回 + 清台账条目）。文件仍在 → 零网络。
pub(crate) fn enable_extension(pkg_dir: &str) -> Result<Option<PiOverrideEntry>, String> {
    let Some(entry) = load_overrides()
        .into_iter()
        .find(|e| package_dir_of(&e.source).as_deref() == Some(pkg_dir))
    else {
        return Ok(None);
    };
    mutate_packages(|_| true, vec![entry.source.clone()])?;
    let mut entries = load_overrides();
    entries.retain(|e| e != &entry);
    save_overrides(&entries)?;
    Ok(Some(entry))
}

/// 替代者卸载钩子：恢复所有因它停用的扩展，返回恢复清单（含展示名，
/// 供卸载结果提示「已恢复 XX」）。恢复后由调用方探针验证引擎健康。
pub(crate) fn restore_replaced_by(replacer_source: &str) -> Vec<PiOverrideEntry> {
    let mut restored = Vec::new();
    for entry in load_overrides() {
        if entry.replaced_by != replacer_source {
            continue;
        }
        let pkg_dir = package_dir_of(&entry.source).unwrap_or_else(|| entry.source.clone());
        match enable_extension(&pkg_dir) {
            Ok(Some(e)) => restored.push(e),
            Ok(None) => {}
            Err(err) => log::warn!("[pi-registry] 恢复 {} 失败: {err}", entry.source),
        }
    }
    restored
}

/// 卸载自身钩子：被停用者本身被删除时，清掉它的台账条目。
pub(crate) fn forget_disabled(pkg_dir: &str) -> Result<(), String> {
    let mut entries = load_overrides();
    let before = entries.len();
    entries.retain(|e| package_dir_of(&e.source).as_deref() != Some(pkg_dir));
    if entries.len() != before {
        save_overrides(&entries)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 注册串 → 包目录名（无版本/带版本/scoped/裸名）。
    #[test]
    fn package_dir_of_forms() {
        assert_eq!(
            package_dir_of("npm:pi-web-access").as_deref(),
            Some("pi-web-access")
        );
        assert_eq!(
            package_dir_of("npm:pi-web-access@0.32.0").as_deref(),
            Some("pi-web-access")
        );
        assert_eq!(
            package_dir_of("npm:@juicesharp/rpiv-todo@2.11.0").as_deref(),
            Some("@juicesharp/rpiv-todo")
        );
        assert_eq!(
            package_dir_of("npm:@scope/pkg").as_deref(),
            Some("@scope/pkg")
        );
        assert_eq!(package_dir_of("git:github.com/a/b"), None);
    }

    /// 停用/恢复闭环（临时 hub home + 临时 pi settings 双隔离）：
    /// disable 移注册+记台账 → enable 注册回来+清台账 →
    /// restore_replaced_by 按替代者恢复 → forget 清条目。
    #[test]
    fn disable_enable_restore_roundtrip() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        let pi_settings = tmp.path().join("pi-settings.json");
        std::fs::write(
            &pi_settings,
            r#"{"theme": "dark", "packages": ["npm:pi-lens@4.3.0", "npm:pi-web-access@0.32.0", "npm:pi-subagents@0.72.0"]}"#,
        )
        .unwrap();
        std::env::set_var("JISHU_PI_SETTINGS", &pi_settings);

        // 停用内置联网搜索（被 rpiv-web-tools 替代）
        disable_extension(
            "npm:pi-web-access@0.32.0",
            "联网搜索",
            "npm:@juicesharp/rpiv-web-tools",
        )
        .unwrap();
        let pkgs = registered_packages();
        assert!(
            !pkgs.iter().any(|p| p.contains("pi-web-access")),
            "注册已移除: {pkgs:?}"
        );
        assert!(
            pkgs.iter().any(|p| p.contains("pi-lens")),
            "其他注册不受影响"
        );
        assert_eq!(load_overrides().len(), 1);
        assert!(load_overrides()[0].builtin);

        // 替代者卸载 → 自动恢复
        let restored = restore_replaced_by("npm:@juicesharp/rpiv-web-tools");
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].display, "联网搜索");
        assert!(registered_packages()
            .iter()
            .any(|p| p == "npm:pi-web-access@0.32.0"));
        assert!(load_overrides().is_empty());
        // settings 其他字段保留
        let body = std::fs::read_to_string(&pi_settings).unwrap();
        assert!(body.contains("\"theme\": \"dark\""), "其他字段保留: {body}");

        // 被停者自身删除 → forget 清条目
        disable_extension("npm:pi-web-access@0.32.0", "联网搜索", "npm:x/y").unwrap();
        assert_eq!(load_overrides().len(), 1);
        forget_disabled("pi-web-access").unwrap();
        assert!(load_overrides().is_empty());

        std::env::remove_var("JISHU_HUB_HOME");
        std::env::remove_var("JISHU_PI_SETTINGS");
    }

    /// 包目录名/展示名映射。
    #[test]
    fn override_mappings() {
        assert_eq!(builtin_pi_display_name("pi-web-access"), Some("联网搜索"));
        assert_eq!(builtin_pi_display_name("no-such"), None);
        assert_eq!(
            builtin_pi_display_name("@juicesharp/rpiv-todo"),
            Some("待办清单")
        );
    }
}
