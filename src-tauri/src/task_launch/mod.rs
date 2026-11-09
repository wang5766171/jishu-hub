use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::util::now_ms;

/// 任务实例生命周期状态（v0.9.7 需求2 去阶段化：收敛为 active|archived；
/// 阶段语义 4 值退场，执行态由 `run_status` 独立追踪）。
pub const STATUS_ACTIVE: &str = "active";

/// 任务实例建库默认标题。需求9 #4：runner 上报 goal 时仅当标题仍是该默认
/// 值才覆盖（用户重命名过的标题不回写）——单源常量供创建与覆盖判定共用。
pub const DEFAULT_TASK_TITLE: &str = "新任务";

/// 执行实例运行态（5 值，冗余到 task_instance.run_status）。
///
/// 由 graph_run.status 派生，通过 `sync_run_status` 写回。`status` 字段不随执行态变化。
pub const RUN_STATUS_RUNNING: &str = "running";
pub const RUN_STATUS_PAUSED: &str = "paused";
pub const RUN_STATUS_COMPLETED: &str = "completed";
pub const RUN_STATUS_FAILED: &str = "failed";
pub const RUN_STATUS_CANCELLED: &str = "cancelled";

/// task_instance 表 schema 版本。升级表结构时递增，并在 `migrate_schema` 中处理迁移。
/// v0.9.7 需求2 C2：schema v4——去阶段化（列名沿用磁盘真名 stages_json，
/// 语义改为 runner 步骤清单 JSON：`{steps:[{id,title,status}],pendingQuestion?}`；
/// current_phase/requirement_file/requirement_session_id/planning_session_id
/// 四列退场，合并为 task_session_id）。
const TASK_INSTANCE_SCHEMA_VERSION: i64 = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskLaunchInstance {
    pub task_id: String,
    pub project_root: String,
    pub title: String,
    pub skill_id: String,
    pub planner_agent_id: String,
    /// TaskInstance 生命周期状态（active|archived）。
    pub status: String,
    /// 任务主对话会话（原 requirement/planning 两列合并——单对话流）。
    #[serde(default)]
    pub task_session_id: Option<String>,
    pub graph_id: Option<String>,
    /// 当前活跃执行实例（逻辑外键 → orchestrator.db.graph_run）。
    pub active_run_id: Option<String>,
    /// 最近一次执行实例。
    pub last_run_id: Option<String>,
    /// 执行状态冗余（5 值枚举，仅执行期有值）。
    pub run_status: Option<String>,
    /// 幂等启动键（防止 fork/resume 重复启动 run）。
    pub last_launch_key: Option<String>,
    /// runner 步骤清单 JSON（任务卡数据源；None = 尚未拆解）。
    #[serde(default)]
    pub stages_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct TaskRequirementMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
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
#[allow(dead_code)]
pub struct TaskRequirementFinalized {
    pub task_id: String,
    pub title: String,
    pub requirement_dir: String,
    pub requirement_file: String,
}

/// 任务会话索引项。一个任务实例下可查看的会话（1 需求 + 1 规划 + N 节点）。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §1.3。
/// 注意：主任务会话是 task_event 投影的"虚拟会话"，无真实 session_id，此处不包含它。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct TaskSessionEntry {
    pub phase: String,
    pub session_id: String,
    pub session_type: String,
    pub node_id: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
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

// v0.9.7 需求2：conductor_sync_phase 及配套结构随三阶段概念退役；
// conductor_load_task_state 改名 runner_load_task_state。
pub use conductor::{runner_load_task_state, ConductorLoadStateResult};
pub use instance_store::{
    attach_graph, create_from_existing_graph, delete_task, find_by_session, get_task_instance,
    list_task_instances, mark_task_session, rename_task, runner_update_steps, sync_run_status,
};
mod revise;

pub use proposal::{orchestrator_validate_proposal, ValidateProposalRequest};
pub use revise::{conductor_revise_plan, RevisePlanRequest};
mod dispatch;
pub use dispatch::{conductor_dispatch_to_node, DispatchToNodeRequest};
pub use run::{
    orchestrator_start_run_from_revision, sync_run_status_to_task_instance, task_launch_start_run,
    StartRunFromRevisionRequest, StartRunFromRevisionResult, TaskLaunchStartRunRequest,
};

fn open_store(project_root: &str) -> Result<TaskInstanceStore, String> {
    let db_path = task_instances_db_path(&normalize_project_root(project_root));
    TaskInstanceStore::open(&db_path)
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

    /// v0.9.7 需求2：mark_task_session（无 phase）+ attach_graph 不降级语义。
    #[test]
    fn mark_session_and_attach_graph_roundtrip() {
        let project = temp_project("mark-session");
        let project_root = project.to_string_lossy().to_string();

        let instance = mark_task_session(
            &project_root,
            None,
            "task-main-session",
            "jishu-task-runner",
            Some("Demo task"),
        )
        .unwrap();
        assert_eq!(instance.status, STATUS_ACTIVE);
        assert_eq!(
            instance.task_session_id.as_deref(),
            Some("task-main-session")
        );

        attach_graph(&project_root, &instance.task_id, "graph-1").unwrap();
        let updated = mark_task_session(
            &project_root,
            Some(&instance.task_id),
            "task-main-session-2",
            "jishu-task-runner",
            None,
        )
        .unwrap();
        assert_eq!(updated.graph_id.as_deref(), Some("graph-1"));

        let _ = std::fs::remove_dir_all(&project);
    }

    /// v0.9.7 需求2：runner_update_steps 形状校验 + 持久化 + runner 加载。
    /// 需求9 #4 扩展：可选 title 覆盖链（默认标题→覆盖；用户重命名→不回写）。
    #[test]
    fn runner_steps_roundtrip() {
        let project = temp_project("runner-steps");
        let project_root = project.to_string_lossy().to_string();
        // title 传 None → 建库默认「新任务」（runner goal 上报覆盖链的起点）。
        let instance =
            mark_task_session(&project_root, None, "s1", "jishu-task-runner", None).unwrap();
        assert_eq!(instance.title, DEFAULT_TASK_TITLE);

        let steps = serde_json::json!({
            "steps": [
                { "id": "a", "title": "第一步", "status": "done" },
                { "id": "b", "title": "第二步", "status": "running" },
            ],
            "pendingQuestion": null,
        })
        .to_string();
        runner_update_steps(&project_root, &instance.task_id, &steps, None).unwrap();
        // 拒绝非 steps 形状。
        assert!(runner_update_steps(&project_root, &instance.task_id, "{\"x\":1}", None).is_err());

        let loaded = runner_load_task_state(&project_root, &instance.task_id)
            .unwrap()
            .instance
            .unwrap();
        assert_eq!(loaded.stages_json.as_deref(), Some(steps.as_str()));
        // 需求9 #4：可选 title——默认标题时覆盖（截 40 字符），非默认（用户
        // 重命名）不回写。
        runner_update_steps(
            &project_root,
            &instance.task_id,
            &steps,
            Some("优化首页性能并给出报告"),
        )
        .unwrap();
        let titled = runner_load_task_state(&project_root, &instance.task_id)
            .unwrap()
            .instance
            .unwrap();
        assert_eq!(titled.title, "优化首页性能并给出报告");
        rename_task(&project_root, &instance.task_id, "用户自定义名").unwrap();
        runner_update_steps(
            &project_root,
            &instance.task_id,
            &steps,
            Some("再上报也不覆盖"),
        )
        .unwrap();
        let kept = runner_load_task_state(&project_root, &instance.task_id)
            .unwrap()
            .instance
            .unwrap();
        assert_eq!(
            kept.title, "用户自定义名",
            "非默认标题不应被 runner 上报回写"
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
        // → 任务查不到（丢失）→ 关联任务会话回归常规会话列表"。
        let project = temp_project("path-forms");
        let root = project.to_string_lossy().to_string();

        // 用规范路径形式创建任务（mark_task_session 内部 upsert 会写入 project_root）。
        let instance = mark_task_session(
            &root,
            None,
            "requirements-session",
            "jishu-task-runner",
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
}
