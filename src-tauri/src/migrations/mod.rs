//! 需求16（v0.9.8）：版本数据迁移框架。
//!
//! 产品语义（用户裁决 2026-11-21）：每个版本可定义迁移脚本；用户从历史
//! 版本升级后**首次启动新版本时自动执行**未应用的迁移；页面友好呈现
//! （进度/完成/失败出路）。参照 zcode 开源项目的迁移模式：
//! - 一次性导入快照：迁完的旧文件归档（`.imported`），不再回写；
//! - 迁移逻辑独立成模块（本文件 + 每版本一个脚本文件）；
//! - append-only 注册表：**已发布的迁移永不修改**，新变更=追加新迁移；
//! - 反例教训（zcode 3.12.3 迁移静默失效）：每个迁移执行后带健康
//!   自检（脚本内部对账），失败绝不静默——critical 失败阻止进入主界面。
//!
//! 执行模型：`applied.json` 记已应用集合；启动时（GUI setup 与 CLI main
//! 双入口，消费者之前）跑差集；`migrations.lock` 文件锁防双进程并发；
//! 每条迁移**必须幂等**（中断后重启从头重跑该条不出脏数据）。

mod v0_9_8_equipment_db;
mod v0_9_8_extensions_db;

use std::path::PathBuf;

/// 单个迁移脚本（一次定义永不修改；description 是用户可见文案，零术语）。
pub struct Migration {
    /// 全局唯一 id（如 "v0.9.8-extensions-db"）。
    pub id: &'static str,
    /// 引入版本。
    pub version: &'static str,
    /// 用户可见描述（如「升级插件与扩展数据结构」）。
    pub description: &'static str,
    /// 失败是否阻止进入主界面（关键数据迁移=true；避免半迁移状态被
    /// 后续写污染——非关键可跳过下次重试）。
    pub critical: bool,
    /// 执行体（必须幂等：存在即跳过/事务；内部自带健康自检）。
    pub run: fn(&MigrationCtx) -> Result<(), String>,
}

/// 注册表（append-only：按版本序排列，只增不改；元素为静态项引用）。
const MIGRATIONS: &[&Migration] =
    &[&v0_9_8_extensions_db::MIGRATION, &v0_9_8_equipment_db::MIGRATION];

/// 已应用记录（applied.json 数组元素）。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AppliedRecord {
    pub id: String,
    pub version: String,
    /// epoch 毫秒。
    pub applied_at: i64,
    pub duration_ms: u64,
}

/// 迁移执行上下文：数据目录 + 备份原语（供脚本在改动前留快照）。
pub struct MigrationCtx {
    /// hub 数据目录（~/.jishu-hub；测试经 JISHU_HUB_HOME 重定向）。
    pub hub_home: PathBuf,
}

impl MigrationCtx {
    /// 本版本的备份目录（惰性创建）：`migrations/backup/<version>/`。
    pub fn backup_dir(&self, version: &str) -> Result<PathBuf, String> {
        let dir = self
            .hub_home
            .join("migrations")
            .join("backup")
            .join(version);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    /// 备份单个文件到本版本备份目录（存在才备份；幂等覆盖）。
    pub fn backup_file(&self, version: &str, file: &std::path::Path) -> Result<(), String> {
        if !file.exists() {
            return Ok(());
        }
        let dir = self.backup_dir(version)?;
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unnamed".to_string());
        std::fs::copy(file, dir.join(name)).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 归档旧文件（zcode 一次性导入快照模式）：迁入完成后重命名
    /// `.imported`——保留取证/回退快照，代码从此不再读写它。
    pub fn archive_imported(&self, file: &std::path::Path) -> Result<(), String> {
        if !file.exists() {
            return Ok(());
        }
        let mut target = file.to_path_buf();
        target.set_extension("imported");
        if target.exists() {
            let _ = std::fs::remove_file(&target);
        }
        std::fs::rename(file, target).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// 迁移目录（测试隔离：JISHU_MIGRATIONS_DIR 重定向）。
fn migrations_dir() -> PathBuf {
    if let Ok(p) = std::env::var("JISHU_MIGRATIONS_DIR") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    crate::agent::manifest::hub_home().join("migrations")
}

fn applied_path() -> PathBuf {
    migrations_dir().join("applied.json")
}

fn load_applied() -> Vec<AppliedRecord> {
    std::fs::read_to_string(applied_path())
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn save_applied(records: &[AppliedRecord]) -> Result<(), String> {
    let dir = migrations_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    crate::util::atomic_write(&applied_path(), body.as_bytes()).map_err(|e| e.to_string())
}

/// 事件出口（GUI 有 app handle → 前端进度呈现；CLI/无 handle → 仅日志）。
struct Emitter(Option<tauri::AppHandle>);

impl Emitter {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Some(app) = &self.0 {
            let _ = tauri::Emitter::emit(app, event, payload);
        }
    }
}

/// 简单文件锁：存在且未过期=他人持有（跳过等待）；过期（>3 分钟）=接管。
fn try_acquire_lock() -> bool {
    let lock = migrations_dir().join("migrations.lock");
    let _ = std::fs::create_dir_all(migrations_dir());
    if let Ok(meta) = std::fs::metadata(&lock) {
        let stale = meta
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|e| e > std::time::Duration::from_secs(180));
        if !stale {
            return false;
        }
    }
    let _ = std::fs::write(&lock, format!("{}", std::process::id()));
    true
}

fn release_lock() {
    let _ = std::fs::remove_file(migrations_dir().join("migrations.lock"));
}

/// 启动入口：执行全部未应用迁移。
///
/// - 成功/无事可做 → Ok(())（applied 全量在册）。
/// - critical 迁移失败 → Err（GUI 侧应阻止进入主界面并给重试出路）。
/// - 非关键失败 → 记录并继续（Ok；下次启动重试差集）。
pub fn run_pending(app: Option<tauri::AppHandle>) -> Result<(), String> {
    if !try_acquire_lock() {
        // 另一进程正在迁移（GUI/CLI 双入口互斥）——本轮跳过，对端负责。
        log::info!("[migrations] 另一进程持有锁，跳过");
        return Ok(());
    }
    let result = run_pending_locked(&Emitter(app));
    release_lock();
    result
}

fn run_pending_locked(emitter: &Emitter) -> Result<(), String> {
    let mut applied = load_applied();
    let done: Vec<&str> = applied.iter().map(|r| r.id.as_str()).collect();
    let pending: Vec<&Migration> = MIGRATIONS
        .iter()
        .filter(|m| !done.contains(&m.id))
        .copied()
        .collect();
    if pending.is_empty() {
        clear_last_error();
        return Ok(());
    }
    let total = pending.len();
    let ctx = MigrationCtx {
        hub_home: crate::agent::manifest::hub_home(),
    };
    for (i, m) in pending.iter().enumerate() {
        emitter.emit(
            "migration-progress",
            serde_json::json!({
                "current": i + 1,
                "total": total,
                "description": m.description,
            }),
        );
        let started = std::time::Instant::now();
        match (m.run)(&ctx) {
            Ok(()) => {
                applied.push(AppliedRecord {
                    id: m.id.to_string(),
                    version: m.version.to_string(),
                    applied_at: chrono_epoch_ms(),
                    duration_ms: started.elapsed().as_millis() as u64,
                });
                // 每条落盘一次（crash-safe：中断后只重跑未记录条目）。
                if let Err(e) = save_applied(&applied) {
                    let err = format!("迁移 {} 记录落盘失败: {e}", m.id);
                    if m.critical {
                        return Err(err);
                    }
                    log::warn!("[migrations] {err}");
                }
            }
            Err(error) => {
                log::error!("[migrations] 迁移 {} 失败: {error}", m.id);
                if m.critical {
                    save_last_error(m.id, &error);
                }
                emitter.emit(
                    "migration-failed",
                    serde_json::json!({
                        "id": m.id,
                        "error": error,
                        "critical": m.critical,
                    }),
                );
                if m.critical {
                    return Err(format!("数据升级未完成（{}）：{error}", m.description));
                }
                // 非关键：跳过继续（下次启动重试）。
            }
        }
    }
    clear_last_error();
    emitter.emit(
        "migration-done",
        serde_json::json!({ "applied": pending.iter().map(|m| m.id).collect::<Vec<_>>() }),
    );
    Ok(())
}

/// 迁移状态查询（GUI 启动兜底呈现/诊断用）：applied/pending/注册表 +
/// last_error（critical 失败落盘，前端阻断卡与重试按钮的数据源）。
pub fn status() -> serde_json::Value {
    let applied = load_applied();
    let done: Vec<&str> = applied.iter().map(|r| r.id.as_str()).collect();
    let pending: Vec<&str> = MIGRATIONS
        .iter()
        .filter(|m| !done.contains(&m.id))
        .map(|m| m.id)
        .collect();
    let last_error: Option<serde_json::Value> =
        std::fs::read_to_string(migrations_dir().join("last-error.json"))
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok());
    serde_json::json!({
        "applied": applied,
        "pending": pending,
        "registry": MIGRATIONS.iter().map(|m| m.id).collect::<Vec<_>>(),
        "last_error": last_error,
    })
}

/// critical 失败落档（前端刷新后仍能呈现阻断卡；成功即清除）。
fn save_last_error(id: &str, error: &str) {
    let dir = migrations_dir();
    let _ = std::fs::create_dir_all(&dir);
    let body = serde_json::json!({ "id": id, "error": error, "at": chrono_epoch_ms() });
    let _ = std::fs::write(
        dir.join("last-error.json"),
        serde_json::to_string_pretty(&body).unwrap_or_default(),
    );
}

fn clear_last_error() {
    let _ = std::fs::remove_file(migrations_dir().join("last-error.json"));
}

fn chrono_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试隔离：JISHU_MIGRATIONS_DIR 指临时目录 + 锁/记录读写不出圈。
    #[test]
    fn applied_roundtrip_and_pending_filter() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_MIGRATIONS_DIR", tmp.path());
        assert!(load_applied().is_empty());
        save_applied(&[AppliedRecord {
            id: "v0.9.8-extensions-db".into(),
            version: "0.9.8".into(),
            applied_at: 1,
            duration_ms: 2,
        }])
        .unwrap();
        assert_eq!(load_applied().len(), 1);
        // 注册表已追加 M-2（v0.9.8-equipment-db）——仅应用 M-1 → 差集 1
        // （真实注册表未来追加时本断言随版本更新）。
        let st = status();
        assert_eq!(
            st.get("pending").and_then(|p| p.as_array()).map(Vec::len),
            Some(1)
        );
        std::env::remove_var("JISHU_MIGRATIONS_DIR");
    }

    /// 归档：文件改后缀 .imported，二次调用幂等（不存在=no-op）。
    #[test]
    fn archive_imported_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = MigrationCtx {
            hub_home: tmp.path().to_path_buf(),
        };
        let f = tmp.path().join("old.json");
        std::fs::write(&f, "[1]").unwrap();
        ctx.backup_file("0.9.8", &f).unwrap();
        ctx.archive_imported(&f).unwrap();
        assert!(!f.exists());
        let archived = tmp.path().join("old.imported");
        assert!(archived.exists());
        ctx.archive_imported(&f).unwrap(); // 不存在 → no-op 不炸
        assert!(ctx.backup_dir("0.9.8").unwrap().join("old.json").exists());
    }
}
