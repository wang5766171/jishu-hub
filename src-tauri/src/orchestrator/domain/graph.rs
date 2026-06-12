use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use super::policy::NodePolicy;

/// Long-lived task identity. Does not carry per-run state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskGraph {
    pub graph_id: String,
    pub title: String,
    pub goal: String,
    pub project_root: PathBuf,
    pub owner: String,
    pub current_draft_revision: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Top-level node category.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    /// Entire task goal and acceptance criteria.
    Goal,
    /// Organisational phase / foldable scope with budget aggregation.
    Group,
    /// Work unit executable by AgentRuntime or local executor.
    Executable,
    /// Repeat a sub-graph with an evaluator-driven termination.
    #[serde(rename = "control_loop")]
    ControlLoop,
    /// Explicit release, permission, or business approval gate.
    #[serde(rename = "control_approval_gate")]
    ControlApprovalGate,
}

/// Strongly typed input / output contract for a node.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Contract {
    /// Human-readable description of expected inputs.
    #[serde(default)]
    pub description: Option<String>,
    /// Named artifact references this node consumes (input) or produces (output).
    #[serde(default)]
    pub artifacts: Vec<String>,
    /// Free-form schema hints (JSON Schema fragments serialised as Value).
    #[serde(default)]
    pub schema: Option<serde_json::Value>,
}

/// Discriminated union for Executable payloads.
///
/// Agent-specific differences must NOT enter this type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutablePayload {
    /// Dispatch work to an agent resolved from role / capability requirements.
    Dispatch {
        role_id: String,
        prompt: String,
        project: Option<PathBuf>,
        session: Option<String>,
    },
    /// Run a shell command via OS Adapter.
    Shell {
        command: String,
        cwd: Option<PathBuf>,
        timeout_ms: Option<u64>,
    },
    /// Read a file within the project root.
    Read {
        path: PathBuf,
        max_bytes: Option<u64>,
    },
    /// Write a file. May require approval.
    Write {
        path: PathBuf,
        content: String,
        requires_approval: bool,
    },
    /// Ask the supervisor / planner a question about run state.
    Reflect { question: String },
    /// Verify a typed condition.
    Verify { check: VerifyCheck },
}

/// Strongly typed verification checks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VerifyCheck {
    FileExists {
        path: PathBuf,
    },
    CommandSuccess {
        command: String,
        cwd: Option<PathBuf>,
    },
    OutputContains {
        command: String,
        cwd: Option<PathBuf>,
        substring: String,
    },
}

/// Configuration for `Control::Loop` nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopControllerConfig {
    /// Sub-graph body executed each iteration (referenced by child node ids).
    pub body_node_ids: Vec<String>,
    /// Evaluator node or inline evaluator spec.
    pub evaluator: EvaluatorSpec,
    /// Interval / backoff in milliseconds.
    pub interval_ms: u64,
    pub backoff_multiplier: Option<f64>,
    pub max_interval_ms: Option<u64>,
    /// Termination condition description.
    pub termination_condition: String,
    pub max_iterations: Option<u32>,
    pub deadline_ms: Option<u64>,
    /// At least one hard budget is required.
    pub token_budget: Option<u64>,
    pub cost_budget_usd: Option<f64>,
    pub no_progress_threshold: Option<u32>,
    pub escalation_policy: String,
}

/// How the loop evaluator is expressed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EvaluatorSpec {
    /// Reference to a node that evaluates iteration progress.
    NodeRef { node_id: String },
    /// Inline evaluation rules.
    Inline { rules: serde_json::Value },
}

/// Configuration for `Control::ApprovalGate` nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalGateConfig {
    /// Human-readable description of what is being approved.
    pub description: String,
    /// Risk level for UI display.
    pub risk_level: ApprovalRisk,
    /// Scope of the approval (e.g. file paths, commands).
    #[serde(default)]
    pub scope: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalRisk {
    Low,
    Medium,
    High,
    Critical,
}

/// A node in the task graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub node_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub node_kind: NodeKind,
    #[serde(default)]
    pub input_contract: Contract,
    #[serde(default)]
    pub output_contract: Contract,
    #[serde(default)]
    pub role_requirement: Option<RoleRequirement>,
    #[serde(default)]
    pub capability_requirements: Vec<String>,
    #[serde(default)]
    pub agent_assignment_constraint: Option<AgentAssignmentConstraint>,
    #[serde(default)]
    pub policy: NodePolicy,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
    /// Payload for Executable nodes.
    #[serde(default)]
    pub executable_payload: Option<ExecutablePayload>,
    /// Config for Control::Loop nodes.
    #[serde(default)]
    pub loop_config: Option<LoopControllerConfig>,
    /// Config for Control::ApprovalGate nodes.
    #[serde(default)]
    pub approval_gate_config: Option<ApprovalGateConfig>,
}

/// Role requirement for a node — declares what kind of agent is needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleRequirement {
    pub role_id: String,
    pub responsibility: String,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub preferred_capabilities: Vec<String>,
}

/// Structured agent assignment constraint — never a hardcoded agent_id branch.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentAssignmentConstraint {
    pub role_id: String,
    pub locked_agent_id: Option<String>,
    #[serde(default)]
    pub allowed_agent_ids: Vec<String>,
    #[serde(default)]
    pub denied_agent_ids: Vec<String>,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
}

/// Edge kind in the core DAG.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// Target must wait for source success or condition.
    ControlDependency,
    /// Target consumes source output or artifact.
    DataDependency,
}

/// A directed edge in the task graph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct GraphEdge {
    pub edge_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub kind: EdgeKind,
}

/// Immutable in-memory representation of the full graph at a revision.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GraphSnapshot {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

impl GraphSnapshot {
    pub fn node_by_id(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.iter().find(|n| n.node_id == id)
    }

    pub fn node_by_id_mut(&mut self, id: &str) -> Option<&mut GraphNode> {
        self.nodes.iter_mut().find(|n| n.node_id == id)
    }

    pub fn edges_from(&self, node_id: &str) -> Vec<&GraphEdge> {
        self.edges
            .iter()
            .filter(|e| e.source_node_id == node_id)
            .collect()
    }

    pub fn edges_to(&self, node_id: &str) -> Vec<&GraphEdge> {
        self.edges
            .iter()
            .filter(|e| e.target_node_id == node_id)
            .collect()
    }

    pub fn child_node_ids(&self, parent_id: &str) -> Vec<String> {
        self.nodes
            .iter()
            .filter(|n| n.parent_id.as_deref() == Some(parent_id))
            .map(|n| n.node_id.clone())
            .collect()
    }

    /// Collect all node ids reachable from the given root by parent->child.
    pub fn descendants(&self, root_id: &str) -> Vec<String> {
        let mut result = Vec::new();
        let mut stack = vec![root_id.to_string()];
        while let Some(current) = stack.pop() {
            for child_id in self.child_node_ids(&current) {
                if !result.contains(&child_id) {
                    result.push(child_id.clone());
                    stack.push(child_id);
                }
            }
        }
        result
    }

    /// Check if all node_id and parent_id references are valid.
    pub fn validate_references(&self) -> Result<(), super::state_machine::ValidationError> {
        use super::state_machine::ValidationError;

        let node_ids: std::collections::HashSet<&str> =
            self.nodes.iter().map(|n| n.node_id.as_str()).collect();

        if node_ids.len() != self.nodes.len() {
            return Err(ValidationError::DuplicateNodeId);
        }

        for node in &self.nodes {
            if let Some(parent_id) = &node.parent_id {
                if !node_ids.contains(parent_id.as_str()) {
                    return Err(ValidationError::DanglingParent {
                        node_id: node.node_id.clone(),
                        parent_id: parent_id.clone(),
                    });
                }
                if parent_id == &node.node_id {
                    return Err(ValidationError::SelfParent {
                        node_id: node.node_id.clone(),
                    });
                }
            }
        }

        for edge in &self.edges {
            if !node_ids.contains(edge.source_node_id.as_str()) {
                return Err(ValidationError::DanglingEdge {
                    edge_id: edge.edge_id.clone(),
                    missing: edge.source_node_id.clone(),
                });
            }
            if !node_ids.contains(edge.target_node_id.as_str()) {
                return Err(ValidationError::DanglingEdge {
                    edge_id: edge.edge_id.clone(),
                    missing: edge.target_node_id.clone(),
                });
            }
        }

        Ok(())
    }

    /// Topological sort for DAG validation. Returns Err if a cycle is found.
    pub fn topological_order(&self) -> Result<Vec<String>, super::state_machine::ValidationError> {
        use super::state_machine::ValidationError;
        use std::collections::{HashMap, HashSet, VecDeque};

        let node_ids: HashSet<&str> = self.nodes.iter().map(|n| n.node_id.as_str()).collect();
        let mut in_degree: HashMap<&str, usize> = HashMap::new();
        let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();

        for id in &node_ids {
            in_degree.insert(id, 0);
            adj.insert(id, Vec::new());
        }

        for edge in &self.edges {
            if let Some(deg) = in_degree.get_mut(edge.target_node_id.as_str()) {
                *deg += 1;
            }
            if let Some(neighbors) = adj.get_mut(edge.source_node_id.as_str()) {
                neighbors.push(edge.target_node_id.as_str());
            }
        }

        let mut queue: VecDeque<&str> = in_degree
            .iter()
            .filter(|(_, &d)| d == 0)
            .map(|(&id, _)| id)
            .collect();

        let mut sorted = Vec::with_capacity(self.nodes.len());
        while let Some(id) = queue.pop_front() {
            sorted.push(id.to_string());
            if let Some(neighbors) = adj.get(id) {
                for &neighbor in neighbors {
                    if let Some(deg) = in_degree.get_mut(neighbor) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(neighbor);
                        }
                    }
                }
            }
        }

        if sorted.len() != self.nodes.len() {
            let cycle_nodes: Vec<String> = self
                .nodes
                .iter()
                .filter(|n| !sorted.contains(&n.node_id))
                .map(|n| n.node_id.clone())
                .collect();
            return Err(ValidationError::CycleDetected { nodes: cycle_nodes });
        }

        Ok(sorted)
    }

    /// Validate that parent hierarchy has no cycles.
    pub fn validate_parent_hierarchy(&self) -> Result<(), super::state_machine::ValidationError> {
        use super::state_machine::ValidationError;
        use std::collections::HashMap;

        let parent_map: HashMap<&str, Option<&str>> = self
            .nodes
            .iter()
            .map(|n| (n.node_id.as_str(), n.parent_id.as_deref()))
            .collect();

        for node in &self.nodes {
            let mut current = node.parent_id.as_deref();
            let mut depth = 0;
            while let Some(parent_id) = current {
                depth += 1;
                if depth > self.nodes.len() {
                    return Err(ValidationError::ParentCycle {
                        node_id: node.node_id.clone(),
                    });
                }
                if parent_id == node.node_id {
                    return Err(ValidationError::SelfParent {
                        node_id: node.node_id.clone(),
                    });
                }
                current = parent_map.get(parent_id).copied().flatten();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_node(id: &str, parent: Option<&str>) -> GraphNode {
        GraphNode {
            node_id: id.into(),
            parent_id: parent.map(String::from),
            title: format!("Node {id}"),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Contract::default(),
            output_contract: Contract::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: NodePolicy::default(),
            metadata: HashMap::new(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }
    }

    #[test]
    fn snapshot_validates_references() {
        let snapshot = GraphSnapshot {
            nodes: vec![make_node("a", None), make_node("b", Some("a"))],
            edges: vec![GraphEdge {
                edge_id: "e1".into(),
                source_node_id: "a".into(),
                target_node_id: "b".into(),
                kind: EdgeKind::ControlDependency,
            }],
        };
        assert!(snapshot.validate_references().is_ok());
    }

    #[test]
    fn snapshot_detects_dangling_parent() {
        let snapshot = GraphSnapshot {
            nodes: vec![make_node("a", Some("nonexistent"))],
            edges: vec![],
        };
        assert!(snapshot.validate_references().is_err());
    }

    #[test]
    fn snapshot_detects_cycle() {
        let snapshot = GraphSnapshot {
            nodes: vec![make_node("a", None), make_node("b", None)],
            edges: vec![
                GraphEdge {
                    edge_id: "e1".into(),
                    source_node_id: "a".into(),
                    target_node_id: "b".into(),
                    kind: EdgeKind::ControlDependency,
                },
                GraphEdge {
                    edge_id: "e2".into(),
                    source_node_id: "b".into(),
                    target_node_id: "a".into(),
                    kind: EdgeKind::ControlDependency,
                },
            ],
        };
        let result = snapshot.topological_order();
        assert!(result.is_err());
    }

    #[test]
    fn snapshot_topological_order_ok() {
        let snapshot = GraphSnapshot {
            nodes: vec![
                make_node("a", None),
                make_node("b", None),
                make_node("c", None),
            ],
            edges: vec![
                GraphEdge {
                    edge_id: "e1".into(),
                    source_node_id: "a".into(),
                    target_node_id: "b".into(),
                    kind: EdgeKind::ControlDependency,
                },
                GraphEdge {
                    edge_id: "e2".into(),
                    source_node_id: "b".into(),
                    target_node_id: "c".into(),
                    kind: EdgeKind::ControlDependency,
                },
            ],
        };
        let order = snapshot.topological_order().unwrap();
        let pos_a = order.iter().position(|x| x == "a").unwrap();
        let pos_b = order.iter().position(|x| x == "b").unwrap();
        let pos_c = order.iter().position(|x| x == "c").unwrap();
        assert!(pos_a < pos_b);
        assert!(pos_b < pos_c);
    }

    #[test]
    fn snapshot_descendants() {
        let snapshot = GraphSnapshot {
            nodes: vec![
                make_node("root", None),
                make_node("child1", Some("root")),
                make_node("child2", Some("root")),
                make_node("grandchild", Some("child1")),
            ],
            edges: vec![],
        };
        let desc = snapshot.descendants("root");
        assert_eq!(desc.len(), 3);
        assert!(desc.contains(&"child1".to_string()));
        assert!(desc.contains(&"child2".to_string()));
        assert!(desc.contains(&"grandchild".to_string()));
    }

    #[test]
    fn executable_payload_serialization() {
        let payload = ExecutablePayload::Shell {
            command: "cargo build".into(),
            cwd: Some(PathBuf::from("/project")),
            timeout_ms: Some(60000),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"type\":\"shell\""));
        let de: ExecutablePayload = serde_json::from_str(&json).unwrap();
        matches!(de, ExecutablePayload::Shell { .. });
    }

    #[test]
    fn node_kind_serialization() {
        let kinds = vec![
            NodeKind::Goal,
            NodeKind::Group,
            NodeKind::Executable,
            NodeKind::ControlLoop,
            NodeKind::ControlApprovalGate,
        ];
        for kind in &kinds {
            let json = serde_json::to_string(kind).unwrap();
            let de: NodeKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, &de);
        }
    }
}
