use crate::orchestrator::domain::graph::{EdgeKind, GraphSnapshot, NodeKind};
use crate::orchestrator::domain::run::{NodeRun, NodeRunStatus};

/// Computes the set of node IDs that should transition to `NodeRunStatus::Ready`.
///
/// A node is considered Ready if:
/// 1. Its current status is `Blocked` (or it doesn't have a run state yet, but typically we initialize them as Blocked).
/// 2. All incoming `control_dependency` and `data_dependency` edges originate from nodes that have `Succeeded`.
pub fn compute_ready_set(snapshot: &GraphSnapshot, runs: &[NodeRun], now: i64) -> Vec<String> {
    let mut ready_nodes = Vec::new();

    // Build a map of node_id -> status for quick lookup.
    // If a node is missing from runs, we assume it's Blocked (the default).
    let mut latest_runs: std::collections::HashMap<String, &NodeRun> =
        std::collections::HashMap::new();
    for run in runs {
        let replace = latest_runs
            .get(&run.node_id)
            .map(|current| {
                (
                    run.loop_iteration.unwrap_or_default(),
                    run.attempt_count,
                    run.started_at.unwrap_or_default(),
                ) > (
                    current.loop_iteration.unwrap_or_default(),
                    current.attempt_count,
                    current.started_at.unwrap_or_default(),
                )
            })
            .unwrap_or(true);
        if replace {
            latest_runs.insert(run.node_id.clone(), run);
        }
    }
    let status_map = latest_runs
        .iter()
        .map(|(node_id, run)| (node_id.clone(), run.status.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let loop_body_ids = snapshot
        .nodes
        .iter()
        .filter_map(|node| node.loop_config.as_ref())
        .flat_map(|config| config.body_node_ids.iter().cloned())
        .collect::<std::collections::HashSet<_>>();

    for node in &snapshot.nodes {
        if !matches!(
            node.node_kind,
            NodeKind::Executable | NodeKind::ControlApprovalGate | NodeKind::ControlLoop
        ) {
            continue;
        }
        if loop_body_ids.contains(&node.node_id)
            && latest_runs
                .get(&node.node_id)
                .and_then(|run| run.loop_iteration)
                .is_none()
        {
            continue;
        }
        let current_status = status_map
            .get(&node.node_id)
            .unwrap_or(&NodeRunStatus::Blocked);

        let schedulable = match current_status {
            NodeRunStatus::Blocked => true,
            NodeRunStatus::RetryWait => latest_runs
                .get(&node.node_id)
                .and_then(|run| run.wake_at)
                .map(|wake_at| wake_at <= now)
                .unwrap_or(false),
            _ => false,
        };
        if !schedulable {
            // Already processing or terminal.
            continue;
        }

        // Check incoming edges.
        let mut dependencies_satisfied = true;

        let incoming_edges = snapshot
            .edges
            .iter()
            .filter(|e| e.target_node_id == node.node_id);

        for edge in incoming_edges {
            if matches!(
                edge.kind,
                EdgeKind::ControlDependency | EdgeKind::DataDependency
            ) {
                let Some(source_node) = snapshot.node_by_id(&edge.source_node_id) else {
                    dependencies_satisfied = false;
                    break;
                };
                if matches!(source_node.node_kind, NodeKind::Goal | NodeKind::Group) {
                    continue;
                }
                let source_status = status_map
                    .get(&edge.source_node_id)
                    .unwrap_or(&NodeRunStatus::Blocked);
                if *source_status != NodeRunStatus::Succeeded {
                    dependencies_satisfied = false;
                    break;
                }
            }
        }

        if dependencies_satisfied {
            ready_nodes.push(node.node_id.clone());
        }
    }

    ready_nodes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::domain::graph::{GraphEdge, GraphNode, NodeKind};

    #[test]
    fn test_compute_ready_set_simple_chain() {
        let mut n1 = GraphNode {
            node_id: "A".into(),
            parent_id: None,
            title: "A".into(),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: Default::default(),
            metadata: std::collections::HashMap::new(),
            executable_payload: None,
            loop_config: None,
            approval_gate_config: None,
        };
        let mut n2 = n1.clone();
        n2.node_id = "B".into();
        n2.title = "B".into();
        let edge = GraphEdge {
            edge_id: "e1".into(),
            source_node_id: "A".into(),
            target_node_id: "B".into(),
            kind: EdgeKind::ControlDependency,
        };
        let snapshot = GraphSnapshot {
            nodes: vec![n1, n2],
            edges: vec![edge],
        };

        // Initially, A has no incoming edges, so it should be ready. B is blocked by A.
        let ready = compute_ready_set(&snapshot, &[], 0);
        assert_eq!(ready, vec!["A".to_string()]);

        // If A is Succeeded, B becomes ready.
        let mut run_a = NodeRun::new("run_A", "run_1", "A", "rev_1");
        run_a.status = NodeRunStatus::Succeeded;
        let ready2 = compute_ready_set(&snapshot, &[run_a], 0);
        assert_eq!(ready2, vec!["B".to_string()]);
    }

    #[test]
    fn retry_wait_only_becomes_ready_after_wake_time() {
        let snapshot = GraphSnapshot {
            nodes: vec![GraphNode {
                node_id: "A".into(),
                parent_id: None,
                title: "A".into(),
                description: None,
                node_kind: NodeKind::Executable,
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
            }],
            edges: vec![],
        };
        let mut run = NodeRun::new("nr", "run", "A", "rev");
        run.status = NodeRunStatus::RetryWait;
        run.wake_at = Some(100);

        assert!(compute_ready_set(&snapshot, &[run.clone()], 99).is_empty());
        assert_eq!(compute_ready_set(&snapshot, &[run], 100), vec!["A"]);
    }
}
