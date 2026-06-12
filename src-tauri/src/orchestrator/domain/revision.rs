use super::graph::GraphSnapshot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Immutable, fully-validated task graph snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphRevision {
    pub revision_id: String,
    pub graph_id: String,
    pub parent_revision_id: Option<String>,
    pub schema_version: String,
    /// Normalised canonical JSON of the graph (nodes + edges + policies).
    pub canonical_snapshot: CanonicalSnapshot,
    /// SHA-256 content hash of the canonical snapshot.
    pub content_hash: ContentHash,
    /// Skill references used for this revision.
    #[serde(default)]
    pub skill_refs: Vec<SkillRef>,
    /// Template references used for this revision.
    #[serde(default)]
    pub template_refs: Vec<TemplateRef>,
    /// Planner policy references used for this revision.
    #[serde(default)]
    pub planner_policy_refs: Vec<PlannerPolicyRef>,
    /// Human-readable summary of what changed.
    #[serde(default)]
    pub change_summary: String,
    /// Who created this revision (user id or "planner").
    pub author: String,
    pub created_at: i64,
}

/// Wrapper around the canonical JSON serialisation of a GraphSnapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonicalSnapshot {
    /// The canonical JSON string (sorted keys, deterministic).
    pub json: String,
}

impl CanonicalSnapshot {
    /// Build canonical JSON from a GraphSnapshot deterministically.
    pub fn from_snapshot(snapshot: &GraphSnapshot) -> Result<Self, serde_json::Error> {
        let mut normalized = snapshot.clone();
        normalized
            .nodes
            .sort_by(|left, right| left.node_id.cmp(&right.node_id));
        normalized
            .edges
            .sort_by(|left, right| left.edge_id.cmp(&right.edge_id));
        let value = serde_json::to_value(normalized)?;
        let canonical = canonicalize_json(&value);
        let json = serde_json::to_string(&canonical)?;
        Ok(Self { json })
    }

    /// Deserialize back to GraphSnapshot.
    pub fn to_snapshot(&self) -> Result<GraphSnapshot, serde_json::Error> {
        serde_json::from_str(&self.json)
    }
}

/// Recursively sort object keys for deterministic serialisation.
fn canonicalize_json(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            let mut sorted: Vec<(String, Value)> = map
                .iter()
                .map(|(k, v)| (k.clone(), canonicalize_json(v)))
                .collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            let mut object = serde_json::Map::new();
            for (k, v) in sorted {
                object.insert(k, v);
            }
            Value::Object(object)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(canonicalize_json).collect()),
        _ => value.clone(),
    }
}

/// Content hash computed from the canonical snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ContentHash(pub String);

impl ContentHash {
    pub fn from_canonical(canonical_json: &str) -> Self {
        let digest = Sha256::digest(canonical_json.as_bytes());
        Self(format!("{digest:x}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Reference to a skill used in planning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRef {
    pub skill_id: String,
    pub version_or_hash: String,
    #[serde(default)]
    pub inputs: serde_json::Value,
}

/// Reference to a template used in planning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateRef {
    pub template_id: String,
    pub version_or_hash: String,
    #[serde(default)]
    pub inputs: serde_json::Value,
}

/// Reference to a planner policy used in planning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannerPolicyRef {
    pub policy_id: String,
    pub version_or_hash: String,
    #[serde(default)]
    pub inputs: serde_json::Value,
}

impl GraphRevision {
    /// Create a new revision from a snapshot, computing canonical form and hash.
    pub fn from_snapshot(
        revision_id: impl Into<String>,
        graph_id: impl Into<String>,
        parent_revision_id: Option<String>,
        snapshot: &GraphSnapshot,
        author: impl Into<String>,
        created_at: i64,
    ) -> Result<Self, serde_json::Error> {
        let canonical = CanonicalSnapshot::from_snapshot(snapshot)?;
        let hash = ContentHash::from_canonical(&canonical.json);
        let mut revision = Self {
            revision_id: revision_id.into(),
            graph_id: graph_id.into(),
            parent_revision_id,
            schema_version: CURRENT_SCHEMA_VERSION.to_string(),
            canonical_snapshot: canonical,
            content_hash: hash,
            skill_refs: vec![],
            template_refs: vec![],
            planner_policy_refs: vec![],
            change_summary: String::new(),
            author: author.into(),
            created_at,
        };
        revision.refresh_content_hash()?;
        Ok(revision)
    }

    /// Deserialize the canonical snapshot back to GraphSnapshot.
    pub fn snapshot(&self) -> Result<GraphSnapshot, serde_json::Error> {
        self.canonical_snapshot.to_snapshot()
    }

    /// Recompute the immutable revision contract hash, including planning inputs.
    pub fn refresh_content_hash(&mut self) -> Result<(), serde_json::Error> {
        let envelope = serde_json::json!({
            "schema_version": self.schema_version,
            "canonical_snapshot": serde_json::from_str::<serde_json::Value>(
                &self.canonical_snapshot.json
            )?,
            "skill_refs": self.skill_refs,
            "template_refs": self.template_refs,
            "planner_policy_refs": self.planner_policy_refs,
        });
        let canonical = canonicalize_json(&envelope);
        self.content_hash = ContentHash::from_canonical(&serde_json::to_string(&canonical)?);
        Ok(())
    }
}

/// Current schema version for revisions.
pub const CURRENT_SCHEMA_VERSION: &str = "1.0.0";

/// Structured diff between two revisions.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RevisionDiff {
    pub from_revision_id: String,
    pub to_revision_id: String,
    pub nodes_added: Vec<String>,
    pub nodes_removed: Vec<String>,
    pub nodes_updated: Vec<NodeDiff>,
    pub edges_added: Vec<String>,
    pub edges_removed: Vec<String>,
    pub policy_changes: Vec<PolicyChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeDiff {
    pub node_id: String,
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyChange {
    pub node_id: String,
    pub field: String,
    pub old_value: serde_json::Value,
    pub new_value: serde_json::Value,
}

/// Compute a structured diff between two snapshots.
pub fn diff_snapshots(
    from: &GraphSnapshot,
    to: &GraphSnapshot,
    from_revision_id: &str,
    to_revision_id: &str,
) -> RevisionDiff {
    use std::collections::HashSet;

    let from_ids: HashSet<&str> = from.nodes.iter().map(|n| n.node_id.as_str()).collect();
    let to_ids: HashSet<&str> = to.nodes.iter().map(|n| n.node_id.as_str()).collect();

    let nodes_added: Vec<String> = to_ids
        .difference(&from_ids)
        .map(|s| s.to_string())
        .collect();
    let nodes_removed: Vec<String> = from_ids
        .difference(&to_ids)
        .map(|s| s.to_string())
        .collect();

    let mut nodes_updated = Vec::new();
    for to_node in &to.nodes {
        if let Some(from_node) = from.node_by_id(&to_node.node_id) {
            let mut changes = Vec::new();
            if from_node.title != to_node.title {
                changes.push("title".into());
            }
            if from_node.description != to_node.description {
                changes.push("description".into());
            }
            if from_node.node_kind != to_node.node_kind {
                changes.push("node_kind".into());
            }
            if from_node.parent_id != to_node.parent_id {
                changes.push("parent_id".into());
            }
            if from_node.executable_payload != to_node.executable_payload {
                changes.push("executable_payload".into());
            }
            if serde_json::to_value(&from_node.input_contract).ok()
                != serde_json::to_value(&to_node.input_contract).ok()
            {
                changes.push("input_contract".into());
            }
            if serde_json::to_value(&from_node.output_contract).ok()
                != serde_json::to_value(&to_node.output_contract).ok()
            {
                changes.push("output_contract".into());
            }
            if serde_json::to_value(&from_node.role_requirement).ok()
                != serde_json::to_value(&to_node.role_requirement).ok()
            {
                changes.push("role_requirement".into());
            }
            if from_node.capability_requirements != to_node.capability_requirements {
                changes.push("capability_requirements".into());
            }
            if serde_json::to_value(&from_node.agent_assignment_constraint).ok()
                != serde_json::to_value(&to_node.agent_assignment_constraint).ok()
            {
                changes.push("agent_assignment_constraint".into());
            }
            if serde_json::to_value(&from_node.metadata).ok()
                != serde_json::to_value(&to_node.metadata).ok()
            {
                changes.push("metadata".into());
            }
            if serde_json::to_value(&from_node.loop_config).ok()
                != serde_json::to_value(&to_node.loop_config).ok()
            {
                changes.push("loop_config".into());
            }
            if serde_json::to_value(&from_node.approval_gate_config).ok()
                != serde_json::to_value(&to_node.approval_gate_config).ok()
            {
                changes.push("approval_gate_config".into());
            }
            if !changes.is_empty() {
                nodes_updated.push(NodeDiff {
                    node_id: to_node.node_id.clone(),
                    changes,
                });
            }
        }
    }

    let from_edge_ids: HashSet<&str> = from.edges.iter().map(|e| e.edge_id.as_str()).collect();
    let to_edge_ids: HashSet<&str> = to.edges.iter().map(|e| e.edge_id.as_str()).collect();

    let edges_added: Vec<String> = to_edge_ids
        .difference(&from_edge_ids)
        .map(|s| s.to_string())
        .collect();
    let edges_removed: Vec<String> = from_edge_ids
        .difference(&to_edge_ids)
        .map(|s| s.to_string())
        .collect();

    let mut policy_changes = Vec::new();
    for to_node in &to.nodes {
        if let Some(from_node) = from.node_by_id(&to_node.node_id) {
            let old_policy = serde_json::to_value(&from_node.policy).unwrap_or_default();
            let new_policy = serde_json::to_value(&to_node.policy).unwrap_or_default();
            if old_policy != new_policy {
                policy_changes.push(PolicyChange {
                    node_id: to_node.node_id.clone(),
                    field: "policy".into(),
                    old_value: old_policy,
                    new_value: new_policy,
                });
            }
        }
    }

    let mut nodes_added = nodes_added;
    let mut nodes_removed = nodes_removed;
    let mut edges_added = edges_added;
    let mut edges_removed = edges_removed;
    nodes_added.sort();
    nodes_removed.sort();
    edges_added.sort();
    edges_removed.sort();
    nodes_updated.sort_by(|left, right| left.node_id.cmp(&right.node_id));
    policy_changes.sort_by(|left, right| left.node_id.cmp(&right.node_id));

    RevisionDiff {
        from_revision_id: from_revision_id.into(),
        to_revision_id: to_revision_id.into(),
        nodes_added,
        nodes_removed,
        nodes_updated,
        edges_added,
        edges_removed,
        policy_changes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::domain::graph::{
        EdgeKind, GraphEdge, GraphNode, GraphSnapshot, NodeKind,
    };
    use std::collections::HashMap;

    fn make_node(id: &str) -> GraphNode {
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
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        }
    }

    #[test]
    fn revision_hash_is_deterministic() {
        let snapshot = GraphSnapshot {
            nodes: vec![make_node("a"), make_node("b")],
            edges: vec![GraphEdge {
                edge_id: "e1".into(),
                source_node_id: "a".into(),
                target_node_id: "b".into(),
                kind: EdgeKind::ControlDependency,
            }],
        };
        let canonical1 = CanonicalSnapshot::from_snapshot(&snapshot).unwrap();
        let canonical2 = CanonicalSnapshot::from_snapshot(&snapshot).unwrap();
        assert_eq!(canonical1.json, canonical2.json);

        let hash1 = ContentHash::from_canonical(&canonical1.json);
        let hash2 = ContentHash::from_canonical(&canonical2.json);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn revision_hash_changes_with_content() {
        let snapshot1 = GraphSnapshot {
            nodes: vec![make_node("a")],
            edges: vec![],
        };
        let snapshot2 = GraphSnapshot {
            nodes: vec![make_node("a"), make_node("b")],
            edges: vec![],
        };
        let hash1 = ContentHash::from_canonical(
            &CanonicalSnapshot::from_snapshot(&snapshot1).unwrap().json,
        );
        let hash2 = ContentHash::from_canonical(
            &CanonicalSnapshot::from_snapshot(&snapshot2).unwrap().json,
        );
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn revision_roundtrip() {
        let snapshot = GraphSnapshot {
            nodes: vec![make_node("a"), make_node("b")],
            edges: vec![GraphEdge {
                edge_id: "e1".into(),
                source_node_id: "a".into(),
                target_node_id: "b".into(),
                kind: EdgeKind::DataDependency,
            }],
        };
        let revision =
            GraphRevision::from_snapshot("rev_1", "graph_1", None, &snapshot, "user", 1700000000)
                .unwrap();
        assert_eq!(revision.graph_id, "graph_1");
        assert_eq!(revision.schema_version, "1.0.0");

        let recovered = revision.snapshot().unwrap();
        assert_eq!(recovered.nodes.len(), 2);
        assert_eq!(recovered.edges.len(), 1);
    }

    #[test]
    fn diff_detects_added_node() {
        let from = GraphSnapshot {
            nodes: vec![make_node("a")],
            edges: vec![],
        };
        let to = GraphSnapshot {
            nodes: vec![make_node("a"), make_node("b")],
            edges: vec![],
        };
        let diff = diff_snapshots(&from, &to, "rev_1", "rev_2");
        assert_eq!(diff.nodes_added, vec!["b"]);
        assert!(diff.nodes_removed.is_empty());
    }

    #[test]
    fn diff_detects_removed_node() {
        let from = GraphSnapshot {
            nodes: vec![make_node("a"), make_node("b")],
            edges: vec![],
        };
        let to = GraphSnapshot {
            nodes: vec![make_node("a")],
            edges: vec![],
        };
        let diff = diff_snapshots(&from, &to, "rev_1", "rev_2");
        assert_eq!(diff.nodes_removed, vec!["b"]);
        assert!(diff.nodes_added.is_empty());
    }

    #[test]
    fn diff_detects_updated_node() {
        let from = GraphSnapshot {
            nodes: vec![make_node("a")],
            edges: vec![],
        };
        let mut node_b = make_node("a");
        node_b.title = "Updated Title".into();
        let to = GraphSnapshot {
            nodes: vec![node_b],
            edges: vec![],
        };
        let diff = diff_snapshots(&from, &to, "rev_1", "rev_2");
        assert_eq!(diff.nodes_updated.len(), 1);
        assert_eq!(diff.nodes_updated[0].node_id, "a");
        assert!(diff.nodes_updated[0].changes.contains(&"title".to_string()));
    }

    #[test]
    fn sha256_known_vector() {
        let hash = ContentHash::from_canonical("");
        assert_eq!(
            hash.as_str(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn canonical_hash_ignores_node_and_edge_order() {
        let edge = GraphEdge {
            edge_id: "e1".into(),
            source_node_id: "a".into(),
            target_node_id: "b".into(),
            kind: EdgeKind::ControlDependency,
        };
        let first = GraphSnapshot {
            nodes: vec![make_node("a"), make_node("b")],
            edges: vec![edge.clone()],
        };
        let second = GraphSnapshot {
            nodes: vec![make_node("b"), make_node("a")],
            edges: vec![edge],
        };
        let first = CanonicalSnapshot::from_snapshot(&first).unwrap();
        let second = CanonicalSnapshot::from_snapshot(&second).unwrap();
        assert_eq!(first.json, second.json);
        assert_eq!(
            ContentHash::from_canonical(&first.json),
            ContentHash::from_canonical(&second.json)
        );
    }

    #[test]
    fn revision_hash_includes_planning_inputs() {
        let snapshot = GraphSnapshot {
            nodes: vec![make_node("a")],
            edges: vec![],
        };
        let mut first =
            GraphRevision::from_snapshot("rev_1", "graph_1", None, &snapshot, "user", 1).unwrap();
        let mut second = first.clone();
        second.skill_refs = vec![SkillRef {
            skill_id: "superpowers".into(),
            version_or_hash: "sha256:one".into(),
            inputs: serde_json::json!({"mode": "tdd"}),
        }];
        second.refresh_content_hash().unwrap();
        first.refresh_content_hash().unwrap();

        assert_ne!(first.content_hash, second.content_hash);
    }

    #[test]
    fn diff_detects_agent_assignment_constraint_change() {
        let from = GraphSnapshot {
            nodes: vec![make_node("a")],
            edges: vec![],
        };
        let mut changed = make_node("a");
        changed.agent_assignment_constraint = Some(
            crate::orchestrator::domain::graph::AgentAssignmentConstraint {
                role_id: "implementer".into(),
                locked_agent_id: Some("codex".into()),
                ..Default::default()
            },
        );
        let to = GraphSnapshot {
            nodes: vec![changed],
            edges: vec![],
        };

        let diff = diff_snapshots(&from, &to, "rev_1", "rev_2");
        assert!(diff.nodes_updated[0]
            .changes
            .contains(&"agent_assignment_constraint".to_string()));
    }
}
