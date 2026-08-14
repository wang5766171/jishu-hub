use super::*;

impl TaskStore {
    pub(super) fn backup_before_migrate(conn: &Connection, db_path: &Path) {
        let current_version: i64 =
            match conn.pragma_query_value(None, "user_version", |row| row.get(0)) {
                Ok(v) => v,
                Err(_) => return,
            };
        if current_version == 0 || current_version == TASK_STORE_SCHEMA_VERSION {
            return;
        }
        // 把 WAL 合并进主库文件，保证备份完整（WAL 模式下部分数据在 -wal 文件）。
        let _ = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE");
        let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let backup = db_path.with_file_name(format!(
            "taskstore.db.v{}-to-v{}.{}.bak",
            current_version, TASK_STORE_SCHEMA_VERSION, ts
        ));
        match std::fs::copy(db_path, &backup) {
            Ok(_) => {
                log::warn!(
                    "taskstore schema 升级 {} → {}：已备份旧库至 {}",
                    current_version,
                    TASK_STORE_SCHEMA_VERSION,
                    backup.display()
                );
                Self::cleanup_old_backups(db_path);
            }
            Err(e) => log::warn!("taskstore 迁移前备份失败 ({})；继续迁移（无备份兜底）", e),
        }
    }

    /// 只保留最近 5 份迁移备份（taskstore.db.v*.bak），避免无限堆积。
    pub(super) fn cleanup_old_backups(db_path: &Path) {
        let dir = match db_path.parent() {
            Some(d) => d,
            None => return,
        };
        let mut backups: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("taskstore.db.v") && name.ends_with(".bak") {
                    let path = entry.path();
                    let mtime = entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    backups.push((path, mtime));
                }
            }
        }
        if backups.len() <= 5 {
            return;
        }
        // 按修改时间倒序，保留最新的 5 份，删除其余。
        backups.sort_by(|a, b| b.1.cmp(&a.1));
        for (path, _) in backups.into_iter().skip(5) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Open an in-memory store for testing.
    /// Uses a unique named in-memory database per call, combining a global counter
    /// with the thread ID so each invocation gets its own isolated database.

    pub(super) fn create_schema(conn: &Connection) -> Result<(), StoreError> {
        let current_version: i64 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current_version != TASK_STORE_SCHEMA_VERSION {
            conn.execute_batch(
                r#"
                DROP TABLE IF EXISTS projection_checkpoint;
                DROP TABLE IF EXISTS wake_timer;
                DROP TABLE IF EXISTS task_interaction_request;
                DROP TABLE IF EXISTS approval_request;
                DROP TABLE IF EXISTS artifact_ref;
                DROP TABLE IF EXISTS task_event;
                DROP TABLE IF EXISTS node_attempt;
                DROP TABLE IF EXISTS node_run;
                DROP TABLE IF EXISTS run_revision_proposal;
                DROP TABLE IF EXISTS graph_run;
                DROP TABLE IF EXISTS graph_revision;
                DROP TABLE IF EXISTS task_graph;
                "#,
            )?;
        }
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_graph (
                graph_id       TEXT PRIMARY KEY,
                title          TEXT NOT NULL,
                goal           TEXT NOT NULL,
                project_root   TEXT NOT NULL,
                owner          TEXT NOT NULL,
                current_draft_revision TEXT,
                created_at     INTEGER NOT NULL,
                updated_at     INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS graph_revision (
                revision_id    TEXT PRIMARY KEY,
                graph_id       TEXT NOT NULL REFERENCES task_graph(graph_id),
                parent_revision_id TEXT,
                schema_version TEXT NOT NULL,
                canonical_snapshot TEXT NOT NULL,
                content_hash   TEXT NOT NULL,
                skill_refs     TEXT DEFAULT '[]',
                template_refs  TEXT DEFAULT '[]',
                planner_policy_refs TEXT DEFAULT '[]',
                change_summary TEXT DEFAULT '',
                author         TEXT NOT NULL,
                created_at     INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_revision_graph
                ON graph_revision(graph_id, created_at);

            CREATE TABLE IF NOT EXISTS graph_run (
                run_id          TEXT PRIMARY KEY,
                graph_id        TEXT NOT NULL REFERENCES task_graph(graph_id),
                active_revision_id TEXT NOT NULL,
                status          TEXT NOT NULL,
                run_seq         INTEGER NOT NULL DEFAULT 0,
                budget_state    TEXT DEFAULT '{}',
                planning_snapshot TEXT NOT NULL DEFAULT '{}',
                started_at      INTEGER NOT NULL,
                finished_at     INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_run_graph ON graph_run(graph_id);

            CREATE TABLE IF NOT EXISTS run_revision_proposal (
                proposal_id          TEXT PRIMARY KEY,
                run_id               TEXT NOT NULL REFERENCES graph_run(run_id),
                base_revision_id     TEXT NOT NULL,
                candidate_revision_id TEXT NOT NULL,
                expected_run_seq     INTEGER NOT NULL,
                frozen_node_ids      TEXT NOT NULL DEFAULT '[]',
                superseded_node_ids  TEXT NOT NULL DEFAULT '[]',
                created_at           INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_run_revision_proposal_run
                ON run_revision_proposal(run_id, created_at);

            CREATE TABLE IF NOT EXISTS node_run (
                node_run_id     TEXT PRIMARY KEY,
                run_id          TEXT NOT NULL REFERENCES graph_run(run_id),
                node_id         TEXT NOT NULL,
                status          TEXT NOT NULL,
                revision_id     TEXT NOT NULL,
                started_at      INTEGER,
                finished_at     INTEGER,
                attempt_count   INTEGER DEFAULT 0,
                wake_at         INTEGER,
                error           TEXT,
                loop_iteration  INTEGER,
                superseded      INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_noderun_run ON node_run(run_id);
            CREATE INDEX IF NOT EXISTS idx_noderun_status ON node_run(status);

            CREATE TABLE IF NOT EXISTS node_attempt (
                attempt_id      TEXT PRIMARY KEY,
                node_run_id     TEXT NOT NULL REFERENCES node_run(node_run_id),
                attempt_number  INTEGER NOT NULL,
                agent_assignment TEXT,
                transport       TEXT,
                session_id      TEXT,
                lease           TEXT,
                usage           TEXT DEFAULT '{}',
                error           TEXT,
                idempotency_key TEXT,
                checkpoint      TEXT,
                dispatch_prompt TEXT,
                started_at      INTEGER NOT NULL,
                finished_at     INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_attempt_noderun ON node_attempt(node_run_id);

            CREATE TABLE IF NOT EXISTS task_event (
                event_id        TEXT PRIMARY KEY,
                run_id          TEXT NOT NULL,
                run_seq         INTEGER NOT NULL,
                event_type      TEXT NOT NULL,
                schema_version  TEXT NOT NULL,
                occurred_at     INTEGER NOT NULL,
                actor           TEXT NOT NULL,
                causation_id    TEXT,
                correlation_id  TEXT,
                payload         TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_event_run_seq
                ON task_event(run_id, run_seq);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_event_run_seq_unique
                ON task_event(run_id, run_seq);

            CREATE TABLE IF NOT EXISTS artifact_ref (
                artifact_id     TEXT PRIMARY KEY,
                run_id          TEXT NOT NULL,
                node_run_id     TEXT NOT NULL,
                attempt_id      TEXT NOT NULL,
                name            TEXT NOT NULL,
                artifact_type   TEXT NOT NULL,
                hash            TEXT NOT NULL,
                sensitivity     TEXT NOT NULL,
                created_at      INTEGER NOT NULL,
                metadata        TEXT DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_artifact_run ON artifact_ref(run_id);

            CREATE TABLE IF NOT EXISTS approval_request (
                approval_id     TEXT PRIMARY KEY,
                run_id          TEXT NOT NULL,
                node_run_id     TEXT NOT NULL,
                description     TEXT NOT NULL,
                risk_level      TEXT NOT NULL,
                scope           TEXT DEFAULT '[]',
                requester       TEXT NOT NULL,
                resolver        TEXT,
                resolved        INTEGER DEFAULT 0,
                approved        INTEGER,
                created_at      INTEGER NOT NULL,
                resolved_at     INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_approval_run ON approval_request(run_id);
            CREATE INDEX IF NOT EXISTS idx_approval_pending ON approval_request(resolved) WHERE resolved = 0;

            CREATE TABLE IF NOT EXISTS task_interaction_request (
                request_id      TEXT PRIMARY KEY,
                graph_id       TEXT NOT NULL REFERENCES task_graph(graph_id),
                run_id         TEXT,
                node_id        TEXT,
                node_run_id    TEXT,
                session_id     TEXT,
                prompt         TEXT NOT NULL,
                options        TEXT NOT NULL DEFAULT '[]',
                allow_multiple INTEGER NOT NULL DEFAULT 0,
                allow_custom_text INTEGER NOT NULL DEFAULT 0,
                required       INTEGER NOT NULL DEFAULT 1,
                created_at     INTEGER NOT NULL,
                resolved_at    INTEGER,
                consumed_at    INTEGER,
                submission     TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_task_interaction_graph_pending
                ON task_interaction_request(graph_id, resolved_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_task_interaction_node_consumed
                ON task_interaction_request(node_run_id, resolved_at, consumed_at, created_at);

            CREATE TABLE IF NOT EXISTS projection_checkpoint (
                run_id          TEXT PRIMARY KEY,
                last_seq        INTEGER NOT NULL,
                projection_json TEXT NOT NULL,
                updated_at      INTEGER NOT NULL
            );
            "#,
        )?;

        // ── 轻量 migration：对已有库补列（新库 CREATE TABLE 已含）──
        // dispatch_prompt：T0 新增，node_attempt 派发 prompt（三角色识别用）。
        // SQLite 没有 ADD COLUMN IF NOT EXISTS，先查 pragma 检查列是否存在。
        ensure_column(&conn, "node_attempt", "dispatch_prompt", "TEXT")?;

        conn.pragma_update(None, "user_version", TASK_STORE_SCHEMA_VERSION)?;

        Ok(())
    }

    // ── TaskGraph operations ──────────────────────────────────────────
}
