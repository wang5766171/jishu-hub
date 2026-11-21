//! 需求16 M-2（v0.9.8）：equipment.db 初始化（服务需求5 合并版——任务
//! 驱动装备推荐与自适应套装）。
//!
//! 幂等设计（中断重跑安全）：建表 IF NOT EXISTS；健康自检对账 fail-loud
//! （zcode 3.12.3 静默失效反例教训）。无历史数据迁入（本需求为净新增
//! 资产：官方件档案在 curated.json 编译期，不落库防双真源）。

use super::{Migration, MigrationCtx};
use crate::agent::equipment_db;

pub(crate) static MIGRATION: Migration = Migration {
    id: "v0.9.8-equipment-db",
    version: "0.9.8",
    description: "升级装备推荐数据结构",
    critical: false,
    run,
};

fn run(_ctx: &MigrationCtx) -> Result<(), String> {
    // 1) 建四表（幂等）。
    equipment_db::ensure_schema()?;

    // 2) 健康自检：四表可查（建表失败/损坏 fail-loud，不静默）。
    equipment_db::tags_list()?;
    equipment_db::profile_latest()?;
    equipment_db::recommended_list("health-check")?;
    equipment_db::origins_list()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// M-2 幂等：连续跑两遍不出错（差集层由框架 tested；此处锁脚本本体）。
    #[test]
    fn m2_idempotent() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_EQUIPMENT_DB", tmp.path().join("equipment.db"));
        let ctx = super::super::MigrationCtx {
            hub_home: tmp.path().to_path_buf(),
        };
        super::run(&ctx).unwrap();
        super::run(&ctx).unwrap();
        std::env::remove_var("JISHU_EQUIPMENT_DB");
    }
}
