//! 任务执行器（v0.9.7 需求2 去阶段化）。
//!
//! 原 conductor.rs 的三阶段状态机（is_legal_conductor_transition /
//! verify_artifact_hash / conductor_sync_phase / legacy_sync_phase /
//! sync_pipeline_phase / stage_keys_and_templates，约 580 行）随阶段概念
//! 整体退役——砍除清单见 docs/v0.9.7/需求2-任务模式重构/01 §B2。
//! 保留：runner 状态加载（session_start 权威恢复）。
//! 派发/修订在 dispatch.rs / revise.rs（未动）。

use super::*;

#[derive(Debug, Clone, Serialize)]
pub struct ConductorLoadStateResult {
    pub found: bool,
    pub instance: Option<TaskLaunchInstance>,
}

/// runner 加载任务状态（session_start 时扩展从 Hub 拉取权威状态——
/// 任务卡 steps/run 状态以 TaskInstance 为准，覆盖 appendEntry）。
pub fn runner_load_task_state(
    project_root: &str,
    task_id: &str,
) -> Result<ConductorLoadStateResult, String> {
    let store = open_store(project_root)?;
    match store.get(task_id)? {
        Some(instance) => Ok(ConductorLoadStateResult {
            found: true,
            instance: Some(instance),
        }),
        None => Ok(ConductorLoadStateResult {
            found: false,
            instance: None,
        }),
    }
}
