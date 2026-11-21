//! v0.9.8 需求15 方案 A：pi 扩展注册与冲突停用（hub 侧冲突治理）。
//! v0.9.8 需求4 D4-8：停用台账迁入扩展统一登记簿 extensions.db
//! （原 pi-extension-overrides.json 由需求16 M-1 一次性迁入并归档）。
//!
//! 产品语义（用户裁决 2026-11-20/21）：
//! - 拥抱 pi 原生 fail-loud（工具名冲突拒绝启动），hub 负责让用户永远
//!   进不了崩态：安装预检检出冲突 → 说明「与已装能力重叠」→ 用户选择
//!   继续安装（停用对手）/取消（不装）。
//! - 冲突治理**对所有扩展一致**（内置 vs 用户装、用户 A vs 用户 B 同规）；
//!   差别只在处置面：内置只能停用（不可删除），自建可停用也可删除。
//! - 「停用」= 仅从 pi settings.json `packages` 移除注册（文件保留）+
//!   登记簿 state=disabled + **级联停用依赖它的适配件**（2026-11-21
//!   用户裁决：与其使用时高度不确定，不如联动停用）；「恢复」= 注册
//!   加回（零网络）+ 级联精确反启。
//!
//! 本文件保留 pi settings.json 注册面的读写（pi 域唯一写入方）；台账/
//! 级联/查询全部走 [`crate::agent::extensions_db`]。

use std::path::PathBuf;

/// 内置 pi 扩展展示名（数据驱动：builtin.json；包装供旧调用点）。
pub(crate) fn builtin_pi_display_name(pkg_dir_name: &str) -> Option<String> {
    super::builtin_pi_display_name_of(pkg_dir_name)
}

/// 停用台账条目（需求15 命令响应形状——前端契约不变）。
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

/// 读停用台账（extensions.db 视图；库缺失/损坏 → 空表）。
pub(crate) fn load_overrides() -> Vec<PiOverrideEntry> {
    let _ = crate::agent::extensions_db::ensure_schema();
    crate::agent::extensions_db::disabled_entries()
        .unwrap_or_default()
        .into_iter()
        .map(|e| PiOverrideEntry {
            source: e.source,
            builtin: e.builtin,
            display: e.display,
            replaced_by: e.replaced_by,
        })
        .collect()
}

/// 停用一个扩展：移注册（pi 域）+ 登记簿 disabled + 级联停用适配件。
/// 幂等（已停用则仅补台账面）。返回被级联停用的插件（提示用）。
pub(crate) fn disable_extension(
    source: &str,
    display: &str,
    replaced_by: &str,
) -> Result<Vec<String>, String> {
    let pkg_dir = package_dir_of(source).ok_or("仅支持 npm: 源停用")?;
    mutate_packages(
        |s| package_dir_of(s).as_deref() != Some(pkg_dir.as_str()),
        Vec::new(),
    )?;
    let _ = crate::agent::extensions_db::ensure_schema();
    crate::agent::extensions_db::set_extension_disabled(source, display, replaced_by)
}

/// 恢复一个被停用的扩展：注册加回（pi 域）+ 登记簿 active + 级联精确
/// 反启。文件仍在 → 零网络。返回 (台账条目, 被级联恢复的插件)。
pub(crate) fn enable_extension(
    pkg_dir: &str,
) -> Result<(Option<PiOverrideEntry>, Vec<String>), String> {
    let _ = crate::agent::extensions_db::ensure_schema();
    let pkg_key = format!("npm:{pkg_dir}");
    let (entry, restored) = crate::agent::extensions_db::set_extension_active(&pkg_key)?;
    if let Some(e) = &entry {
        mutate_packages(|_| true, vec![e.source.clone()])?;
    }
    Ok((
        entry.map(|e| PiOverrideEntry {
            source: e.source,
            builtin: e.builtin,
            display: e.display,
            replaced_by: e.replaced_by,
        }),
        restored,
    ))
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
            Ok((Some(e), _)) => restored.push(e),
            Ok((None, _)) => {}
            Err(err) => log::warn!("[pi-registry] 恢复 {} 失败: {err}", entry.source),
        }
    }
    restored
}

/// 卸载自身钩子：被停用者本身被删除时，清掉它的台账条目（含级联行）。
pub(crate) fn forget_disabled(pkg_dir: &str) -> Result<(), String> {
    crate::agent::extensions_db::ensure_schema()?;
    crate::agent::extensions_db::forget_extension(&format!("npm:{pkg_dir}"))
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

    /// 停用/恢复闭环（hub home + pi settings + extensions.db 三重隔离）：
    /// disable 移注册+记台账 → enable 注册回来+清台账 →
    /// restore_replaced_by 按替代者恢复 → forget 清条目。
    #[test]
    fn disable_enable_restore_roundtrip() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        std::env::set_var("JISHU_EXTENSIONS_DB", tmp.path().join("ext.db"));
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
        std::env::remove_var("JISHU_EXTENSIONS_DB");
    }

    /// 包目录名/展示名映射（数据驱动 builtin.json）。
    #[test]
    fn override_mappings() {
        assert_eq!(
            builtin_pi_display_name("pi-web-access"),
            Some("联网搜索".to_string())
        );
        assert_eq!(builtin_pi_display_name("no-such"), None);
        assert_eq!(
            builtin_pi_display_name("@juicesharp/rpiv-todo"),
            Some("待办清单".to_string())
        );
    }
}
