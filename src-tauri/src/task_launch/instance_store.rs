use super::*;

/// 进程内串行化「打开 + 迁移」（评审修复轮 R3 / P2-3）。
///
/// 同一个库文件的初始化只能做一次。库的建表 / 升级靠 SQLite 自己的写锁排队
///（见 [`TaskInstanceStore::migrate_schema`]）；但把日志模式切成 WAL 这一步
/// 要独占文件、**不等锁**——SQLite 文档里它就不走忙等回调。几个线程同时首开
/// 一个还没切到 WAL 的库（新项目第一次用、或升级后头几秒任务列表、开关读写、
/// 扩展的查询一起开它），后到的直接报「库被锁」。所以打开这一小段在进程内
/// 排队：先到的把文件初始化好，后到的进来时一切都已就绪。只覆盖「打开 + 迁
/// 程」这几毫秒，之后各连接各走各的。
static OPEN_SERIAL: Mutex<()> = Mutex::new(());

/// 测试用：把 v4 → v5 迁移里「看完列、还没 ALTER」的窗口撑开（毫秒；0 = 不撑）。
/// 并发首开的用例靠它确定性地撞上「两个线程都看到还没有这一列」；生产代码里
/// 恒为 0，不产生任何等待。
#[cfg(test)]
pub(super) static MIGRATION_RACE_WINDOW_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
fn widen_migration_race_window_for_test() {
    let millis = MIGRATION_RACE_WINDOW_MS.load(std::sync::atomic::Ordering::Relaxed);
    if millis > 0 {
        std::thread::sleep(std::time::Duration::from_millis(millis));
    }
}

#[cfg(not(test))]
fn widen_migration_race_window_for_test() {}

pub struct TaskInstanceStore {
    writer: Mutex<Connection>,
    #[allow(dead_code)]
    db_path: PathBuf,
}

impl TaskInstanceStore {
    /// 打开（或创建）指定路径的任务实例库。写路径用——库不在就建。
    pub fn open(db_path: &Path) -> Result<Self, String> {
        Self::open_at(db_path, false)?
            .ok_or_else(|| format!("任务实例库未能创建：{}", db_path.display()))
    }

    /// 只读路径用：库不在就当「这个项目还没有任务」，不建库、不建目录。
    /// 返回 None = 库文件不存在。
    ///
    /// v0.9.8 评审修复轮 R3（P2-5）：此前查「某会话是不是任务会话」也走会建库
    /// 的打开方式——每选中一个普通会话，就给它所在的项目多出一个空的任务实
    /// 例库文件（连 WAL）。没有证据就不该落盘。
    pub fn open_existing(db_path: &Path) -> Result<Option<Self>, String> {
        Self::open_at(db_path, true)
    }

    fn open_at(db_path: &Path, existing_only: bool) -> Result<Option<Self>, String> {
        // 进程内排队（见 OPEN_SERIAL）。「库在不在」也在锁内判断：排在前面的那
        // 一个可能正好把库建出来。
        let _serial = OPEN_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        if existing_only && !db_path.is_file() {
            return Ok(None);
        }
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        let step = |what: &str, e: rusqlite::Error| format!("任务实例库打开失败（{what}）：{e}");
        // 切 WAL 要独占文件、不等锁：只有在进程内排队（OPEN_SERIAL）的保护下
        // 做才安全——别的线程此刻不会同时打开这个文件。等锁期限仍在最前面设，
        // 后面的迁移拿写锁靠它排队。
        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(|e| step("设置等锁期限", e))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| step("切换日志模式", e))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| step("设置同步级别", e))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| step("开启外键", e))?;
        Self::migrate_schema(&conn)?;
        Ok(Some(Self {
            writer: Mutex::new(conn),
            db_path: db_path.to_path_buf(),
        }))
    }

    /// 建表 / 迁移到当前版本。整个迁移在一个写事务里：先拿写锁，再在锁内读
    /// 版本、看列、升级。
    ///
    /// v0.9.8 评审修复轮 R3（P2-3）：此前是「读版本 → 查有没有 no_ask 列 →
    /// ALTER → 写 user_version」各走各的，没有事务也没有重查。升级后第一次，
    /// 两个线程同时首开同一个库（任务列表、开关读写、扩展的查询都会开它），
    /// 后到的那个 ALTER 会撞上「列已存在」，这一次调用失败。与账本的迁移同一
    /// 个做法：拿锁之后再读一遍，后到的在锁内看到已是 v5，直接跳过。
    ///
    /// 进程内的并发由 [`OPEN_SERIAL`] 整段排队；这一层管的是跨进程（命令行与
    /// 界面同时首开）与「绕过排队直接拿到连接」的调用方。
    pub(super) fn migrate_schema(conn: &Connection) -> Result<(), String> {
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| format!("任务实例库迁移拿写锁失败：{e}"))?;
        match Self::migrate_schema_locked(conn) {
            Ok(()) => conn.execute_batch("COMMIT;").map_err(|e| e.to_string()),
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

    /// 迁移的正文——调用方已持有写锁，版本与列都在锁内读。
    fn migrate_schema_locked(conn: &Connection) -> Result<(), String> {
        let current_version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;

        let exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_instance'")
            .map_err(|e| e.to_string())?
            .exists([])
            .map_err(|e| e.to_string())?;

        // v0.9.8 需求22（评审修复轮 R2）：v4 → v5 是纯加列（no_ask）。任务是
        // 长期数据（常常跨天），这一步**原地升级**，不走下面的 DROP 重建。
        if exists && current_version == TASK_INSTANCE_SCHEMA_VERSION - 1 {
            let has_no_ask: bool = conn
                .prepare("SELECT 1 FROM pragma_table_info('task_instance') WHERE name = 'no_ask'")
                .map_err(|e| e.to_string())?
                .exists([])
                .map_err(|e| e.to_string())?;
            if !has_no_ask {
                widen_migration_race_window_for_test();
                conn.execute_batch(
                    "ALTER TABLE task_instance ADD COLUMN no_ask INTEGER NOT NULL DEFAULT 0;",
                )
                .map_err(|e| e.to_string())?;
            }
        } else if current_version != TASK_INSTANCE_SCHEMA_VERSION {
            // v0.9.7 需求2 C2（P1-4b 修复）：DROP 条件从「仅全新库」扩为
            // **版本不等即 DROP 重建**（对齐 orchestrator 侧语义；不做跨版本
            // 迁移——B3 既定约定）。重建前 .bak 备份。
            if exists && current_version > 0 {
                // 与 orchestrator 同款：备份旧库文件由调用方 db_path 处理不可行
                //（此处只有连接）——表级备份为 .bak 表，保底可追溯。
                let backup = format!("task_instance_v{current_version}_bak");
                conn.execute_batch(&format!(
                    "DROP TABLE IF EXISTS {backup}; ALTER TABLE task_instance RENAME TO {backup};"
                ))
                .map_err(|e| e.to_string())?;
                log::warn!(
                    "[task-instance] schema v{current_version} → v{TASK_INSTANCE_SCHEMA_VERSION}：旧表保留为 {backup}"
                );
            }
            conn.execute_batch("DROP TABLE IF EXISTS task_instance;")
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
                status                   TEXT NOT NULL DEFAULT 'active',
                task_session_id          TEXT,
                graph_id                 TEXT,
                active_run_id            TEXT,
                last_run_id              TEXT,
                run_status               TEXT,
                last_launch_key          TEXT,
                stages_json              TEXT,
                no_ask                   INTEGER NOT NULL DEFAULT 0,
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
            task_session_id: row.get("task_session_id")?,
            graph_id: row.get("graph_id")?,
            active_run_id: row.get("active_run_id")?,
            last_run_id: row.get("last_run_id")?,
            run_status: row.get("run_status")?,
            last_launch_key: row.get("last_launch_key")?,
            stages_json: row.get("stages_json")?,
            no_ask: row.get("no_ask")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    const SELECT_COLUMNS: &'static str = "task_id, project_root, title, skill_id, planner_agent_id,
                status, task_session_id, graph_id, active_run_id, last_run_id, run_status,
                last_launch_key, stages_json, no_ask, created_at, updated_at";

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

    /// 按图找任务实例（v0.9.8 需求22：节点会话经编排库定位到图之后走这里）。
    /// 一张图最多绑定一个任务实例；没有 → `Ok(None)`。
    pub(super) fn by_graph_id(&self, graph_id: &str) -> Result<Option<TaskLaunchInstance>, String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        let sql = format!(
            "SELECT {} FROM task_instance WHERE graph_id = ?1 LIMIT 1",
            Self::SELECT_COLUMNS
        );
        conn.query_row(&sql, params![graph_id], Self::row_to_instance)
            .optional()
            .map_err(|e| e.to_string())
    }

    /// v0.9.8 需求22：只改「不询问」开关，其余字段不动。
    ///
    /// 不动 `updated_at`（评审修复轮 R3 / P2-4）：任务列表按它倒序，点一下开关
    /// 不该让任务跳到最前。
    pub(super) fn set_no_ask(&self, task_id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE task_instance SET no_ask = ?2 WHERE task_id = ?1",
                params![task_id, enabled as i64],
            )
            .map_err(|e| e.to_string())?;
        if affected == 0 {
            return Err(format!("task instance not found: {task_id}"));
        }
        Ok(())
    }

    /// 只改任务挂的会话键（评审修复轮 R3 / P1-1：登记先于首条 prompt，解析出
    /// 真实会话号后再改绑）。`None` = 这个任务当前没有会话。
    pub(super) fn set_session_id(
        &self,
        task_id: &str,
        session_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE task_instance SET task_session_id = ?2 WHERE task_id = ?1",
                params![task_id, session_id],
            )
            .map_err(|e| e.to_string())?;
        if affected == 0 {
            return Err(format!("task instance not found: {task_id}"));
        }
        Ok(())
    }

    pub(super) fn upsert(&self, instance: &TaskLaunchInstance) -> Result<(), String> {
        let conn = self.writer.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO task_instance (
                task_id, project_root, title, skill_id, planner_agent_id, status,
                task_session_id, graph_id, active_run_id, last_run_id, run_status,
                last_launch_key, stages_json, no_ask, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(task_id) DO UPDATE SET
                title = excluded.title,
                skill_id = excluded.skill_id,
                planner_agent_id = excluded.planner_agent_id,
                status = excluded.status,
                task_session_id = excluded.task_session_id,
                graph_id = excluded.graph_id,
                active_run_id = excluded.active_run_id,
                last_run_id = excluded.last_run_id,
                run_status = excluded.run_status,
                last_launch_key = excluded.last_launch_key,
                stages_json = excluded.stages_json,
                no_ask = excluded.no_ask,
                updated_at = excluded.updated_at",
            params![
                instance.task_id,
                normalize_project_root(&instance.project_root),
                instance.title,
                instance.skill_id,
                instance.planner_agent_id,
                instance.status,
                instance.task_session_id,
                instance.graph_id,
                instance.active_run_id,
                instance.last_run_id,
                instance.run_status,
                instance.last_launch_key,
                instance.stages_json,
                instance.no_ask as i64,
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

/// v0.9.7 需求2 C2：标记任务主会话（原 requirement/planning 两列合并为
/// task_session_id——单对话流）。无 phase 语义。
pub fn mark_task_session(
    project_root: &str,
    task_id: Option<&str>,
    session_id: &str,
    skill_id: &str,
    title: Option<&str>,
) -> Result<TaskLaunchInstance, String> {
    if session_id.trim().is_empty() {
        return Err("session_id is required".into());
    }
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
            .unwrap_or(DEFAULT_TASK_TITLE)
            .to_string(),
        skill_id: skill_id.to_string(),
        planner_agent_id: "jishu_agent".into(),
        status: STATUS_ACTIVE.into(),
        task_session_id: None,
        graph_id: None,
        active_run_id: None,
        last_run_id: None,
        run_status: None,
        last_launch_key: None,
        stages_json: None,
        no_ask: false,
        created_at: now,
        updated_at: now,
    });

    instance.skill_id = skill_id.to_string();
    instance.updated_at = now;
    // 需求9 #4 补：mark 时前端传首条 goal（单步任务步骤上报链不触发）——
    // 截 40 字符与 runner_update_steps 的覆盖口径一致；仅默认标题时写
    // （用户重命名不回写，同 runner_update_steps 语义）。
    if let Some(title) = title
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(40).collect::<String>())
    {
        if instance.title == DEFAULT_TASK_TITLE {
            instance.title = title;
        }
    }
    instance.task_session_id = Some(session_id.to_string());

    store.upsert(&instance)?;
    Ok(instance)
}

/// 通过 session_id 查找任务实例（读路径：这个项目还没有任务库时返回 None，
/// 不建库——见 [`TaskInstanceStore::open_existing`]）。
pub fn find_by_session(
    project_root: &str,
    session_id: &str,
) -> Result<Option<TaskLaunchInstance>, String> {
    let Some(store) = open_store_existing(project_root)? else {
        return Ok(None);
    };
    let instances = store.list_by_project(project_root)?;
    Ok(instances
        .into_iter()
        .find(|inst| inst.task_session_id.as_deref() == Some(session_id)))
}

/// v0.9.7 需求2 C2：runner 步骤清单上报（任务卡数据源，stages_json 列）。
/// 需求9 #4：可选 `title`（runner 扩展随步骤上报 goal）——仅当实例标题仍是
/// 建库默认「新任务」时覆盖（用户重命名过的标题不回写）。
/// 成功后由调用方（IPC 层）emit `task-instance-changed`。
pub fn runner_update_steps(
    project_root: &str,
    task_id: &str,
    steps_json: &str,
    title: Option<&str>,
) -> Result<TaskLaunchInstance, String> {
    if steps_json.trim().is_empty() {
        return Err("steps_json is required".into());
    }
    // 形状校验：必须可解析且含 steps 数组（拒绝任意 JSON 塞库）。
    let parsed: serde_json::Value =
        serde_json::from_str(steps_json).map_err(|e| format!("steps_json 解析失败: {e}"))?;
    if !parsed.get("steps").is_some_and(|s| s.is_array()) {
        return Err("steps_json 须为 {\"steps\":[…]} 形状".into());
    }
    let store = open_store(project_root)?;
    let mut instance = store
        .get(task_id)?
        .ok_or_else(|| format!("task instance not found: {task_id}"))?;
    instance.stages_json = Some(steps_json.to_string());
    if let Some(new_title) = title.map(str::trim).filter(|t| !t.is_empty()) {
        if instance.title == DEFAULT_TASK_TITLE {
            instance.title = new_title.chars().take(40).collect();
        }
    }
    instance.updated_at = now_ms();
    store.upsert(&instance)?;
    Ok(instance)
}

/// 将生成的 TaskGraph 绑定到任务实例。
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
        status: STATUS_ACTIVE.into(),
        task_session_id: None,
        graph_id: Some(graph_id.to_string()),
        active_run_id: None,
        last_run_id: None,
        run_status: None,
        last_launch_key: None,
        stages_json: None,
        no_ask: false,
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
