use crate::orchestrator::domain::graph::{GraphSnapshot, NodeKind};

use crate::orchestrator::domain::state_machine::ValidationError;
use std::path::{Component, Path};

/// Validate semantic rules beyond structural integrity.
///
/// Checks:
/// - Exactly one Goal node
/// - Goal node has no parent
/// - Executable nodes have a payload
/// - Loop nodes have body, termination and budget
/// - Edge targets are not Goal nodes
pub fn validate_semantics(
    snapshot: &GraphSnapshot,
    warnings: &mut Vec<String>,
) -> Result<(), ValidationError> {
    // Exactly one Goal node.
    let goals: Vec<_> = snapshot
        .nodes
        .iter()
        .filter(|n| n.node_kind == NodeKind::Goal)
        .collect();

    match goals.len() {
        0 => {
            return Err(ValidationError::MissingGoal);
        }
        1 => {
            if goals[0].parent_id.is_some() {
                return Err(ValidationError::GoalWithParent {
                    node_id: goals[0].node_id.clone(),
                });
            }
        }
        _ => {
            return Err(ValidationError::MultipleGoals);
        }
    }

    for edge in &snapshot.edges {
        if snapshot
            .node_by_id(&edge.target_node_id)
            .is_some_and(|node| node.node_kind == NodeKind::Goal)
        {
            return Err(ValidationError::GoalDependencyTarget {
                edge_id: edge.edge_id.clone(),
                node_id: edge.target_node_id.clone(),
            });
        }
    }

    // Executable nodes must have a payload.
    for node in &snapshot.nodes {
        if node.node_kind == NodeKind::Executable && node.executable_payload.is_none() {
            return Err(ValidationError::MissingExecutablePayload {
                node_id: node.node_id.clone(),
            });
        }
        for path in node
            .policy
            .read_set
            .iter()
            .chain(node.policy.write_set.iter())
            .chain(node.policy.resource_requirements.directory_locks.iter())
        {
            validate_project_relative_path(path)?;
        }
        if !node.policy.read_set.is_empty() && !node.policy.permission_scope.can_read_files {
            return Err(ValidationError::PermissionMismatch {
                node_id: node.node_id.clone(),
                detail: "read_set requires can_read_files".into(),
            });
        }
        if !node.policy.write_set.is_empty() && !node.policy.permission_scope.can_write_files {
            return Err(ValidationError::PermissionMismatch {
                node_id: node.node_id.clone(),
                detail: "write_set requires can_write_files".into(),
            });
        }
    }

    // Loop nodes must have body, termination, and budget.
    let mut loop_owners = std::collections::HashMap::<String, String>::new();
    for node in &snapshot.nodes {
        if node.node_kind == NodeKind::ControlLoop {
            if let Some(config) = &node.loop_config {
                if config.body_node_ids.is_empty() {
                    return Err(ValidationError::EmptyLoopBody {
                        node_id: node.node_id.clone(),
                    });
                }
                if config.termination_condition.is_empty() {
                    return Err(ValidationError::MissingTermination {
                        node_id: node.node_id.clone(),
                    });
                }
                let has_budget = config.max_iterations.is_some()
                    || config.deadline_ms.is_some()
                    || config.token_budget.is_some()
                    || config.cost_budget_usd.is_some();
                if !has_budget {
                    return Err(ValidationError::MissingLoopBudget {
                        node_id: node.node_id.clone(),
                    });
                }
                for body_node_id in &config.body_node_ids {
                    let Some(body_node) = snapshot.node_by_id(body_node_id) else {
                        return Err(ValidationError::InvalidLoopBody {
                            node_id: node.node_id.clone(),
                            body_node_id: body_node_id.clone(),
                            reason: "node does not exist".into(),
                        });
                    };
                    if body_node.node_kind == NodeKind::Goal || body_node_id == &node.node_id {
                        return Err(ValidationError::InvalidLoopBody {
                            node_id: node.node_id.clone(),
                            body_node_id: body_node_id.clone(),
                            reason: "goal and the loop controller itself cannot be body nodes"
                                .into(),
                        });
                    }
                    if let Some(owner) =
                        loop_owners.insert(body_node_id.clone(), node.node_id.clone())
                    {
                        return Err(ValidationError::InvalidLoopBody {
                            node_id: node.node_id.clone(),
                            body_node_id: body_node_id.clone(),
                            reason: format!("already owned by loop {owner}"),
                        });
                    }
                }
                if let crate::orchestrator::domain::graph::EvaluatorSpec::NodeRef {
                    node_id: evaluator_node_id,
                } = &config.evaluator
                {
                    if !config.body_node_ids.contains(evaluator_node_id) {
                        return Err(ValidationError::InvalidLoopBody {
                            node_id: node.node_id.clone(),
                            body_node_id: evaluator_node_id.clone(),
                            reason: "node evaluator must belong to the loop body".into(),
                        });
                    }
                }
            } else {
                return Err(ValidationError::MissingTermination {
                    node_id: node.node_id.clone(),
                });
            }
        }
    }

    // Warn about orphan nodes (no parent, not goal, not root-level group).
    let goal_child_ids: std::collections::HashSet<String> = snapshot
        .nodes
        .iter()
        .filter(|n| n.parent_id.is_none() && n.node_kind != NodeKind::Goal)
        .map(|n| n.node_id.clone())
        .collect();

    if !goal_child_ids.is_empty() && goals.len() == 1 {
        let goal_id = &goals[0].node_id;
        for id in &goal_child_ids {
            if id != goal_id {
                warnings.push(format!(
                    "Node {id} has no parent and is not the goal; consider grouping it"
                ));
            }
        }
    }

    // Warn about nodes with no incoming or outgoing edges (except goal and groups).
    for node in &snapshot.nodes {
        if node.node_kind == NodeKind::Executable {
            let has_incoming = snapshot
                .edges
                .iter()
                .any(|e| e.target_node_id == node.node_id);
            let has_outgoing = snapshot
                .edges
                .iter()
                .any(|e| e.source_node_id == node.node_id);
            if !has_incoming && !has_outgoing {
                warnings.push(format!(
                    "Executable node {} has no dependencies or dependents",
                    node.node_id
                ));
            }
        }
    }

    Ok(())
}

fn validate_project_relative_path(path: &Path) -> Result<(), ValidationError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(ValidationError::PathEscape {
            path: path.display().to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::domain::graph::{
        EdgeKind, ExecutablePayload, GraphEdge, GraphNode, NodeKind,
    };
    use crate::orchestrator::domain::policy::NodePolicy;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn make_goal() -> GraphNode {
        GraphNode {
            node_id: "goal".into(),
            parent_id: None,
            title: "Goal".into(),
            description: Some("Do X".into()),
            node_kind: NodeKind::Goal,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: HashMap::new(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }
    }

    fn make_exec(id: &str) -> GraphNode {
        GraphNode {
            node_id: id.into(),
            parent_id: Some("goal".into()),
            title: id.into(),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: HashMap::new(),
            executable_payload: Some(ExecutablePayload::Shell {
                command: "echo hi".into(),
                cwd: None,
                timeout_ms: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        }
    }

    #[test]
    fn valid_graph_passes() {
        let snapshot = GraphSnapshot {
            nodes: vec![make_goal(), make_exec("a"), make_exec("b")],
            edges: vec![
                GraphEdge {
                    edge_id: "e1".into(),
                    source_node_id: "a".into(),
                    target_node_id: "b".into(),
                    kind: EdgeKind::ControlDependency,
                },
                GraphEdge {
                    edge_id: "e2".into(),
                    source_node_id: "goal".into(),
                    target_node_id: "a".into(),
                    kind: EdgeKind::ControlDependency,
                },
            ],
        };
        let mut warnings = vec![];
        assert!(validate_semantics(&snapshot, &mut warnings).is_ok());
    }

    #[test]
    fn multiple_goals_fails() {
        let mut goal2 = make_goal();
        goal2.node_id = "goal2".into();
        let snapshot = GraphSnapshot {
            nodes: vec![make_goal(), goal2],
            edges: vec![],
        };
        let mut warnings = vec![];
        assert!(validate_semantics(&snapshot, &mut warnings).is_err());
    }

    #[test]
    fn missing_goal_fails() {
        let snapshot = GraphSnapshot {
            nodes: vec![make_exec("a")],
            edges: vec![],
        };
        let mut warnings = vec![];
        assert_eq!(
            validate_semantics(&snapshot, &mut warnings),
            Err(ValidationError::MissingGoal)
        );
    }

    #[test]
    fn edge_targeting_goal_fails() {
        let snapshot = GraphSnapshot {
            nodes: vec![make_goal(), make_exec("a")],
            edges: vec![GraphEdge {
                edge_id: "e1".into(),
                source_node_id: "a".into(),
                target_node_id: "goal".into(),
                kind: EdgeKind::ControlDependency,
            }],
        };
        let mut warnings = vec![];
        assert!(matches!(
            validate_semantics(&snapshot, &mut warnings),
            Err(ValidationError::GoalDependencyTarget { .. })
        ));
    }

    #[test]
    fn goal_with_parent_fails() {
        let mut goal = make_goal();
        goal.parent_id = Some("other".into());
        let snapshot = GraphSnapshot {
            nodes: vec![goal, make_exec("other")],
            edges: vec![],
        };
        let mut warnings = vec![];
        let result = validate_semantics(&snapshot, &mut warnings);
        assert!(result.is_err());
    }

    #[test]
    fn executable_without_payload_fails() {
        let snapshot = GraphSnapshot {
            nodes: vec![
                make_goal(),
                GraphNode {
                    node_id: "a".into(),
                    parent_id: Some("goal".into()),
                    title: "A".into(),
                    description: None,
                    node_kind: NodeKind::Executable,
                    input_contract: Default::default(),
                    output_contract: Default::default(),
                    role_requirement: None,
                    capability_requirements: vec![],
                    agent_assignment_constraint: None,
                    policy: Default::default(),
                    metadata: HashMap::new(),
                    executable_payload: None,
                    loop_config: None,
                    approval_gate_config: None,
                },
            ],
            edges: vec![],
        };
        let mut warnings = vec![];
        assert!(validate_semantics(&snapshot, &mut warnings).is_err());
    }

    #[test]
    fn loop_without_budget_fails() {
        use crate::orchestrator::domain::graph::LoopControllerConfig;
        let loop_node = GraphNode {
            node_id: "loop1".into(),
            parent_id: Some("goal".into()),
            title: "Loop".into(),
            description: None,
            node_kind: NodeKind::ControlLoop,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: HashMap::new(),
            executable_payload: None,
            loop_config: Some(LoopControllerConfig {
                body_node_ids: vec!["a".into()],
                evaluator: crate::orchestrator::domain::graph::EvaluatorSpec::NodeRef {
                    node_id: "a".into(),
                },
                interval_ms: 5000,
                backoff_multiplier: None,
                max_interval_ms: None,
                termination_condition: "health_ok".into(),
                max_iterations: None,
                deadline_ms: None,
                token_budget: None,
                cost_budget_usd: None,
                no_progress_threshold: None,
                escalation_policy: "human".into(),
            }),
            approval_gate_config: None,
        };
        let snapshot = GraphSnapshot {
            nodes: vec![make_goal(), make_exec("a"), loop_node],
            edges: vec![],
        };
        let mut warnings = vec![];
        let result = validate_semantics(&snapshot, &mut warnings);
        assert!(result.is_err());
    }

    #[test]
    fn orphan_node_warns() {
        let mut orphan = make_exec("orphan");
        orphan.parent_id = None;
        let snapshot = GraphSnapshot {
            nodes: vec![make_goal(), orphan],
            edges: vec![],
        };
        let mut warnings = vec![];
        validate_semantics(&snapshot, &mut warnings).unwrap();
        assert!(warnings.iter().any(|w| w.contains("orphan")));
    }

    #[test]
    fn policy_paths_must_be_project_relative() {
        let mut node = make_exec("escape");
        node.policy.permission_scope.can_write_files = true;
        node.policy.write_set = vec![PathBuf::from("../outside")];
        let snapshot = GraphSnapshot {
            nodes: vec![make_goal(), node],
            edges: vec![],
        };
        let mut warnings = vec![];
        assert!(matches!(
            validate_semantics(&snapshot, &mut warnings),
            Err(ValidationError::PathEscape { .. })
        ));
    }

    #[test]
    fn declared_write_set_requires_write_permission() {
        let mut node = make_exec("writer");
        node.policy.write_set = vec![PathBuf::from("src")];
        let snapshot = GraphSnapshot {
            nodes: vec![make_goal(), node],
            edges: vec![],
        };
        let mut warnings = vec![];
        assert!(matches!(
            validate_semantics(&snapshot, &mut warnings),
            Err(ValidationError::PermissionMismatch { .. })
        ));
    }
}
