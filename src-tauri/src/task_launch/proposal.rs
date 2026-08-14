use super::*;

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
