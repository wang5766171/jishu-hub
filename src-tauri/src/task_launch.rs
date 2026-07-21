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

        if current_version == 0 {
            // v0（全新库）：drop 重建。
            conn.execute_batch("DROP TABLE IF EXISTS task_instance;")
                .map_err(|e| e.to_string())?;
        } else if current_version == 1 {
            // v1 → v2：增量迁移，新增 last_launch_key 列。
            conn.execute_batch("ALTER TABLE task_instance ADD COLUMN last_launch_key TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // current_version == 2：无需迁移。

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
                last_launch_key          TEXT,
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
            last_launch_key: row.get("last_launch_key")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    const SELECT_COLUMNS: &'static str = "task_id, project_root, title, skill_id, planner_agent_id,
                status, current_phase, requirement_file, requirement_session_id,
                planning_session_id, graph_id, active_run_id, last_run_id, run_status,
                last_launch_key, created_at, updated_at";

    fn list_by_project(&self, project_root: &str) -> Result<Vec<TaskLaunchInstance>, String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        let normalized_root = normalize_project_root(project_root);
        let sql = format!(
            "SELECT {} FROM task_instance WHERE project_root = ?1 ORDER BY updated_at DESC",
            Self::SELECT_COLUMNS
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![normalized_root], Self::row_to_instance)
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
                graph_id, active_run_id, last_run_id, run_status, last_launch_key,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
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
                last_launch_key = excluded.last_launch_key,
                updated_at = excluded.updated_at",
            params![
                instance.task_id,
                normalize_project_root(&instance.project_root),
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
                instance.last_launch_key,
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

pub fn planning_instruction_for_instance(
    project_root: &str,
    task_id: &str,
) -> Result<String, String> {
    let store = open_store(project_root)?;
    let instance = store
        .get(task_id)?
        .ok_or_else(|| format!("task instance not found: {task_id}"))?;
    let requirement_file = instance
        .requirement_file
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("task instance has no requirement file: {task_id}"))?;

    build_planning_instruction_from_requirement(Path::new(requirement_file))
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
        last_launch_key: None,
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
        last_launch_key: None,
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
        last_launch_key: None,
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

// ─── Conductor 桥接（Phase 2：Hub 任务实例对接）───

/// Conductor 阶段同步请求（由扩展通过 hub_invoke 桥接调用）。
///
/// 设计依据：`jishu-task-conductor_实施计划.md` Phase 2 任务 2.1。
/// Conductor 阶段变化时同步 TaskInstance，消除双状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConductorSyncPhaseRequest {
    pub task_id: String,
    pub project_root: String,
    /// 目标阶段（Conductor 视角）："discuss" | "plan" | "execute" | "done"。
    pub phase: String,
    pub domain: String,
    /// 产物路径（可选，阶段提交时携带）。
    pub artifacts: Option<ConductorSyncArtifacts>,
    /// 乐观并发：Conductor 期望的当前阶段。不匹配则拒绝（保护事实权威）。
    pub expected_phase: Option<String>,
    /// 产物内容哈希（sha256:hex 格式），用于校验 manifest 完整性。
    pub artifact_hash: Option<String>,
    /// 任务标题（首次创建时使用）。
    pub title: Option<String>,
    /// 来源会话 id（追溯用）。
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConductorSyncArtifacts {
    pub requirements: Option<String>,
    pub flow_plan_json: Option<String>,
    pub flow_plan_md: Option<String>,
}

/// Conductor 阶段同步结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConductorSyncPhaseResult {
    pub success: bool,
    pub instance: TaskLaunchInstance,
    pub error: Option<String>,
}

/// Conductor 加载任务状态结果（session_start 校正用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConductorLoadStateResult {
    pub found: bool,
    pub instance: Option<TaskLaunchInstance>,
}

/// 校验 Conductor 阶段转换是否合法。
///
/// 合法转换：discuss→plan, plan→execute, execute→done。
/// 首次创建时允许 idle→discuss。
fn is_legal_conductor_transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("idle", "discuss") | ("discuss", "plan") | ("plan", "execute") | ("execute", "done")
    )
}

/// 校验 planning manifest 与提案文件的真实内容哈希。
fn verify_artifact_hash(
    project_root: &str,
    task_id: &str,
    artifact_subdir: &str,
    artifact_filename: &str,
    proposal_path: &str,
    expected_hash: &str,
) -> Result<(), String> {
    let artifact_dir = task_workspace_root(project_root)
        .join(task_id)
        .join("artifacts")
        .join(artifact_subdir);
    let expected_proposal_path = artifact_dir.join(artifact_filename);
    let supplied_proposal_path = PathBuf::from(proposal_path);
    if normalize_lexical_path(&supplied_proposal_path)
        != normalize_lexical_path(&expected_proposal_path)
    {
        return Err(format!(
            "产物路径不在任务命名空间: {}",
            supplied_proposal_path.display()
        ));
    }
    let manifest_path = artifact_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!("产物 manifest 不存在: {}", manifest_path.display()));
    }
    let content =
        std::fs::read_to_string(&manifest_path).map_err(|e| format!("读取 manifest 失败: {e}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("manifest JSON 解析失败: {e}"))?;
    let stored_hash = manifest
        .get("content_hash")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if stored_hash != expected_hash {
        return Err(format!(
            "产物哈希校验失败: manifest={stored_hash}, expected={expected_hash}"
        ));
    }
    let proposal = std::fs::read(&expected_proposal_path)
        .map_err(|e| format!("读取产物失败 ({}): {e}", expected_proposal_path.display()))?;
    let actual_hash = format!("sha256:{:x}", Sha256::digest(&proposal));
    if actual_hash != expected_hash {
        return Err(format!(
            "产物内容哈希校验失败: actual={actual_hash}, expected={expected_hash}"
        ));
    }
    Ok(())
}

/// Conductor 阶段同步：校验 + 更新 TaskInstance。
///
/// 设计依据：`jishu-task-conductor_实施计划.md` Phase 2 任务 2.1/2.5。
/// - 校验合法状态转换 + expectedPhase 乐观并发 + artifact hash 完整性
/// - TaskInstance 不存在时自动创建（任务 2.5）
/// - 非法转换/校验失败 → 拒绝（保护事实权威）
pub fn conductor_sync_phase(
    request: ConductorSyncPhaseRequest,
) -> Result<ConductorSyncPhaseResult, String> {
    let ConductorSyncPhaseRequest {
        task_id,
        project_root,
        phase,
        domain,
        artifacts,
        expected_phase,
        artifact_hash,
        title,
        session_id,
    } = request;

    let store = open_store(&project_root)?;
    let now = now_ms();
    let existing = store.get(&task_id)?;

    // 确定当前阶段（用于转换校验）
    let current_conductor_phase = if let Some(ref inst) = existing {
        // 从 TaskInstance 的 current_phase 反推 Conductor 阶段
        match inst.current_phase.as_str() {
            "requirements" => {
                if inst.status == STATUS_REQUIREMENTS_DISCUSSING {
                    "discuss"
                } else {
                    "discuss" // requirements_finalized 仍属 discuss→plan 过渡
                }
            }
            "planning" => "plan",
            "execution" => {
                if inst.run_status.as_deref() == Some(RUN_STATUS_COMPLETED) {
                    "done"
                } else {
                    "execute"
                }
            }
            _ => "idle",
        }
    } else {
        "idle"
    };

    // 乐观并发校验：expected_phase 不匹配则拒绝
    if let Some(ref expected) = expected_phase {
        if expected != current_conductor_phase {
            return Ok(ConductorSyncPhaseResult {
                success: false,
                instance: existing.unwrap_or_else(|| TaskLaunchInstance {
                    task_id: task_id.clone(),
                    project_root: project_root.clone(),
                    title: title.clone().unwrap_or_else(|| "新任务".into()),
                    skill_id: format!("jishu-conductor-{domain}"),
                    planner_agent_id: "jishu_agent".into(),
                    status: STATUS_REQUIREMENTS_DISCUSSING.into(),
                    current_phase: "requirements".into(),
                    requirement_file: None,
                    requirement_session_id: None,
                    planning_session_id: None,
                    graph_id: None,
                    active_run_id: None,
                    last_run_id: None,
                    run_status: None,
                    last_launch_key: None,
                    created_at: now,
                    updated_at: now,
                }),
                error: Some(format!(
                    "乐观并发冲突: 期望阶段={expected}, 实际阶段={current_conductor_phase}"
                )),
            });
        }
    }

    // 合法转换校验
    if !is_legal_conductor_transition(current_conductor_phase, &phase) {
        return Ok(ConductorSyncPhaseResult {
            success: false,
            instance: existing.ok_or_else(|| format!("task instance not found: {task_id}"))?,
            error: Some(format!("非法阶段转换: {current_conductor_phase} → {phase}")),
        });
    }

    // 阶段产物必须位于任务命名空间，且 manifest 声明与真实内容 hash 一致。
    if phase == "plan" {
        let hash = artifact_hash
            .as_deref()
            .ok_or("discuss→plan 必须提供 artifact_hash")?;
        let requirement_path = artifacts
            .as_ref()
            .and_then(|value| value.requirements.as_deref())
            .ok_or("discuss→plan 必须提供 requirements")?;
        verify_artifact_hash(
            &project_root,
            &task_id,
            "requirements",
            "REQUIREMENTS.md",
            requirement_path,
            hash,
        )?;
    } else if phase == "execute" {
        let hash = artifact_hash
            .as_deref()
            .ok_or("plan→execute 必须提供 artifact_hash")?;
        let proposal_path = artifacts
            .as_ref()
            .and_then(|value| value.flow_plan_json.as_deref())
            .ok_or("plan→execute 必须提供 flow_plan_json")?;
        verify_artifact_hash(
            &project_root,
            &task_id,
            "planning",
            "flow-plan-proposal.json",
            proposal_path,
            hash,
        )?;
    }

    // 构建/更新 TaskInstance
    let mut instance = existing.unwrap_or_else(|| TaskLaunchInstance {
        task_id: task_id.clone(),
        project_root: project_root.clone(),
        title: title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "新任务".into()),
        skill_id: format!("jishu-conductor-{domain}"),
        planner_agent_id: "jishu_agent".into(),
        status: STATUS_REQUIREMENTS_DISCUSSING.into(),
        current_phase: "requirements".into(),
        requirement_file: None,
        requirement_session_id: None,
        planning_session_id: None,
        graph_id: None,
        active_run_id: None,
        last_run_id: None,
        run_status: None,
        last_launch_key: None,
        created_at: now,
        updated_at: now,
    });

    // 按目标阶段推进状态
    match phase.as_str() {
        "discuss" => {
            instance.current_phase = "requirements".into();
            instance.status = STATUS_REQUIREMENTS_DISCUSSING.into();
            if let Some(ref sid) = session_id {
                instance.requirement_session_id = Some(sid.clone());
            }
        }
        "plan" => {
            instance.current_phase = "planning".into();
            instance.status = STATUS_PLANNING_DISCUSSING.into();
            if let Some(ref arts) = artifacts {
                if let Some(ref req_path) = arts.requirements {
                    instance.requirement_file = Some(req_path.clone());
                }
            }
            if let Some(ref sid) = session_id {
                instance.planning_session_id = Some(sid.clone());
            }
        }
        "execute" => {
            instance.current_phase = "execution".into();
            instance.status = STATUS_GRAPH_CREATED.into();
        }
        "done" => {
            // done 不改 current_phase（保持 execution），只标记完成
            // 在 fallback 模式下无 run_id，用 run_status=completed 标记
            if instance.run_status.is_none() {
                instance.run_status = Some(RUN_STATUS_COMPLETED.into());
            }
        }
        _ => {}
    }

    if let Some(ref t) = title {
        if !t.trim().is_empty() {
            instance.title = t.trim().to_string();
        }
    }
    instance.updated_at = now;
    store.upsert(&instance)?;

    Ok(ConductorSyncPhaseResult {
        success: true,
        instance,
        error: None,
    })
}

/// Conductor 加载任务状态（session_start 时从 Hub 拉取权威状态）。
///
/// 设计依据：`jishu-task-conductor_实施计划.md` Phase 2 任务 2.6。
/// session_start 时先从 Hub 拉取 TaskInstance（phase/status/run_status），
/// 覆盖 appendEntry。冲突时以 TaskInstance 为准。
pub fn conductor_load_task_state(
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

// ── Phase 3+4: Orchestrator 桥接命令 ─────────────────────────────────────────────

/// 提案校验请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidateProposalRequest {
    pub task_id: String,
    pub project_root: String,
    pub proposal_path: String,
}

/// 提案校验结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidateProposalResult {
    pub graph_id: String,
    pub revision_id: String,
    pub content_hash: String,
}

/// 校验 flow-plan-proposal.json 并创建 TaskGraph + GraphRevision。
///
/// 流程：
/// 1. 读取 proposal JSON，解析 `jishu-flow-plan-proposal/v1` schema
/// 2. 构建 GraphSnapshot（Goal + Executable nodes + edges）
/// 3. graph_validate 校验 DAG 完整性
/// 4. 创建 TaskGraph + 初始 GraphRevision（写入 orchestrator taskstore.db）
/// 5. 更新 TaskInstance.graph_id
/// 6. 更新 planning/manifest.json 的 linked_revision_id
pub fn orchestrator_validate_proposal(
    req: ValidateProposalRequest,
) -> Result<ValidateProposalResult, String> {
    use crate::orchestrator::{
        default_db_path, graph_validate, EdgeKind, ExecutablePayload, GraphEdge, GraphNode,
        GraphRevision, GraphSnapshot, NodeKind, RoleRequirement, TaskGraph, TaskStore,
    };
    use crate::util::gen_id;

    // 1. 读取 proposal
    let proposal_raw = std::fs::read_to_string(&req.proposal_path)
        .map_err(|e| format!("read proposal failed: {e}"))?;
    let proposal: serde_json::Value = serde_json::from_str(&proposal_raw)
        .map_err(|e| format!("parse proposal JSON failed: {e}"))?;

    let schema = proposal
        .get("schema")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if schema != "jishu-flow-plan-proposal/v1" {
        return Err(format!("unsupported proposal schema: {schema}"));
    }

    let goal_text = proposal
        .get("goal")
        .and_then(|v| v.as_str())
        .unwrap_or("Task goal")
        .to_string();
    let nodes_arr = proposal
        .get("nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "proposal missing 'nodes' array".to_string())?;

    // 2. 构建 GraphSnapshot
    let mut snapshot_nodes: Vec<GraphNode> = Vec::new();
    let mut snapshot_edges: Vec<GraphEdge> = Vec::new();

    // Goal 节点
    snapshot_nodes.push(GraphNode {
        node_id: "goal".to_string(),
        parent_id: None,
        title: goal_text.clone(),
        description: Some(goal_text.clone()),
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
    });

    // 解析 proposal nodes → Executable 节点
    let mut node_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for node_val in nodes_arr {
        let node_id = node_val
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "proposal node missing 'id'".to_string())?
            .to_string();
        if !node_ids.insert(node_id.clone()) {
            return Err(format!("duplicate node id: {node_id}"));
        }
        let title = node_val
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or(&node_id)
            .to_string();
        let responsibility = node_val
            .get("responsibility")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let role = node_val
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("developer")
            .to_string();

        snapshot_nodes.push(GraphNode {
            node_id: node_id.clone(),
            parent_id: Some("goal".to_string()),
            title,
            description: Some(responsibility.clone()),
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: Some(RoleRequirement {
                role_id: role.clone(),
                responsibility: responsibility.clone(),
                required_capabilities: vec![],
                preferred_capabilities: vec![],
            }),
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: Default::default(),
            executable_payload: Some(ExecutablePayload::Dispatch {
                role_id: role,
                prompt: responsibility,
                project: None,
                session: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        });
    }

    // 解析 depends_on → edges
    let mut edge_counter = 0u32;
    for node_val in nodes_arr {
        let node_id = node_val.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(deps) = node_val.get("depends_on").and_then(|v| v.as_array()) {
            for dep in deps {
                let dep_id = dep.as_str().unwrap_or("");
                if !node_ids.contains(dep_id) {
                    return Err(format!(
                        "node '{node_id}' depends on unknown node '{dep_id}'"
                    ));
                }
                edge_counter += 1;
                snapshot_edges.push(GraphEdge {
                    edge_id: format!("e{edge_counter}"),
                    source_node_id: dep_id.to_string(),
                    target_node_id: node_id.to_string(),
                    kind: EdgeKind::ControlDependency,
                });
            }
        }
    }

    let snapshot = GraphSnapshot {
        nodes: snapshot_nodes,
        edges: snapshot_edges,
    };

    // 3. 校验 DAG
    let _warnings =
        graph_validate(&snapshot).map_err(|e| format!("graph validation failed: {e:?}"))?;

    // 4. 创建 TaskGraph + GraphRevision
    let db_path = default_db_path();
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create db dir failed: {e}"))?;
    }
    let store =
        TaskStore::open(&db_path).map_err(|e| format!("open orchestrator store failed: {e}"))?;

    let now = now_ms();
    let graph_id = gen_id("graph");
    let revision_id = gen_id("rev");

    let graph = TaskGraph {
        graph_id: graph_id.clone(),
        title: goal_text.clone(),
        goal: goal_text,
        project_root: PathBuf::from(&req.project_root),
        owner: "conductor".to_string(),
        current_draft_revision: Some(revision_id.clone()),
        created_at: now,
        updated_at: now,
    };

    let mut revision =
        GraphRevision::from_snapshot(&revision_id, &graph_id, None, &snapshot, "conductor", now)
            .map_err(|e| format!("create revision failed: {e}"))?;
    revision.change_summary = "Created from flow-plan-proposal".to_string();
    revision
        .refresh_content_hash()
        .map_err(|e| format!("refresh content hash failed: {e}"))?;

    store
        .create_graph_with_revision(&graph, &revision)
        .map_err(|e| format!("persist graph+revision failed: {e}"))?;

    // 5. 更新 TaskInstance.graph_id（仅写 graph_id，不推进 phase/status，阶段推进由 syncHubPhase 负责）
    let ti_store = open_store(&req.project_root)?;
    if let Some(mut instance) = ti_store.get(&req.task_id)? {
        instance.graph_id = Some(graph_id.clone());
        instance.updated_at = now_ms();
        ti_store.upsert(&instance)?;
    }

    // 6. 更新 planning/manifest.json 的 linked_revision_id
    let manifest_path = task_workspace_root(&req.project_root)
        .join(&req.task_id)
        .join("artifacts")
        .join("planning")
        .join("manifest.json");
    if manifest_path.exists() {
        if let Ok(manifest_raw) = std::fs::read_to_string(&manifest_path) {
            if let Ok(mut manifest) = serde_json::from_str::<serde_json::Value>(&manifest_raw) {
                manifest["linked_revision_id"] = serde_json::Value::String(revision_id.clone());
                let _ = std::fs::write(
                    &manifest_path,
                    serde_json::to_string_pretty(&manifest).unwrap_or_default(),
                );
            }
        }
    }

    Ok(ValidateProposalResult {
        graph_id,
        revision_id,
        content_hash: revision.content_hash.0.clone(),
    })
}

/// 启动执行运行请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartRunFromRevisionRequest {
    pub task_id: String,
    pub project_root: String,
    pub idempotency_key: String,
}

/// 启动执行运行结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartRunFromRevisionResult {
    pub status: String,
    pub run_id: String,
    pub graph_id: String,
    pub revision_id: String,
}

/// 从 manifest 中读取 linked_revision_id 并启动 GraphRun。
///
/// 幂等约束：同一 idempotency_key 不会重复创建 run。
pub fn orchestrator_start_run_from_revision(
    req: StartRunFromRevisionRequest,
) -> Result<StartRunFromRevisionResult, String> {
    use crate::orchestrator::events::payloads;
    use crate::orchestrator::{
        build_event, default_db_path, BudgetState, GraphRun, RunPlanningSnapshot, RunStatus,
        TaskEventType, TaskStore,
    };
    use crate::util::gen_id;

    // 1. 读取 manifest 获取 linked_revision_id + content_hash
    let manifest_path = task_workspace_root(&req.project_root)
        .join(&req.task_id)
        .join("artifacts")
        .join("planning")
        .join("manifest.json");
    let manifest_raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read manifest failed: {e}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_raw).map_err(|e| format!("parse manifest failed: {e}"))?;

    let revision_id = manifest
        .get("linked_revision_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "manifest missing linked_revision_id".to_string())?;
    let expected_hash = manifest
        .get("content_hash")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // 2. 幂等检查：已有活跃 run 且 key 相同 → 返回现有 run_id
    let ti_store = open_store(&req.project_root)?;
    let instance = ti_store
        .get(&req.task_id)?
        .ok_or_else(|| format!("task instance not found: {}", req.task_id))?;

    if let (Some(active_run), Some(last_key)) = (&instance.active_run_id, &instance.last_launch_key)
    {
        if *last_key == req.idempotency_key {
            // 幂等：返回已有 run
            let graph_id = instance.graph_id.clone().unwrap_or_default();
            return Ok(StartRunFromRevisionResult {
                status: "already_running".to_string(),
                run_id: active_run.clone(),
                graph_id,
                revision_id: revision_id.to_string(),
            });
        }
    }

    // 3. 打开 orchestrator store，校验 revision 存在
    let db_path = default_db_path();
    let store =
        TaskStore::open(&db_path).map_err(|e| format!("open orchestrator store failed: {e}"))?;

    let revision = store
        .get_revision(revision_id)
        .map_err(|e| format!("get revision failed: {e}"))?;

    // 校验 manifest 完整性（评审 P1）：重读提案文件，验证其哈希与 manifest.content_hash 一致。
    // 注意：manifest.content_hash 是提案 JSON 文件的哈希，与 revision.content_hash（图快照哈希）无关。
    if !expected_hash.is_empty() {
        if let Some(dir) = manifest_path.parent() {
            let proposal_path = dir.join("flow-plan-proposal.json");
            if let Ok(proposal_raw) = std::fs::read_to_string(&proposal_path) {
                let actual_hash = format!("sha256:{:x}", Sha256::digest(proposal_raw.as_bytes()));
                if actual_hash != expected_hash {
                    return Err(format!(
                        "proposal file tampered: manifest={expected_hash}, actual={actual_hash}"
                    ));
                }
            }
        }
    }

    let graph_id = revision.graph_id.clone();

    // 4. 创建 GraphRun（status=Running）
    let run_id = gen_id("run");
    let now = now_ms();
    let snapshot = revision
        .snapshot()
        .map_err(|e| format!("deserialize revision snapshot failed: {e}"))?;
    let planning_snapshot = RunPlanningSnapshot {
        revision_content_hash: revision.content_hash.0.clone(),
        skill_refs: revision.skill_refs.clone(),
        template_refs: revision.template_refs.clone(),
        planner_policy_refs: revision.planner_policy_refs.clone(),
        node_policies: snapshot
            .nodes
            .into_iter()
            .map(|node| (node.node_id, node.policy))
            .collect(),
    };

    let run = GraphRun {
        run_id: run_id.clone(),
        graph_id: graph_id.clone(),
        active_revision_id: revision_id.to_string(),
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: BudgetState::default(),
        planning_snapshot,
        started_at: now,
        finished_at: None,
    };

    let event = build_event(
        gen_id("evt"),
        &run_id,
        1,
        TaskEventType::RunStarted,
        "conductor",
        now,
        serde_json::to_value(&payloads::RunStartedPayload {
            run_id: run_id.clone(),
            graph_id: graph_id.clone(),
            revision_id: revision_id.to_string(),
            initial_status: RunStatus::Running,
            budget_state: BudgetState::default(),
        })
        .map_err(|e| format!("serialize event payload failed: {e}"))?,
    );

    store
        .create_run_with_event(&run, &event)
        .map_err(|e| format!("create run failed: {e}"))?;

    // 5. 更新 TaskInstance
    let mut updated = instance;
    updated.active_run_id = Some(run_id.clone());
    updated.last_run_id = Some(run_id.clone());
    updated.run_status = Some(RUN_STATUS_RUNNING.to_string());
    updated.current_phase = "execution".to_string();
    updated.status = STATUS_GRAPH_CREATED.to_string();
    updated.last_launch_key = Some(req.idempotency_key);
    updated.updated_at = now;
    ti_store.upsert(&updated)?;

    Ok(StartRunFromRevisionResult {
        status: "started".to_string(),
        run_id,
        graph_id,
        revision_id: revision_id.to_string(),
    })
}

/// UI 执行工作台手动启动 run 的请求（显式指定最新 revision，不依赖 manifest）。
///
/// 与 [`orchestrator_start_run_from_revision`] 的区别：用户在执行工作台按节点选智能体后
/// 会生成新 revision，此处直接用 UI 传入的最新 revision_id 启动，避免 manifest 滞后。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLaunchStartRunRequest {
    pub task_id: String,
    pub project_root: String,
    pub revision_id: String,
    pub idempotency_key: String,
}

/// UI 执行工作台手动启动 run：在指定 revision 上创建 GraphRun 并同步更新 TaskInstance。
pub fn task_launch_start_run(
    req: TaskLaunchStartRunRequest,
) -> Result<StartRunFromRevisionResult, String> {
    use crate::orchestrator::events::payloads;
    use crate::orchestrator::{
        build_event, default_db_path, BudgetState, GraphRun, RunPlanningSnapshot, RunStatus,
        TaskEventType, TaskStore,
    };
    use crate::util::gen_id;

    // 1. 幂等检查：已有活跃 run 且 key 相同 → 返回现有 run_id
    let ti_store = open_store(&req.project_root)?;
    let instance = ti_store
        .get(&req.task_id)?
        .ok_or_else(|| format!("task instance not found: {}", req.task_id))?;

    if let (Some(active_run), Some(last_key)) = (&instance.active_run_id, &instance.last_launch_key)
    {
        if *last_key == req.idempotency_key {
            let graph_id = instance.graph_id.clone().unwrap_or_default();
            return Ok(StartRunFromRevisionResult {
                status: "already_running".to_string(),
                run_id: active_run.clone(),
                graph_id,
                revision_id: req.revision_id.clone(),
            });
        }
    }

    // 2. 打开 orchestrator store，校验 revision 存在
    let db_path = default_db_path();
    let store =
        TaskStore::open(&db_path).map_err(|e| format!("open orchestrator store failed: {e}"))?;

    let revision = store
        .get_revision(&req.revision_id)
        .map_err(|e| format!("get revision failed: {e}"))?;
    let graph_id = revision.graph_id.clone();

    // 3. 创建 GraphRun（status=Running）
    let run_id = gen_id("run");
    let now = now_ms();
    let snapshot = revision
        .snapshot()
        .map_err(|e| format!("deserialize revision snapshot failed: {e}"))?;
    let planning_snapshot = RunPlanningSnapshot {
        revision_content_hash: revision.content_hash.0.clone(),
        skill_refs: revision.skill_refs.clone(),
        template_refs: revision.template_refs.clone(),
        planner_policy_refs: revision.planner_policy_refs.clone(),
        node_policies: snapshot
            .nodes
            .into_iter()
            .map(|node| (node.node_id, node.policy))
            .collect(),
    };

    let run = GraphRun {
        run_id: run_id.clone(),
        graph_id: graph_id.clone(),
        active_revision_id: req.revision_id.clone(),
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: BudgetState::default(),
        planning_snapshot,
        started_at: now,
        finished_at: None,
    };

    let event = build_event(
        gen_id("evt"),
        &run_id,
        1,
        TaskEventType::RunStarted,
        "ui_workbench",
        now,
        serde_json::to_value(&payloads::RunStartedPayload {
            run_id: run_id.clone(),
            graph_id: graph_id.clone(),
            revision_id: req.revision_id.clone(),
            initial_status: RunStatus::Running,
            budget_state: BudgetState::default(),
        })
        .map_err(|e| format!("serialize event payload failed: {e}"))?,
    );

    store
        .create_run_with_event(&run, &event)
        .map_err(|e| format!("create run failed: {e}"))?;

    // 4. 更新 TaskInstance
    let mut updated = instance;
    updated.active_run_id = Some(run_id.clone());
    updated.last_run_id = Some(run_id.clone());
    updated.run_status = Some(RUN_STATUS_RUNNING.to_string());
    updated.current_phase = "execution".to_string();
    updated.status = STATUS_GRAPH_CREATED.to_string();
    updated.last_launch_key = Some(req.idempotency_key);
    updated.updated_at = now;
    ti_store.upsert(&updated)?;

    Ok(StartRunFromRevisionResult {
        status: "started".to_string(),
        run_id,
        graph_id,
        revision_id: req.revision_id,
    })
}

/// 完成态投影：将 run 终态同步到 TaskInstance。
///
/// 由 engine 的 finish_run 钩子调用。失败只 warn 不阻塞 engine。
pub fn sync_run_status_to_task_instance(
    project_root: &str,
    run_id: &str,
    final_status: &str,
) -> Result<(), String> {
    let store = open_store(project_root)?;
    // 按 active_run_id 查找 TaskInstance
    let instances = store.list_by_project(project_root)?;
    let Some(mut instance) = instances
        .into_iter()
        .find(|i| i.active_run_id.as_deref() == Some(run_id))
    else {
        // 没有匹配的 instance，可能已被清理，静默返回
        return Ok(());
    };

    instance.run_status = Some(final_status.to_string());
    instance.last_run_id = Some(run_id.to_string());
    instance.active_run_id = None;
    instance.updated_at = now_ms();
    store.upsert(&instance)?;
    Ok(())
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
