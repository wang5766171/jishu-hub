use serde::{Deserialize, Serialize};

use crate::orchestrator::domain::graph::{
    AgentAssignmentConstraint, Contract, EdgeKind, ExecutablePayload, GraphEdge, GraphNode,
    GraphSnapshot, LoopControllerConfig, NodeKind, RoleRequirement,
};
use crate::orchestrator::domain::policy::NodePolicy;
use crate::orchestrator::domain::revision::{
    diff_snapshots, GraphRevision, PlannerPolicyRef, RevisionDiff, SkillRef, TemplateRef,
};
use crate::orchestrator::domain::state_machine::ValidationError;

/// Unified GraphCommand protocol.
/// Canvas, forms, command palette and AI must all use this.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum GraphCommand {
    AddNode {
        command_id: String,
        node: GraphNode,
    },
    RemoveNode {
        command_id: String,
        node_id: String,
    },
    ReparentNode {
        command_id: String,
        node_id: String,
        new_parent_id: Option<String>,
    },
    ReorderNode {
        command_id: String,
        node_id: String,
        before_sibling: Option<String>,
        after_sibling: Option<String>,
    },
    UpdateNode {
        command_id: String,
        node_id: String,
        patch: NodePatch,
    },
    AddEdge {
        command_id: String,
        edge: GraphEdge,
    },
    RemoveEdge {
        command_id: String,
        edge_id: String,
    },
    GroupNodes {
        command_id: String,
        node_ids: Vec<String>,
        group_node: GraphNode,
    },
    UngroupNodes {
        command_id: String,
        group_node_id: String,
    },
    UpdatePolicy {
        command_id: String,
        node_id: String,
        policy: NodePolicy,
    },
    SetGoal {
        command_id: String,
        goal_node: GraphNode,
    },
}

impl GraphCommand {
    pub fn command_id(&self) -> &str {
        match self {
            Self::AddNode { command_id, .. }
            | Self::RemoveNode { command_id, .. }
            | Self::ReparentNode { command_id, .. }
            | Self::ReorderNode { command_id, .. }
            | Self::UpdateNode { command_id, .. }
            | Self::AddEdge { command_id, .. }
            | Self::RemoveEdge { command_id, .. }
            | Self::GroupNodes { command_id, .. }
            | Self::UngroupNodes { command_id, .. }
            | Self::UpdatePolicy { command_id, .. }
            | Self::SetGoal { command_id, .. } => command_id,
        }
    }
}

/// Patch for partial node updates.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodePatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub node_kind: Option<NodeKind>,
    #[serde(default)]
    pub executable_payload: Option<Option<ExecutablePayload>>,
    #[serde(default)]
    pub role_requirement: Option<Option<RoleRequirement>>,
    #[serde(default)]
    pub capability_requirements: Option<Vec<String>>,
    #[serde(default)]
    pub loop_config: Option<Option<LoopControllerConfig>>,
    #[serde(default)]
    pub agent_assignment_constraint: Option<Option<AgentAssignmentConstraint>>,
    /// 验收契约（output_contract.description 即「验收标准」）。B4 二次编排「调整节点」
    /// 需可改验收，故补此字段。注：output_contract 本身非 Option（与 executable_payload 不同），
    /// 故用单层 Option——Some 即覆盖，缺省（None）即不改。
    #[serde(default)]
    pub output_contract: Option<Contract>,
}

/// Input for creating a new task graph.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CreateGraphInput {
    pub title: String,
    pub goal: String,
    pub project_root: String,
    pub owner: String,
    #[serde(default)]
    pub skill_refs: Vec<SkillRef>,
    #[serde(default)]
    pub template_refs: Vec<TemplateRef>,
    #[serde(default)]
    pub planner_policy_refs: Vec<PlannerPolicyRef>,
}

/// Result of applying commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevisionResult {
    pub revision: GraphRevision,
    pub diff: Option<RevisionDiff>,
}

/// Apply a sequence of commands to a snapshot, producing a new snapshot.
pub fn apply_commands(
    snapshot: &GraphSnapshot,
    commands: &[GraphCommand],
) -> Result<GraphSnapshot, ValidationError> {
    let mut result = snapshot.clone();

    for cmd in commands {
        apply_single_command(&mut result, cmd)?;
    }

    Ok(result)
}

fn apply_single_command(
    snapshot: &mut GraphSnapshot,
    cmd: &GraphCommand,
) -> Result<(), ValidationError> {
    match cmd {
        GraphCommand::AddNode { node, .. } => {
            if snapshot.nodes.iter().any(|n| n.node_id == node.node_id) {
                return Err(ValidationError::DuplicateNodeId);
            }
            snapshot.nodes.push(node.clone());
        }
        GraphCommand::RemoveNode { node_id, .. } => {
            if snapshot.node_by_id(node_id).is_none() {
                return Err(ValidationError::DanglingEdge {
                    edge_id: String::new(),
                    missing: node_id.clone(),
                });
            }
            // Also remove edges connected to this node.
            snapshot
                .edges
                .retain(|e| e.source_node_id != *node_id && e.target_node_id != *node_id);
            // Reparent children to the removed node's parent.
            let parent_id = snapshot
                .node_by_id(node_id)
                .and_then(|n| n.parent_id.clone());
            snapshot.nodes.retain(|n| n.node_id != *node_id);
            // Update children's parent
            for node in &mut snapshot.nodes {
                if node.parent_id.as_deref() == Some(node_id.as_str()) {
                    node.parent_id = parent_id.clone();
                }
            }
        }
        GraphCommand::ReparentNode {
            node_id,
            new_parent_id,
            ..
        } => {
            let node =
                snapshot
                    .node_by_id_mut(node_id)
                    .ok_or_else(|| ValidationError::DanglingEdge {
                        edge_id: String::new(),
                        missing: node_id.clone(),
                    })?;
            node.parent_id = new_parent_id.clone();
        }
        GraphCommand::ReorderNode {
            node_id,
            before_sibling: _,
            after_sibling: _,
            ..
        } => {
            // Reordering is a metadata concern; the execution order is determined
            // by DAG edges, not array position. We validate the node exists.
            if !snapshot.nodes.iter().any(|n| n.node_id == *node_id) {
                return Err(ValidationError::DanglingEdge {
                    edge_id: String::new(),
                    missing: node_id.clone(),
                });
            }
        }
        GraphCommand::UpdateNode { node_id, patch, .. } => {
            let node =
                snapshot
                    .node_by_id_mut(node_id)
                    .ok_or_else(|| ValidationError::DanglingEdge {
                        edge_id: String::new(),
                        missing: node_id.clone(),
                    })?;

            if let Some(title) = &patch.title {
                node.title = title.clone();
            }
            if let Some(description) = &patch.description {
                node.description = description.clone();
            }
            if let Some(kind) = &patch.node_kind {
                node.node_kind = kind.clone();
            }
            if let Some(payload) = &patch.executable_payload {
                node.executable_payload = payload.clone();
            }
            if let Some(role) = &patch.role_requirement {
                node.role_requirement = role.clone();
            }
            if let Some(caps) = &patch.capability_requirements {
                node.capability_requirements = caps.clone();
            }
            if let Some(constraint) = &patch.agent_assignment_constraint {
                node.agent_assignment_constraint = constraint.clone();
            }
            if let Some(loop_config) = &patch.loop_config {
                node.loop_config = loop_config.clone();
            }
            if let Some(contract) = &patch.output_contract {
                node.output_contract = contract.clone();
            }
        }
        GraphCommand::AddEdge { edge, .. } => {
            if edge.source_node_id == edge.target_node_id {
                return Err(ValidationError::SelfLoopEdge {
                    edge_id: edge.edge_id.clone(),
                    node_id: edge.source_node_id.clone(),
                });
            }
            if snapshot.edges.iter().any(|e| e.edge_id == edge.edge_id) {
                return Err(ValidationError::DuplicateEdgeId {
                    edge_id: edge.edge_id.clone(),
                });
            }
            if snapshot.edges.iter().any(|e| {
                e.source_node_id == edge.source_node_id
                    && e.target_node_id == edge.target_node_id
                    && e.kind == edge.kind
            }) {
                return Err(ValidationError::DuplicateEdge {
                    source_node: edge.source_node_id.clone(),
                    target_node: edge.target_node_id.clone(),
                });
            }
            snapshot.edges.push(edge.clone());
        }
        GraphCommand::RemoveEdge { edge_id, .. } => {
            snapshot.edges.retain(|e| e.edge_id != *edge_id);
        }
        GraphCommand::GroupNodes {
            node_ids,
            group_node,
            ..
        } => {
            // Validate all node_ids exist.
            for id in node_ids {
                if snapshot.node_by_id(id).is_none() {
                    return Err(ValidationError::DanglingEdge {
                        edge_id: String::new(),
                        missing: id.clone(),
                    });
                }
            }
            // Add the group node.
            if snapshot
                .nodes
                .iter()
                .any(|n| n.node_id == group_node.node_id)
            {
                return Err(ValidationError::DuplicateNodeId);
            }
            snapshot.nodes.push(group_node.clone());
            // Reparent the nodes.
            for id in node_ids {
                if let Some(node) = snapshot.node_by_id_mut(id) {
                    node.parent_id = Some(group_node.node_id.clone());
                }
            }
        }
        GraphCommand::UngroupNodes { group_node_id, .. } => {
            let parent_id = snapshot
                .node_by_id(group_node_id)
                .and_then(|n| n.parent_id.clone());
            // Reparent children to the group's parent.
            for node in &mut snapshot.nodes {
                if node.parent_id.as_deref() == Some(group_node_id.as_str()) {
                    node.parent_id = parent_id.clone();
                }
            }
            // Remove the group node.
            snapshot.nodes.retain(|n| n.node_id != *group_node_id);
        }
        GraphCommand::UpdatePolicy {
            node_id, policy, ..
        } => {
            let node =
                snapshot
                    .node_by_id_mut(node_id)
                    .ok_or_else(|| ValidationError::DanglingEdge {
                        edge_id: String::new(),
                        missing: node_id.clone(),
                    })?;
            node.policy = policy.clone();
        }
        GraphCommand::SetGoal { goal_node, .. } => {
            let old_goal_ids: Vec<String> = snapshot
                .nodes
                .iter()
                .filter(|node| node.node_kind == NodeKind::Goal)
                .map(|node| node.node_id.clone())
                .collect();
            snapshot
                .nodes
                .retain(|node| node.node_kind != NodeKind::Goal);
            for node in &mut snapshot.nodes {
                if node
                    .parent_id
                    .as_ref()
                    .is_some_and(|parent_id| old_goal_ids.contains(parent_id))
                {
                    node.parent_id = Some(goal_node.node_id.clone());
                }
            }
            for edge in &mut snapshot.edges {
                if old_goal_ids.contains(&edge.source_node_id) {
                    edge.source_node_id = goal_node.node_id.clone();
                }
                if old_goal_ids.contains(&edge.target_node_id) {
                    edge.target_node_id = goal_node.node_id.clone();
                }
            }
            snapshot.nodes.push(goal_node.clone());
        }
    }

    Ok(())
}

/// Create a new empty graph snapshot with a goal node.
pub fn graph_create(input: &CreateGraphInput) -> GraphSnapshot {
    let goal_node = GraphNode {
        node_id: "goal".to_string(),
        parent_id: None,
        title: input.title.clone(),
        description: Some(input.goal.clone()),
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
    };

    GraphSnapshot {
        nodes: vec![goal_node],
        edges: vec![],
    }
}

/// Validate a snapshot fully (references, DAG, hierarchy, semantics).
pub fn graph_validate(snapshot: &GraphSnapshot) -> Result<Vec<String>, ValidationError> {
    let mut warnings = Vec::new();

    snapshot.validate_references()?;
    snapshot.validate_parent_hierarchy()?;
    snapshot.topological_order()?;
    super::validate::validate_semantics(snapshot, &mut warnings)?;

    Ok(warnings)
}

/// Compute diff between two revisions' snapshots.
pub fn graph_diff(
    from: &GraphRevision,
    to: &GraphRevision,
) -> Result<RevisionDiff, serde_json::Error> {
    let from_snapshot = from.snapshot()?;
    let to_snapshot = to.snapshot()?;
    Ok(diff_snapshots(
        &from_snapshot,
        &to_snapshot,
        &from.revision_id,
        &to.revision_id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::domain::graph::EdgeKind;
    use std::collections::HashMap;

    fn make_executable(id: &str) -> GraphNode {
        GraphNode {
            node_id: id.into(),
            parent_id: None,
            title: format!("Node {id}"),
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
                command: "echo hello".into(),
                cwd: None,
                timeout_ms: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        }
    }

    fn empty_snapshot() -> GraphSnapshot {
        GraphSnapshot {
            nodes: vec![GraphNode {
                node_id: "goal".into(),
                parent_id: None,
                title: "Goal".into(),
                description: Some("Do something".into()),
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
            }],
            edges: vec![],
        }
    }

    #[test]
    fn add_node_command() {
        let snapshot = empty_snapshot();
        let commands = vec![GraphCommand::AddNode {
            command_id: "c1".into(),
            node: make_executable("a"),
        }];
        let result = apply_commands(&snapshot, &commands).unwrap();
        assert_eq!(result.nodes.len(), 2);
    }

    #[test]
    fn add_duplicate_node_fails() {
        let snapshot = empty_snapshot();
        let commands = vec![
            GraphCommand::AddNode {
                command_id: "c1".into(),
                node: make_executable("a"),
            },
            GraphCommand::AddNode {
                command_id: "c2".into(),
                node: make_executable("a"),
            },
        ];
        let result = apply_commands(&snapshot, &commands);
        assert!(result.is_err());
    }

    #[test]
    fn add_remove_edge() {
        let mut snapshot = empty_snapshot();
        snapshot.nodes.push(make_executable("a"));
        snapshot.nodes.push(make_executable("b"));

        let commands = vec![
            GraphCommand::AddEdge {
                command_id: "c1".into(),
                edge: GraphEdge {
                    edge_id: "e1".into(),
                    source_node_id: "a".into(),
                    target_node_id: "b".into(),
                    kind: EdgeKind::ControlDependency,
                },
            },
            GraphCommand::RemoveEdge {
                command_id: "c2".into(),
                edge_id: "e1".into(),
            },
        ];
        let result = apply_commands(&snapshot, &commands).unwrap();
        assert!(result.edges.is_empty());
    }

    #[test]
    fn self_loop_edge_fails() {
        let mut snapshot = empty_snapshot();
        snapshot.nodes.push(make_executable("a"));

        let commands = vec![GraphCommand::AddEdge {
            command_id: "c1".into(),
            edge: GraphEdge {
                edge_id: "e1".into(),
                source_node_id: "a".into(),
                target_node_id: "a".into(),
                kind: EdgeKind::ControlDependency,
            },
        }];
        let result = apply_commands(&snapshot, &commands);
        assert!(result.is_err());
    }

    #[test]
    fn group_ungroup_nodes() {
        let mut snapshot = empty_snapshot();
        snapshot.nodes.push(make_executable("a"));
        snapshot.nodes.push(make_executable("b"));

        let group_node = GraphNode {
            node_id: "phase1".into(),
            parent_id: None,
            title: "Phase 1".into(),
            description: None,
            node_kind: NodeKind::Group,
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
        };

        let commands = vec![GraphCommand::GroupNodes {
            command_id: "c1".into(),
            node_ids: vec!["a".into(), "b".into()],
            group_node: group_node.clone(),
        }];
        let result = apply_commands(&snapshot, &commands).unwrap();
        assert_eq!(result.nodes.len(), 4);
        assert_eq!(
            result.node_by_id("a").unwrap().parent_id.as_deref(),
            Some("phase1")
        );

        let commands = vec![GraphCommand::UngroupNodes {
            command_id: "c2".into(),
            group_node_id: "phase1".into(),
        }];
        let result = apply_commands(&result, &commands).unwrap();
        assert_eq!(result.nodes.len(), 3);
        assert!(result.node_by_id("a").unwrap().parent_id.is_none());
    }

    #[test]
    fn update_policy_command() {
        let mut snapshot = empty_snapshot();
        snapshot.nodes.push(make_executable("a"));

        let mut new_policy = crate::orchestrator::domain::policy::NodePolicy::default();
        new_policy.priority = 99;

        let commands = vec![GraphCommand::UpdatePolicy {
            command_id: "c1".into(),
            node_id: "a".into(),
            policy: new_policy,
        }];
        let result = apply_commands(&snapshot, &commands).unwrap();
        assert_eq!(result.node_by_id("a").unwrap().policy.priority, 99);
    }

    #[test]
    fn remove_node_cleans_edges_and_reparents() {
        let mut snapshot = empty_snapshot();
        snapshot.nodes.push(make_executable("parent"));
        snapshot.nodes.push(make_executable("child"));
        snapshot.node_by_id_mut("child").unwrap().parent_id = Some("parent".into());
        snapshot.edges.push(GraphEdge {
            edge_id: "e1".into(),
            source_node_id: "parent".into(),
            target_node_id: "child".into(),
            kind: EdgeKind::ControlDependency,
        });

        let commands = vec![GraphCommand::RemoveNode {
            command_id: "c1".into(),
            node_id: "parent".into(),
        }];
        let result = apply_commands(&snapshot, &commands).unwrap();
        assert!(result.node_by_id("parent").is_none());
        assert!(result.edges.is_empty());
        // child reparented to parent's parent (None)
        assert!(result.node_by_id("child").unwrap().parent_id.is_none());
    }

    #[test]
    fn graph_create_makes_goal() {
        let input = CreateGraphInput {
            title: "Test Task".into(),
            goal: "Achieve X".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        };
        let snapshot = graph_create(&input);
        assert_eq!(snapshot.nodes.len(), 1);
        assert_eq!(snapshot.nodes[0].node_kind, NodeKind::Goal);
    }

    #[test]
    fn set_goal_replaces_existing() {
        let snapshot = empty_snapshot();
        let new_goal = GraphNode {
            node_id: "goal_v2".into(),
            parent_id: None,
            title: "New Goal".into(),
            description: Some("New objective".into()),
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
        };
        let commands = vec![GraphCommand::SetGoal {
            command_id: "c1".into(),
            goal_node: new_goal,
        }];
        let result = apply_commands(&snapshot, &commands).unwrap();
        let goals: Vec<_> = result
            .nodes
            .iter()
            .filter(|n| n.node_kind == NodeKind::Goal)
            .collect();
        assert_eq!(goals.len(), 1);
        assert_eq!(goals[0].node_id, "goal_v2");
    }

    #[test]
    fn set_goal_reparents_existing_children() {
        let mut snapshot = empty_snapshot();
        let mut child = make_executable("child");
        child.parent_id = Some("goal".into());
        snapshot.nodes.push(child);
        let new_goal = GraphNode {
            node_id: "goal_v2".into(),
            parent_id: None,
            title: "New Goal".into(),
            description: None,
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
        };
        let result = apply_commands(
            &snapshot,
            &[GraphCommand::SetGoal {
                command_id: "c1".into(),
                goal_node: new_goal,
            }],
        )
        .unwrap();
        assert_eq!(
            result.node_by_id("child").unwrap().parent_id.as_deref(),
            Some("goal_v2")
        );
        graph_validate(&result).unwrap();
    }
}
