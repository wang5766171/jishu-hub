use super::*;

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
