//! 需求4 D4-8（v0.9.8）：扩展统一登记簿 extensions.db。
//!
//! 产品语义（用户三轮裁决 2026-11-21）：插件（GUI 呈现）与 pi 扩展之间
//! 是 **M:N 关系**——一个扩展可被多个插件适配（会话用量弹窗+项目用量
//! 侧栏），一个插件也可整合多个扩展；「有无 GUI」从此查表有据。内置
//! 扩展与用户装的同构（builtin 仅标记列；「定制/适配好/预置」= 出厂可
//! 带 adapters）。
//!
//! 职责分层（防两本账打架）：
//! - 注册真源 = pi settings.json（pi 域，hub 只读）；
//! - 适配关系真源 = plugin.toml `[[adapt]]` 声明（rebuild 全量重算）；
//! - 本库 = 可重建索引（注册面+关系表）+ hub 独有元数据（gui_verdict/
//!   verdict_note 长驻，重建不覆盖）+ 级联停用台账。
//!
//! 级联语义（用户裁决 2026-11-21）：扩展停用 → 依赖它的全部适配件
//! **联动停用**（不猜「部分依赖还能不能用」）；扩展恢复 → 按
//! cascade_disables 台账**精确反启**（用户手动停过的不动；用户在源仍停
//! 时手动启用的插件，台账行清除=用户意志优先，界面仅警示）。

use rusqlite::Connection;
use std::path::PathBuf;

/// db 路径（测试隔离：JISHU_EXTENSIONS_DB 重定向）。
fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("JISHU_EXTENSIONS_DB") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    crate::agent::manifest::hub_home().join("extensions.db")
}

fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, String> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path).map_err(|e| format!("extensions.db 打开失败: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("extensions.db WAL 失败: {e}"))?;
    f(&conn).map_err(|e| format!("extensions.db 操作失败: {e}"))
}

/// 建表（幂等；M-1 迁移与首次消费双入口共用）。
pub fn ensure_schema() -> Result<(), String> {
    with_conn(|conn| {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS extensions (
              source       TEXT NOT NULL,
              -- 同包恒一行（版本升级=source 刷新，不堆行）；停用态行保留
              --（注册被有意移除正是停用语义）。
              pkg_key      TEXT NOT NULL UNIQUE,
              display      TEXT NOT NULL,
              builtin      INTEGER NOT NULL DEFAULT 0,
              state        TEXT NOT NULL DEFAULT 'active',
              replaced_by  TEXT,
              gui_verdict  TEXT NOT NULL DEFAULT 'pending',
              verdict_note TEXT,
              updated_at   INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ext_pkg ON extensions(pkg_key);
            CREATE TABLE IF NOT EXISTS plugin_adaptations (
              plugin_id TEXT NOT NULL,
              pkg_key   TEXT NOT NULL,
              tools     TEXT,
              PRIMARY KEY (plugin_id, pkg_key)
            );
            CREATE INDEX IF NOT EXISTS idx_adapt_pkg ON plugin_adaptations(pkg_key);
            CREATE TABLE IF NOT EXISTS cascade_disables (
              plugin_id   TEXT NOT NULL,
              pkg_key     TEXT NOT NULL,
              disabled_at INTEGER NOT NULL,
              PRIMARY KEY (plugin_id, pkg_key)
            );
            "#,
        )
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `npm:pkg@1.0` → 无版本关系键 `npm:pkg`（复用 pi_registry 的目录名
/// 解析——pkg_key 与包目录名同构：`npm:` + 目录名）。
pub fn pkg_key_of(source: &str) -> Option<String> {
    super::jishu_self::pi_registry::package_dir_of(source).map(|dir| format!("npm:{dir}"))
}

/// upsert 一个扩展行（pkg_key 锚定：同包恒一行，source 随注册串刷新；
/// **不触碰** state/replaced_by/gui_verdict/verdict_note——hub 元数据
/// 与停用态长驻，重建不覆盖）。
fn upsert_registry_face(
    conn: &Connection,
    source: &str,
    pkg_key: &str,
    display: &str,
    builtin: bool,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO extensions (source, pkg_key, display, builtin, state, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', ?5)
         ON CONFLICT(pkg_key) DO UPDATE SET
           source = excluded.source,
           display = CASE WHEN excluded.builtin = 1 THEN excluded.display ELSE extensions.display END,
           builtin = MAX(extensions.builtin, excluded.builtin),
           updated_at = excluded.updated_at",
        rusqlite::params![source, pkg_key, display, builtin as i64, now_ms()],
    )?;
    Ok(())
}

/// 注册面对账：内置清单 ∪ pi settings 注册全量 upsert；清理「已卸载残留」
/// （非内置、非停用态、既不在注册表、池内文件又不存在）。
pub fn sync_registry_face(
    builtin: &[(String, String, String)], // (source, dir, display)
    registered: &[String],
    pool_root: Option<&std::path::Path>,
) -> Result<(), String> {
    with_conn(|conn| {
        for (source, dir, display) in builtin {
            upsert_registry_face(conn, source, &format!("npm:{dir}"), display, true)?;
        }
        for source in registered {
            let pkg_key = pkg_key_of(source).unwrap_or_else(|| source.clone());
            let display = pkg_key.trim_start_matches("npm:").to_string();
            upsert_registry_face(conn, source, &pkg_key, &display, false)?;
        }
        // 残留清理：保守删除（停用态保留——注册被有意移除是停用语义）。
        let stale: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT source, pkg_key FROM extensions WHERE builtin = 0 AND state = 'active'",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for (_source, pkg_key) in stale {
            let still_registered = registered
                .iter()
                .any(|s| pkg_key_of(s).as_deref() == Some(pkg_key.as_str()));
            if still_registered {
                continue;
            }
            let file_gone = pool_root
                .map(|root| {
                    let dir = pkg_key
                        .trim_start_matches("npm:")
                        .replace('/', std::path::MAIN_SEPARATOR_STR);
                    !root.join(dir).exists()
                })
                .unwrap_or(false);
            if file_gone {
                conn.execute("DELETE FROM extensions WHERE pkg_key = ?1", [&pkg_key])?;
                conn.execute(
                    "DELETE FROM plugin_adaptations WHERE pkg_key = ?1",
                    [&pkg_key],
                )?;
            }
        }
        Ok(())
    })
}

/// 关系表重建（真源=插件 [[adapt]] 声明）：事务内全量重算。
pub fn rebuild_adaptations(
    decls: &[(String, Vec<(String, Option<Vec<String>>)>)], // (plugin_id, [(extension, tools)])
) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute("DELETE FROM plugin_adaptations", [])?;
        for (plugin_id, sections) in decls {
            for (extension, tools) in sections {
                let tools_json = tools
                    .as_ref()
                    .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".into()));
                conn.execute(
                    "INSERT OR REPLACE INTO plugin_adaptations (plugin_id, pkg_key, tools)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![plugin_id, extension, tools_json],
                )?;
            }
        }
        Ok(())
    })
}

/// 停用一个扩展（登记簿态）并**级联停用**依赖它的适配件。
/// 返回被级联停用的插件 id 清单（调用方提示用）。
pub fn set_extension_disabled(
    source: &str,
    display: &str,
    replaced_by: &str,
) -> Result<Vec<String>, String> {
    let pkg_key = pkg_key_of(source).ok_or("仅支持 npm: 源停用")?;
    let builtin = super::jishu_self::builtin_pi_display_name_of(
        &pkg_key.trim_start_matches("npm:").to_string(),
    )
    .is_some();
    with_conn(|conn| {
        conn.execute(
            "INSERT INTO extensions (source, pkg_key, display, builtin, state, replaced_by, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'disabled', ?5, ?6)
             ON CONFLICT(pkg_key) DO UPDATE SET
               source = excluded.source,
               display = excluded.display,
               builtin = MAX(extensions.builtin, excluded.builtin),
               state = 'disabled', replaced_by = ?5,
               updated_at = excluded.updated_at",
            rusqlite::params![source, pkg_key, display, builtin as i64, replaced_by, now_ms()],
        )?;
        Ok(())
    })?;
    cascade_disable(&pkg_key)
}

/// 恢复扩展（active + 清替代者）并**级联恢复**。返回 (entry, 恢复的插件)。
pub fn set_extension_active(pkg_key: &str) -> Result<(Option<DisabledEntry>, Vec<String>), String> {
    let entry = disabled_entry_by_pkg(pkg_key)?;
    let Some(e) = entry else {
        return Ok((None, Vec::new()));
    };
    with_conn(|conn| {
        conn.execute(
            "UPDATE extensions SET state = 'active', replaced_by = NULL, updated_at = ?2
             WHERE pkg_key = ?1",
            rusqlite::params![pkg_key, now_ms()],
        )?;
        Ok(())
    })?;
    let restored = cascade_restore(pkg_key);
    Ok((Some(e), restored))
}

/// 台账视图：被停用条目（对齐需求15 PiOverrideEntry 语义）。
#[derive(serde::Serialize, Clone)]
pub struct DisabledEntry {
    pub source: String,
    pub builtin: bool,
    pub display: String,
    pub replaced_by: String,
}

/// 按 pkg_key 取停用条目（冲突替代关系；启用守卫消费）。
pub(crate) fn disabled_entry_by_pkg(pkg_key: &str) -> Result<Option<DisabledEntry>, String> {
    with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT source, builtin, display, replaced_by FROM extensions
             WHERE pkg_key = ?1 AND state = 'disabled'",
        )?;
        let mut rows = stmt.query_map([pkg_key], |row| {
            Ok(DisabledEntry {
                source: row.get(0)?,
                builtin: row.get::<_, i64>(1)? == 1,
                display: row.get(2)?,
                replaced_by: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })?;
        Ok(rows.next().transpose()?)
    })
}

/// 全部被停用条目（替代者卸载钩子/overrides 清单消费）。
pub fn disabled_entries() -> Result<Vec<DisabledEntry>, String> {
    with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT source, builtin, display, replaced_by FROM extensions
             WHERE state = 'disabled' ORDER BY updated_at",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DisabledEntry {
                source: row.get(0)?,
                builtin: row.get::<_, i64>(1)? == 1,
                display: row.get(2)?,
                replaced_by: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

/// 扩展展示名（登记簿在册者；用于守卫提示点名替代者）。
pub(crate) fn display_of_pkg(pkg_key: &str) -> Option<String> {
    with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT display FROM extensions WHERE pkg_key = ?1")?;
        let mut rows = stmt.query_map([pkg_key], |row| row.get::<_, String>(0))?;
        Ok(rows.next().transpose()?)
    })
    .ok()
    .flatten()
}

/// 被停者自身被卸载：清行（含级联行）。
pub fn forget_extension(pkg_key: &str) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute(
            "DELETE FROM extensions WHERE pkg_key = ?1 AND state = 'disabled'",
            [pkg_key],
        )?;
        conn.execute("DELETE FROM cascade_disables WHERE pkg_key = ?1", [pkg_key])?;
        Ok(())
    })
}

/// 卸载路径的级联停用（R2-T2 实测缺口收口）：扩展卸载后停用其适配件
/// 并记台账（重装扩展后经 reconcile_cascade/恢复流回到启用）。失败仅
/// 记日志——卸载主流程不因此回滚（文件已删，半途而废更糟）。
pub fn cascade_disable_adapters(pkg_key: &str) -> Vec<String> {
    match cascade_disable(pkg_key) {
        Ok(list) => list,
        Err(e) => {
            log::warn!("[extensions-db] 卸载级联停用失败（{pkg_key}）: {e}");
            Vec::new()
        }
    }
}

/// 级联写入插件启停态：适配件走带守卫的入口；内置 pi 扩展包的启停闸门
/// 走内部写入（v0.9.8 评审修复轮 R1-0——闸门是用户在确认卡上明确选择的
/// 冲突处置对象，不受「默认安装集不可禁用」约束，也不能被启用冲突守卫
/// 挡住：恢复时登记簿已先回到启用态）。
fn set_plugin_enabled_for_extension(plugin_id: &str, enabled: bool) -> Result<(), String> {
    if crate::agent::plugin::is_pi_package_plugin(plugin_id) {
        crate::agent::plugin::apply_plugin_enabled(plugin_id, enabled).map(|_| ())
    } else {
        crate::agent::plugin::set_plugin_enabled(plugin_id, enabled).map(|_| ())
    }
}

/// 级联停用：停用依赖 pkg_key 的全部**当前启用中**的适配件并记台账
/// （用户此前已手动停的不重复记——恢复时不动它们）。
///
/// v0.9.8 评审修复轮 R1-0：内置 pi 扩展包的**启停闸门插件**与其适配件
/// 同列——扩展停用，决定「注册同步是否保留该包」的源头必须一并停用
/// （否则下次同步把停用的包补回 → 工具撞名 → 引擎启动即退出）。闸门走
/// 同一本级联台账：恢复时精确反启；用户此前已手动停用的不记台账、恢复
/// 时不动（用户意志优先）。
fn cascade_disable(pkg_key: &str) -> Result<Vec<String>, String> {
    let mut plugins = adapters_of_pkg(pkg_key)?;
    if let Some(gate) =
        crate::agent::plugin::pi_package_plugin_id(pkg_key.trim_start_matches("npm:"))
    {
        if !plugins.iter().any(|p| p == gate) {
            plugins.push(gate.to_string());
        }
    }
    let disabled_now = crate::agent::plugin::load_plugin_config().disabled;
    let mut cascaded = Vec::new();
    for plugin_id in plugins {
        if disabled_now.contains(&plugin_id) {
            continue; // 用户已手动停——不记台账，恢复时不碰。
        }
        match set_plugin_enabled_for_extension(&plugin_id, false) {
            Ok(_) => {
                with_conn(|conn| {
                    conn.execute(
                        "INSERT OR REPLACE INTO cascade_disables (plugin_id, pkg_key, disabled_at)
                         VALUES (?1, ?2, ?3)",
                        rusqlite::params![plugin_id, pkg_key, now_ms()],
                    )?;
                    Ok(())
                })?;
                cascaded.push(plugin_id);
            }
            Err(e) => log::warn!("[extensions-db] 级联停用 {plugin_id} 失败: {e}"),
        }
    }
    Ok(cascaded)
}

/// 级联恢复：精确反启「因 pkg_key 被联动停且当前仍停用」的插件。
fn cascade_restore(pkg_key: &str) -> Vec<String> {
    let rows: Vec<String> = match with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT plugin_id FROM cascade_disables WHERE pkg_key = ?1")?;
        let rows = stmt.query_map([pkg_key], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[extensions-db] 级联恢复读取失败: {e}");
            return Vec::new();
        }
    };
    let disabled_now = crate::agent::plugin::load_plugin_config().disabled;
    let mut restored = Vec::new();
    for plugin_id in rows {
        if !disabled_now.contains(&plugin_id) {
            // 用户已自行启用（源仍停时的手动覆盖）——清台账行，用户意志优先。
            let _ = with_conn(|conn| {
                conn.execute(
                    "DELETE FROM cascade_disables WHERE plugin_id = ?1 AND pkg_key = ?2",
                    rusqlite::params![plugin_id, pkg_key],
                )?;
                Ok(())
            });
            continue;
        }
        match set_plugin_enabled_for_extension(&plugin_id, true) {
            Ok(_) => {
                let _ = with_conn(|conn| {
                    conn.execute(
                        "DELETE FROM cascade_disables WHERE plugin_id = ?1 AND pkg_key = ?2",
                        rusqlite::params![plugin_id, pkg_key],
                    )?;
                    Ok(())
                });
                restored.push(plugin_id);
            }
            Err(e) => log::warn!("[extensions-db] 级联恢复 {plugin_id} 失败: {e}"),
        }
    }
    restored
}

/// 对账级联（rebuild/启停后调用）：
/// 1) 台账在册但插件已启用 → 用户手动覆盖，清行；
/// 2) 扩展 disabled 但适配件仍在启用 → 补级联（防绕道）。
pub fn reconcile_cascade() -> Result<(), String> {
    let disabled_now = crate::agent::plugin::load_plugin_config().disabled;
    // 1) 手动覆盖清理。
    let rows: Vec<(String, String)> = with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT plugin_id, pkg_key FROM cascade_disables")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })?;
    for (plugin_id, pkg_key) in rows {
        if !disabled_now.contains(&plugin_id) {
            with_conn(|conn| {
                conn.execute(
                    "DELETE FROM cascade_disables WHERE plugin_id = ?1 AND pkg_key = ?2",
                    rusqlite::params![plugin_id, pkg_key],
                )?;
                Ok(())
            })?;
        }
    }
    // 2) 停用扩展的适配件补停。
    let disabled_pkgs: Vec<String> = with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT DISTINCT pkg_key FROM extensions WHERE state = 'disabled'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })?;
    for pkg_key in disabled_pkgs {
        cascade_disable(&pkg_key)?;
    }
    Ok(())
}

fn adapters_of_pkg(pkg_key: &str) -> Result<Vec<String>, String> {
    with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT plugin_id FROM plugin_adaptations WHERE pkg_key = ?1")?;
        let rows = stmt.query_map([pkg_key], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

/// gui_verdict 落档（D4-7 第 0 步判定结果；adapted 为派生值不落库）。
pub fn set_verdict(pkg_key: &str, verdict: &str, note: Option<&str>) -> Result<(), String> {
    if !matches!(verdict, "pending" | "noneeded" | "session") {
        return Err(format!("非法 verdict: {verdict}"));
    }
    with_conn(|conn| {
        conn.execute(
            "UPDATE extensions SET gui_verdict = ?2, verdict_note = ?3, updated_at = ?4
             WHERE pkg_key = ?1",
            rusqlite::params![pkg_key, verdict, note, now_ms()],
        )?;
        Ok(())
    })
}

// ── 前端查询视图（契约冻结：snake_case）──

/// 扩展条目视图（extension_registry_list 元素）。
#[derive(serde::Serialize)]
pub struct ExtensionEntryView {
    pub source: String,
    pub pkg_key: String,
    pub display: String,
    pub builtin: bool,
    pub state: String,
    pub replaced_by: Option<String>,
    /// pending | noneeded | adapted（派生：adapters 非空）。
    pub gui_verdict: String,
    pub verdict_note: Option<String>,
    pub adapters: Vec<AdapterView>,
}

#[derive(serde::Serialize)]
pub struct AdapterView {
    pub plugin_id: String,
    /// 插件当前启停态（false=停用；是否因级联看 cascade_disabled）。
    pub enabled: bool,
    pub cascade_disabled: bool,
}

/// 扩展的生效态（视图用，v0.9.8 评审修复轮 R1-0）：内置 pi 扩展包已安装
/// 时取自其启停闸门——那才是决定注册同步是否保留该包的源头，登记簿不再
/// 为这类包单独维护一份可能走样的启停态（用户在插件中心停用它，扩展
/// 清单如实显示停用）。其余扩展（用户装的 / 未安装的内置包）用登记簿
/// 自己的状态。
fn effective_state(pkg_key: &str, registry_state: String, disabled_plugins: &[String]) -> String {
    let dir = pkg_key.trim_start_matches("npm:");
    match crate::agent::plugin::pi_package_plugin_id(dir) {
        Some(id) if crate::agent::plugin::plugin_installed(id) => {
            if disabled_plugins.iter().any(|d| d == id) {
                "disabled".to_string()
            } else {
                "active".to_string()
            }
        }
        _ => registry_state,
    }
}

/// 全量扩展清单（含 adapters 反查）——已装页「扩展包」tab 与市场已装卡消费。
pub fn registry_list() -> Result<Vec<ExtensionEntryView>, String> {
    let disabled_now = crate::agent::plugin::load_plugin_config().disabled;
    let cascade: Vec<String> = with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT plugin_id FROM cascade_disables")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })?;
    let base: Vec<(
        String,
        String,
        String,
        bool,
        String,
        Option<String>,
        String,
        Option<String>,
    )> = with_conn(|conn| {
        let mut stmt = conn.prepare(
                "SELECT source, pkg_key, display, builtin, state, replaced_by, gui_verdict, verdict_note
                 FROM extensions ORDER BY builtin DESC, display",
            )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get::<_, i64>(3)? == 1,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })?;
    let mut out = Vec::new();
    for (source, pkg_key, display, builtin, state, replaced_by, verdict, note) in base {
        let adapters_raw: Vec<String> = with_conn(|conn| {
            let mut stmt =
                conn.prepare("SELECT plugin_id FROM plugin_adaptations WHERE pkg_key = ?1")?;
            let rows = stmt.query_map([&pkg_key], |row| row.get::<_, String>(0))?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })?;
        let adapters = adapters_raw
            .into_iter()
            .map(|plugin_id| {
                let enabled = !disabled_now.contains(&plugin_id);
                let cascade_disabled = !enabled && cascade.contains(&plugin_id);
                AdapterView {
                    plugin_id,
                    enabled,
                    cascade_disabled,
                }
            })
            .collect::<Vec<_>>();
        let gui_verdict = if !adapters.is_empty() {
            "adapted".to_string()
        } else {
            verdict
        };
        out.push(ExtensionEntryView {
            source,
            state: effective_state(&pkg_key, state, &disabled_now),
            pkg_key,
            display,
            builtin,
            replaced_by,
            gui_verdict,
            verdict_note: note,
            adapters,
        });
    }
    Ok(out)
}

/// 插件依赖视图（plugin_extension_deps 元素）——适配件「基于」行消费。
#[derive(serde::Serialize)]
pub struct PluginDepView {
    pub plugin_id: String,
    pub deps: Vec<DepView>,
}

#[derive(serde::Serialize)]
pub struct DepView {
    pub pkg_key: String,
    pub display: String,
    pub state: String,
}

pub fn plugin_deps() -> Result<Vec<PluginDepView>, String> {
    let disabled_plugins = crate::agent::plugin::load_plugin_config().disabled;
    let rows: Vec<(String, String)> = with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT plugin_id, pkg_key FROM plugin_adaptations ORDER BY plugin_id")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })?;
    let mut by_plugin: std::collections::BTreeMap<String, Vec<DepView>> = Default::default();
    for (plugin_id, pkg_key) in rows {
        let dep = with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT display, state FROM extensions WHERE pkg_key = ?1
                 ORDER BY builtin DESC LIMIT 1",
            )?;
            let mut rows = stmt.query_map([&pkg_key], |row| {
                Ok(DepView {
                    display: row.get(0)?,
                    state: row.get(1)?,
                    pkg_key: pkg_key.clone(),
                })
            })?;
            Ok(rows.next().transpose()?)
        })?
        .map(|dep| DepView {
            state: effective_state(&pkg_key, dep.state, &disabled_plugins),
            ..dep
        });
        if let Some(dep) = dep {
            by_plugin.entry(plugin_id).or_default().push(dep);
        } else {
            // 扩展行不存在（未迁移/残留）——以 pkg_key 兜底展示，state=missing。
            by_plugin.entry(plugin_id).or_default().push(DepView {
                display: pkg_key.trim_start_matches("npm:").to_string(),
                state: "missing".to_string(),
                pkg_key,
            });
        }
    }
    Ok(by_plugin
        .into_iter()
        .map(|(plugin_id, deps)| PluginDepView { plugin_id, deps })
        .collect())
}

/// 一站式对账（rebuild_registry 尾部/CLI 启动消费）：建表 → 注册面同步
/// （内置∪pi settings∪池残留清理）→ 关系表重建（真源=插件 [[adapt]]）→
/// 级联对账。幂等；失败仅记日志不阻断装载（登记簿是索引层）。
pub fn sync_all() {
    let run = || -> Result<(), String> {
        ensure_schema()?;
        let builtin = crate::agent::jishu_self::builtin_extensions()
            .iter()
            .map(|(s, d, n)| (s.clone(), d.clone(), n.clone()))
            .collect::<Vec<_>>();
        let registered = crate::agent::jishu_self::pi_registry::registered_packages();
        let pool_root = crate::agent::jishu_self::paths::agent_dir()
            .ok()
            .map(|d| PathBuf::from(d).join("npm").join("node_modules"));
        sync_registry_face(&builtin, &registered, pool_root.as_deref())?;
        // 需求17/R3 修正：builtin preset 仅在 M-1 迁移时写入一次（首次启动），
        // 后续 sync 不覆盖——用户「重新判定」→ pending → 适配按钮出现。
        rebuild_adaptations(&crate::agent::plugin::adapt_declarations())?;
        // 预置适配关系（builtin.json preset_adapters）在 rebuild 之后插入
        // ——rebuild 全量 DELETE+从 plugin.toml [[adapt]] 重算会抹掉 preset 行。
        apply_preset_adapters()?;
        reconcile_cascade()?;
        Ok(())
    };
    if let Err(e) = run() {
        log::warn!("[extensions-db] 对账失败（登记簿索引层，不阻断）: {e}");
    }
}

/// 内置判定预置（builtin.json）：仅对仍为 pending 的内置行落 noneeded，
/// 用户改判（pending 重置后的手动结论/adapters 派生态）不覆盖。
pub fn apply_builtin_verdict_presets() -> Result<(), String> {
    for (pkg_key, verdict, note) in crate::agent::jishu_self::builtin_gui_verdicts() {
        with_conn(|conn| {
            // R3 修正：builtin.json 是 hub 权威数据（与代码同版本演进）——
            // 始终刷新（旧版预置的 noneeded 需随升级更新为逐件判定）；
            // 用户改判后下一次 sync 会被覆盖回预置——「重新判定」语义是
            // 给用户看当前判定依据+触发 agent 重评，非永久覆盖 hub 预置。
            conn.execute(
                "UPDATE extensions SET gui_verdict = ?2, verdict_note = ?3, updated_at = ?4
                 WHERE pkg_key = ?1 AND gui_verdict = 'pending'",
                rusqlite::params![pkg_key, verdict, note, now_ms()],
            )?;
            Ok(())
        })?;
    }
    Ok(())
}

/// 预置适配关系（builtin.json preset_adapters：如 rpiv-todo → 任务看板）。
/// 独立于判定预置——必须在 rebuild_adaptations **之后**执行（后者全量
/// DELETE+从 plugin.toml 重算，会抹掉 preset 行）。仅在该扩展无任何
/// 适配行时插入（不与用户产出件竞争）。
pub fn apply_preset_adapters() -> Result<(), String> {
    for (pkg_key, adapters) in crate::agent::jishu_self::builtin_preset_adapters() {
        let existing = with_conn(|conn| {
            let mut stmt =
                conn.prepare("SELECT COUNT(*) FROM plugin_adaptations WHERE pkg_key = ?1")?;
            Ok(stmt.query_row([&pkg_key], |r| r.get::<_, i64>(0))?)
        })?;
        if existing == 0 {
            for plugin_id in adapters {
                with_conn(|conn| {
                    conn.execute(
                        "INSERT OR IGNORE INTO plugin_adaptations (plugin_id, pkg_key, tools) VALUES (?1, ?2, NULL)",
                        rusqlite::params![plugin_id, pkg_key],
                    )?;
                    Ok(())
                })?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db(guard: &std::sync::MutexGuard<'_, ()>) -> PathBuf {
        let _ = guard;
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("ext.db");
        std::env::set_var("JISHU_EXTENSIONS_DB", &db);
        db
    }

    /// upsert 不覆盖 hub 元数据（verdict/note 长驻），注册面全量同步。
    #[test]
    fn upsert_preserves_metadata() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _tmp = test_db(&guard);
        ensure_schema().unwrap();
        sync_registry_face(&[], &["npm:pi-smart-fetch@0.3.23".to_string()], None).unwrap();
        set_verdict("npm:pi-smart-fetch", "noneeded", Some("后台工具")).unwrap();
        // 再同步（版本升级重跑）——verdict 不丢。
        sync_registry_face(&[], &["npm:pi-smart-fetch@0.3.24".to_string()], None).unwrap();
        let list = registry_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].gui_verdict, "noneeded");
        assert_eq!(list[0].verdict_note.as_deref(), Some("后台工具"));
        std::env::remove_var("JISHU_EXTENSIONS_DB");
    }

    /// 级联全链（用户裁决 2026-11-21）：扩展停用 → 依赖适配件联动停用
    /// （级联台账在册）；扩展恢复 → 精确反启（仅联动停的回来）。
    /// 适配件用内置 session.outline（known ids 恒含，无需扫真实目录）。
    #[test]
    fn cascade_disable_restore_with_adapter() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        std::env::set_var("JISHU_EXTENSIONS_DB", tmp.path().join("ext.db"));
        let pi = tmp.path().join("pi.json");
        std::fs::write(&pi, r#"{"packages": ["npm:pi-smart-fetch@0.3.23"]}"#).unwrap();
        std::env::set_var("JISHU_PI_SETTINGS", &pi);
        ensure_schema().unwrap();
        sync_registry_face(&[], &["npm:pi-smart-fetch@0.3.23".to_string()], None).unwrap();
        rebuild_adaptations(&[(
            "session.usage".to_string(),
            vec![("npm:pi-smart-fetch".to_string(), None)],
        )])
        .unwrap();

        // 级联停用：插件从启用被联动停 + 台账行 + disabled_entries。
        let cascaded =
            set_extension_disabled("npm:pi-smart-fetch@0.3.23", "pi-smart-fetch", "npm:x/y")
                .unwrap();
        assert_eq!(cascaded, vec!["session.usage".to_string()]);
        assert!(crate::agent::plugin::load_plugin_config()
            .disabled
            .iter()
            .any(|x| x == "session.usage"));
        assert_eq!(disabled_entries().unwrap().len(), 1);

        // 级联恢复：精确反启（联动停的回来，台账清空）。
        let (entry, restored) = set_extension_active("npm:pi-smart-fetch").unwrap();
        assert!(entry.is_some());
        assert_eq!(restored, vec!["session.usage".to_string()]);
        assert!(!crate::agent::plugin::load_plugin_config()
            .disabled
            .iter()
            .any(|x| x == "session.usage"));
        assert!(disabled_entries().unwrap().is_empty());

        std::env::remove_var("JISHU_HUB_HOME");
        std::env::remove_var("JISHU_PI_SETTINGS");
        std::env::remove_var("JISHU_EXTENSIONS_DB");
    }

    /// 卸载路径级联（R2-T2 实测缺口）：cascade_disable_adapters 停用适配
    /// 件+记台账；扩展重装后 reconcile_cascade 不自动恢复（卸载态语义：
    /// 恢复走显式 enable 或 reconcile 的 disabled 分支——此处锁停用事实）。
    #[test]
    fn cascade_disable_adapters_for_uninstall() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        std::env::set_var("JISHU_EXTENSIONS_DB", tmp.path().join("ext.db"));
        let pi = tmp.path().join("pi.json");
        std::fs::write(&pi, r#"{"packages": ["npm:pi-x@1.0"]}"#).unwrap();
        std::env::set_var("JISHU_PI_SETTINGS", &pi);
        ensure_schema().unwrap();
        sync_registry_face(&[], &["npm:pi-x@1.0".to_string()], None).unwrap();
        rebuild_adaptations(&[(
            "session.usage".to_string(),
            vec![("npm:pi-x".to_string(), None)],
        )])
        .unwrap();
        let cascaded = cascade_disable_adapters("npm:pi-x");
        assert_eq!(cascaded, vec!["session.usage".to_string()]);
        // v0.9.8 评审修复轮 R1-0：用户装的非内置扩展（不在插件↔包映射里）
        // 停用，不触碰任何启停闸门。
        for (gate, _) in crate::agent::plugin::PI_PACKAGE_PLUGIN_MAP {
            assert!(
                !crate::agent::plugin::load_plugin_config()
                    .disabled
                    .iter()
                    .any(|x| x == gate),
                "{gate} 不应被联动停用"
            );
        }
        assert!(crate::agent::plugin::load_plugin_config()
            .disabled
            .iter()
            .any(|x| x == "session.usage"));
        std::env::remove_var("JISHU_HUB_HOME");
        std::env::remove_var("JISHU_PI_SETTINGS");
        std::env::remove_var("JISHU_EXTENSIONS_DB");
    }

    /// 停用/恢复闭环 + 台账视图 + forget。
    /// v0.9.8 评审修复轮 R1-0：内置 pi 扩展包没有适配件时，停用仍级联其
    /// **启停闸门**（注册同步的源头）；恢复时精确反启。
    #[test]
    fn disable_active_roundtrip() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", home.path());
        let _tmp = test_db(&guard);
        ensure_schema().unwrap();
        sync_registry_face(&[], &["npm:pi-web-access@0.32.0".to_string()], None).unwrap();
        // 停用（无适配件场景）：级联只含启停闸门。
        let cascaded = set_extension_disabled(
            "npm:pi-web-access@0.32.0",
            "联网搜索",
            "npm:@juicesharp/rpiv-web-tools",
        )
        .unwrap();
        assert_eq!(cascaded, vec!["pi-web-access".to_string()]);
        assert!(crate::agent::plugin::load_plugin_config()
            .disabled
            .iter()
            .any(|x| x == "pi-web-access"));
        let entries = disabled_entries().unwrap();
        assert_eq!(entries.len(), 1);
        // 恢复：闸门精确反启。
        let (entry, restored) = set_extension_active("npm:pi-web-access").unwrap();
        assert_eq!(entry.unwrap().display, "联网搜索");
        assert_eq!(restored, vec!["pi-web-access".to_string()]);
        assert!(!crate::agent::plugin::load_plugin_config()
            .disabled
            .iter()
            .any(|x| x == "pi-web-access"));
        assert!(disabled_entries().unwrap().is_empty());
        std::env::remove_var("JISHU_EXTENSIONS_DB");
        std::env::remove_var("JISHU_HUB_HOME");
    }

    /// v0.9.8 评审修复轮 R1-0：已安装的内置 pi 扩展包，其生效态与启停闸门
    /// 同源——用户在插件中心停用它，扩展清单与依赖视图如实显示停用
    /// （修前清单仍显示启用，两处状态各说各话）。
    #[test]
    fn registry_state_follows_gate_for_installed_builtin_package() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        std::env::set_var("JISHU_EXTENSIONS_DB", tmp.path().join("ext.db"));
        let pi = tmp.path().join("pi.json");
        std::fs::write(&pi, r#"{"packages": ["npm:pi-lens@4.3.0"]}"#).unwrap();
        std::env::set_var("JISHU_PI_SETTINGS", &pi);
        crate::agent::plugin::market::materialize_agent_toml("pi-lens").unwrap();
        ensure_schema().unwrap();
        sync_registry_face(&[], &["npm:pi-lens@4.3.0".to_string()], None).unwrap();
        rebuild_adaptations(&[(
            "session.usage".to_string(),
            vec![("npm:pi-lens".to_string(), None)],
        )])
        .unwrap();
        let state_of = || {
            registry_list()
                .unwrap()
                .into_iter()
                .find(|e| e.pkg_key == "npm:pi-lens")
                .expect("登记簿在册")
                .state
        };
        let dep_state = || {
            plugin_deps()
                .unwrap()
                .into_iter()
                .find(|d| d.plugin_id == "session.usage")
                .expect("依赖视图在册")
                .deps[0]
                .state
                .clone()
        };
        assert_eq!(state_of(), "active");
        assert_eq!(dep_state(), "active");

        // 用户在插件中心停用它。
        crate::agent::plugin::set_plugin_enabled("pi-lens", false).unwrap();
        assert_eq!(state_of(), "disabled");
        assert_eq!(dep_state(), "disabled");

        // 启用回来。
        crate::agent::plugin::set_plugin_enabled("pi-lens", true).unwrap();
        assert_eq!(state_of(), "active");
        assert_eq!(dep_state(), "active");

        std::env::remove_var("JISHU_HUB_HOME");
        std::env::remove_var("JISHU_PI_SETTINGS");
        std::env::remove_var("JISHU_EXTENSIONS_DB");
        drop(guard);
    }

    /// 关系重建：全量重算 + deps 视图 + adapted 派生。
    #[test]
    fn adaptations_rebuild_and_views() {
        let guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _tmp = test_db(&guard);
        ensure_schema().unwrap();
        sync_registry_face(&[], &["npm:pi-smart-fetch@0.3.23".to_string()], None).unwrap();
        rebuild_adaptations(&[
            (
                "session.smart-fetch-view".to_string(),
                vec![(
                    "npm:pi-smart-fetch".to_string(),
                    Some(vec!["web_fetch".into()]),
                )],
            ),
            (
                "sidebar.usage".to_string(),
                vec![("npm:pi-smart-fetch".to_string(), None)],
            ),
        ])
        .unwrap();
        let list = registry_list().unwrap();
        assert_eq!(list[0].gui_verdict, "adapted");
        assert_eq!(list[0].adapters.len(), 2);
        let deps = plugin_deps().unwrap();
        assert_eq!(deps.len(), 2);
        std::env::remove_var("JISHU_EXTENSIONS_DB");
    }
}
