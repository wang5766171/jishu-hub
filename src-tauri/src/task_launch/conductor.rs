use super::*;

/// Conductor 阶段同步请求（由扩展通过 hub_invoke 桥接调用）。
///
/// 设计依据：`jishu-task-conductor_实施计划.md` Phase 2 任务 2.1。
/// Conductor 阶段变化时同步 TaskInstance，消除双状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConductorSyncPhaseRequest {
    pub task_id: String,
    pub project_root: String,
    /// 目标阶段（Conductor 视角）："discuss" | "plan" | "execute" | "done"
    /// （legacy 三段式）；pipeline 任务为**阶段 key**（或末阶段后的 "done"）。
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
    /// 声明驱动阶段序列（v0.9.3 需求13 C4-slice2）：展开后阶段数组，仅在
    /// 任务首次 sync（创建实例）时携带并持久化；之后以持久化声明为权威。
    #[serde(default)]
    pub stages: Option<Vec<serde_json::Value>>,
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
/// - v0.9.3 需求13 C4-slice2：实例带声明阶段序列（或首次携带）走
///   `sync_pipeline_phase`（相邻推进）；legacy 三段式路径结构上零变化。
pub fn conductor_sync_phase(
    request: ConductorSyncPhaseRequest,
) -> Result<ConductorSyncPhaseResult, String> {
    let store = open_store(&request.project_root)?;
    let existing = store.get(&request.task_id)?;
    let pipeline_stages: Option<Vec<serde_json::Value>> = match &existing {
        Some(inst) => inst
            .stages_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| format!("stages_json 解析失败: {e}"))?,
        None => request
            .stages
            .clone()
            .filter(|stages| !stages.is_empty()),
    };
    if pipeline_stages.is_some() {
        return sync_pipeline_phase(request, &store, existing, pipeline_stages.unwrap());
    }
    legacy_sync_phase(request, &store, existing)
}

/// 声明驱动阶段同步（C4-slice2）：阶段 key 相邻推进 + 模板阶段沿用产物校验。
///
/// - 合法转换：idle→stages[0]、stages[i]→stages[i+1]、末阶段→done；
/// - expected_phase 乐观并发（stage key 比较）+ 幂等条款（已在目标阶段视同成功）；
/// - 哈希校验仅模板阶段（template=phase.plan → REQUIREMENTS、phase.execute →
///   flow-plan）；自定义阶段不校验（产出协议校验为后续增强，非本 slice 范围）；
/// - current_phase 存阶段 key；status 进行中恒 requirements_discussing，
///   done 语义沿用 run_status=completed。
fn sync_pipeline_phase(
    request: ConductorSyncPhaseRequest,
    store: &super::instance_store::TaskInstanceStore,
    existing: Option<TaskLaunchInstance>,
    stages: Vec<serde_json::Value>,
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
        ..
    } = request;

    let stage_list = stage_keys_and_templates(&stages)?;
    let keys: Vec<&str> = stage_list.iter().map(|(k, _)| k.as_str()).collect();

    // 当前阶段：无实例=idle；已完成=done；否则 current_phase 必须是声明内 key。
    let current = match &existing {
        None => "idle".to_string(),
        Some(inst) => {
            if inst.run_status.as_deref() == Some(RUN_STATUS_COMPLETED) {
                "done".to_string()
            } else if keys.contains(&inst.current_phase.as_str()) {
                inst.current_phase.clone()
            } else {
                return Ok(ConductorSyncPhaseResult {
                    success: false,
                    instance: existing.clone().ok_or("task instance not found")?,
                    error: Some(format!(
                        "实例 current_phase 不在声明阶段内: {}（声明：{}）",
                        inst.current_phase,
                        keys.join("→")
                    )),
                });
            }
        }
    };

    // 目标阶段合法性（相邻推进）。
    let legal = match (current.as_str(), phase.as_str()) {
        ("idle", target) => keys.first() == Some(&target),
        (from, "done") => keys.last() == Some(&from),
        (from, target) => {
            match (keys.iter().position(|k| *k == from), keys.iter().position(|k| *k == target)) {
                (Some(i), Some(j)) => j == i + 1,
                _ => false,
            }
        }
    };
    let idempotent = current == phase;
    if !legal && !idempotent {
        return Ok(ConductorSyncPhaseResult {
            success: false,
            instance: existing.ok_or("task instance not found")?,
            error: Some(format!(
                "非法阶段转换: {current} → {phase}（声明序列仅相邻推进：idle→{}→done）",
                keys.join("→")
            )),
        });
    }

    // 乐观并发（同 legacy 幂等条款：目标已达成视同成功）。
    if let Some(expected) = expected_phase.as_deref() {
        if expected != current && current != phase {
            return Ok(ConductorSyncPhaseResult {
                success: false,
                instance: existing.ok_or("task instance not found")?,
                error: Some(format!(
                    "乐观并发冲突: 期望阶段={expected}, 实际阶段={current}"
                )),
            });
        }
    }

    // 模板阶段产物校验（自定义阶段不校验）。
    if phase != "done" {
        let template = keys
            .iter()
            .position(|k| k == &phase)
            .and_then(|i| stage_list[i].1.clone());
        match template.as_deref() {
            Some("phase.plan") => {
                let hash = artifact_hash
                    .as_deref()
                    .ok_or("进入 plan 模板阶段必须提供 artifact_hash")?;
                let requirement_path = artifacts
                    .as_ref()
                    .and_then(|v| v.requirements.as_deref())
                    .ok_or("进入 plan 模板阶段必须提供 requirements")?;
                verify_artifact_hash(
                    &project_root,
                    &task_id,
                    "requirements",
                    "REQUIREMENTS.md",
                    requirement_path,
                    hash,
                )?;
            }
            Some("phase.execute") => {
                let hash = artifact_hash
                    .as_deref()
                    .ok_or("进入 execute 模板阶段必须提供 artifact_hash")?;
                let proposal_path = artifacts
                    .as_ref()
                    .and_then(|v| v.flow_plan_json.as_deref())
                    .ok_or("进入 execute 模板阶段必须提供 flow_plan_json")?;
                verify_artifact_hash(
                    &project_root,
                    &task_id,
                    "planning",
                    "flow-plan-proposal.json",
                    proposal_path,
                    hash,
                )?;
            }
            _ => {}
        }
    }

    let now = now_ms();
    let stages_json = serde_json::to_string(&stages).map_err(|e| e.to_string())?;
    let mut instance = existing.unwrap_or_else(|| TaskLaunchInstance {
        task_id: task_id.clone(),
        project_root: project_root.clone(),
        title: title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "新任务".into()),
        skill_id: format!("pipeline:{domain}"),
        planner_agent_id: "jishu_agent".into(),
        status: STATUS_REQUIREMENTS_DISCUSSING.into(),
        current_phase: keys.first().copied().unwrap_or_default().to_string(),
        requirement_file: None,
        requirement_session_id: None,
        planning_session_id: None,
        graph_id: None,
        active_run_id: None,
        last_run_id: None,
        run_status: None,
        last_launch_key: None,
        stages_json: Some(stages_json),
        created_at: now,
        updated_at: now,
    });

    if phase == "done" {
        if instance.run_status.is_none() {
            instance.run_status = Some(RUN_STATUS_COMPLETED.into());
        }
    } else {
        instance.current_phase = phase.clone();
        instance.status = STATUS_REQUIREMENTS_DISCUSSING.into();
        if let Some(ref arts) = artifacts {
            if let Some(ref req_path) = arts.requirements {
                instance.requirement_file = Some(req_path.clone());
            }
        }
    }
    // 会话绑定：首个阶段记 requirement_session_id（任务列表按会话关联依赖它）；
    // 后续阶段不覆盖（流水线全程同一会话，缺席才补）。
    if let Some(ref sid) = session_id {
        if instance.requirement_session_id.is_none() {
            instance.requirement_session_id = Some(sid.clone());
        }
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

/// 声明阶段序列解析：key 必填非空且唯一，template 可选。
fn stage_keys_and_templates(
    stages: &[serde_json::Value],
) -> Result<Vec<(String, Option<String>)>, String> {
    if stages.is_empty() {
        return Err("阶段序列为空".into());
    }
    let mut out = Vec::new();
    for (index, stage) in stages.iter().enumerate() {
        let key = stage
            .get("key")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .ok_or_else(|| format!("阶段 {} 缺少 key", index + 1))?
            .to_string();
        if out.iter().any(|(k, _): &(String, Option<String>)| *k == key) {
            return Err(format!("阶段 key 重复: {key}"));
        }
        let template = stage
            .get("template")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string);
        out.push((key, template));
    }
    Ok(out)
}

/// legacy 三段式阶段同步（discuss→plan→execute→done，原 conductor_sync_phase
/// 主体，C4-slice2 起独立为函数——行为零变化）。
fn legacy_sync_phase(
    request: ConductorSyncPhaseRequest,
    store: &super::instance_store::TaskInstanceStore,
    existing: Option<TaskLaunchInstance>,
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
        ..
    } = request;

    let now = now_ms();

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

    // 乐观并发校验：expected_phase 不匹配则拒绝——**除非 hub 已在目标阶段**
    // （v0.9.2 测试期修复：首次 sync 超时→null→误判成功→模型重试→hub 已
    // 在目标阶段→expected 冲突→死循环。幂等处理：目标已达成视同成功）。
    if let Some(ref expected) = expected_phase {
        let target_conductor_phase = match phase.as_str() {
            "discuss" => "discuss",
            "plan" => "plan",
            "execute" => {
                if existing
                    .as_ref()
                    .and_then(|inst| inst.run_status.as_deref())
                    == Some(crate::task_launch::RUN_STATUS_COMPLETED)
                {
                    "done"
                } else {
                    "execute"
                }
            }
            _ => "idle",
        };
        if expected != current_conductor_phase && current_conductor_phase != target_conductor_phase {
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
                    stages_json: None,
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
        stages_json: None,
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

#[cfg(test)]
mod pipeline_tests {
    use super::*;

    fn temp_project(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jishu-conductor-pipeline-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// video-maker 形状：discuss 模板段 + 三个自定义段。
    fn stages() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({ "key": "discuss", "template": "phase.discuss", "prompt": "a", "tools": [], "skills": [], "gate": "confirm", "outputs": [] }),
            serde_json::json!({ "key": "storyboard", "name": "分镜设计", "prompt": "b", "tools": [], "skills": [], "gate": "none", "outputs": [] }),
            serde_json::json!({ "key": "assets", "name": "素材整理", "prompt": "c", "tools": [], "skills": [], "gate": "none", "outputs": [] }),
            serde_json::json!({ "key": "render", "name": "视频生成", "prompt": "d", "tools": [], "skills": [], "gate": "confirm", "outputs": [] }),
        ]
    }

    fn sync(root: &str, task_id: &str, phase: &str, expected: Option<&str>, stages: Option<Vec<serde_json::Value>>) -> ConductorSyncPhaseResult {
        conductor_sync_phase(ConductorSyncPhaseRequest {
            task_id: task_id.into(),
            project_root: root.into(),
            phase: phase.into(),
            domain: "session.video-maker".into(),
            artifacts: None,
            expected_phase: expected.map(str::to_string),
            artifact_hash: None,
            title: Some("视频任务".into()),
            session_id: Some("session-pipe-1".into()),
            stages,
        })
        .unwrap()
    }

    #[test]
    fn pipeline_first_stage_creates_instance_with_stages() {
        let root = temp_project("create");
        let root = root.to_string_lossy().to_string();
        let created = sync(&root, "task_p1", "discuss", Some("idle"), Some(stages()));
        assert!(created.success, "{:?}", created.error);
        let inst = created.instance;
        assert_eq!(inst.current_phase, "discuss");
        assert_eq!(inst.status, STATUS_REQUIREMENTS_DISCUSSING);
        assert_eq!(inst.skill_id, "pipeline:session.video-maker");
        assert_eq!(inst.requirement_session_id.as_deref(), Some("session-pipe-1"));
        assert!(inst.stages_json.is_some());
        let persisted: Vec<serde_json::Value> =
            serde_json::from_str(inst.stages_json.as_deref().unwrap()).unwrap();
        assert_eq!(persisted.len(), 4);
        // conductor_load_task_state 透出（扩展恢复链路）。
        let loaded = conductor_load_task_state(&root, "task_p1").unwrap();
        assert!(loaded.found && loaded.instance.unwrap().stages_json.is_some());
    }

    #[test]
    fn pipeline_adjacent_advance_ok_and_skip_rejected() {
        let root = temp_project("advance");
        let root = root.to_string_lossy().to_string();
        assert!(sync(&root, "task_p2", "discuss", Some("idle"), Some(stages())).success);
        // 相邻推进：discuss→storyboard（自定义段，无哈希校验要求）。
        let advanced = sync(&root, "task_p2", "storyboard", Some("discuss"), None);
        assert!(advanced.success, "{:?}", advanced.error);
        assert_eq!(advanced.instance.current_phase, "storyboard");
        // 跳跃拒绝：storyboard→render（隔了 assets）。
        let skipped = sync(&root, "task_p2", "render", Some("storyboard"), None);
        assert!(!skipped.success);
        assert!(skipped.error.unwrap().contains("非法阶段转换"));
        // 乐观并发：期望错阶段拒绝。
        let raced = sync(&root, "task_p2", "assets", Some("discuss"), None);
        assert!(!raced.success);
        // 幂等：目标已达成视同成功（重复 sync 当前阶段）。
        let idem = sync(&root, "task_p2", "storyboard", Some("discuss"), None);
        assert!(idem.success);
    }

    #[test]
    fn pipeline_done_only_from_last_stage() {
        let root = temp_project("done");
        let root = root.to_string_lossy().to_string();
        assert!(sync(&root, "task_p3", "discuss", Some("idle"), Some(stages())).success);
        // 非末阶段 → done 拒绝。
        let early = sync(&root, "task_p3", "done", Some("discuss"), None);
        assert!(!early.success);
        // 走到末阶段。
        for key in ["storyboard", "assets", "render"] {
            assert!(sync(&root, "task_p3", key, None, None).success, "advance {key}");
        }
        let done = sync(&root, "task_p3", "done", Some("render"), None);
        assert!(done.success, "{:?}", done.error);
        assert_eq!(done.instance.run_status.as_deref(), Some(RUN_STATUS_COMPLETED));
        assert_eq!(done.instance.current_phase, "render");
    }

    #[test]
    fn pipeline_plan_template_stage_keeps_hash_gate() {
        let root = temp_project("hashgate");
        let root = root.to_string_lossy().to_string();
        // 首段为 plan 模板段的声明：进入该段必须提供 artifact_hash（Err 通路）。
        let stages = vec![
            serde_json::json!({ "key": "plan", "template": "phase.plan", "prompt": "", "tools": [], "skills": [], "gate": "confirm", "outputs": [] }),
            serde_json::json!({ "key": "after", "name": "后续", "prompt": "", "tools": [], "skills": [], "gate": "none", "outputs": [] }),
        ];
        let result = conductor_sync_phase(ConductorSyncPhaseRequest {
            task_id: "task_p4".into(),
            project_root: root.clone(),
            phase: "plan".into(),
            domain: "session.x".into(),
            artifacts: None,
            expected_phase: Some("idle".into()),
            artifact_hash: None,
            title: None,
            session_id: None,
            stages: Some(stages),
        });
        assert!(result.is_err(), "plan 模板阶段缺哈希应 Err（沿用 legacy 校验强度）: {result:?}");
        assert!(result.unwrap_err().contains("artifact_hash"));
    }

    #[test]
    fn legacy_stages_absent_keeps_three_phase_matrix() {
        // legacy 回归：无 stages 请求 → 走三段式（非法转换沿用旧矩阵拒绝）。
        let root = temp_project("legacy");
        let root = root.to_string_lossy().to_string();
        assert!(sync(&root, "task_l1", "discuss", Some("idle"), None).success);
        let rejected = sync(&root, "task_l1", "execute", Some("discuss"), None);
        assert!(!rejected.success);
        assert!(rejected.error.unwrap().contains("非法阶段转换"));
    }

    #[test]
    fn schema_v2_to_v3_migration_adds_stages_column() {
        use rusqlite::Connection;
        let root = temp_project("migrate");
        let db_path = super::super::task_instances_db_path(&root.to_string_lossy());
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        {
            // 手工建 v2 库（无 stages_json 列）。
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE task_instance (
                    task_id TEXT PRIMARY KEY, project_root TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '新任务', skill_id TEXT NOT NULL,
                    planner_agent_id TEXT NOT NULL DEFAULT 'jishu_agent',
                    status TEXT NOT NULL DEFAULT 'requirements_discussing',
                    current_phase TEXT NOT NULL DEFAULT 'requirements',
                    requirement_file TEXT, requirement_session_id TEXT,
                    planning_session_id TEXT, graph_id TEXT, active_run_id TEXT,
                    last_run_id TEXT, run_status TEXT, last_launch_key TEXT,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                PRAGMA user_version = 2;",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO task_instance (task_id, project_root, title, skill_id, created_at, updated_at)
                 VALUES ('t_old', 'x', '旧任务', 's', 1, 1)",
                [],
            )
            .unwrap();
        }
        // 打开触发迁移；旧行可读且 stages_json 为 NULL（legacy 语义）。
        let root_str = root.to_string_lossy().to_string();
        let loaded = conductor_load_task_state(&root_str, "t_old").unwrap();
        let inst = loaded.instance.unwrap();
        assert_eq!(inst.title, "旧任务");
        assert!(inst.stages_json.is_none());
        let conn = Connection::open(&db_path).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn schema_poisoned_version_downgrade_self_heals() {
        // 用户实测态：新代码完成 v3 迁移后旧版本应用又打开库，把 user_version
        // 写回 2（v3 列已存在）——按版本号盲 ALTER 会 duplicate column 使
        // store 打开失败（任务列表空/会话落常规/新任务启动链全挡）。列存在性
        // 迁移须自愈该态：跳过已存在列，版本写回 3，数据可读。
        use rusqlite::Connection;
        let root = temp_project("poisoned");
        let db_path = super::super::task_instances_db_path(&root.to_string_lossy());
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE task_instance (
                    task_id TEXT PRIMARY KEY, project_root TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '新任务', skill_id TEXT NOT NULL,
                    planner_agent_id TEXT NOT NULL DEFAULT 'jishu_agent',
                    status TEXT NOT NULL DEFAULT 'requirements_discussing',
                    current_phase TEXT NOT NULL DEFAULT 'requirements',
                    requirement_file TEXT, requirement_session_id TEXT,
                    planning_session_id TEXT, graph_id TEXT, active_run_id TEXT,
                    last_run_id TEXT, run_status TEXT, last_launch_key TEXT,
                    stages_json TEXT,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                PRAGMA user_version = 2;",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO task_instance (task_id, project_root, title, skill_id, current_phase, created_at, updated_at)
                 VALUES ('t_p', 'x', '带毒任务', 's', 'requirements', 1, 1)",
                [],
            )
            .unwrap();
        }
        let root_str = root.to_string_lossy().to_string();
        // 修前形态在此处 Err("duplicate column name: stages_json")。
        let loaded = conductor_load_task_state(&root_str, "t_p").unwrap();
        assert_eq!(loaded.instance.unwrap().title, "带毒任务");
        let conn = Connection::open(&db_path).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
    }
}
