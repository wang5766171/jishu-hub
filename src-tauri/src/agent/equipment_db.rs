//! 需求5（v0.9.8 合并版：任务驱动装备推荐与自适应套装）：equipment.db。
//!
//! 存储选型（用户质询 2026-11-22 定案）：运行时四份资产合一个 SQLite/WAL
//! 库（一域一库，对齐需求4 extensions.db 方向）——按行更新粒度、并发写
//! WAL 化解（安装链挂标 vs 推荐卡回写 tags_hint vs 画像落盘）、「只增不
//! 减资产」语义用表约束表达。建库走需求16 迁移框架 **M-2**
//! （v0_9_8_equipment_db.rs；M-1 已 applied 不能改）。
//!
//! 数据分层（防两本账）：
//! - 官方件档案真源 = curated.json（编译期，tags/stars 随版本）——本库
//!   **不存官方件行**，前端合并视图（catalog）现场拼接；
//! - 第三方件标签 = 本库 equipment_tags（三时机固化：安装时/懒固化；
//!   开发时机在 curated 侧）；
//! - 已装态 = 派生态（plugin_list/skillhub_installed/pi sources 现场算），
//!   本库不镜像。

use rusqlite::Connection;
use std::path::PathBuf;

/// db 路径（测试隔离：JISHU_EQUIPMENT_DB 重定向——与 extensions_db 同模式）。
fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("JISHU_EQUIPMENT_DB") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    crate::agent::manifest::hub_home().join("equipment.db")
}

fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>) -> Result<T, String> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path).map_err(|e| format!("equipment.db 打开失败: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("equipment.db WAL 失败: {e}"))?;
    f(&conn).map_err(|e| format!("equipment.db 操作失败: {e}"))
}

/// 建表（幂等；M-2 迁移与首次消费双入口共用）。
pub fn ensure_schema() -> Result<(), String> {
    with_conn(|conn| {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS equipment_tags (
              -- 装备统一 ref（skillhub:<slug> / pi:<source>；官方 curated:*
              -- 档案在 curated.json 不入库，防双真源）。
              ref          TEXT PRIMARY KEY,
              title        TEXT NOT NULL DEFAULT '',
              -- JSON 数组（中文短语，L0 子串命中）。
              tags         TEXT NOT NULL DEFAULT '[]',
              stars        INTEGER NOT NULL DEFAULT 3,
              -- official | tested | signals（官方件不落本表，此列多为
              -- install/lazy 场景的 signals；agent 实测可升 tested）。
              stars_basis  TEXT NOT NULL DEFAULT 'signals',
              -- install | lazy（固化时机；设计三时机之两机）。
              source       TEXT NOT NULL DEFAULT 'lazy',
              installed_at INTEGER,
              updated_at   INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_profiles (
              session_id TEXT PRIMARY KEY,
              scene      TEXT NOT NULL DEFAULT 'custom',
              keywords   TEXT NOT NULL DEFAULT '[]',
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS equip_recommended (
              session_id TEXT NOT NULL,
              ref        TEXT NOT NULL,
              at         INTEGER NOT NULL,
              PRIMARY KEY (session_id, ref)
            );
            CREATE TABLE IF NOT EXISTS equip_origins (
              ref TEXT PRIMARY KEY,
              -- recommend-card | input-bar | market-zone | onboarding | manual
              via TEXT NOT NULL,
              at  INTEGER NOT NULL
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

/// 安装链 meta（前端调用安装命令时的可选参数）：via=推荐链路来源
/// （recommend-card/input-bar/market-zone/onboarding，缺省 manual）；
/// title=第三方件友好名（agent 推荐块/市场卡带回）；tags=agent 推荐理由
/// 提取的标签（安装时机固化标签的原料，手动装缺省空）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct InstallMeta {
    #[serde(default)]
    pub via: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

impl InstallMeta {
    /// via 归一：空 = manual。
    pub fn via_or_manual(&self) -> &str {
        if self.via.is_empty() {
            "manual"
        } else {
            &self.via
        }
    }
}

// ── equipment_tags：第三方件标签库（三时机固化的落点） ──

/// 标签行视图（前端整表拉取后本地算 L0/L1）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct EquipmentTagRow {
    pub r#ref: String,
    pub title: String,
    pub tags: Vec<String>,
    pub stars: u8,
    pub stars_basis: String,
    pub source: String,
    pub installed_at: Option<i64>,
}

pub fn tags_list() -> Result<Vec<EquipmentTagRow>, String> {
    with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT ref, title, tags, stars, stars_basis, source, installed_at
             FROM equipment_tags ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                let tags_json: String = r.get(2)?;
                Ok(EquipmentTagRow {
                    r#ref: r.get(0)?,
                    title: r.get(1)?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    stars: r.get::<_, i64>(3)? as u8,
                    stars_basis: r.get(4)?,
                    source: r.get(5)?,
                    installed_at: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// upsert 标签行（安装链挂标 / 懒固化 / tags_hint 回写共用）。
/// 空字段不覆盖已有值（COALESCE 语义）——手动装 tags 留空待懒固化补。
pub fn tag_upsert(
    r#ref: &str,
    title: Option<&str>,
    tags: Option<&[String]>,
    stars: Option<u8>,
    source: Option<&str>,
) -> Result<(), String> {
    let tags_json = tags
        .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_default();
    with_conn(|conn| {
        conn.execute(
            "INSERT INTO equipment_tags (ref, title, tags, stars, stars_basis, source, installed_at, updated_at)
             VALUES (?1, COALESCE(?2, ''), COALESCE(?3, '[]'), COALESCE(?4, 3), 'signals', COALESCE(?5, 'lazy'), ?6, ?6)
             ON CONFLICT(ref) DO UPDATE SET
               title = CASE WHEN excluded.title != '' THEN excluded.title ELSE equipment_tags.title END,
               tags  = CASE WHEN excluded.tags != '[]' THEN excluded.tags ELSE equipment_tags.tags END,
               stars = MAX(equipment_tags.stars, excluded.stars),
               source = CASE WHEN excluded.source != '' THEN excluded.source ELSE equipment_tags.source END,
               installed_at = COALESCE(excluded.installed_at, equipment_tags.installed_at),
               updated_at = excluded.updated_at",
            rusqlite::params![
                r#ref,
                title.unwrap_or(""),
                tags_json,
                stars.map(|s| s as i64),
                source.unwrap_or(""),
                now_ms()
            ],
        )?;
        Ok(())
    })
}

// ── task_profiles：任务画像（L2 产出 / L1 消费；LRU 20） ──

#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskProfileRow {
    pub session_id: String,
    pub scene: String,
    pub keywords: Vec<String>,
    pub updated_at: i64,
}

/// 最近一份画像（跨会话消费：市场推荐区/输入框建议条）。
pub fn profile_latest() -> Result<Option<TaskProfileRow>, String> {
    with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT session_id, scene, keywords, updated_at FROM task_profiles ORDER BY updated_at DESC LIMIT 1")?;
        let mut rows = stmt.query_map([], |r| {
            let kw: String = r.get(2)?;
            Ok(TaskProfileRow {
                session_id: r.get(0)?,
                scene: r.get(1)?,
                keywords: serde_json::from_str(&kw).unwrap_or_default(),
                updated_at: r.get(3)?,
            })
        })?;
        match rows.next() {
            Some(Ok(p)) => Ok(Some(p)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    })
}

/// 画像落盘（同会话覆盖刷新）+ LRU 淘汰（保留最近 20 条）。
pub fn profile_upsert(session_id: &str, scene: &str, keywords: &[String]) -> Result<(), String> {
    let kw = serde_json::to_string(keywords).unwrap_or_else(|_| "[]".into());
    with_conn(|conn| {
        conn.execute(
            "INSERT INTO task_profiles (session_id, scene, keywords, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET
               scene = excluded.scene, keywords = excluded.keywords, updated_at = excluded.updated_at",
            rusqlite::params![session_id, scene, kw, now_ms()],
        )?;
        conn.execute(
            "DELETE FROM task_profiles WHERE session_id NOT IN (
               SELECT session_id FROM task_profiles ORDER BY updated_at DESC LIMIT 20
             )",
            [],
        )?;
        Ok(())
    })
}

// ── equip_recommended：已推记忆（防重复推 + 每会话限次的数据面） ──

pub fn recommended_list(session_id: &str) -> Result<Vec<String>, String> {
    with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT ref FROM equip_recommended WHERE session_id = ?1 ORDER BY at")?;
        let rows = stmt
            .query_map([session_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// 推荐记录（幂等：同会话同 ref 只记一行；同一次调用=同一时刻=同一批）。
pub fn recommended_add(session_id: &str, refs: &[String]) -> Result<(), String> {
    let at = now_ms();
    with_conn(|conn| {
        for r#ref in refs {
            conn.execute(
                "INSERT INTO equip_recommended (session_id, ref, at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id, ref) DO NOTHING",
                rusqlite::params![session_id, r#ref, at],
            )?;
        }
        Ok(())
    })
}

/// 该会话已推荐「批次」数（限次判定：同批多 ref 记一次时刻）。
pub fn recommended_batch_count(session_id: &str) -> Result<i64, String> {
    with_conn(|conn| {
        conn.query_row(
            "SELECT COUNT(DISTINCT at) FROM equip_recommended WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .map_err(|e| e.into())
    })
}

/// 重置推荐记忆（设置页动作：清全表）。
pub fn recommended_clear() -> Result<(), String> {
    with_conn(|conn| conn.execute("DELETE FROM equip_recommended", []).map(|_| ()))
}

/// 会话删除时清理（与 recommended 两表同步）。
pub fn session_cleanup(session_id: &str) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute("DELETE FROM equip_recommended WHERE session_id = ?1", [session_id])?;
        conn.execute("DELETE FROM task_profiles WHERE session_id = ?1", [session_id])?;
        Ok(())
    })
}

// ── equip_origins：来源台账（反馈信号：每件从哪来） ──

#[derive(Debug, Clone, serde::Serialize)]
pub struct OriginRow {
    pub r#ref: String,
    pub via: String,
    pub at: i64,
}

pub fn origins_list() -> Result<Vec<OriginRow>, String> {
    with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT ref, via, at FROM equip_origins ORDER BY at DESC")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(OriginRow {
                    r#ref: r.get(0)?,
                    via: r.get(1)?,
                    at: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// 安装链收尾统一挂点：来源 upsert（manual 为默认，推荐链路各面传入）。
pub fn origin_upsert(r#ref: &str, via: &str) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute(
            "INSERT INTO equip_origins (ref, via, at) VALUES (?1, ?2, ?3)
             ON CONFLICT(ref) DO UPDATE SET via = excluded.via, at = excluded.at",
            rusqlite::params![r#ref, via, now_ms()],
        )?;
        Ok(())
    })
}

/// 安装链统一收尾（挂标 + 台账一步）：skillhub/pi 第三方件进标签库，
/// curated 官方件只记来源（档案真源在 curated.json，防双真源）。
pub fn record_install(
    r#ref: &str,
    via: &str,
    title: Option<&str>,
    tags_hint: Option<&[String]>,
) -> Result<(), String> {
    if r#ref.starts_with("curated:") {
        return origin_upsert(r#ref, via);
    }
    // 失败仅记日志不阻断安装主流程（台账是旁路资产——与卸载级联停用
    // 同语义：数据来源没了不该挡用户装东西）。
    let _ = tag_upsert(r#ref, title, tags_hint, None, Some("install"));
    if let Err(e) = origin_upsert(r#ref, via) {
        log::warn!("[equipment] origin upsert 失败 ref={}: {e}", r#ref);
    }
    Ok(())
}

// ── 装备目录注入块（L2 信息供给：agent 看任务对照货架的唯一通道） ──

/// 渲染 `<JISHU-EQUIP-CATALOG>` 注入块（用户消息后缀；chat.rs compose 挂点）。
///
/// 收录口径：curated **非 required 且未装**件（required 恒装无推荐价值；
/// 已装不荐）+ 标签库第三方件（未装且 stars ≥3；`third_party` 配置关则
/// 不收）。目录规模 ≤2KB：curated ~11 行 + 第三方增量。
/// `workspace_scene`（工作区场景分析结果）非空时补一行场景提示——agent
/// 的 profile.scene 有据可依（用户裁决：按项目定位推荐）。
pub fn catalog_block(
    installed_curated: &[String],
    installed_skillhub: &[String],
    third_party: bool,
    workspace_scene: Option<&str>,
) -> String {
    use super::internal_prompts;
    let mut lines: Vec<String> = Vec::new();
    if let Some(scene) = workspace_scene {
        lines.push(format!("[当前工作区场景：{scene}——按项目文件特征判定，用户大概率在做这类任务]"));
    }
    for e in super::plugin::market::market_list_curated(None) {
        if e.required || installed_curated.iter().any(|id| id == &e.id) {
            continue;
        }
        let tags = if e.tags.is_empty() {
            e.description.chars().take(18).collect()
        } else {
            e.tags.join("/")
        };
        lines.push(format!(
            "- curated:{} | ★{} | {} | {}",
            e.id,
            e.stars,
            tags,
            "未装"
        ));
    }
    if third_party {
        if let Ok(rows) = tags_list() {
            for r in rows {
                if r.installed_at.is_some()
                    || r.stars < 3
                    || installed_skillhub.iter().any(|s| r.r#ref == format!("skillhub:{s}"))
                {
                    continue;
                }
                let tags = if r.tags.is_empty() {
                    r.title.chars().take(18).collect()
                } else {
                    r.tags.join("/")
                };
                let title = if r.title.is_empty() {
                    r.r#ref.trim_start_matches("skillhub:").to_string()
                } else {
                    r.title.clone()
                };
                lines.push(format!(
                    "- {} | ★{} | {}：{} | 未装",
                    r.r#ref, r.stars, title, tags
                ));
            }
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "{}{}{}",
        internal_prompts::EQUIP_CATALOG_OPEN,
        internal_prompts::PROMPT_EQUIP_CATALOG.body().replace("{{catalog_lines}}", &lines.join("\n")),
        internal_prompts::EQUIP_CATALOG_CLOSE
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试隔离（与 extensions_db 同模式）：guard 由测试持有整个周期——
    /// JISHU_EQUIPMENT_DB 环境变量在并行测试间独占。
    fn test_db(_guard: &std::sync::MutexGuard<'_, ()>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_EQUIPMENT_DB", dir.path().join("equipment.db"));
        ensure_schema().unwrap();
        dir
    }

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn schema_idempotent_and_tag_upsert_semantics() {
        let guard = lock();
        let _dir = test_db(&guard);
        ensure_schema().unwrap(); // 二次建表幂等

        // 手动装：tags 留空，title 有值。
        tag_upsert("skillhub:pmaster", Some("产品经理综合技能"), None, None, Some("install")).unwrap();
        let rows = tags_list().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "产品经理综合技能");
        assert!(rows[0].tags.is_empty(), "手动装 tags 留空待懒固化");
        assert_eq!(rows[0].source, "install");
        assert!(rows[0].installed_at.is_some());

        // 懒固化补 tags：不覆盖 title，不降 stars。
        tag_upsert(
            "skillhub:pmaster",
            None,
            Some(&["产品经理".into(), "需求文档".into()]),
            Some(4),
            None,
        )
        .unwrap();
        let rows = tags_list().unwrap();
        assert_eq!(rows[0].tags, vec!["产品经理", "需求文档"]);
        assert_eq!(rows[0].title, "产品经理综合技能", "空 title 不覆盖");
        assert_eq!(rows[0].stars, 4);

        // 星级只升不降（MAX 语义）。
        tag_upsert("skillhub:pmaster", None, None, Some(2), None).unwrap();
        assert_eq!(tags_list().unwrap()[0].stars, 4);
    }

    #[test]
    fn profile_lru_and_latest() {
        let guard = lock();
        let _dir = test_db(&guard);
        assert!(profile_latest().unwrap().is_none());
        for i in 0..25 {
            profile_upsert(&format!("s{i}"), "video", &[format!("kw{i}")]).unwrap();
        }
        // 上限 20：最早的 5 条被淘汰。
        let latest = profile_latest().unwrap().unwrap();
        assert_eq!(latest.session_id, "s24");
        let count = with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM task_profiles", [], |r| {
                r.get::<_, i64>(0)
            })
        })
        .unwrap();
        assert_eq!(count, 20);
    }

    #[test]
    fn recommended_batch_and_clear() {
        let guard = lock();
        let _dir = test_db(&guard);
        recommended_add("s1", &["curated:pi-lens".into(), "skillhub:x".into()]).unwrap();
        recommended_add("s1", &["curated:pi-lens".into()]).unwrap(); // 幂等
        let list = recommended_list("s1").unwrap();
        assert_eq!(list.len(), 2, "同 ref 不重复");
        assert_eq!(recommended_batch_count("s1").unwrap(), 1, "同刻两 ref = 一批");
        recommended_add("s1", &["curated:task-plan".into()]).unwrap();
        assert_eq!(recommended_batch_count("s1").unwrap(), 2);
        recommended_clear().unwrap();
        assert!(recommended_list("s1").unwrap().is_empty());
    }

    #[test]
    fn record_install_routes_by_ref_prefix() {
        let guard = lock();
        let _dir = test_db(&guard);
        // curated 官方件：只记 origin，不进标签库（防双真源）。
        record_install("curated:pi-lens", "recommend-card", None, None).unwrap();
        assert!(tags_list().unwrap().is_empty());
        assert_eq!(origins_list().unwrap()[0].via, "recommend-card");
        // skillhub 件：标签库 + origin 双落。
        record_install(
            "skillhub:pmaster",
            "input-bar",
            Some("产品经理综合技能"),
            Some(&["需求文档".into()]),
        )
        .unwrap();
        let rows = tags_list().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tags, vec!["需求文档"]);
        assert_eq!(origins_list().unwrap().len(), 2);
    }
}
