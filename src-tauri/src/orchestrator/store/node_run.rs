use super::*;

impl TaskStore {
    pub fn save_node_run(&self, node_run: &NodeRun) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO node_run
             (node_run_id, run_id, node_id, status, revision_id, started_at, finished_at,
              attempt_count, wake_at, error, loop_iteration, superseded)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                node_run.node_run_id,
                node_run.run_id,
                node_run.node_id,
                serde_json::to_string(&node_run.status)?,
                node_run.revision_id,
                node_run.started_at,
                node_run.finished_at,
                node_run.attempt_count,
                node_run.wake_at,
                node_run.error,
                node_run.loop_iteration,
                node_run.superseded as i32,
            ],
        )?;
        Ok(())
    }

    pub fn save_execution_update(
        &self,
        node_run: &NodeRun,
        attempt: Option<&NodeAttempt>,
        artifacts: &[ArtifactRef],
        events: &[TaskEvent],
        budget_delta: Option<&crate::orchestrator::domain::run::AttemptUsage>,
        run_status: Option<(&RunStatus, Option<i64>)>,
    ) -> Result<u64, StoreError> {
        if events.is_empty() {
            return Err(StoreError::Conflict(
                "execution updates must include at least one event".into(),
            ));
        }
        if events.iter().any(|event| event.run_id != node_run.run_id) {
            return Err(StoreError::Conflict(
                "execution events must belong to the node run's graph run".into(),
            ));
        }

        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        let (current_seq, budget_json): (u64, String) = tx.query_row(
            "SELECT run_seq, budget_state FROM graph_run WHERE run_id = ?1",
            params![node_run.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut budget_state: BudgetState = decode_json_column(&budget_json, 1)?;
        if let Some(delta) = budget_delta {
            budget_state.consume(
                delta.input_tokens.saturating_add(delta.output_tokens),
                delta.cost_usd,
            );
        }
        for (index, event) in events.iter().enumerate() {
            let expected_seq = current_seq + index as u64 + 1;
            if event.run_seq != expected_seq {
                return Err(StoreError::Conflict(format!(
                    "expected run sequence {expected_seq}, got {}",
                    event.run_seq
                )));
            }
        }

        tx.execute(
            "INSERT OR REPLACE INTO node_run
             (node_run_id, run_id, node_id, status, revision_id, started_at, finished_at,
              attempt_count, wake_at, error, loop_iteration, superseded)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                node_run.node_run_id,
                node_run.run_id,
                node_run.node_id,
                serde_json::to_string(&node_run.status)?,
                node_run.revision_id,
                node_run.started_at,
                node_run.finished_at,
                node_run.attempt_count,
                node_run.wake_at,
                node_run.error,
                node_run.loop_iteration,
                node_run.superseded as i32,
            ],
        )?;

        if let Some(attempt) = attempt {
            let agent_assignment = attempt
                .agent_assignment
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let lease = attempt
                .lease
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let error = attempt
                .error
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            tx.execute(
                "INSERT OR REPLACE INTO node_attempt
                 (attempt_id, node_run_id, attempt_number, agent_assignment, transport,
                  session_id, lease, usage, error, idempotency_key, checkpoint, dispatch_prompt,
                  started_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    attempt.attempt_id,
                    attempt.node_run_id,
                    attempt.attempt_number,
                    agent_assignment,
                    attempt.transport,
                    attempt.session_id,
                    lease,
                    serde_json::to_string(&attempt.usage)?,
                    error,
                    attempt.idempotency_key,
                    attempt
                        .checkpoint
                        .as_ref()
                        .map(|checkpoint| checkpoint.to_string()),
                    attempt.dispatch_prompt,
                    attempt.started_at,
                    attempt.finished_at,
                ],
            )?;
        }

        for artifact in artifacts {
            tx.execute(
                "INSERT OR REPLACE INTO artifact_ref
                 (artifact_id, run_id, node_run_id, attempt_id, name, artifact_type,
                  hash, sensitivity, created_at, metadata)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    artifact.artifact_id,
                    artifact.run_id,
                    artifact.node_run_id,
                    artifact.attempt_id,
                    artifact.name,
                    artifact.artifact_type,
                    artifact.hash,
                    serde_json::to_string(&artifact.sensitivity)?,
                    artifact.created_at,
                    serde_json::to_string(&artifact.metadata)?,
                ],
            )?;
        }

        for event in events {
            insert_event(&tx, event)?;
        }

        // Try to advance the projection checkpoint within the same transaction.
        // Legitimate skips (no checkpoint, stale/gapped) return Ok silently.
        // Genuine anomalies (deserialize/apply failures) are logged but don't fail the tx.
        if let Err(error) = try_advance_projection_checkpoint(&tx, &node_run.run_id, events) {
            tracing::warn!(
                run_id = %node_run.run_id,
                error = %error,
                "in-tx projection checkpoint advance skipped; will self-heal on next read"
            );
        }

        let max_seq = events
            .last()
            .map(|event| event.run_seq)
            .unwrap_or(current_seq);
        if let Some((status, finished_at)) = run_status {
            tx.execute(
                "UPDATE graph_run
                 SET status = ?1, run_seq = ?2, finished_at = ?3, budget_state = ?4
                 WHERE run_id = ?5",
                params![
                    serde_json::to_string(status)?,
                    max_seq,
                    finished_at,
                    serde_json::to_string(&budget_state)?,
                    node_run.run_id,
                ],
            )?;
        } else {
            tx.execute(
                "UPDATE graph_run SET run_seq = ?1, budget_state = ?2 WHERE run_id = ?3",
                params![
                    max_seq,
                    serde_json::to_string(&budget_state)?,
                    node_run.run_id
                ],
            )?;
        }
        tx.commit()?;
        Ok(max_seq)
    }

    pub fn save_node_runs_with_events(
        &self,
        node_runs: &[NodeRun],
        events: &[TaskEvent],
        run_status: Option<(&RunStatus, Option<i64>)>,
    ) -> Result<u64, StoreError> {
        let first = node_runs
            .first()
            .ok_or_else(|| StoreError::Conflict("node run batch cannot be empty".into()))?;
        if events.is_empty()
            || node_runs
                .iter()
                .any(|node_run| node_run.run_id != first.run_id)
            || events.iter().any(|event| event.run_id != first.run_id)
        {
            return Err(StoreError::Conflict(
                "node run batch and events must belong to one run".into(),
            ));
        }
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        let current_seq: u64 = tx.query_row(
            "SELECT run_seq FROM graph_run WHERE run_id = ?1",
            params![first.run_id],
            |row| row.get(0),
        )?;
        for (index, event) in events.iter().enumerate() {
            let expected_seq = current_seq + index as u64 + 1;
            if event.run_seq != expected_seq {
                return Err(StoreError::Conflict(format!(
                    "expected run sequence {expected_seq}, got {}",
                    event.run_seq
                )));
            }
        }
        for node_run in node_runs {
            tx.execute(
                "INSERT OR REPLACE INTO node_run
                 (node_run_id, run_id, node_id, status, revision_id, started_at, finished_at,
                  attempt_count, wake_at, error, loop_iteration, superseded)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    node_run.node_run_id,
                    node_run.run_id,
                    node_run.node_id,
                    serde_json::to_string(&node_run.status)?,
                    node_run.revision_id,
                    node_run.started_at,
                    node_run.finished_at,
                    node_run.attempt_count,
                    node_run.wake_at,
                    node_run.error,
                    node_run.loop_iteration,
                    node_run.superseded as i32,
                ],
            )?;
        }
        for event in events {
            insert_event(&tx, event)?;
        }
        let max_seq = events
            .last()
            .map(|event| event.run_seq)
            .unwrap_or(current_seq);
        if let Some((status, finished_at)) = run_status {
            tx.execute(
                "UPDATE graph_run SET status = ?1, run_seq = ?2, finished_at = ?3
                 WHERE run_id = ?4",
                params![
                    serde_json::to_string(status)?,
                    max_seq,
                    finished_at,
                    first.run_id
                ],
            )?;
        } else {
            tx.execute(
                "UPDATE graph_run SET run_seq = ?1 WHERE run_id = ?2",
                params![max_seq, first.run_id],
            )?;
        }
        tx.commit()?;
        Ok(max_seq)
    }

    pub fn get_node_runs(&self, run_id: &str) -> Result<Vec<NodeRun>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT node_run_id, run_id, node_id, status, revision_id, started_at,
                    finished_at, attempt_count, wake_at, error, loop_iteration, superseded
             FROM node_run WHERE run_id = ?1",
        )?;

        let runs = stmt
            .query_map(params![run_id], |row| {
                let status_json: String = row.get(3)?;
                Ok(NodeRun {
                    node_run_id: row.get(0)?,
                    run_id: row.get(1)?,
                    node_id: row.get(2)?,
                    status: decode_json_column(&status_json, 3)?,
                    revision_id: row.get(4)?,
                    started_at: row.get(5)?,
                    finished_at: row.get(6)?,
                    attempt_count: row.get(7)?,
                    wake_at: row.get(8)?,
                    error: row.get(9)?,
                    loop_iteration: row.get(10)?,
                    superseded: row.get::<_, i32>(11)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(runs)
    }

    pub fn get_node_run(&self, node_run_id: &str) -> Result<NodeRun, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.query_row(
            "SELECT node_run_id, run_id, node_id, status, revision_id, started_at,
                    finished_at, attempt_count, wake_at, error, loop_iteration, superseded
             FROM node_run WHERE node_run_id = ?1",
            params![node_run_id],
            |row| {
                let status_json: String = row.get(3)?;
                Ok(NodeRun {
                    node_run_id: row.get(0)?,
                    run_id: row.get(1)?,
                    node_id: row.get(2)?,
                    status: decode_json_column(&status_json, 3)?,
                    revision_id: row.get(4)?,
                    started_at: row.get(5)?,
                    finished_at: row.get(6)?,
                    attempt_count: row.get(7)?,
                    wake_at: row.get(8)?,
                    error: row.get(9)?,
                    loop_iteration: row.get(10)?,
                    superseded: row.get::<_, i32>(11)? != 0,
                })
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("node run {node_run_id}")))
    }

    // ── NodeAttempt operations ────────────────────────────────────────

    pub fn save_attempt(&self, attempt: &NodeAttempt) -> Result<(), StoreError> {
        let agent_assignment = attempt
            .agent_assignment
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let lease = attempt
            .lease
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let error = attempt
            .error
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO node_attempt
             (attempt_id, node_run_id, attempt_number, agent_assignment, transport,
              session_id, lease, usage, error, idempotency_key, checkpoint, dispatch_prompt,
              started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                attempt.attempt_id,
                attempt.node_run_id,
                attempt.attempt_number,
                agent_assignment,
                attempt.transport,
                attempt.session_id,
                lease,
                serde_json::to_string(&attempt.usage)?,
                error,
                attempt.idempotency_key,
                attempt.checkpoint.as_ref().map(|c| c.to_string()),
                attempt.dispatch_prompt,
                attempt.started_at,
                attempt.finished_at,
            ],
        )?;
        Ok(())
    }

    /// 节点 attempt 开始执行后，runtime 解析出真实 session_id（SessionResolved 事件）。
    /// 立即落库，使前端在节点**运行中**即可拿到 session_id 进入会话实时查看，
    /// 不必等到 attempt 完成（此前 session_id 仅完成时落库，导致运行中无法进入节点会话）。
    pub fn set_node_attempt_session_id(
        &self,
        attempt_id: &str,
        session_id: &str,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            "UPDATE node_attempt SET session_id = ?1 WHERE attempt_id = ?2",
            params![session_id, attempt_id],
        )?;
        Ok(())
    }

    pub fn latest_attempt(&self, node_run_id: &str) -> Result<Option<NodeAttempt>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.query_row(
            "SELECT attempt_id, node_run_id, attempt_number, agent_assignment, transport,
                    session_id, lease, usage, error, idempotency_key, checkpoint, dispatch_prompt,
                    started_at, finished_at
             FROM node_attempt WHERE node_run_id = ?1
             ORDER BY attempt_number DESC LIMIT 1",
            params![node_run_id],
            |row| {
                let agent_assignment = row
                    .get::<_, Option<String>>(3)?
                    .map(|value| decode_json_column(&value, 3))
                    .transpose()?;
                let lease = row
                    .get::<_, Option<String>>(6)?
                    .map(|value| decode_json_column(&value, 6))
                    .transpose()?;
                let usage_json: String = row.get(7)?;
                let error = row
                    .get::<_, Option<String>>(8)?
                    .map(|value| decode_json_column(&value, 8))
                    .transpose()?;
                let checkpoint = row
                    .get::<_, Option<String>>(10)?
                    .map(|value| decode_json_column(&value, 10))
                    .transpose()?;
                Ok(NodeAttempt {
                    attempt_id: row.get(0)?,
                    node_run_id: row.get(1)?,
                    attempt_number: row.get(2)?,
                    agent_assignment,
                    transport: row.get(4)?,
                    session_id: row.get(5)?,
                    lease,
                    usage: decode_json_column(&usage_json, 7)?,
                    error,
                    idempotency_key: row.get(9)?,
                    checkpoint,
                    dispatch_prompt: row.get(11)?,
                    started_at: row.get(12)?,
                    finished_at: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    /// Fetch a single attempt by (node_run_id, attempt_number).
    pub fn get_attempt(
        &self,
        node_run_id: &str,
        attempt_number: u32,
    ) -> Result<crate::orchestrator::domain::run::NodeAttempt, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.query_row(
            "SELECT attempt_id, node_run_id, attempt_number, agent_assignment, transport,
                    session_id, lease, usage, error, idempotency_key, checkpoint, dispatch_prompt,
                    started_at, finished_at
             FROM node_attempt WHERE node_run_id = ?1 AND attempt_number = ?2",
            params![node_run_id, attempt_number],
            |row| {
                let agent_assignment = row
                    .get::<_, Option<String>>(3)?
                    .map(|value| decode_json_column(&value, 3))
                    .transpose()?;
                let lease = row
                    .get::<_, Option<String>>(6)?
                    .map(|value| decode_json_column(&value, 6))
                    .transpose()?;
                let usage_json: String = row.get(7)?;
                let error = row
                    .get::<_, Option<String>>(8)?
                    .map(|value| decode_json_column(&value, 8))
                    .transpose()?;
                let checkpoint = row
                    .get::<_, Option<String>>(10)?
                    .map(|value| decode_json_column(&value, 10))
                    .transpose()?;
                Ok(NodeAttempt {
                    attempt_id: row.get(0)?,
                    node_run_id: row.get(1)?,
                    attempt_number: row.get(2)?,
                    agent_assignment,
                    transport: row.get(4)?,
                    session_id: row.get(5)?,
                    lease,
                    usage: decode_json_column(&usage_json, 7)?,
                    error,
                    idempotency_key: row.get(9)?,
                    checkpoint,
                    dispatch_prompt: row.get(11)?,
                    started_at: row.get(12)?,
                    finished_at: row.get(13)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                StoreError::NotFound(format!("attempt {node_run_id}/{attempt_number}"))
            }
            other => StoreError::Sqlite(other),
        })
    }

    /// 所有节点 attempt 的去重非空 session_id 列表。
    ///
    /// 用于前端把节点子代理会话从常规会话列表过滤（设计 18 §3 / 实施计划 19 T3.1）。
    /// 全表扫描：session_id 跨项目唯一（Pi session id），前端按当前项目 sessions 过滤时，
    /// 超集里的他项目 id 不会误伤（不在当前项目 session 列表里自然不匹配）。
    pub fn list_node_session_ids(&self) -> Result<Vec<String>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT session_id FROM node_attempt
             WHERE session_id IS NOT NULL AND session_id <> ''",
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    }

    /// 列出某次 run 下所有节点的最新 attempt 摘要（侧边栏任务二级树用）。
    ///
    /// 单条 SQL JOIN node_run + node_attempt（取每个 node_run 的最大 attempt_number），
    /// 避免 N+1 查询。设计 `02-总体设计.md` §6.2。
    pub fn list_node_sessions(&self, run_id: &str) -> Result<Vec<NodeSessionSummary>, StoreError> {
        // 1. 取出本 run 下所有节点的最新 attempt（含该节点所属的 revision_id）。
        //    用独立作用域持有 reader 锁，收集完即释放——避免后续 get_revision 再次加锁死锁。
        let node_rows: Vec<(
            String,         // node_id
            String,         // node_run_id
            String,         // status
            u32,            // attempt_number
            Option<String>, // session_id
            Option<String>, // agent_id
            String,         // revision_id
        )> = {
            let conn = self
                .reader
                .lock()
                .map_err(|e| StoreError::Lock(e.to_string()))?;
            let mut stmt = conn.prepare(
                "SELECT nr.node_id,
                        nr.node_run_id,
                        nr.status,
                        na.attempt_number,
                        na.session_id,
                        na.agent_assignment,
                        nr.revision_id
                 FROM node_run nr
                 LEFT JOIN node_attempt na
                   ON na.node_run_id = nr.node_run_id
                  AND na.attempt_number = (
                      SELECT MAX(attempt_number) FROM node_attempt WHERE node_run_id = nr.node_run_id
                  )
                 WHERE nr.run_id = ?1
                 ORDER BY nr.started_at ASC, nr.node_run_id ASC",
            )?;
            let rows = stmt.query_map(params![run_id], |row| {
                let status_raw: String = row.get(2)?;
                // node_run.status 列存的是 serde_json::to_string 结果（带引号的 JSON 字符串，
                // 如 `"succeeded"`）。这里解码回枚举再序列化为干净的 snake_case 字符串，
                // 避免前端拿到带引号的字符串导致状态图标匹配失败（全部走 default 空心圆）。
                let status = serde_json::from_str::<NodeRunStatus>(&status_raw)
                    .map(|s| {
                        serde_json::to_string(&s)
                            .map(|v| v.trim_matches('"').to_string())
                            .unwrap_or_else(|_| status_raw.clone())
                    })
                    .unwrap_or_else(|_| status_raw.clone());
                let agent_assignment_json: Option<String> = row.get(5)?;
                let agent_id = agent_assignment_json
                    .as_deref()
                    .and_then(|json| {
                        serde_json::from_str::<crate::orchestrator::domain::run::AgentAssignment>(
                            json,
                        )
                        .ok()
                    })
                    .map(|assignment| assignment.agent_id);
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    status,
                    row.get::<_, Option<i64>>(3)?.map(|n| n as u32).unwrap_or(0),
                    row.get(4)?,
                    agent_id,
                    row.get::<_, String>(6)?,
                ))
            })?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row?);
            }
            v
        };

        if node_rows.is_empty() {
            return Ok(Vec::new());
        }

        // 2. 取 graph 的 current_draft_revision（兜底标题源）。
        let draft_revision_id: Option<String> = {
            let conn = self
                .reader
                .lock()
                .map_err(|e| StoreError::Lock(e.to_string()))?;
            conn.query_row(
                "SELECT g.current_draft_revision
                 FROM graph_run r
                 LEFT JOIN graph g ON g.graph_id = r.graph_id
                 WHERE r.run_id = ?1",
                params![run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        };

        // 3. 加载需要的 revision，构建 node_id → 中文标题 映射。
        //    优先用 run 实际执行的 revision（node_id 必然对齐）；draft 仅作兜底。
        let mut run_title_map: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut draft_title_map: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut loaded: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (_, _, _, _, _, _, rev_id) in &node_rows {
            if rev_id.is_empty() || !loaded.insert(rev_id.clone()) {
                continue;
            }
            if let Ok(rev) = self.get_revision(rev_id) {
                if let Ok(snap) = rev.canonical_snapshot.to_snapshot() {
                    for n in snap.nodes {
                        let t = n.title.trim().to_string();
                        if !t.is_empty() {
                            run_title_map.entry(n.node_id.clone()).or_insert(t);
                        }
                    }
                }
            }
        }
        if let Some(d) = &draft_revision_id {
            if !d.is_empty() && loaded.insert(d.clone()) {
                if let Ok(rev) = self.get_revision(d) {
                    if let Ok(snap) = rev.canonical_snapshot.to_snapshot() {
                        for n in snap.nodes {
                            let t = n.title.trim().to_string();
                            if !t.is_empty() {
                                draft_title_map.entry(n.node_id.clone()).or_insert(t);
                            }
                        }
                    }
                }
            }
        }

        // 4. 选择展示标题：run revision（对齐）优先，其次 draft，最后才回退裸 node_id。
        //    过滤掉 "Node n1" 这类占位标题，确保侧边栏永远显示中文标题、绝不出现 N1/N2。
        let pick = |title: Option<String>, node_id: &str| -> Option<String> {
            title.filter(|t| {
                let tt = t.trim();
                !tt.is_empty()
                    && !tt.eq_ignore_ascii_case(&format!("Node {node_id}"))
                    && !tt.starts_with("Node ")
            })
        };

        let mut summaries = Vec::with_capacity(node_rows.len());
        for (node_id, node_run_id, status, attempt_number, session_id, agent_id, _) in node_rows {
            let title = pick(run_title_map.get(&node_id).cloned(), &node_id)
                .or_else(|| pick(draft_title_map.get(&node_id).cloned(), &node_id))
                .unwrap_or_else(|| node_id.clone());
            summaries.push(NodeSessionSummary {
                node_id,
                node_run_id,
                status,
                attempt_number,
                session_id,
                agent_id,
                title,
            });
        }
        Ok(summaries)
    }

    /// 列出某节点所有 attempt 的派发 prompt（三角色识别用，设计 §7.1 方案 A）。
    ///
    /// 依赖 `dispatch_prompt` 列（T0 新增）。老库无此列时 SQLite ALTER TABLE ADD COLUMN
    /// 默认 NULL，返回空 prompt（前端降级为两角色）。
    pub fn list_attempt_dispatches(
        &self,
        node_run_id: &str,
    ) -> Result<Vec<AttemptDispatch>, StoreError> {
        let conn = self
            .reader
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT attempt_number, started_at, dispatch_prompt
             FROM node_attempt
             WHERE node_run_id = ?1 AND dispatch_prompt IS NOT NULL
             ORDER BY attempt_number ASC",
        )?;
        let rows = stmt.query_map(params![node_run_id], |row| {
            Ok(AttemptDispatch {
                attempt_number: row.get::<_, i64>(0)? as u32,
                dispatched_at: row.get(1)?,
                prompt: row.get(2)?,
            })
        })?;
        let mut dispatches = Vec::new();
        for row in rows {
            dispatches.push(row?);
        }
        Ok(dispatches)
    }

    /// Refresh the heartbeat deadline on the latest attempt's lease for a node run.
    /// Used by the execution heartbeat loop to keep an in-flight lease alive.
    pub fn refresh_lease_heartbeat(
        &self,
        node_run_id: &str,
        heartbeat_deadline: i64,
    ) -> Result<(), StoreError> {
        let conn = self
            .writer
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT attempt_id, lease FROM node_attempt
                 WHERE node_run_id = ?1 ORDER BY attempt_number DESC LIMIT 1",
                params![node_run_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let Some((attempt_id, lease_json)) = row else {
            return Ok(());
        };
        let Some(lease_json) = lease_json else {
            return Ok(());
        };
        let mut lease: crate::orchestrator::domain::run::Lease =
            serde_json::from_str(&lease_json).map_err(|e| StoreError::Serde(e.into()))?;
        lease.heartbeat_deadline = heartbeat_deadline;
        let updated = serde_json::to_string(&lease).map_err(|e| StoreError::Serde(e.into()))?;
        conn.execute(
            "UPDATE node_attempt SET lease = ?1 WHERE attempt_id = ?2",
            params![updated, attempt_id],
        )?;
        Ok(())
    }

    // ── Approval operations ───────────────────────────────────────────
}
