use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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
const TASK_INSTANCE_SCHEMA_VERSION: i64 = 1;

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

/// 阶段推进请求（统一入口，不绑定 skill）。
///
/// `phase` 表示要推进到哪个阶段：
/// - "planning"：需求→规划（落盘终稿 + 推进状态 + 返回规划指令）
/// - "execution"：规划→执行（推进状态到 graph_created）
///
/// 设计依据：阶段转换应该是确定性的后端原子操作，不应依赖前端关键词检测。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancePhaseRequest {
    pub task_id: String,
    pub phase: String,
    /// 仅 requirements→planning 需要：需求终稿 markdown（由 skill 的 format_requirement.mjs 产出）。
    pub requirement_markdown: Option<String>,
    /// 仅 requirements→planning 需要：需求阶段会话 id（追溯用）。
    pub requirement_session_id: Option<String>,
}

/// 阶段推进结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancePhaseResult {
    pub instance: TaskLaunchInstance,
    /// 仅 requirements→planning：传给规划阶段新会话的首条消息（隐藏指令 + 需求终稿）。
    /// 前端收到后直接用 send_message 发给 agent（用新 pending session）。
    pub planning_instruction: Option<String>,
}

/// 独立 SQLite 任务实例库。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §1.1、§7。
/// 与 orchestrator 的 TaskStore 分库，graph_id/run_id 作为逻辑外键，应用层维护一致性。
pub struct TaskInstanceStore {
    writer: Mutex<Connection>,
    #[allow(dead_code)]
    db_path: PathBuf,
}

impl TaskInstanceStore {
    /// 打开（或创建）指定路径的任务实例库。
    pub fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(|e| e.to_string())?;
        Self::migrate_schema(&conn)?;
        Ok(Self {
            writer: Mutex::new(conn),
            db_path: db_path.to_path_buf(),
        })
    }

    fn migrate_schema(conn: &Connection) -> Result<(), String> {
        let current_version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if current_version != TASK_INSTANCE_SCHEMA_VERSION {
            // v0 → v1：旧版本可能为 0（全新库）或不存在 task_instance 表。
            // 开发期允许 drop 重建；正式发布后需要按 version 增量迁移。
            conn.execute_batch(
                r#"
                DROP TABLE IF EXISTS task_instance;
                "#,
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_instance (
                task_id                  TEXT PRIMARY KEY,
                project_root             TEXT NOT NULL,
                title                    TEXT NOT NULL DEFAULT '新任务',
                skill_id                 TEXT NOT NULL,
                planner_agent_id         TEXT NOT NULL DEFAULT 'jishu_agent',
                status                   TEXT NOT NULL DEFAULT 'requirements_discussing',
                current_phase            TEXT NOT NULL DEFAULT 'requirements',
                requirement_file         TEXT,
                requirement_session_id   TEXT,
                planning_session_id      TEXT,
                graph_id                 TEXT,
                active_run_id            TEXT,
                last_run_id              TEXT,
                run_status               TEXT,
                created_at               INTEGER NOT NULL,
                updated_at               INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_task_instance_project
                ON task_instance(project_root, updated_at DESC);
            "#,
        )
        .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "user_version", TASK_INSTANCE_SCHEMA_VERSION)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn row_to_instance(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskLaunchInstance> {
        Ok(TaskLaunchInstance {
            task_id: row.get("task_id")?,
            project_root: row.get("project_root")?,
            title: row.get("title")?,
            skill_id: row.get("skill_id")?,
            planner_agent_id: row.get("planner_agent_id")?,
            status: row.get("status")?,
            current_phase: row.get("current_phase")?,
            requirement_file: row.get("requirement_file")?,
            requirement_session_id: row.get("requirement_session_id")?,
            planning_session_id: row.get("planning_session_id")?,
            graph_id: row.get("graph_id")?,
            active_run_id: row.get("active_run_id")?,
            last_run_id: row.get("last_run_id")?,
            run_status: row.get("run_status")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    const SELECT_COLUMNS: &'static str = "task_id, project_root, title, skill_id, planner_agent_id,
                status, current_phase, requirement_file, requirement_session_id,
                planning_session_id, graph_id, active_run_id, last_run_id, run_status,
                created_at, updated_at";

    fn list_by_project(&self, project_root: &str) -> Result<Vec<TaskLaunchInstance>, String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        let sql = format!(
            "SELECT {} FROM task_instance WHERE project_root = ?1 ORDER BY updated_at DESC",
            Self::SELECT_COLUMNS
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_root], Self::row_to_instance)
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    fn get(&self, task_id: &str) -> Result<Option<TaskLaunchInstance>, String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        let sql = format!(
            "SELECT {} FROM task_instance WHERE task_id = ?1",
            Self::SELECT_COLUMNS
        );
        conn.query_row(&sql, params![task_id], Self::row_to_instance)
            .optional()
            .map_err(|e| e.to_string())
    }

    fn upsert(&self, instance: &TaskLaunchInstance) -> Result<(), String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO task_instance (
                task_id, project_root, title, skill_id, planner_agent_id, status,
                current_phase, requirement_file, requirement_session_id, planning_session_id,
                graph_id, active_run_id, last_run_id, run_status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(task_id) DO UPDATE SET
                title = excluded.title,
                skill_id = excluded.skill_id,
                planner_agent_id = excluded.planner_agent_id,
                status = excluded.status,
                current_phase = excluded.current_phase,
                requirement_file = excluded.requirement_file,
                requirement_session_id = excluded.requirement_session_id,
                planning_session_id = excluded.planning_session_id,
                graph_id = excluded.graph_id,
                active_run_id = excluded.active_run_id,
                last_run_id = excluded.last_run_id,
                run_status = excluded.run_status,
                updated_at = excluded.updated_at",
            params![
                instance.task_id,
                instance.project_root,
                instance.title,
                instance.skill_id,
                instance.planner_agent_id,
                instance.status,
                instance.current_phase,
                instance.requirement_file,
                instance.requirement_session_id,
                instance.planning_session_id,
                instance.graph_id,
                instance.active_run_id,
                instance.last_run_id,
                instance.run_status,
                instance.created_at,
                instance.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn delete(&self, task_id: &str) -> Result<(), String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM task_instance WHERE task_id = ?1",
            params![task_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// 打开（或创建）某项目根目录下的任务实例库。
fn open_store(project_root: &str) -> Result<TaskInstanceStore, String> {
    let db_path = task_instances_db_path(project_root);
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

pub fn list_task_instances(project_root: &str) -> Result<Vec<TaskLaunchInstance>, String> {
    let store = open_store(project_root)?;
    store.list_by_project(project_root)
}

pub fn get_task_instance(
    project_root: &str,
    task_id: &str,
) -> Result<Option<TaskLaunchInstance>, String> {
    let store = open_store(project_root)?;
    store.get(task_id)
}

/// 标记某阶段的会话。阶段由 `phase` 参数决定（经 `normalize_phase` 归一化）。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §3.1、§3.2、§1.3。
/// - requirements 阶段：写 requirement_session_id + status=requirements_discussing
/// - planning 阶段：写 planning_session_id + status=planning_discussing
/// - execution 阶段：不绑定 session_id（执行阶段会话由 run/node 管理），只推进 current_phase
pub fn mark_task_stage_session(
    project_root: &str,
    task_id: Option<&str>,
    session_id: &str,
    skill_id: &str,
    phase: &str,
    title: Option<&str>,
) -> Result<TaskLaunchInstance, String> {
    if session_id.trim().is_empty() {
        return Err("session_id is required".into());
    }
    let phase = normalize_phase(phase);
    let store = open_store(project_root)?;
    let now = now_ms();
    let id = task_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("task_{}", uuid::Uuid::new_v4().simple()));

    // 先读现有实例（若存在），用于保留未参与本次更新的字段。
    let existing = store.get(&id)?;
    let mut instance = existing.unwrap_or_else(|| TaskLaunchInstance {
        task_id: id.clone(),
        project_root: project_root.to_string(),
        title: title
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("新任务")
            .to_string(),
        skill_id: skill_id.to_string(),
        planner_agent_id: "jishu_agent".into(),
        status: STATUS_REQUIREMENTS_DISCUSSING.into(),
        current_phase: phase.clone(),
        requirement_file: None,
        requirement_session_id: None,
        planning_session_id: None,
        graph_id: None,
        active_run_id: None,
        last_run_id: None,
        run_status: None,
        created_at: now,
        updated_at: now,
    });

    instance.skill_id = skill_id.to_string();
    instance.updated_at = now;
    if let Some(title) = title.map(str::trim).filter(|v| !v.is_empty()) {
        instance.title = title.to_string();
    }

    match phase.as_str() {
        "planning" => {
            instance.planning_session_id = Some(session_id.to_string());
            if instance.status != STATUS_GRAPH_CREATED {
                instance.current_phase = "planning".into();
                instance.status = STATUS_PLANNING_DISCUSSING.into();
            }
        }
        "execution" => {
            // 执行阶段不绑定 session_id（执行会话由 run/node 管理）。
            // 仅当当前 status 还没到 graph_created 时才推进（避免覆盖已绑图的状态）。
            instance.current_phase = "execution".into();
            if instance.status != STATUS_GRAPH_CREATED {
                instance.status = STATUS_GRAPH_CREATED.into();
            }
        }
        _ => {
            // requirements 阶段
            instance.requirement_session_id = Some(session_id.to_string());
            if instance.status == STATUS_REQUIREMENTS_DISCUSSING {
                instance.current_phase = "requirements".into();
                instance.status = STATUS_REQUIREMENTS_DISCUSSING.into();
            }
        }
    }

    store.upsert(&instance)?;
    Ok(instance)
}

/// 通过 session_id 查找任务实例。
/// agent 调 advance_phase.mjs 时可能不知道 task_id，但知道自己的 session_id
/// （Pi 的 get_state 返回）。用 session_id 反查 task_id 是确定性的。
pub fn find_by_session(
    project_root: &str,
    session_id: &str,
) -> Result<Option<TaskLaunchInstance>, String> {
    let store = open_store(project_root)?;
    let instances = store.list_by_project(project_root)?;
    Ok(instances.into_iter().find(|inst| {
        inst.requirement_session_id.as_deref() == Some(session_id)
            || inst.planning_session_id.as_deref() == Some(session_id)
    }))
}

/// 需求定稿：落盘 requirement_markdown + 推进 status=requirements_finalized。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §3.1。
/// `requirement_markdown` 由调用方决定（Agent 按 skill 约束产出 / 直接模式原始描述），
/// 后端只负责落盘 + 记元数据 + 生成规划指令。不再硬编码 render_requirement_markdown。
pub fn finalize_requirement(
    project_root: &str,
    request: RequirementFinalizeRequest,
) -> Result<TaskRequirementFinalized, String> {
    let RequirementFinalizeRequest {
        task_id,
        skill_id,
        title,
        requirement_markdown,
        source_session_id,
        creation_mode,
    } = request;

    if requirement_markdown.trim().is_empty() {
        return Err("requirement_markdown is required".into());
    }
    let store = open_store(project_root)?;
    let now = now_ms();
    let id = task_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("task_{}", uuid::Uuid::new_v4().simple()));

    let final_title = title
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| derive_title_from_markdown(&requirement_markdown))
        .unwrap_or_else(|| "新任务需求".to_string());

    let requirement_dir = task_workspace_root(project_root)
        .join(&id)
        .join("requirements");
    std::fs::create_dir_all(&requirement_dir).map_err(|err| err.to_string())?;
    let requirement_file = requirement_dir.join("requirements.md");
    let content = render_finalized_markdown(
        &final_title,
        &skill_id,
        source_session_id.as_deref(),
        creation_mode.as_str(),
        &requirement_markdown,
    );
    crate::util::atomic_write(&requirement_file, content.as_bytes())
        .map_err(|err| err.to_string())?;

    let existing = store.get(&id)?;
    let mut instance = existing.unwrap_or_else(|| TaskLaunchInstance {
        task_id: id.clone(),
        project_root: project_root.to_string(),
        title: final_title.clone(),
        skill_id: skill_id.clone(),
        planner_agent_id: "jishu_agent".into(),
        status: STATUS_REQUIREMENTS_FINALIZED.into(),
        current_phase: "requirements".into(),
        requirement_file: None,
        requirement_session_id: None,
        planning_session_id: None,
        graph_id: None,
        active_run_id: None,
        last_run_id: None,
        run_status: None,
        created_at: now,
        updated_at: now,
    });
    instance.title = final_title.clone();
    instance.skill_id = skill_id.clone();
    instance.status = STATUS_REQUIREMENTS_FINALIZED.into();
    instance.current_phase = "requirements".into();
    instance.requirement_file = Some(requirement_file.to_string_lossy().to_string());
    if let Some(session_id) = source_session_id.filter(|v| !v.trim().is_empty()) {
        instance.requirement_session_id = Some(session_id);
    }
    instance.updated_at = now;
    store.upsert(&instance)?;

    let planning_instruction = build_planning_instruction_from_requirement(&requirement_file)?;
    Ok(TaskRequirementFinalized {
        task_id: id,
        title: final_title,
        requirement_dir: requirement_dir.to_string_lossy().to_string(),
        requirement_file: requirement_file.to_string_lossy().to_string(),
        planning_instruction,
    })
}

/// 将生成的 TaskGraph 绑定到任务实例，推进到执行阶段（status 终态）。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §3.2、§2.1。
pub fn attach_graph(
    project_root: &str,
    task_id: &str,
    graph_id: &str,
) -> Result<TaskLaunchInstance, String> {
    let store = open_store(project_root)?;
    let mut instance = store
        .get(task_id)?
        .ok_or_else(|| format!("task instance not found: {task_id}"))?;
    instance.graph_id = Some(graph_id.to_string());
    instance.status = STATUS_GRAPH_CREATED.into();
    instance.current_phase = "execution".into();
    instance.updated_at = now_ms();
    store.upsert(&instance)?;
    Ok(instance)
}

/// 统一阶段推进入口。
///
/// 按 `request.phase` 决定转换类型：
/// - "planning"：需求→规划。落盘需求终稿，推进 status → requirements_finalized → planning_discussing，
///   返回规划指令（含需求终稿内容），前端用它发起新的规划阶段会话。
/// - "execution"：规划→执行。推进 status → graph_created，current_phase → execution。
///
/// 设计依据：阶段转换是确定性的后端原子操作（状态机 + 文件），不依赖前端关键词检测或 skill 话术。
/// 无论用什么 skill，阶段转换都走这个统一入口。
pub fn advance_phase(
    project_root: &str,
    request: AdvancePhaseRequest,
) -> Result<AdvancePhaseResult, String> {
    let AdvancePhaseRequest {
        task_id,
        phase,
        requirement_markdown,
        requirement_session_id,
    } = request;

    let store = open_store(project_root)?;
    let mut instance = store
        .get(&task_id)?
        .ok_or_else(|| format!("task instance not found: {task_id}"))?;

    match phase.as_str() {
        "planning" => {
            // 需求→规划：落盘终稿 + 推进状态
            let markdown = requirement_markdown
                .ok_or_else(|| "requirement_markdown is required for planning phase".to_string())?;
            if markdown.trim().is_empty() {
                return Err("requirement_markdown is empty".into());
            }

            // 落盘需求终稿
            let requirement_dir = task_workspace_root(project_root)
                .join(&task_id)
                .join("requirements");
            std::fs::create_dir_all(&requirement_dir).map_err(|err| err.to_string())?;
            let requirement_file = requirement_dir.join("requirements.md");
            let content = render_finalized_markdown(
                &instance.title,
                &instance.skill_id,
                requirement_session_id.as_deref(),
                "discussion",
                &markdown,
            );
            crate::util::atomic_write(&requirement_file, content.as_bytes())
                .map_err(|err| err.to_string())?;

            // 推进状态
            let now = now_ms();
            instance.status = STATUS_PLANNING_DISCUSSING.into();
            instance.current_phase = "planning".into();
            instance.requirement_file = Some(requirement_file.to_string_lossy().to_string());
            if let Some(sid) = requirement_session_id.filter(|v| !v.trim().is_empty()) {
                instance.requirement_session_id = Some(sid);
            }
            instance.updated_at = now;
            store.upsert(&instance)?;

            // 生成规划指令（传给规划阶段新会话的首条消息）
            let planning_instruction =
                build_planning_instruction_from_requirement(&requirement_file)?;

            Ok(AdvancePhaseResult {
                instance,
                planning_instruction: Some(planning_instruction),
            })
        }
        "execution" => {
            // 规划→执行：推进状态到 graph_created
            // 注意：graph 的创建（orchestrator_create_graph）由前端调用，
            // 这里只推进 task_instance 状态。前端先 create_graph 拿到 graph_id，
            // 再调本命令推进状态。或者在 attach_graph 之后调本命令。
            // 简化：execution 阶段推进只更新 current_phase，graph_id 由 attach_graph 设置。
            instance.status = STATUS_GRAPH_CREATED.into();
            instance.current_phase = "execution".into();
            instance.updated_at = now_ms();
            store.upsert(&instance)?;

            Ok(AdvancePhaseResult {
                instance,
                planning_instruction: None,
            })
        }
        _ => Err(format!("unknown phase: {phase}")),
    }
}
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §1.1 联动契约、§2.1 run_status 流转。
/// - running：写 active_run_id + run_status=running
/// - 终态（completed/failed/cancelled）：last_run_id ← active_run_id，清 active_run_id，写 run_status
/// - paused：仅更新 run_status（active_run_id 保留）
pub fn sync_run_status(
    project_root: &str,
    task_id: &str,
    run_id: &str,
    run_status: &str,
) -> Result<TaskLaunchInstance, String> {
    let normalized = normalize_run_status(run_status);
    let store = open_store(project_root)?;
    let mut instance = store
        .get(task_id)?
        .ok_or_else(|| format!("task instance not found: {task_id}"))?;
    instance.updated_at = now_ms();
    match normalized.as_str() {
        RUN_STATUS_RUNNING => {
            instance.active_run_id = Some(run_id.to_string());
            instance.run_status = Some(RUN_STATUS_RUNNING.into());
        }
        RUN_STATUS_PAUSED => {
            // 保留 active_run_id（暂停的 run 仍是当前活跃实例）
            instance.run_status = Some(RUN_STATUS_PAUSED.into());
        }
        RUN_STATUS_COMPLETED | RUN_STATUS_FAILED | RUN_STATUS_CANCELLED => {
            instance.last_run_id = Some(run_id.to_string());
            instance.active_run_id = None;
            instance.run_status = Some(normalized.clone());
        }
        _ => {
            return Err(format!("invalid run_status: {run_status}"));
        }
    }
    store.upsert(&instance)?;
    Ok(instance)
}

pub fn rename_task(
    project_root: &str,
    task_id: &str,
    title: &str,
) -> Result<TaskLaunchInstance, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("title is required".into());
    }
    let store = open_store(project_root)?;
    let mut instance = store
        .get(task_id)?
        .ok_or_else(|| format!("task instance not found: {task_id}"))?;
    instance.title = title.to_string();
    instance.updated_at = now_ms();
    store.upsert(&instance)?;
    Ok(instance)
}

/// 删除任务实例（SQLite 行 + 需求终稿目录）。
///
/// 设计依据：`任务数据结构与生命周期设计_20260622.md` §7。
/// 注意：orchestrator.db 的 graph 级联数据由调用方另外调用 `orchestrator_delete_graph` 清理。
pub fn delete_task(project_root: &str, task_id: &str) -> Result<(), String> {
    let store = open_store(project_root)?;
    store.delete(task_id)?;
    let dir = task_workspace_root(project_root).join(task_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// 为孤儿 graph 补建 TaskInstance（打开旧路径创建的图时检测调用）。
///
/// 设计依据：`任务入口与容器架构设计_20260622.md` §2.5。
pub fn create_from_existing_graph(
    project_root: &str,
    graph_id: &str,
    title: &str,
    skill_id: &str,
) -> Result<TaskLaunchInstance, String> {
    let store = open_store(project_root)?;
    let now = now_ms();
    let id = format!("task_{}", uuid::Uuid::new_v4().simple());
    let instance = TaskLaunchInstance {
        task_id: id,
        project_root: project_root.to_string(),
        title: title.to_string(),
        skill_id: skill_id.to_string(),
        planner_agent_id: "jishu_agent".into(),
        status: STATUS_GRAPH_CREATED.into(),
        current_phase: "execution".into(),
        requirement_file: None,
        requirement_session_id: None,
        planning_session_id: None,
        graph_id: Some(graph_id.to_string()),
        active_run_id: None,
        last_run_id: None,
        run_status: None,
        created_at: now,
        updated_at: now,
    };
    store.upsert(&instance)?;
    Ok(instance)
}

fn normalize_run_status(status: &str) -> String {
    match status {
        "Running" | "running" => RUN_STATUS_RUNNING.into(),
        "Paused" | "paused" => RUN_STATUS_PAUSED.into(),
        "Completed" | "completed" => RUN_STATUS_COMPLETED.into(),
        "Failed" | "failed" => RUN_STATUS_FAILED.into(),
        "Cancelled" | "cancelled" => RUN_STATUS_CANCELLED.into(),
        _ => status.to_string(),
    }
}

fn build_planning_instruction_from_requirement(requirement_file: &Path) -> Result<String, String> {
    let content = std::fs::read_to_string(requirement_file).map_err(|err| err.to_string())?;
    Ok(format!(
        "请读取以下需求终稿，并基于该需求与用户进行任务流程规划讨论。当前阶段不要直接执行任务，也不要要求用户去画布点击智能规划；请在会话中持续澄清流程节点、职责、依赖、验收与风险。当流程方案明确后，请发起交互式确认，询问用户是否生成任务流程图。\n\n需求终稿文件：{}\n\n--- 需求终稿开始 ---\n{}\n--- 需求终稿结束 ---",
        requirement_file.display(),
        content.trim(),
    ))
}

/// 渲染最终落盘的 requirements.md。
///
/// 结构：元数据头 + 调用方提供的定稿内容。后端不解析/重组内容，
/// 格式由调用方（Agent 按 skill 约束 / 直接模式原始描述）决定。
fn render_finalized_markdown(
    title: &str,
    skill_id: &str,
    session_id: Option<&str>,
    creation_mode: &str,
    body_markdown: &str,
) -> String {
    let mut output = String::new();
    output.push_str("# ");
    output.push_str(title.trim());
    output.push_str("\n\n");
    output.push_str("- 需求稿类型：任务流程生成终稿\n");
    output.push_str("- 驱动技能：");
    output.push_str(skill_id);
    output.push('\n');
    output.push_str("- 创建模式：");
    output.push_str(creation_mode);
    output.push('\n');
    if let Some(session_id) = session_id {
        output.push_str("- 来源阶段会话：");
        output.push_str(session_id);
        output.push('\n');
    }
    output.push_str("\n## 定稿内容\n\n");
    output.push_str(body_markdown.trim());
    output.push('\n');
    output
}

fn derive_title_from_markdown(markdown: &str) -> Option<String> {
    // 优先从 markdown 一级标题提取；否则取第一行非空文本。
    for line in markdown.lines() {
        let trimmed = line.trim();
        if let Some(stripped) = trimmed.strip_prefix("# ") {
            let title = stripped.trim();
            if !title.is_empty() {
                return Some(truncate_title(title));
            }
        }
        if !trimmed.is_empty() && !trimmed.starts_with('-') {
            return Some(truncate_title(trimmed));
        }
    }
    None
}

fn truncate_title(value: &str) -> String {
    let mut title = value.replace(['\r', '\n', '\t'], " ");
    title.truncate(40);
    title
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
            "jishu-task-planner",
            "requirements",
            Some("Demo task"),
        )
        .unwrap();
        attach_graph(&project_root, &instance.task_id, "graph-1").unwrap();

        let updated = mark_task_stage_session(
            &project_root,
            Some(&instance.task_id),
            "planning-session",
            "jishu-task-planner",
            "planning",
            None,
        )
        .unwrap();

        assert_eq!(updated.status, STATUS_GRAPH_CREATED);
        assert_eq!(updated.current_phase, "execution");
        assert_eq!(updated.planning_session_id.as_deref(), Some("planning-session"));

        let _ = std::fs::remove_dir_all(&project);
    }
}
