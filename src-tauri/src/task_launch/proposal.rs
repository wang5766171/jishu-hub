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

    // v0.9.2 需求5：提前取 TaskInstance——派发 prompt 需要需求文档上下文
    // （requirement_file 在执行链路此前零引用，是"原始需求遗漏"的根因之一）。
    let instance = ti_instance(&req.project_root, &req.task_id)?;
    let requirement_path = instance
        .as_ref()
        .and_then(|inst| inst.requirement_file.as_ref())
        .map(|rel| {
            PathBuf::from(&req.project_root)
                .join(rel)
                .to_string_lossy()
                .into_owned()
        });

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
        // v0.9.2 需求5：acceptance 不再在转图时丢弃——进 metadata（供 UI 展示
        // 验收要点）并参与派发 prompt 组装。
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
        // 协作上下文：上下游节点摘要（从 proposal 的节点与依赖机械投影）
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
                    .map(|n| CollaboratorSummary {
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
            .map(|n| CollaboratorSummary {
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
        let collaboration = render_collaboration(&upstream, &downstream);
        let dispatch_prompt = compose_dispatch_prompt(
            &goal_text,
            &title,
            &responsibility,
            &acceptance,
            collaboration.as_deref(),
            requirement_path.as_deref(),
        );

        let mut metadata = std::collections::HashMap::new();
        if !acceptance.is_empty() {
            metadata.insert(
                "acceptance".to_string(),
                serde_json::Value::String(acceptance.clone()),
            );
        }

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
            metadata,
            executable_payload: Some(ExecutablePayload::Dispatch {
                role_id: role,
                prompt: dispatch_prompt,
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

/// 取 TaskInstance（不存在时 None，不视为错误——提案可先于实例登记到达）。
pub(super) fn ti_instance(
    project_root: &str,
    task_id: &str,
) -> Result<Option<TaskLaunchInstance>, String> {
    let store = open_store(project_root)?;
    store.get(task_id)
}

/// 协作摘要中单节点职责的截断上限（字符数）——契约要点足够，防 prompt 膨胀。
const COLLABORATOR_SUMMARY_MAX_CHARS: usize = 240;

/// 截断到字符边界的摘要。
fn truncate_chars(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(max).collect();
    format!("{cut}…")
}

/// 协作节点摘要（id/标题/职责截断）。
pub(super) struct CollaboratorSummary {
    pub(super) node_id: String,
    pub(super) title: String,
    pub(super) responsibility: String,
}

/// 渲染【协作上下文】：前置节点（其产出是本节点的输入）与后继节点（依赖本节点的产出）。
/// 多节点一致性来自同一份计划文本的机械投影——各节点看到相同契约，而非各自解读全量需求。
pub(super) fn render_collaboration(
    upstream: &[CollaboratorSummary],
    downstream: &[CollaboratorSummary],
) -> Option<String> {
    if upstream.is_empty() && downstream.is_empty() {
        return None;
    }
    let mut sections: Vec<String> = Vec::new();
    if !upstream.is_empty() {
        let lines = upstream
            .iter()
            .map(|c| {
                format!(
                    "- {}（{}）：{}",
                    c.title,
                    c.node_id,
                    truncate_chars(&c.responsibility, COLLABORATOR_SUMMARY_MAX_CHARS)
                )
            })
            .collect::<Vec<_>>();
        sections.push(format!(
            "前置节点（其产出是本节点的输入）：
{}",
            lines.join(
                "
"
            )
        ));
    }
    if !downstream.is_empty() {
        let lines = downstream
            .iter()
            .map(|c| {
                format!(
                    "- {}（{}）：{}",
                    c.title,
                    c.node_id,
                    truncate_chars(&c.responsibility, COLLABORATOR_SUMMARY_MAX_CHARS)
                )
            })
            .collect::<Vec<_>>();
        sections.push(format!(
            "后继节点（依赖本节点的产出，注意为其留好衔接）：
{}",
            lines.join(
                "
"
            )
        ));
    }
    Some(sections.join(
        "

",
    ))
}

/// v0.9.2 需求5（2026-09-09 用户裁决修正：全量需求不下发）节点派发 prompt 组装：
/// 任务目标 / 本节点职责（conductor 规划时梳理的自包含摘要）/ 验收标准 /
/// 协作上下文（图结构机械投影的上下游契约）/ 需求文档**路径引用**（需要全局
/// 背景时节点自行读取，不再内嵌全文——避免多节点各自解读全量需求导致实现
/// 前后不一致，保持拆分协作的意义）。
pub(super) fn compose_dispatch_prompt(
    goal: &str,
    title: &str,
    responsibility: &str,
    acceptance: &str,
    collaboration: Option<&str>,
    requirement_doc_path: Option<&str>,
) -> String {
    let mut prompt = String::new();
    prompt.push_str(
        "【任务目标】
",
    );
    prompt.push_str(goal.trim());
    prompt.push_str(
        "

【本节点职责】（节点：",
    );
    prompt.push_str(title.trim());
    prompt.push_str(
        "）
",
    );
    if responsibility.trim().is_empty() {
        prompt.push_str("（未填写，以任务目标与验收标准为准）");
    } else {
        prompt.push_str(responsibility.trim());
    }
    prompt.push_str(
        "

【验收标准】
",
    );
    if acceptance.trim().is_empty() {
        prompt.push_str("（未填写，以任务目标为准）");
    } else {
        prompt.push_str(acceptance.trim());
    }
    if let Some(collab) = collaboration {
        prompt.push_str(
            "

【协作上下文】（来自任务计划，多节点协作契约）
",
        );
        prompt.push_str(collab);
    }
    if let Some(path) = requirement_doc_path {
        prompt.push_str(
            "

【需求文档】完整需求见：",
        );
        prompt.push_str(path);
        prompt.push_str("（如需全局背景可读取；本节点职责与验收标准为权威口径，与需求文档冲突时先在职责口径内执行并反馈疑问）");
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_prompt_composes_sections_and_path_reference_only() {
        let prompt = compose_dispatch_prompt(
            "完成配置迁移",
            "数据迁移脚本",
            "编写迁移脚本",
            "迁移后数据完整",
            Some(
                "前置节点（其产出是本节点的输入）：
- 结构梳理（n1）：扫描现有配置",
            ),
            Some("/proj/REQUIREMENTS.md"),
        );
        assert!(prompt.contains(
            "【任务目标】
完成配置迁移"
        ));
        assert!(prompt.contains(
            "【本节点职责】（节点：数据迁移脚本）
编写迁移脚本"
        ));
        assert!(prompt.contains(
            "【验收标准】
迁移后数据完整"
        ));
        assert!(prompt.contains("【协作上下文】"));
        assert!(prompt.contains("前置节点"));
        // 需求文档仅路径引用，不内嵌全文
        assert!(prompt.contains("/proj/REQUIREMENTS.md"));
        assert!(prompt.contains("如需全局背景可读取"));
        assert!(!prompt.contains("# 开发登录 Demo"));
    }

    #[test]
    fn dispatch_prompt_falls_back_when_fields_missing() {
        let prompt = compose_dispatch_prompt("目标", "节点A", "", "", None, None);
        assert!(prompt.contains("（未填写，以任务目标与验收标准为准）"));
        assert!(!prompt.contains("【协作上下文】"));
        assert!(!prompt.contains("【需求文档】"));
    }

    #[test]
    fn collaboration_summary_truncates_long_responsibility() {
        let long = "字".repeat(500);
        let rendered = render_collaboration(
            &[CollaboratorSummary {
                node_id: "n1".into(),
                title: "上游".into(),
                responsibility: long.clone(),
            }],
            &[],
        )
        .unwrap();
        assert!(rendered.contains("上游（n1）："));
        assert!(rendered.chars().count() < 500);
        assert!(rendered.ends_with("…"));
        // 双向均空 → None
        assert!(render_collaboration(&[], &[]).is_none());
    }
}
