use super::*;

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
