use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::util::now_ms;

/// 任务实例生命周期状态（4 值，持久化到 task_instance.status）。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §2.2。
/// status 止步于 `graph_created`（终态），后续执行态由 `run_status` 独立追踪。
pub const STATUS_REQUIREMENTS_DISCUSSING: &str = "requirements_discussing";
pub const STATUS_REQUIREMENTS_FINALIZED: &str = "requirements_finalized";
pub const STATUS_PLANNING_DISCUSSING: &str = "planning_discussing";
pub const STATUS_GRAPH_CREATED: &str = "graph_created";

/// 执行实例运行态（5 值，冗余到 task_instance.run_status）。
///
/// 由 graph_run.status 派生，通过 `sync_run_status` 写回。`status` 字段不随执行态变化。
pub const RUN_STATUS_RUNNING: &str = "running";
pub const RUN_STATUS_PAUSED: &str = "paused";
pub const RUN_STATUS_COMPLETED: &str = "completed";
pub const RUN_STATUS_FAILED: &str = "failed";
pub const RUN_STATUS_CANCELLED: &str = "cancelled";

/// task_instance 表 schema 版本。升级表结构时递增，并在 `migrate_schema` 中处理迁移。
const TASK_INSTANCE_SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskLaunchInstance {
    pub task_id: String,
    pub project_root: String,
    pub title: String,
    pub skill_id: String,
    /// 需求/规划阶段使用的 agent（默认 "jishu_agent"）。
    pub planner_agent_id: String,
    /// TaskInstance 生命周期状态（4 值枚举）。
    pub status: String,
    /// 当前阶段："requirements" | "planning" | "execution"。
    pub current_phase: String,
    pub requirement_file: Option<String>,
    pub requirement_session_id: Option<String>,
    pub planning_session_id: Option<String>,
    pub graph_id: Option<String>,
    /// 当前活跃执行实例（逻辑外键 → orchestrator.db.graph_run）。
    pub active_run_id: Option<String>,
    /// 最近一次执行实例。
    pub last_run_id: Option<String>,
    /// 执行状态冗余（5 值枚举，仅执行阶段有值）。
    pub run_status: Option<String>,
    /// 幂等启动键（防止 fork/resume 重复启动 run）。
    pub last_launch_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRequirementMessage {
    pub role: String,
    pub content: String,
}

/// 需求定稿入参（统一接口，按 creation_mode 分流）。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §3.1。
/// `requirement_markdown` 由调用方（Agent 按 skill 约束产出 / 直接模式用户原始描述）决定，
/// 后端只负责落盘 + 记元数据，不硬编码格式。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequirementFinalizeRequest {
    pub task_id: Option<String>,
    pub skill_id: String,
    pub title: Option<String>,
    /// 终稿 markdown 内容（Agent 按 skill 约束产出，或用户直接描述）。
    pub requirement_markdown: String,
    /// 来源阶段会话（追溯用）。
    pub source_session_id: Option<String>,
    /// 创建模式："discussion" | "direct"。
    pub creation_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRequirementFinalized {
    pub task_id: String,
    pub title: String,
    pub requirement_dir: String,
    pub requirement_file: String,
    pub planning_instruction: String,
}

/// 任务会话索引项。一个任务实例下可查看的会话（1 需求 + 1 规划 + N 节点）。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §1.3。
/// 注意：主任务会话是 task_event 投影的"虚拟会话"，无真实 session_id，此处不包含它。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSessionEntry {
    pub phase: String,
    pub session_id: String,
    pub session_type: String,
    pub node_id: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSessionIndex {
    pub task_id: String,
    pub entries: Vec<TaskSessionEntry>,
}

/// 独立 SQLite 任务实例库。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §1.1、§7。
/// 与 orchestrator 的 TaskStore 分库，graph_id/run_id 作为逻辑外键，应用层维护一致性。
// task_launch 按职责拆分（v0.7.3 需求1-M6）：实例存储与用例 / conductor 同步 /
// 提案校验 / run 启动分属子模块；跨模块路径与存储助手留在 mod.rs。
mod conductor;
mod instance_store;
mod proposal;
mod run;

use instance_store::TaskInstanceStore;

pub use conductor::{
    conductor_load_task_state, conductor_sync_phase, ConductorLoadStateResult,
    ConductorSyncArtifacts, ConductorSyncPhaseRequest, ConductorSyncPhaseResult,
};
pub use instance_store::{
    attach_graph, create_from_existing_graph, delete_task, finalize_requirement, find_by_session,
    get_task_instance, list_task_instances, mark_task_stage_session,
    planning_instruction_for_instance, rename_task, sync_run_status,
};
pub use proposal::{
    orchestrator_validate_proposal, ValidateProposalRequest, ValidateProposalResult,
};
pub use run::{
    orchestrator_start_run_from_revision, sync_run_status_to_task_instance, task_launch_start_run,
    StartRunFromRevisionRequest, StartRunFromRevisionResult, TaskLaunchStartRunRequest,
};

fn open_store(project_root: &str) -> Result<TaskInstanceStore, String> {
    let db_path = task_instances_db_path(&normalize_project_root(project_root));
    TaskInstanceStore::open(&db_path)
}

fn normalize_phase(phase: &str) -> String {
    // 后端 canonical 统一为 "execution"（消除旧的 "graph" 别名）。
    // 见 `任务数据结构与生命周期设计_20260622.md` §1.2、§8。
    match phase {
        "planning" => "planning".into(),
        "execution" | "graph" => "execution".into(),
        _ => "requirements".into(),
    }
}

/// 将 `project_root` 规范化为稳定字符串，确保"db 路径 / 查询键 / 存储值"三者形式一致。
///
/// 根因：`project_root` 字符串同时被用作 db 文件路径（`PathBuf`，文件系统容忍分隔符/
/// 大小写/`\\?\` 前缀差异）与 SQL 查询键（`WHERE project_root = ?`，严格逐字符匹配）。
/// 若创建任务时存入的形式与加载时查询的形式不同——例如 orchestrator 经过 canonicalize
/// 得到 `\\?\D:\foo`，而前端直接传入 `D:\foo`——同一个 db 文件能打开，但记录查不到，
/// 表现为任务"丢失"、关联的 requirement/planning session 回归常规会话列表。
///
/// 统一用 `canonicalize`（消除大小写/符号链接/分隔符/`\\?\` 前缀差异，且与 orchestrator
/// 的 canonicalize 行为对齐）；路径不存在时退回词法规范化，保证不报错。
/// 不迁移历史数据——旧记录保持旧形式，自此次修复起写入与查询一致即可。
fn normalize_project_root(project_root: &str) -> String {
    let path = std::path::Path::new(project_root);
    match path.canonicalize() {
        Ok(canon) => canon.to_string_lossy().into_owned(),
        Err(_) => normalize_lexical_path(path).to_string_lossy().into_owned(),
    }
}

/// 纯词法规范化（不触碰文件系统）：去掉 `.`、消解 `..`、统一分隔符、去 trailing separator。
/// 与 `orchestrator/resources::normalize_lexical` 等价，作为 canonicalize 不可用时的兜底。
fn normalize_lexical_path(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut stack: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match stack.last() {
                Some(Component::Normal(_)) => {
                    stack.pop();
                }
                _ => stack.push(component),
            },
            other => stack.push(other),
        }
    }
    let mut result = std::path::PathBuf::new();
    for component in stack {
        result.push(component.as_os_str());
    }
    if result.as_os_str().is_empty() {
        result.push(Component::CurDir.as_os_str());
    }
    result
}

fn task_workspace_root(project_root: &str) -> PathBuf {
    PathBuf::from(project_root).join(".jishu-hub").join("tasks")
}

fn task_instances_db_path(project_root: &str) -> PathBuf {
    task_workspace_root(project_root).join("task-instances.db")
}

#[cfg(test)]

mod tests {
    use super::*;

    fn temp_project(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jishu-task-launch-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mark_stage_session_does_not_downgrade_graph_created_instance() {
        let project = temp_project("no-downgrade");
        let project_root = project.to_string_lossy().to_string();

        let instance = mark_task_stage_session(
            &project_root,
            None,
            "requirements-session",
            "jishu-conductor-dev",
            "requirements",
            Some("Demo task"),
        )
        .unwrap();
        attach_graph(&project_root, &instance.task_id, "graph-1").unwrap();

        let updated = mark_task_stage_session(
            &project_root,
            Some(&instance.task_id),
            "planning-session",
            "jishu-conductor-dev",
            "planning",
            None,
        )
        .unwrap();

        assert_eq!(updated.status, STATUS_GRAPH_CREATED);
        assert_eq!(updated.current_phase, "execution");
        assert_eq!(
            updated.planning_session_id.as_deref(),
            Some("planning-session")
        );

        let _ = std::fs::remove_dir_all(&project);
    }

    /// 制造等价但形式不同的路径：翻转分隔符并加 trailing separator。
    fn alternate_path_form(root: &str) -> String {
        #[cfg(windows)]
        {
            format!("{}/", root.replace('\\', "/"))
        }
        #[cfg(not(windows))]
        {
            format!("{root}/")
        }
    }

    #[test]
    fn task_persists_and_lists_across_equivalent_path_forms() {
        // 回归守护：同一项目用不同路径形式（分隔符/trailing）创建与查询，必须查到任务。
        // normalize_project_root 统一了 project_root 形式，避免"创建存入形式 ≠ 加载查询形式
        // → 任务查不到（丢失）→ 关联的 requirement/planning session 回归常规会话列表"。
        let project = temp_project("path-forms");
        let root = project.to_string_lossy().to_string();

        // 用规范路径形式创建任务（mark_task_stage_session 内部 upsert 会写入 project_root）。
        let instance = mark_task_stage_session(
            &root,
            None,
            "requirements-session",
            "jishu-conductor-dev",
            "requirements",
            Some("Path forms task"),
        )
        .unwrap();

        // 用等价但形式不同的路径查询，必须命中。
        let alt_root = alternate_path_form(&root);
        let listed = list_task_instances(&alt_root).unwrap();
        let found = listed.iter().any(|t| t.task_id == instance.task_id);
        assert!(
            found,
            "等价路径形式应能查到任务（root={root}, alt={alt_root}）",
        );

        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn conductor_sync_validates_transitions_and_artifact_content() {
        let project = temp_project("conductor-sync");
        let project_root = project.to_string_lossy().to_string();
        let task_id = "task_conductor_sync";

        let created = conductor_sync_phase(ConductorSyncPhaseRequest {
            task_id: task_id.into(),
            project_root: project_root.clone(),
            phase: "discuss".into(),
            domain: "dev".into(),
            artifacts: None,
            expected_phase: Some("idle".into()),
            artifact_hash: None,
            title: Some("Conductor sync".into()),
            session_id: Some("session-1".into()),
        })
        .unwrap();
        assert!(created.success);
        assert_eq!(created.instance.current_phase, "requirements");

        let requirements_dir = task_workspace_root(&project_root)
            .join(task_id)
            .join("artifacts")
            .join("requirements");
        std::fs::create_dir_all(&requirements_dir).unwrap();
        let requirements_path = requirements_dir.join("REQUIREMENTS.md");
        let requirements = b"# Requirements\n";
        std::fs::write(&requirements_path, requirements).unwrap();
        let requirements_hash = format!("sha256:{:x}", Sha256::digest(requirements));
        std::fs::write(
            requirements_dir.join("manifest.json"),
            serde_json::json!({ "content_hash": requirements_hash }).to_string(),
        )
        .unwrap();

        let planning = conductor_sync_phase(ConductorSyncPhaseRequest {
            task_id: task_id.into(),
            project_root: project_root.clone(),
            phase: "plan".into(),
            domain: "dev".into(),
            artifacts: Some(ConductorSyncArtifacts {
                requirements: Some(requirements_path.to_string_lossy().into_owned()),
                flow_plan_json: None,
                flow_plan_md: None,
            }),
            expected_phase: Some("discuss".into()),
            artifact_hash: Some(requirements_hash),
            title: None,
            session_id: Some("session-1".into()),
        })
        .unwrap();
        assert!(planning.success);
        assert_eq!(planning.instance.current_phase, "planning");

        let rejected = conductor_sync_phase(ConductorSyncPhaseRequest {
            task_id: task_id.into(),
            project_root: project_root.clone(),
            phase: "execute".into(),
            domain: "dev".into(),
            artifacts: Some(ConductorSyncArtifacts {
                requirements: None,
                flow_plan_json: Some(
                    project
                        .join("outside-flow-plan-proposal.json")
                        .to_string_lossy()
                        .into_owned(),
                ),
                flow_plan_md: None,
            }),
            expected_phase: Some("plan".into()),
            artifact_hash: Some("sha256:invalid".into()),
            title: None,
            session_id: None,
        });
        assert!(rejected.is_err());

        let persisted = conductor_load_task_state(&project_root, task_id)
            .unwrap()
            .instance
            .unwrap();
        assert_eq!(persisted.current_phase, "planning");
        let _ = std::fs::remove_dir_all(&project);
    }
}
