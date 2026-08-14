use super::*;

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

    pub(super) fn list_by_project(
        &self,
        project_root: &str,
    ) -> Result<Vec<TaskLaunchInstance>, String> {
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

    pub(super) fn get(&self, task_id: &str) -> Result<Option<TaskLaunchInstance>, String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        let sql = format!(
            "SELECT {} FROM task_instance WHERE task_id = ?1",
            Self::SELECT_COLUMNS
        );
        conn.query_row(&sql, params![task_id], Self::row_to_instance)
            .optional()
            .map_err(|e| e.to_string())
    }

    pub(super) fn upsert(&self, instance: &TaskLaunchInstance) -> Result<(), String> {
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
