//! 执行期方案修订（v0.9.2 测试期修复：对话中调整流程真正打通）。
//!
//! 与 `orchestrator_validate_proposal`（首建图）的区别：在**既有图**上创建子
//! revision——同 id 节点即更新、新 id 即新增、缺席即移除；run 进行中则经
//! propose/apply_run_revision 应用（已完成节点冻结保持原结果，新节点并入
//! 调度），run 未启动则仅更新图草稿。「流程尚未开始，可继续调整」与执行中
//! 调整共用此通道。

use super::*;

/// 执行期方案修订请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevisePlanRequest {
    pub task_id: String,
    pub project_root: String,
    pub proposal_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RevisePlanResult {
    pub success: bool,
    pub revision_id: Option<String>,
    /// 是否已应用到进行中的 run（否则待下次启动生效）。
    pub run_updated: bool,
    pub error: Option<String>,
}

pub fn conductor_revise_plan(req: RevisePlanRequest) -> Result<RevisePlanResult, String> {
    use crate::orchestrator::{
        default_db_path, graph_validate, EdgeKind, ExecutablePayload, GraphEdge, GraphNode,
        GraphRevision, GraphSnapshot, NodeKind, RoleRequirement, TaskService, TaskStore,
    };
    use crate::util::gen_id;

    let mut instance = super::proposal::ti_instance(&req.project_root, &req.task_id)?
        .ok_or("task instance not found")?;
    let graph_id = instance.graph_id.clone().ok_or("task has no graph")?;
    if instance.current_phase != "execution" {
        return Err("仅执行阶段任务支持方案修订".to_string());
    }

    // proposal 解析（与 validate 同 schema）
    let proposal_raw = std::fs::read_to_string(&req.proposal_path)
        .map_err(|e| format!("read proposal failed: {e}"))?;
    let proposal: serde_json::Value = serde_json::from_str(&proposal_raw)
        .map_err(|e| format!("parse proposal JSON failed: {e}"))?;
    if proposal.get("schema").and_then(|v| v.as_str()) != Some("jishu-flow-plan-proposal/v1") {
        return Err("unsupported proposal schema".to_string());
    }
    let nodes_arr = proposal
        .get("nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "proposal missing 'nodes' array".to_string())?;
    let requirement_path = instance.requirement_file.as_ref().map(|rel| {
        PathBuf::from(&req.project_root)
            .join(rel)
            .to_string_lossy()
            .into_owned()
    });

    // 既有图：保留 Goal 节点，可执行集按 proposal 重建（同 id = 更新语义）
    let store = TaskStore::open(&default_db_path())
        .map_err(|e| format!("open orchestrator store failed: {e}"))?;
    let graph = store
        .get_graph(&graph_id)
        .map_err(|e| format!("get graph failed: {e:?}"))?;
    let base_rev_id = graph
        .current_draft_revision
        .clone()
        .ok_or("graph has no draft revision")?;
    let base_snapshot = store
        .get_revision(&base_rev_id)
        .map_err(|e| format!("get revision failed: {e:?}"))?
        .snapshot()
        .map_err(|e| format!("snapshot failed: {e}"))?;
    let goal_node = base_snapshot
        .nodes
        .iter()
        .find(|node| node.node_kind == NodeKind::Goal)
        .cloned()
        .ok_or("goal node missing from graph")?;
    let goal_text = goal_node.title.clone();
    let base_nodes: std::collections::HashMap<&str, &GraphNode> = base_snapshot
        .nodes
        .iter()
        .map(|n| (n.node_id.as_str(), n))
        .collect();

    let mut snapshot_nodes: Vec<GraphNode> = vec![goal_node];
    let mut node_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for node_val in nodes_arr {
        let node_id = node_val
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("proposal node missing 'id'")?
            .to_string();
        if !node_ids.insert(node_id.clone()) {
            return Err(format!("duplicate node id: {node_id}"));
        }
        snapshot_nodes.push(rebuild_executable_node(
            node_val,
            nodes_arr,
            &goal_text,
            requirement_path.as_deref(),
            base_nodes.get(node_id.as_str()).copied(),
        )?);
    }
    let mut snapshot_edges: Vec<GraphEdge> = Vec::new();
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
    graph_validate(&snapshot).map_err(|e| format!("graph validation failed: {e:?}"))?;

    // 子 revision + 更新草稿
    let now = now_ms();
    let revision_id = gen_id("rev");
    let mut revision = GraphRevision::from_snapshot(
        &revision_id,
        &graph_id,
        Some(base_rev_id.clone()),
        &snapshot,
        "conductor-revise",
        now,
    )
    .map_err(|e| format!("create revision failed: {e}"))?;
    revision.change_summary = "Execution-phase plan revision (conductor)".to_string();
    revision
        .refresh_content_hash()
        .map_err(|e| format!("refresh content hash failed: {e}"))?;
    store
        .save_revision_and_update_draft(&graph_id, &base_rev_id, &revision, now)
        .map_err(|e| format!("save revision failed: {e}"))?;

    // run 进行中 → 应用修订（冻结已完成节点；新节点并入调度）；
    // run 已终态 → 增量续跑：新 revision 启动新 run，并结转此前已成功且未变更
    // 的节点（Succeeded 直接入库，引擎只调度新增/未完成节点，不重跑）。
    // v0.9.2 测试期修复：active_run_id 完成后被清空 → 回退 last_run_id 查旧 run
    // 状态（否则整个分支被跳过，新 revision 创建了但无人启动新 run，节点卡等待中）。
    // v0.9.2 二次修复：用既有 store 连接查 run 状态（此前 open_store_only 开新连接，
    // get_run 静默失败时整个 carry-over 分支被跳过且无任何日志——draft 更新了但
    // 无新 run，子节点收到旧 revision 的 dispatch prompt）。
    let reference_run_id = instance.active_run_id.clone().or_else(|| instance.last_run_id.clone());
    let mut run_updated = false;
    if let Some(run_id) = reference_run_id {
        let service = TaskService::open_store_only(
            TaskStore::open(&default_db_path())
                .map_err(|e| format!("reopen store for service failed: {e}"))?,
        );
        let run_result = service.get_run(&run_id);
        if let Err(ref e) = run_result {
            tracing::warn!("[revise] get_run({}) failed: {:?} — carry-over skipped", run_id, e);
        }
        if let Ok(run) = run_result {
            if !run.status.is_terminal() && run.active_revision_id != revision_id {
                let run_proposal = service
                    .propose_run_revision(&run_id, &revision_id)
                    .map_err(|e| format!("propose run revision failed: {e:?}"))?;
                service
                    .apply_run_revision(
                        &run_id,
                        &run_proposal.proposal_id,
                        run_proposal.expected_run_seq,
                    )
                    .map_err(|e| format!("apply run revision failed: {e:?}"))?;
                run_updated = true;
            } else if run.status.is_terminal() {
                // 结转集合：旧 run 中 Succeeded 且节点在新旧快照间未变更
                let old_runs = store
                    .get_node_runs(&run_id)
                    .map_err(|e| format!("get old node runs failed: {e}"))?;
                let old_snapshot = store
                    .get_revision(&run.active_revision_id)
                    .map_err(|e| format!("get run revision failed: {e}"))?
                    .snapshot()
                    .map_err(|e| format!("old snapshot failed: {e}"))?;
                let carried = select_carryover_nodes(&old_runs, &old_snapshot, &snapshot);

                let start =
                    super::run::task_launch_start_run(super::run::TaskLaunchStartRunRequest {
                        task_id: req.task_id.clone(),
                        project_root: req.project_root.clone(),
                        revision_id: revision_id.clone(),
                        idempotency_key: format!("revise-{}", gen_id("launch")),
                    })
                    .map_err(|e| format!("start carry-over run failed: {e}"))?;

                // 结转写入新 run（Succeeded + NodeResolved 事件，事件溯源投影同源；
                // 紧随 run 创建执行，引擎 tick（250ms）间隙内完成，竞窗极小）。
                let mut new_run_seq = store
                    .get_run(&start.run_id)
                    .map_err(|e| format!("reload new run failed: {e}"))?
                    .run_seq;
                for carried_run in &carried {
                    let mut seed = crate::orchestrator::domain::run::NodeRun::new(
                        gen_id("nr"),
                        &start.run_id,
                        &carried_run.node_id,
                        &revision_id,
                    );
                    seed.status = crate::orchestrator::domain::run::NodeRunStatus::Succeeded;
                    seed.started_at = carried_run.started_at;
                    seed.finished_at = carried_run.finished_at;
                    let events = vec![crate::orchestrator::build_event(
                        gen_id("evt"),
                        &start.run_id,
                        new_run_seq + 1,
                        crate::orchestrator::TaskEventType::NodeResolved,
                        "conductor-carryover",
                        now_ms(),
                        serde_json::to_value(
                            crate::orchestrator::events::payloads::NodeResolvedPayload {
                                node_run_id: seed.node_run_id.clone(),
                                node_id: carried_run.node_id.clone(),
                                final_status:
                                    crate::orchestrator::domain::run::NodeRunStatus::Succeeded,
                            },
                        )
                        .map_err(|e| format!("serialize carryover payload failed: {e}"))?,
                    )];
                    store
                        .save_execution_update(&seed, None, &[], &events, None, None)
                        .map_err(|e| format!("seed carryover node failed: {e}"))?;
                    new_run_seq += 1;
                }
                run_updated = true;
            }
        }
    }

    instance.updated_at = now_ms();
    open_store(&req.project_root)?.upsert(&instance)?;

    Ok(RevisePlanResult {
        success: true,
        revision_id: Some(revision_id),
        run_updated,
        error: None,
    })
}

/// 结转选择（纯函数）：旧 run 中 Succeeded、且节点在新旧快照间 JSON 等值
/// （未变更）者结转为已成功——新 run 只调度新增/未完成节点，不重跑。
pub(super) struct CarriedNode {
    pub(super) node_id: String,
    pub(super) started_at: Option<i64>,
    pub(super) finished_at: Option<i64>,
}

pub(super) fn select_carryover_nodes(
    old_runs: &[crate::orchestrator::domain::run::NodeRun],
    old_snapshot: &crate::orchestrator::GraphSnapshot,
    new_snapshot: &crate::orchestrator::GraphSnapshot,
) -> Vec<CarriedNode> {
    use crate::orchestrator::domain::run::NodeRunStatus;
    let mut carried = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for run in old_runs {
        if run.status != NodeRunStatus::Succeeded || !seen.insert(run.node_id.clone()) {
            continue;
        }
        let unchanged = old_snapshot
            .node_by_id(&run.node_id)
            .zip(new_snapshot.node_by_id(&run.node_id))
            .and_then(|(a, b)| Some(serde_json::to_value(a).ok()? == serde_json::to_value(b).ok()?))
            .unwrap_or(false);
        if unchanged {
            carried.push(CarriedNode {
                node_id: run.node_id.clone(),
                started_at: run.started_at,
                finished_at: run.finished_at,
            });
        }
    }
    carried
}

/// v0.9.2 评审 P1-1 修复：同 id 节点重建时**条件继承**画布指定的执行者约束。
///
/// proposal 管"做什么"（不含执行者语义），约束是用户画布意图（管"谁来做"）
/// ——修订不应清空。两条护栏：
/// ① 角色前提校验：约束按锁定时的角色表达（画布写入 role_id），proposal
///    新角色与之不符则前提作废，丢弃回退角色解析（防过期锁定遮蔽角色变更
///    ——调度中 locked_agent_id 为最高优先级，会压过角色解析）；
/// ② proposal 优先：仅当重建节点无显式约束时回填（将来 proposal 若扩展
///    执行者语义，显式声明永远赢过继承）。
fn inherited_assignment_constraint(
    base_node: Option<&crate::orchestrator::GraphNode>,
    new_role: &str,
) -> Option<crate::orchestrator::AgentAssignmentConstraint> {
    let constraint = base_node?.agent_assignment_constraint.as_ref()?;
    let premise = constraint.role_id.trim().to_lowercase();
    if !premise.is_empty() && premise != new_role.trim().to_lowercase() {
        return None;
    }
    Some(constraint.clone())
}

/// 单个可执行节点按 proposal 重建（纯函数，revise 与首建共用语义）：
/// 内容字段（职责/验收/角色/协作上下文/派发 prompt）全部取自新 proposal；
/// 同 id 时执行者约束经 [`inherited_assignment_constraint`] 条件继承。
#[allow(clippy::too_many_arguments)]
fn rebuild_executable_node(
    node_val: &serde_json::Value,
    nodes_arr: &[serde_json::Value],
    goal_text: &str,
    requirement_path: Option<&str>,
    base_node: Option<&crate::orchestrator::GraphNode>,
) -> Result<crate::orchestrator::GraphNode, String> {
    use crate::orchestrator::{ExecutablePayload, GraphNode, NodeKind, RoleRequirement};

    let node_id = node_val
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("proposal node missing 'id'")?
        .to_string();
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
    let acceptance = node_val
        .get("acceptance")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let role = node_val
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("developer")
        .to_string();
    // 协作上下文：上下游节点摘要（与 proposal.rs 同规则，从 proposal 机械投影）
    let deps = node_val
        .get("depends_on")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|d| d.as_str().map(str::to_string))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let upstream = deps
        .iter()
        .filter_map(|dep_id| {
            nodes_arr
                .iter()
                .find(|n| n.get("id").and_then(|v| v.as_str()) == Some(dep_id.as_str()))
                .map(|n| super::proposal::CollaboratorSummary {
                    node_id: dep_id.clone(),
                    title: n
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or(dep_id)
                        .to_string(),
                    responsibility: n
                        .get("responsibility")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
        })
        .collect::<Vec<_>>();
    let downstream = nodes_arr
        .iter()
        .filter(|n| {
            n.get("depends_on")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().any(|d| d.as_str() == Some(node_id.as_str())))
                .unwrap_or(false)
        })
        .map(|n| super::proposal::CollaboratorSummary {
            node_id: n
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            title: n
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            responsibility: n
                .get("responsibility")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect::<Vec<_>>();
    let collaboration = super::proposal::render_collaboration(&upstream, &downstream);
    let dispatch_prompt = super::proposal::compose_dispatch_prompt(
        goal_text,
        &title,
        &responsibility,
        &acceptance,
        collaboration.as_deref(),
        requirement_path,
    );
    let mut metadata = std::collections::HashMap::new();
    if !acceptance.is_empty() {
        metadata.insert("acceptance".to_string(), serde_json::Value::String(acceptance));
    }
    Ok(GraphNode {
        node_id,
        parent_id: Some("goal".to_string()),
        title,
        description: Some(responsibility.clone()),
        node_kind: NodeKind::Executable,
        input_contract: Default::default(),
        output_contract: Default::default(),
        role_requirement: Some(RoleRequirement {
            role_id: role.clone(),
            responsibility,
            required_capabilities: vec![],
            preferred_capabilities: vec![],
        }),
        capability_requirements: vec![],
        // P1-1：条件继承（见函数注释）；proposal 未携带约束时此值即最终值。
        agent_assignment_constraint: inherited_assignment_constraint(base_node, &role),
        policy: Default::default(),
        metadata,
        executable_payload: Some(ExecutablePayload::Dispatch {
            role_id: role,
            prompt: dispatch_prompt,
            project: None,
            session: None,
        }),
        loop_config: None,
        approval_gate_config: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 非执行阶段任务拒绝修订（守护：修订通道仅执行期开放）。
    #[test]
    fn revise_rejects_non_execution_phase() {
        let project =
            std::env::temp_dir().join(format!("jishu-revise-guard-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&project).unwrap();
        let project_root = project.to_string_lossy().to_string();
        mark_task_stage_session(
            &project_root,
            None,
            "requirements-session",
            "jishu-conductor-dev",
            "requirements",
            Some("Demo"),
        )
        .unwrap();

        let err = conductor_revise_plan(RevisePlanRequest {
            task_id: "task_nonexistent".to_string(),
            project_root: project_root.clone(),
            proposal_path: project.join("x.json").to_string_lossy().to_string(),
        })
        .unwrap_err();
        assert!(err.contains("task instance not found"), "{err}");

        let _ = std::fs::remove_dir_all(&project);
    }

    // ── P1-1 修复单测：执行者约束条件继承（内容新鲜度 + 角色前提）──

    use crate::orchestrator::{AgentAssignmentConstraint, GraphNode, NodeKind};

    fn base_node_with(constraint: Option<AgentAssignmentConstraint>) -> GraphNode {
        GraphNode {
            node_id: "node_dev".into(),
            parent_id: Some("goal".into()),
            title: "开发登录页面".into(),
            description: Some("旧职责".into()),
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: constraint,
            policy: Default::default(),
            metadata: Default::default(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }
    }

    fn locked_constraint(role: &str, agent: &str) -> AgentAssignmentConstraint {
        AgentAssignmentConstraint {
            role_id: role.into(),
            locked_agent_id: Some(agent.into()),
            allowed_agent_ids: vec![],
            denied_agent_ids: vec![],
            required_capabilities: vec![],
        }
    }

    fn proposal_node(role: &str, responsibility: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "node_dev",
            "title": "开发实现",
            "responsibility": responsibility,
            "acceptance": "验收标准",
            "role": role,
            "depends_on": [],
        })
    }

    /// 用户质疑场景（2026-09-12 讨论）：同 id 同角色、职责变更（加粒子效果）
    /// + 锁定继承 → 派发 prompt 必须含**新**职责（内容全量重建，不因继承变旧），
    /// 且 locked_agent_id 保留。
    #[test]
    fn rebuild_keeps_lock_and_composes_prompt_from_new_responsibility() {
        let base = base_node_with(Some(locked_constraint("developer", "jishu-self")));
        let node = rebuild_executable_node(
            &proposal_node("developer", "开发登录页面，并增加粒子动态效果"),
            &[proposal_node("developer", "开发登录页面，并增加粒子动态效果")],
            "登录 demo",
            None,
            Some(&base),
        )
        .unwrap();
        // 谁来做：锁定保留
        assert_eq!(
            node.agent_assignment_constraint.and_then(|c| c.locked_agent_id),
            Some("jishu-self".into())
        );
        // 做什么：派发 prompt 来自新职责（含新内容，不含旧职责字样）
        let prompt = match node.executable_payload {
            Some(crate::orchestrator::ExecutablePayload::Dispatch { prompt, .. }) => prompt,
            other => panic!("expected dispatch payload, got {other:?}"),
        };
        assert!(prompt.contains("粒子动态效果"), "prompt 应含新职责: {prompt}");
        assert!(!prompt.contains("旧职责"), "prompt 不应含旧职责: {prompt}");
        // 职责字段本体也是新的
        assert!(node.description.as_deref().unwrap_or("").contains("粒子动态效果"));
    }

    /// 角色前提校验：同 id 角色变更（developer→tester）→ 锁定按旧角色表达，
    /// 前提作废，丢弃回退角色解析（防过期锁定遮蔽角色变更）。
    #[test]
    fn rebuild_drops_lock_when_role_changes() {
        let base = base_node_with(Some(locked_constraint("developer", "jishu-self")));
        let node = rebuild_executable_node(
            &proposal_node("tester", "浏览器验收测试"),
            &[proposal_node("tester", "浏览器验收测试")],
            "登录 demo",
            None,
            Some(&base),
        )
        .unwrap();
        assert!(node.agent_assignment_constraint.is_none());
    }

    /// 新增节点（无 base）与无约束 base：均不继承。
    #[test]
    fn rebuild_no_inheritance_for_new_node_or_constrainless_base() {
        let fresh = rebuild_executable_node(
            &proposal_node("developer", "新节点职责"),
            &[proposal_node("developer", "新节点职责")],
            "goal",
            None,
            None,
        )
        .unwrap();
        assert!(fresh.agent_assignment_constraint.is_none());

        let constrainless = rebuild_executable_node(
            &proposal_node("developer", "x"),
            &[proposal_node("developer", "x")],
            "g",
            None,
            Some(&base_node_with(None)),
        )
        .unwrap();
        assert!(constrainless.agent_assignment_constraint.is_none());
    }

    /// 角色大小写/空白容错（画布与 proposal 的角色字符串形态可能不同）。
    #[test]
    fn inherited_constraint_role_comparison_is_case_insensitive() {
        let base = base_node_with(Some(locked_constraint(" Developer ", "codex")));
        assert!(inherited_assignment_constraint(Some(&base), "developer").is_some());
        assert!(inherited_assignment_constraint(Some(&base), "tester").is_none());
    }
}
