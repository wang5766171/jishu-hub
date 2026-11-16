use super::*;
use crate::orchestrator::{NodeRun, TaskEvent};

/// 启动执行运行请求。评审 P1-16（用户裁决补实现）：`revision_id` 为显式
/// 参数来源（01 设计「从 manifest 间接来源改为显式参数来源」）——调用方从
/// `orchestrator_validate_proposal` 建图返回值取得（现有通道），不再经
/// manifest.json 的 linked_revision_id 间接解析，manifest 内容不再参与
/// 启动前置校验（哈希防篡改闸随之移除：显式 revision 为准）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartRunFromRevisionRequest {
    pub task_id: String,
    pub project_root: String,
    pub revision_id: String,
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

/// 按显式 revision_id 启动 GraphRun（评审 P1-16：来源改为请求参数直取
/// 快照建 Run，manifest 间接来源与前置哈希校验移除）。
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

    let revision_id = req.revision_id.clone();

    // 1. 幂等检查：已有活跃 run 且 key 相同 → 返回现有 run_id
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
                revision_id,
            });
        }
    }

    // 2. 打开 orchestrator store，校验 revision 存在并直取快照建 Run
    //    （评审 P1-16：显式 revision 为准——manifest 改动/滞后不再阻断启动）。
    let db_path = default_db_path();
    let store =
        TaskStore::open(&db_path).map_err(|e| format!("open orchestrator store failed: {e}"))?;

    let revision = store
        .get_revision(&revision_id)
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
        active_revision_id: revision_id.clone(),
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
            revision_id: revision_id.clone(),
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
    updated.last_launch_key = Some(req.idempotency_key);
    updated.updated_at = now;
    ti_store.upsert(&updated)?;

    Ok(StartRunFromRevisionResult {
        status: "started".to_string(),
        run_id,
        graph_id,
        revision_id,
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
    /// v0.9.3 需求4（评审 P2-1）：结转种子——run 创建时**单事务原子写入**的
    /// Succeeded 节点（旧 run 已成功且新旧快照未变更者，不重跑）。UI 手动
    /// 启动不传（serde default，前端旧载荷兼容）；revise 增量续跑传入。
    #[serde(default)]
    pub carryover: Vec<CarryoverSeed>,
}

/// 结转种子（随 run 创建原子落库；字段与 revise::CarriedNode 同源）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CarryoverSeed {
    pub node_id: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

/// v0.9.3 需求4：结转种子构造——Succeeded NodeRun + NodeResolved 事件
/// （事件溯源投影同源，actor=conductor-carryover，与原 revise 后补写行为
/// 逐字段一致，仅落库时机改为随 run 创建原子提交）。事件 run_seq 占用
/// 2..=n+1，run 行以最终 run_seq（1+n）落库。
pub(super) fn build_carryover_seeds(
    run_id: &str,
    revision_id: &str,
    carried: &[CarryoverSeed],
) -> Result<Vec<(NodeRun, TaskEvent)>, String> {
    use crate::orchestrator::domain::run::NodeRunStatus;
    use crate::orchestrator::events::payloads::NodeResolvedPayload;
    use crate::orchestrator::{build_event, TaskEventType};
    use crate::util::gen_id;

    let mut seeds = Vec::with_capacity(carried.len());
    for (index, carried_node) in carried.iter().enumerate() {
        let mut seed = NodeRun::new(gen_id("nr"), run_id, &carried_node.node_id, revision_id);
        seed.status = NodeRunStatus::Succeeded;
        seed.started_at = carried_node.started_at;
        seed.finished_at = carried_node.finished_at;
        let event = build_event(
            gen_id("evt"),
            run_id,
            index as u64 + 2,
            TaskEventType::NodeResolved,
            "conductor-carryover",
            now_ms(),
            serde_json::to_value(NodeResolvedPayload {
                node_run_id: seed.node_run_id.clone(),
                node_id: carried_node.node_id.clone(),
                final_status: NodeRunStatus::Succeeded,
            })
            .map_err(|e| format!("serialize carryover payload failed: {e:?}"))?,
        );
        seeds.push((seed, event));
    }
    Ok(seeds)
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
            if !req.carryover.is_empty() {
                // v0.9.3 需求4：结转种子只在 run 首建时原子写入；幂等重入若
                // 携带种子说明调用方状态错乱（首次创建要么带种子要么没带）。
                return Err(
                    "carryover requested on idempotent re-entry: seeds are written atomically at first creation"
                        .to_string(),
                );
            }
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

    // 3. 创建 GraphRun（status=Running）。v0.9.3 需求4（评审 P2-1）：结转种子
    //    随创建**单事务原子落库**——引擎任何时刻读库都看不到「run 已创建但
    //    种子未落」的中间态，消除引擎先 tick 调度结转节点重跑的竞窗；run 行
    //    直接以最终 run_seq（1+种子数）落库，种子事件严格占用 2..=n+1。
    let run_id = gen_id("run");
    let carryover_seeds = build_carryover_seeds(&run_id, &req.revision_id, &req.carryover)?;
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
        run_seq: 1 + carryover_seeds.len() as u64,
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

    if carryover_seeds.is_empty() {
        store
            .create_run_with_event(&run, &event)
            .map_err(|e| format!("create run failed: {e}"))?;
    } else {
        store
            .create_run_with_event_and_seeds(&run, &event, &carryover_seeds)
            .map_err(|e| format!("create run with carryover seeds failed: {e}"))?;
    }

    // 4. 更新 TaskInstance
    let mut updated = instance;
    updated.active_run_id = Some(run_id.clone());
    updated.last_run_id = Some(run_id.clone());
    updated.run_status = Some(RUN_STATUS_RUNNING.to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jishu-task-run-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 评审 P1-16：StartRunFromRevisionRequest 带 revision_id 的 serde 往返
    /// （hub_invoke 分发按 snake_case 反序列化扩展侧参数；缺字段必须拒绝
    /// ——静默缺省会让显式来源退化为空查询）。
    #[test]
    fn start_run_request_revision_id_roundtrip() {
        let req = StartRunFromRevisionRequest {
            task_id: "task-1".into(),
            project_root: "D:/p".into(),
            revision_id: "rev-abc".into(),
            idempotency_key: "key-1".into(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["revision_id"], serde_json::json!("rev-abc"));
        let back: StartRunFromRevisionRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back.revision_id, "rev-abc");

        let missing = serde_json::json!({
            "task_id": "t",
            "project_root": "p",
            "idempotency_key": "k"
        });
        assert!(
            serde_json::from_value::<StartRunFromRevisionRequest>(missing).is_err(),
            "缺 revision_id 的旧载荷必须拒绝解析"
        );
    }

    /// 评审 P1-16：manifest 哈希前置校验已删——manifest 被改动（含会触发
    /// 旧「proposal file tampered」的错哈希与过期 linked_revision_id）不再
    /// 阻断启动；流程直取显式 revision。此处实例建好、显式 revision 不存在
    /// （gen_id 空间不会撞真实库），应停在 store.get_revision 报错而非任何
    /// manifest 类错误。副作用说明：该调用会打开真实 orchestrator 库
    /// （default_db_path），仅读不写（查询失败即返回）。
    #[test]
    fn start_run_from_revision_ignores_manifest_tampering() {
        let project = temp_project("rev-tamper");
        let project_root = project.to_string_lossy().to_string();
        let instance = crate::task_launch::mark_task_session(
            &project_root,
            None,
            "s1",
            "jishu-task-runner",
            None,
        )
        .unwrap();

        // 伪造「被篡改」manifest：错哈希 + 与显式 revision 不同的 id。
        let manifest_dir = task_workspace_root(&project_root)
            .join(&instance.task_id)
            .join("artifacts")
            .join("planning");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        std::fs::write(
            manifest_dir.join("manifest.json"),
            r#"{"linked_revision_id":"rev-STALE","content_hash":"sha256:deadbeef"}"#,
        )
        .unwrap();

        let err = orchestrator_start_run_from_revision(StartRunFromRevisionRequest {
            task_id: instance.task_id.clone(),
            project_root: project_root.clone(),
            revision_id: "rev-EXPLICIT".into(),
            idempotency_key: "key-1".into(),
        })
        .unwrap_err();
        assert!(
            err.contains("get revision failed"),
            "应停在显式 revision 查询（实际: {err}）"
        );
        assert!(
            !err.contains("manifest"),
            "manifest 不再参与前置（实际: {err}）"
        );
        assert!(!err.contains("tampered"), "哈希防篡改闸已删（实际: {err}）");

        let _ = std::fs::remove_dir_all(&project);
    }
}
