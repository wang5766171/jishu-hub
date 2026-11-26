use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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
/// v0.9.8 需求22（评审修复轮 R2）：schema v5——加 `no_ask` 列（「不询问」
/// 开关记在任务实例上）。v4 → v5 是纯加列，任务实例库**原地升级**、不 DROP
/// 重建：任务是长期数据，升级一次就把任务列表清空是不可接受的。
const TASK_INSTANCE_SCHEMA_VERSION: i64 = 5;

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
    /// v0.9.8 需求22（评审修复轮 R2 / C4）：「不询问」开关。按任务记——这个
    /// 任务的主会话和它派发出去的节点会话生效，别的会话一律不生效；重启后
    /// 记得，直到在这个会话里关掉或任务被删除。此前它是全局配置里的一个
    /// 布尔键：任一会话打开，所有会话（包括普通对话）一起进入不询问。
    #[serde(default)]
    pub no_ask: bool,
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

/// 会话 → 所属任务实例的查法：按（项目根, 会话号）找，找不到给 `Ok(None)`。
/// hub_invoke（`runner_capability_plugins`）与它的单测各给一份。
pub(crate) type SessionTaskResolve<'a> =
    &'a dyn Fn(Option<&str>, &str) -> Result<Option<TaskLaunchInstance>, String>;

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
mod session_binding;

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
pub use session_binding::{bind_task_session, TaskBindingSlot, TaskLaunchIntent};

fn open_store(project_root: &str) -> Result<TaskInstanceStore, String> {
    let db_path = task_instances_db_path(&normalize_project_root(project_root));
    TaskInstanceStore::open(&db_path)
}

/// 只读路径用的打开方式：这个项目还没有任务库 → `Ok(None)`，不建库。
fn open_store_existing(project_root: &str) -> Result<Option<TaskInstanceStore>, String> {
    let db_path = task_instances_db_path(&normalize_project_root(project_root));
    TaskInstanceStore::open_existing(&db_path)
}

// ---------------------------------------------------------------------------
// v0.9.8 需求22（评审修复轮 R2 / C4）：「不询问」按会话
// ---------------------------------------------------------------------------

/// 打开全局的编排库（节点会话 → 图 的反查走它）。
fn open_orchestrator_store() -> Result<crate::orchestrator::TaskStore, String> {
    crate::orchestrator::TaskStore::open(&crate::orchestrator::default_db_path())
        .map_err(|e| format!("打开编排库失败: {e}"))
}

/// 会话 → 所属任务实例（生产入口）。不是任务会话 → `Ok(None)`。
pub(crate) fn query_task_instance(
    project_root: Option<&str>,
    session_id: &str,
) -> Result<Option<TaskLaunchInstance>, String> {
    task_instance_for_session_with(
        project_root,
        session_id,
        &|session_id| {
            let store = open_orchestrator_store()?;
            let Some(graph_id) = store
                .node_session_graph(session_id)
                .map_err(|e| format!("反查节点会话失败: {e}"))?
            else {
                return Ok(None);
            };
            let graph_root = store
                .get_graph(&graph_id)
                .map_err(|e| format!("读取图 {graph_id} 失败: {e}"))?
                .project_root
                .to_string_lossy()
                .into_owned();
            Ok(Some((graph_id, graph_root)))
        },
        &crate::agent::jishu_self::pi_session::locate_pi_session_project,
    )
}

/// 会话 → 所属任务实例的判定（可注入两个查询，供单测）。
///
/// - **主会话**：按 `task_session_id` 找。调用方知道项目根就直接查（最便宜，
///   先查）；不知道就经会话头定位会话所在的项目再查（前端开关的命令按跨端
///   契约只带会话号）。
/// - **节点会话**（任务派发出去的执行会话）：任务实例库按项目分库，先经
///   全局的编排库由会话号定位到图，再按图找任务实例——项目根取图自己的。
///
/// 「是不是任务会话」以 hub 的登记为准，不看执行器手里的任务编号——那个
/// 编号要等模型第一次上报步骤之后才有，单步小任务可能一直都没有。
pub(crate) fn task_instance_for_session_with(
    project_root: Option<&str>,
    session_id: &str,
    node_session_graph: &dyn Fn(&str) -> Result<Option<(String, String)>, String>,
    locate_session_project: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<TaskLaunchInstance>, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Ok(None);
    }
    if let Some(root) = project_root {
        if let Some(instance) = find_by_session(root, session_id)? {
            return Ok(Some(instance));
        }
    }
    if let Some((graph_id, graph_root)) = node_session_graph(session_id)? {
        // 读路径：图所在的项目还没有任务库 = 没有任务，不建库。
        let found = match open_store_existing(&graph_root)? {
            Some(store) => store.by_graph_id(&graph_id),
            None => Ok(None),
        };
        match found {
            Ok(instance) => return Ok(instance),
            Err(e) => log::warn!("[task-instance] 按图 {graph_id} 找任务实例失败: {e}"),
        }
    }
    if project_root.is_none() {
        if let Some(root) = locate_session_project(session_id) {
            return find_by_session(&root, session_id);
        }
    }
    Ok(None)
}

/// 某会话的「不询问」开没开。不是任务会话 → false。
pub(crate) fn no_ask_for_session(
    project_root: Option<&str>,
    session_id: &str,
) -> Result<bool, String> {
    Ok(query_task_instance(project_root, session_id)?.is_some_and(|instance| instance.no_ask))
}

/// 设置某会话所属任务的「不询问」开关，返回设置后的值。不是任务会话 → Err
///（不能悄悄记到一个不存在的任务上）。
pub(crate) fn set_no_ask_for_session(
    project_root: Option<&str>,
    session_id: &str,
    enabled: bool,
) -> Result<bool, String> {
    let Some(instance) = query_task_instance(project_root, session_id)? else {
        return Err("这个会话不是任务会话，无法设置「不询问」".to_string());
    };
    let store = open_store(&instance.project_root)?;
    store.set_no_ask(&instance.task_id, enabled)?;
    Ok(enabled)
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
    // ── v0.9.8 需求22（评审修复轮 R2 / C4）：「不询问」按会话 ──

    /// 在编排库里登记「某张图的某次运行里，一个执行节点的会话」。
    fn register_node_session(
        store: &crate::orchestrator::TaskStore,
        graph_id: &str,
        project_root: &str,
        session_id: &str,
    ) {
        use crate::orchestrator::domain::graph::{GraphNode, GraphSnapshot, NodeKind, TaskGraph};
        use crate::orchestrator::domain::run::{
            GraphRun, NodeAttempt, NodeRun, NodeRunStatus, RunStatus,
        };
        let stamp = crate::util::now_ms();
        store
            .create_graph(&TaskGraph {
                graph_id: graph_id.into(),
                title: "T".into(),
                goal: "G".into(),
                project_root: PathBuf::from(project_root),
                owner: "user".into(),
                current_draft_revision: None,
                created_at: stamp,
                updated_at: stamp,
            })
            .unwrap();
        let snapshot = GraphSnapshot {
            nodes: vec![GraphNode {
                node_id: "n1".into(),
                parent_id: None,
                title: "节点".into(),
                description: None,
                node_kind: NodeKind::Goal,
                input_contract: Default::default(),
                output_contract: Default::default(),
                role_requirement: None,
                capability_requirements: vec![],
                agent_assignment_constraint: None,
                policy: Default::default(),
                metadata: Default::default(),
                executable_payload: None,
                loop_config: None,
                approval_gate_config: None,
            }],
            edges: vec![],
        };
        let revision_id = format!("rev-{graph_id}");
        let revision = crate::orchestrator::domain::revision::GraphRevision::from_snapshot(
            &revision_id,
            graph_id,
            None,
            &snapshot,
            "user",
            stamp,
        )
        .unwrap();
        store.save_revision(&revision).unwrap();
        store
            .create_run(&GraphRun {
                run_id: format!("run-{graph_id}"),
                graph_id: graph_id.into(),
                active_revision_id: revision_id.clone(),
                status: RunStatus::Running,
                run_seq: 1,
                budget_state: Default::default(),
                planning_snapshot: Default::default(),
                started_at: stamp,
                finished_at: None,
            })
            .unwrap();
        store
            .save_node_run(&NodeRun {
                node_run_id: format!("nr-{graph_id}"),
                run_id: format!("run-{graph_id}"),
                node_id: "n1".into(),
                status: NodeRunStatus::Running,
                revision_id,
                started_at: Some(stamp),
                finished_at: None,
                attempt_count: 1,
                wake_at: None,
                error: None,
                loop_iteration: None,
                superseded: false,
            })
            .unwrap();
        store
            .save_attempt(&NodeAttempt {
                attempt_id: format!("att-{graph_id}"),
                node_run_id: format!("nr-{graph_id}"),
                attempt_number: 1,
                agent_assignment: None,
                transport: None,
                session_id: Some(session_id.into()),
                lease: None,
                usage: Default::default(),
                error: None,
                idempotency_key: None,
                checkpoint: None,
                dispatch_prompt: None,
                started_at: stamp,
                finished_at: None,
            })
            .unwrap();
    }

    /// 开关记在任务实例上：按任务各记各的，重开库仍在，任务实例的其它写
    /// 路径（上报步骤、改名）不会把它抹掉。
    #[test]
    fn no_ask_is_stored_on_task_instance() {
        let project = temp_project("no-ask");
        let root = project.to_string_lossy().to_string();
        let a = mark_task_session(&root, None, "sess-main-a", "jishu-task-runner", None).unwrap();
        let c = mark_task_session(&root, None, "sess-main-c", "jishu-task-runner", None).unwrap();
        {
            let store = open_store(&root).unwrap();
            assert!(!store.get(&a.task_id).unwrap().unwrap().no_ask);
            store.set_no_ask(&a.task_id, true).unwrap();
        }
        // 重开库：还在；别的任务不受影响。
        let reopened = open_store(&root).unwrap();
        assert!(reopened.get(&a.task_id).unwrap().unwrap().no_ask);
        assert!(
            !reopened.get(&c.task_id).unwrap().unwrap().no_ask,
            "别的任务不受影响"
        );
        drop(reopened);
        runner_update_steps(&root, &a.task_id, r#"{"steps":[]}"#, None).unwrap();
        rename_task(&root, &a.task_id, "改个名").unwrap();
        assert!(
            open_store(&root)
                .unwrap()
                .get(&a.task_id)
                .unwrap()
                .unwrap()
                .no_ask,
            "任务实例的其它写路径不得把开关抹掉"
        );
        open_store(&root)
            .unwrap()
            .set_no_ask(&a.task_id, false)
            .unwrap();
        assert!(
            !open_store(&root)
                .unwrap()
                .get(&a.task_id)
                .unwrap()
                .unwrap()
                .no_ask
        );
        // 任务不存在：报错，不假装成功。
        assert!(open_store(&root)
            .unwrap()
            .set_no_ask("task_missing", true)
            .is_err());

        let _ = std::fs::remove_dir_all(&project);
    }

    /// v4 → v5 原地加列：升级不丢任务，旧任务的开关是关。
    #[test]
    fn schema_v4_upgrades_in_place_keeping_rows() {
        let project = temp_project("schema-v4");
        let root = project.to_string_lossy().to_string();
        // 手工搭一张 v4 旧表（需求22 之前的结构，没有 no_ask 列）并写入两行。
        let db = task_instances_db_path(&normalize_project_root(&root));
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE task_instance (
                task_id TEXT PRIMARY KEY, project_root TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '新任务', skill_id TEXT NOT NULL,
                planner_agent_id TEXT NOT NULL DEFAULT 'jishu_agent',
                status TEXT NOT NULL DEFAULT 'active', task_session_id TEXT, graph_id TEXT,
                active_run_id TEXT, last_run_id TEXT, run_status TEXT, last_launch_key TEXT,
                stages_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            INSERT INTO task_instance
                (task_id, project_root, skill_id, task_session_id, created_at, updated_at)
            VALUES ('task_old', 'x', 'jishu-task-runner', 'sess-old', 1, 1),
                   ('task_old_2', 'x', 'jishu-task-runner', 'sess-old-2', 2, 2);
            PRAGMA user_version = 4;",
        )
        .unwrap();
        drop(conn);

        let old = get_task_instance(&root, "task_old")
            .unwrap()
            .expect("升级不丢任务");
        assert_eq!(old.task_session_id.as_deref(), Some("sess-old"));
        assert!(!old.no_ask, "旧任务的开关默认是关");
        assert!(get_task_instance(&root, "task_old_2").unwrap().is_some());
        let version: i64 = rusqlite::Connection::open(&db)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, TASK_INSTANCE_SCHEMA_VERSION);

        let _ = std::fs::remove_dir_all(&project);
    }

    /// 会话 → 任务：主会话、节点会话（跟随所属任务）各归各；普通会话不是
    /// 任务会话，也不能给它设置开关。
    #[test]
    fn session_resolves_to_owning_task_including_node_sessions() {
        let project = temp_project("session-lookup");
        let root = project.to_string_lossy().to_string();
        let a = mark_task_session(&root, None, "sess-main-a", "jishu-task-runner", None).unwrap();
        let c = mark_task_session(&root, None, "sess-main-c", "jishu-task-runner", None).unwrap();
        attach_graph(&root, &a.task_id, "graph-a").unwrap();
        attach_graph(&root, &c.task_id, "graph-c").unwrap();
        let orchestrator = crate::orchestrator::TaskStore::open_in_memory().unwrap();
        register_node_session(&orchestrator, "graph-a", &root, "sess-node-a");
        register_node_session(&orchestrator, "graph-c", &root, "sess-node-c");
        let node_session_graph = |session_id: &str| {
            let graph_id = orchestrator
                .node_session_graph(session_id)
                .map_err(|e| e.to_string())?;
            Ok(graph_id.map(|graph_id| (graph_id, root.clone())))
        };
        let task_of = |session_id: &str| {
            task_instance_for_session_with(Some(&root), session_id, &node_session_graph, &|_| None)
                .unwrap()
                .map(|instance| instance.task_id)
        };
        assert_eq!(task_of("sess-main-a").as_deref(), Some(a.task_id.as_str()));
        assert_eq!(
            task_of("sess-node-a").as_deref(),
            Some(a.task_id.as_str()),
            "节点会话跟随所属任务"
        );
        assert_eq!(task_of("sess-node-c").as_deref(), Some(c.task_id.as_str()));
        assert_eq!(task_of("sess-plain"), None, "普通会话不是任务会话");
        assert_eq!(task_of("   "), None);

        open_store(&root)
            .unwrap()
            .set_no_ask(&a.task_id, true)
            .unwrap();
        let no_ask = |session_id: &str| {
            task_instance_for_session_with(Some(&root), session_id, &node_session_graph, &|_| None)
                .map(|instance| instance.is_some_and(|instance| instance.no_ask))
                .unwrap()
        };
        assert!(no_ask("sess-main-a"));
        assert!(no_ask("sess-node-a"), "主会话开了，它的节点会话也开");
        assert!(!no_ask("sess-node-c"), "别的任务的节点会话不受影响");
        assert!(!no_ask("sess-plain"));

        // 设置：只对任务会话有意义。
        let set = |session_id: &str, enabled: bool| -> Result<bool, String> {
            match task_instance_for_session_with(
                Some(&root),
                session_id,
                &node_session_graph,
                &|_| None,
            )? {
                Some(instance) => {
                    open_store(&instance.project_root)?.set_no_ask(&instance.task_id, enabled)?;
                    Ok(enabled)
                }
                None => Err("这个会话不是任务会话，无法设置「不询问」".to_string()),
            }
        };
        assert!(set("sess-plain", true).is_err(), "普通会话不能设置开关");
        set("sess-node-c", true).unwrap();
        assert!(no_ask("sess-node-c") && no_ask("sess-main-c"));
        // 任务 A 的开关是任务 A 自己的：给任务 C 打开，不影响它。
        assert!(no_ask("sess-node-a") && no_ask("sess-main-a"));

        let _ = std::fs::remove_dir_all(&project);
    }

    /// 命令按契约只带会话号（不带项目根）：主会话经「会话号 → 项目」的
    /// 定位也能找到；定位不到就不是任务会话。带了项目根时不再做这步定位。
    #[test]
    fn main_session_found_without_project_root() {
        let project = temp_project("session-no-root");
        let root = project.to_string_lossy().to_string();
        let a = mark_task_session(&root, None, "sess-main-a", "jishu-task-runner", None).unwrap();
        let locate = |session_id: &str| (session_id == "sess-main-a").then(|| root.clone());
        let no_node = |_: &str| -> Result<Option<(String, String)>, String> { Ok(None) };
        let found = task_instance_for_session_with(None, "sess-main-a", &no_node, &locate).unwrap();
        assert_eq!(
            found.map(|instance| instance.task_id).as_deref(),
            Some(a.task_id.as_str())
        );
        assert_eq!(
            task_instance_for_session_with(None, "sess-plain", &no_node, &locate).unwrap(),
            None,
            "定位不到会话所在项目 = 不是任务会话"
        );
        // 带了项目根且主会话命中：不做节点会话的反查，也不做会话定位。
        let never = |_: &str| -> Result<Option<(String, String)>, String> {
            panic!("主会话命中后不该再做节点会话的反查")
        };
        let no_locate =
            |_: &str| -> Option<String> { panic!("带了项目根就不该再做会话定位") };
        let found =
            task_instance_for_session_with(Some(&root), "sess-main-a", &never, &no_locate).unwrap();
        assert!(found.is_some());

        let _ = std::fs::remove_dir_all(&project);
    }

    // ── 评审修复轮 R3 ──────────────────────────────────────────────────────

    /// 手工搭一张 v4 旧表（没有 no_ask 列）并写入两行，返回库文件路径。
    fn seed_v4_store(root: &str) -> PathBuf {
        let db = task_instances_db_path(&normalize_project_root(root));
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE task_instance (
                task_id TEXT PRIMARY KEY, project_root TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '新任务', skill_id TEXT NOT NULL,
                planner_agent_id TEXT NOT NULL DEFAULT 'jishu_agent',
                status TEXT NOT NULL DEFAULT 'active', task_session_id TEXT, graph_id TEXT,
                active_run_id TEXT, last_run_id TEXT, run_status TEXT, last_launch_key TEXT,
                stages_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            INSERT INTO task_instance
                (task_id, project_root, skill_id, task_session_id, created_at, updated_at)
            VALUES ('task_old', 'x', 'jishu-task-runner', 'sess-old', 1, 1),
                   ('task_old_2', 'x', 'jishu-task-runner', 'sess-old-2', 2, 2);
            PRAGMA user_version = 4;",
        )
        .unwrap();
        drop(conn);
        db
    }

    /// 守卫：离开作用域把迁移竞态的测试窗口归零（断言失败也会走到 Drop）。
    struct MigrationRaceWindow;

    impl MigrationRaceWindow {
        fn arm(millis: u64) -> Self {
            instance_store::MIGRATION_RACE_WINDOW_MS
                .store(millis, std::sync::atomic::Ordering::Relaxed);
            Self
        }
    }

    impl Drop for MigrationRaceWindow {
        fn drop(&mut self) {
            instance_store::MIGRATION_RACE_WINDOW_MS.store(0, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// 评审修复轮 R3（P2-3）：升级后第一次，几个线程同时首开同一个任务库——
    /// 每次都成功、旧行都在。测试窗口撑开「看完列、还没加列」的那一段；不加
    /// 保护的话四个线程都看到「还没有这一列」，后三个加列时撞上「列已存在」；
    /// 库还没切到 WAL 时还会撞上「库被锁」（切 WAL 不等锁）。这一条走完整的
    /// 打开路径，守的是「并发首开都成功」这个结果。
    #[test]
    fn concurrent_first_open_upgrades_v4_once() {
        let project = temp_project("schema-v4-race");
        let root = project.to_string_lossy().to_string();
        let db = seed_v4_store(&root);
        let _window = MigrationRaceWindow::arm(150);

        let threads = 4;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(threads));
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                let root = root.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    get_task_instance(&root, "task_old")
                })
            })
            .collect();
        for worker in workers {
            let old = worker
                .join()
                .unwrap()
                .expect("并发首开不得失败")
                .expect("升级不丢任务");
            assert_eq!(old.task_session_id.as_deref(), Some("sess-old"));
            assert!(!old.no_ask, "旧任务的开关默认是关");
        }
        assert!(get_task_instance(&root, "task_old_2").unwrap().is_some());
        let version: i64 = rusqlite::Connection::open(&db)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, TASK_INSTANCE_SCHEMA_VERSION);

        let _ = std::fs::remove_dir_all(&project);
    }

    /// 评审修复轮 R3（P2-3）：迁移那一层单独验。各开各的连接、同时跑迁移——
    /// 相当于另一个进程里的首开，不受进程内排队保护。迁移先拿写锁，再在锁内
    /// 读版本与列：先到的做完，后到的在锁内看到已是 v5 就跳过。
    #[test]
    fn migration_takes_the_write_lock_before_reading() {
        let project = temp_project("schema-v4-lock");
        let root = project.to_string_lossy().to_string();
        let db = seed_v4_store(&root);
        // 真实的 v4 旧库已经是 WAL（旧版每次打开都切）；切 WAL 那一步不是这里
        // 要测的，先切好。
        rusqlite::Connection::open(&db)
            .unwrap()
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        let connections: Vec<rusqlite::Connection> = (0..4)
            .map(|_| {
                let conn = rusqlite::Connection::open(&db).unwrap();
                conn.pragma_update(None, "busy_timeout", 5000).unwrap();
                conn
            })
            .collect();
        let _window = MigrationRaceWindow::arm(150);
        let barrier = std::sync::Barrier::new(connections.len());

        let outcomes: Vec<Result<(), String>> = std::thread::scope(|scope| {
            let workers: Vec<_> = connections
                .into_iter()
                .map(|conn| {
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        TaskInstanceStore::migrate_schema(&conn)
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect()
        });
        for outcome in outcomes {
            outcome.expect("并发的迁移不得失败");
        }
        assert_eq!(
            get_task_instance(&root, "task_old")
                .unwrap()
                .unwrap()
                .task_session_id
                .as_deref(),
            Some("sess-old"),
            "升级不丢任务"
        );
        assert!(get_task_instance(&root, "task_old_2").unwrap().is_some());
        let version: i64 = rusqlite::Connection::open(&db)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, TASK_INSTANCE_SCHEMA_VERSION);

        let _ = std::fs::remove_dir_all(&project);
    }

    /// 评审修复轮 R3（P2-4）：切「不询问」开关不改任务的更新时间——任务列
    /// 表按它倒序，点一下开关不该让任务跳到最前。
    #[test]
    fn toggling_no_ask_keeps_updated_at() {
        let project = temp_project("no-ask-order");
        let root = project.to_string_lossy().to_string();
        let a = mark_task_session(&root, None, "sess-main-a", "jishu-task-runner", None).unwrap();
        // c 比 a 新（更新时间严格更大）：列表里 c 在前。
        std::thread::sleep(std::time::Duration::from_millis(5));
        let c = mark_task_session(&root, None, "sess-main-c", "jishu-task-runner", None).unwrap();
        assert!(c.updated_at > a.updated_at, "前置：c 是更近更新的任务");
        let before = get_task_instance(&root, &a.task_id).unwrap().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(5));
        open_store(&root)
            .unwrap()
            .set_no_ask(&a.task_id, true)
            .unwrap();

        let after = get_task_instance(&root, &a.task_id).unwrap().unwrap();
        assert!(after.no_ask, "开关切过去了");
        assert_eq!(after.updated_at, before.updated_at, "切开关不改更新时间");
        let order: Vec<String> = list_task_instances(&root)
            .unwrap()
            .into_iter()
            .map(|instance| instance.task_id)
            .collect();
        assert_eq!(
            order,
            vec![c.task_id.clone(), a.task_id.clone()],
            "列表顺序不跳"
        );

        let _ = std::fs::remove_dir_all(&project);
    }

    /// 评审修复轮 R3（P2-5）：查「某会话是不是任务会话」是读操作——这个项目
    /// 还没有任务库时返回「不是」，不多出空库文件。带项目根、经定位拿到项目
    /// 根两条路都是。
    #[test]
    fn looking_up_a_session_never_creates_a_task_db() {
        let no_node = |_: &str| -> Result<Option<(String, String)>, String> { Ok(None) };

        let project = temp_project("no-db-root");
        let root = project.to_string_lossy().to_string();
        let never =
            |_: &str| -> Option<String> { panic!("带了项目根就不该再做会话定位") };
        assert_eq!(
            task_instance_for_session_with(Some(&root), "sess-plain", &no_node, &never).unwrap(),
            None
        );
        assert!(
            !task_instances_db_path(&normalize_project_root(&root)).exists(),
            "带项目根的查询不该建出任务库"
        );
        let _ = std::fs::remove_dir_all(&project);

        let project = temp_project("no-db-located");
        let root = project.to_string_lossy().to_string();
        let locate = |session_id: &str| (session_id == "sess-plain").then(|| root.clone());
        assert_eq!(
            task_instance_for_session_with(None, "sess-plain", &no_node, &locate).unwrap(),
            None
        );
        assert!(
            !task_instances_db_path(&normalize_project_root(&root)).exists(),
            "经定位拿到项目根的查询不该建出任务库"
        );
        // 节点会话那条路同理：图所在的项目没有任务库 = 没有任务。
        let node_graph = |_: &str| -> Result<Option<(String, String)>, String> {
            Ok(Some(("graph-x".to_string(), root.clone())))
        };
        assert_eq!(
            task_instance_for_session_with(None, "sess-node", &node_graph, &locate).unwrap(),
            None
        );
        assert!(
            !task_instances_db_path(&normalize_project_root(&root)).exists(),
            "按图找任务不该建出任务库"
        );
        let _ = std::fs::remove_dir_all(&project);
    }
}
