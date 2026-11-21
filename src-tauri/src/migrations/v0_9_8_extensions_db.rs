//! 需求16 M-1（v0.9.8）：extensions.db 初始化与历史数据统一迁入。
//!
//! 服务需求4 D4-8（扩展统一登记簿）。幂等设计（中断重跑安全）：
//! - 建表 IF NOT EXISTS；
//! - 内置/已注册扩展 upsert（不覆盖 hub 元数据）；
//! - 方案A 停用台账（pi-extension-overrides.json）一次性迁入后归档
//!   `.imported`（zcode 一次性导入快照模式：旧文件不再回写）；
//! - 关系表重建（真源=插件 [[adapt]] 声明，重算即幂等）；
//! - 健康自检（zcode 3.12.3 静默失效反例教训）：行数对账 fail-loud。

use super::{Migration, MigrationCtx};
use crate::agent::extensions_db;

pub(crate) static MIGRATION: Migration = Migration {
    id: "v0.9.8-extensions-db",
    version: "0.9.8",
    description: "升级插件与扩展数据结构",
    critical: true,
    run,
};

fn run(ctx: &MigrationCtx) -> Result<(), String> {
    // 1) 建表。
    extensions_db::ensure_schema()?;

    // 2) 注册面同步：内置五件 ∪ pi settings 历史已装扩展（用户点名的
    //    「历史安装的插件数据统一迁移」）。
    let builtin = crate::agent::jishu_self::builtin_extensions()
        .iter()
        .map(|(s, d, n)| (s.clone(), d.clone(), n.clone()))
        .collect::<Vec<_>>();
    let registered = crate::agent::jishu_self::pi_registry::registered_packages();
    let pool_root = crate::agent::jishu_self::paths::agent_dir()
        .ok()
        .map(|d| std::path::PathBuf::from(d).join("npm").join("node_modules"));
    extensions_db::sync_registry_face(&builtin, &registered, pool_root.as_deref())?;
    // 内置判定预置（builtin.json 的 noneeded——仅 pending 态落，不覆盖改判）。
    extensions_db::apply_builtin_verdict_presets()?;

    // 3) 方案A 停用台账迁入（存在才迁；迁后归档）。
    let legacy = ctx.hub_home.join("pi-extension-overrides.json");
    if legacy.exists() {
        ctx.backup_file(MIGRATION.version, &legacy)?;
        let entries: Vec<LegacyOverride> = std::fs::read_to_string(&legacy)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default();
        for e in entries {
            extensions_db::set_extension_disabled(&e.source, &e.display, &e.replaced_by)?;
        }
        ctx.archive_imported(&legacy)?;
    }

    // 4) 关系表重建（真源=插件声明；M-1 时点通常为零行，随首装适配件增长）。
    let decls = crate::agent::plugin::adapt_declarations();
    extensions_db::rebuild_adaptations(&decls)?;

    // 5) 级联对账（停用扩展的适配件补停；台账 vs 实际启停一致性）。
    extensions_db::reconcile_cascade()?;

    // 6) 健康自检：内置全量在簿 + 注册面全覆盖（fail-loud，绝不静默）。
    let list = extensions_db::registry_list()?;
    let by_pkg = |key: &str| list.iter().any(|e| e.pkg_key == key);
    for (_, dir, _) in &builtin {
        let pkg_key = format!("npm:{dir}");
        if !by_pkg(&pkg_key) {
            return Err(format!("自检失败：内置扩展 {dir} 未入登记簿"));
        }
    }
    for source in &registered {
        if let Some(key) = extensions_db::pkg_key_of(source) {
            if !by_pkg(&key) {
                return Err(format!("自检失败：已装扩展 {source} 未入登记簿"));
            }
        }
    }
    Ok(())
}

/// 旧台账条目（与需求15 PiOverrideEntry 同构；仅迁移读取用）。
#[derive(serde::Deserialize)]
struct LegacyOverride {
    source: String,
    #[allow(dead_code)]
    builtin: bool,
    display: String,
    replaced_by: String,
}

#[cfg(test)]
mod tests {
    /// builtin.json 解析完整性（5 件、源串形态、目录名/展示名非空）。
    #[test]
    fn builtin_json_parses_five() {
        let list = crate::agent::jishu_self::builtin_extensions();
        assert_eq!(list.len(), 5, "内置扩展清单: {list:?}");
        for (source, dir, display) in list {
            assert!(source.starts_with("npm:"), "源串形态: {source}");
            assert!(!dir.is_empty() && !display.is_empty());
        }
        assert_eq!(
            crate::agent::jishu_self::builtin_pi_display_name_of("pi-web-access"),
            Some("联网搜索".to_string())
        );
        assert_eq!(
            crate::agent::jishu_self::builtin_pi_display_name_of("no-such"),
            None
        );
    }
}
