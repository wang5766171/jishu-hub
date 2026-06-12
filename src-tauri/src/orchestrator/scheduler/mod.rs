use crate::orchestrator::domain::graph::{EdgeKind, GraphNode, GraphSnapshot, NodeKind};
use crate::orchestrator::domain::run::{NodeRun, NodeRunStatus};
use std::collections::{HashMap, HashSet};

/// Is this single node ready to be scheduled, given precomputed indexes?
/// `predecessors[node_id]` = non-(Goal/Group) control/data dependency sources of node_id.
fn node_is_ready(
    node: &GraphNode,
    latest_run: Option<&NodeRun>,
    status_map: &HashMap<&str, NodeRunStatus>,
    predecessors: &HashMap<&str, Vec<&str>>,
    loop_body_ids: &HashSet<&str>,
    now: i64,
) -> bool {
    // 1. Only Executable / ControlApprovalGate / ControlLoop are schedulable.
    if !matches!(
        node.node_kind,
        NodeKind::Executable | NodeKind::ControlApprovalGate | NodeKind::ControlLoop
    ) {
        return false;
    }
    // 2. Loop body nodes need a loop_iteration assigned first.
    if loop_body_ids.contains(node.node_id.as_str())
        && latest_run.and_then(|r| r.loop_iteration).is_none()
    {
        return false;
    }
    // 3. Must be Blocked, or RetryWait whose wake_at <= now.
    let status = latest_run
        .map(|r| &r.status)
        .unwrap_or(&NodeRunStatus::Blocked);
    let schedulable_state = match status {
        NodeRunStatus::Blocked => true,
        NodeRunStatus::RetryWait => latest_run
            .and_then(|r| r.wake_at)
            .map(|wake_at| wake_at <= now)
            .unwrap_or(false),
        _ => false,
    };
    if !schedulable_state {
        return false;
    }
    // 4. All predecessors must be Succeeded.
    if let Some(preds) = predecessors.get(node.node_id.as_str()) {
        for pred_id in preds {
            let pred_status = status_map.get(*pred_id).unwrap_or(&NodeRunStatus::Blocked);
            if *pred_status != NodeRunStatus::Succeeded {
                return false;
            }
        }
    }
    true
}

/// Computes the set of node IDs that should transition to `NodeRunStatus::Ready`.
///
/// A node is considered Ready if:
/// 1. Its current status is `Blocked` (or it doesn't have a run state yet, but typically we initialize them as Blocked).
/// 2. All incoming `control_dependency` and `data_dependency` edges originate from nodes that have `Succeeded`.
pub fn compute_ready_set(snapshot: &GraphSnapshot, runs: &[NodeRun], now: i64) -> Vec<String> {
    let mut ready_nodes = Vec::new();

    // Build a map of node_id -> latest run for quick lookup.
    let mut latest_runs: HashMap<String, &NodeRun> = HashMap::new();
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

    // Build status map with &str keys for predicate
    let status_map: HashMap<&str, NodeRunStatus> = latest_runs
        .iter()
        .map(|(node_id, run)| (node_id.as_str(), run.status.clone()))
        .collect();

    // Build predecessors index: target_id -> Vec<source_id>, excluding Goal/Group sources
    let mut predecessors: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &snapshot.edges {
        if matches!(
            edge.kind,
            EdgeKind::ControlDependency | EdgeKind::DataDependency
        ) {
            // Skip Goal/Group sources
            if let Some(source_node) = snapshot.node_by_id(&edge.source_node_id) {
                if matches!(source_node.node_kind, NodeKind::Goal | NodeKind::Group) {
                    continue;
                }
            }
            predecessors
                .entry(edge.target_node_id.as_str())
                .or_insert_with(Vec::new)
                .push(edge.source_node_id.as_str());
        }
    }

    // Build loop body ids set
    let loop_body_ids: HashSet<&str> = snapshot
        .nodes
        .iter()
        .filter_map(|node| node.loop_config.as_ref())
        .flat_map(|config| config.body_node_ids.iter().map(|id| id.as_str()))
        .collect();

    for node in &snapshot.nodes {
        let latest_run = latest_runs.get(&node.node_id);
        if node_is_ready(
            node,
            latest_run.copied(),
            &status_map,
            &predecessors,
            &loop_body_ids,
            now,
        ) {
            ready_nodes.push(node.node_id.clone());
        }
    }

    ready_nodes
}

/// Incremental ready-set computer. Caches the per-revision dependency index and
/// a dirty set, so each `update()` re-evaluates only nodes whose gating inputs
/// changed (own status, predecessor status, or RetryWait wake time elapsing),
/// instead of re-scanning the whole graph.
pub struct ReadySetComputer {
    revision_id: String,
    /// node_id -> predecessor source_ids (control/data deps, Goal/Group excluded).
    predecessors: HashMap<String, Vec<String>>,
    /// node_id -> dependent target_ids (reverse of predecessors; for dirty propagation).
    dependents: HashMap<String, Vec<String>>,
    /// schedulable node ids (Executable/ControlApprovalGate/ControlLoop).
    schedulable_ids: HashSet<String>,
    /// loop body node ids.
    loop_body_ids: HashSet<String>,
    /// last known (status, wake_at_due, loop_iteration) per node, where wake_at_due = wake_at <= last_now for RetryWait.
    last_inputs: HashMap<String, (NodeRunStatus, bool, Option<u32>)>,
    /// current ready set.
    ready_set: HashSet<String>,
    /// diagnostic: number of `node_is_ready` evaluations performed in the last `update`.
    pub last_eval_count: usize,
}

impl ReadySetComputer {
    /// Build the index for a revision snapshot. The first `update()` will evaluate every node.
    pub fn for_revision(snapshot: &GraphSnapshot, revision_id: &str) -> Self {
        // Build predecessors index: target_id -> Vec<source_id>, excluding Goal/Group sources
        let mut predecessors: HashMap<String, Vec<String>> = HashMap::new();
        let mut dependents: HashMap<String, Vec<String>> = HashMap::new();

        for edge in &snapshot.edges {
            if matches!(
                edge.kind,
                EdgeKind::ControlDependency | EdgeKind::DataDependency
            ) {
                // Skip Goal/Group sources
                if let Some(source_node) = snapshot.node_by_id(&edge.source_node_id) {
                    if matches!(source_node.node_kind, NodeKind::Goal | NodeKind::Group) {
                        continue;
                    }
                }
                predecessors
                    .entry(edge.target_node_id.clone())
                    .or_insert_with(Vec::new)
                    .push(edge.source_node_id.clone());
                dependents
                    .entry(edge.source_node_id.clone())
                    .or_insert_with(Vec::new)
                    .push(edge.target_node_id.clone());
            }
        }

        // Build schedulable node ids (Executable/ControlApprovalGate/ControlLoop)
        let schedulable_ids: HashSet<String> = snapshot
            .nodes
            .iter()
            .filter(|node| {
                matches!(
                    node.node_kind,
                    NodeKind::Executable | NodeKind::ControlApprovalGate | NodeKind::ControlLoop
                )
            })
            .map(|node| node.node_id.clone())
            .collect();

        // Build loop body node ids
        let loop_body_ids: HashSet<String> = snapshot
            .nodes
            .iter()
            .filter_map(|node| node.loop_config.as_ref())
            .flat_map(|config| config.body_node_ids.iter().cloned())
            .collect();

        Self {
            revision_id: revision_id.to_string(),
            predecessors,
            dependents,
            schedulable_ids,
            loop_body_ids,
            last_inputs: HashMap::new(),
            ready_set: HashSet::new(),
            last_eval_count: 0,
        }
    }

    pub fn revision_matches(&self, revision_id: &str) -> bool {
        self.revision_id == revision_id
    }

    /// Incrementally update the ready set. `latest_runs` is node_id -> latest NodeRun.
    /// Returns the current ready set as a Vec<String> (sorted for determinism).
    /// Re-evaluates only dirty nodes; sets `last_eval_count`.
    pub fn update(
        &mut self,
        snapshot: &GraphSnapshot,
        latest_runs: &HashMap<String, &NodeRun>,
        now: i64,
    ) -> Vec<String> {
        self.last_eval_count = 0;

        // Build current inputs: status + wake_at_due + loop_iteration for every schedulable node
        let mut current_inputs: HashMap<String, (NodeRunStatus, bool, Option<u32>)> =
            HashMap::new();
        for node_id in &self.schedulable_ids {
            let status = latest_runs
                .get(node_id)
                .map(|run| &run.status)
                .unwrap_or(&NodeRunStatus::Blocked)
                .clone();
            let wake_at_due = if status == NodeRunStatus::RetryWait {
                latest_runs
                    .get(node_id)
                    .and_then(|run| run.wake_at)
                    .map(|wake_at| wake_at <= now)
                    .unwrap_or(false)
            } else {
                false
            };
            let loop_iteration = latest_runs.get(node_id).and_then(|run| run.loop_iteration);
            current_inputs.insert(node_id.clone(), (status, wake_at_due, loop_iteration));
        }

        // Determine dirty nodes: those whose inputs changed
        let mut dirty: HashSet<String> = HashSet::new();
        for (node_id, current) in &current_inputs {
            if self.last_inputs.get(node_id) != Some(current) {
                dirty.insert(node_id.clone());
                // Also mark all dependents as dirty (their predecessor's status changed)
                if let Some(deps) = self.dependents.get(node_id) {
                    for dep_id in deps {
                        dirty.insert(dep_id.clone());
                    }
                }
            }
        }

        // Build full status_map for predicate (cheap relative to predecessor iteration)
        let status_map: HashMap<&str, NodeRunStatus> = latest_runs
            .iter()
            .map(|(node_id, run)| (node_id.as_str(), run.status.clone()))
            .collect();

        // Build &str-keyed predecessors and loop_body_ids views
        let predecessors_str: HashMap<&str, Vec<&str>> = self
            .predecessors
            .iter()
            .map(|(k, v)| (k.as_str(), v.iter().map(|s| s.as_str()).collect()))
            .collect();

        let loop_body_ids_str: HashSet<&str> =
            self.loop_body_ids.iter().map(|id| id.as_str()).collect();

        // Re-evaluate only dirty nodes
        for node_id in &dirty {
            if let Some(node) = snapshot.node_by_id(node_id) {
                let latest_run = latest_runs.get(node_id).copied();
                let ready = node_is_ready(
                    node,
                    latest_run,
                    &status_map,
                    &predecessors_str,
                    &loop_body_ids_str,
                    now,
                );
                self.last_eval_count += 1;
                if ready {
                    self.ready_set.insert(node_id.clone());
                } else {
                    self.ready_set.remove(node_id);
                }
            }
        }

        // Store current inputs for next iteration
        self.last_inputs = current_inputs;

        // Return sorted ready set for determinism
        let mut ready_vec: Vec<String> = self.ready_set.iter().cloned().collect();
        ready_vec.sort();
        ready_vec
    }
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

    #[test]
    fn incremental_update_only_evaluates_dirty_subgraph() {
        // Graph: A -> B (A gates B), plus N independent already-Succeeded leaf nodes
        // with NO edges. After the first full update, change A to Succeeded and assert
        // the second update evaluates only O(dependents of A) nodes — i.e. A and B —
        // NOT all N+2 nodes.
        let n = 50;

        // Create nodes: A, B, and T0..T49
        let mut nodes = vec![
            GraphNode {
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
            },
            GraphNode {
                node_id: "B".into(),
                parent_id: None,
                title: "B".into(),
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
            },
        ];

        // Add terminal nodes T0..T49
        for i in 0..n {
            nodes.push(GraphNode {
                node_id: format!("T{}", i),
                parent_id: None,
                title: format!("T{}", i),
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
            });
        }

        // Create edge A -> B
        let edges = vec![GraphEdge {
            edge_id: "e1".into(),
            source_node_id: "A".into(),
            target_node_id: "B".into(),
            kind: EdgeKind::ControlDependency,
        }];

        let snapshot = GraphSnapshot { nodes, edges };

        // Build ReadySetComputer
        let mut computer = ReadySetComputer::for_revision(&snapshot, "rev");

        // Build latest_runs: T0..T49 = Succeeded, A = Blocked
        let mut latest_runs = std::collections::HashMap::new();
        for i in 0..n {
            let mut run = NodeRun::new(format!("nr_{}", i), "run", format!("T{}", i), "rev");
            run.status = NodeRunStatus::Succeeded;
            latest_runs.insert(format!("T{}", i), run);
        }
        let mut run_a = NodeRun::new("nr_a", "run", "A", "rev");
        run_a.status = NodeRunStatus::Blocked;
        latest_runs.insert("A".to_string(), run_a);

        // Convert to &NodeRun map as expected by update()
        let runs_ref: std::collections::HashMap<String, &NodeRun> =
            latest_runs.iter().map(|(k, v)| (k.clone(), v)).collect();

        // First update (full) - record ready set
        let ready_set_1 = computer.update(&snapshot, &runs_ref, 0);
        assert_eq!(ready_set_1, vec!["A".to_string()]);

        // Now set A = Succeeded
        latest_runs.get_mut("A").unwrap().status = NodeRunStatus::Succeeded;
        let runs_ref_2: std::collections::HashMap<String, &NodeRun> =
            latest_runs.iter().map(|(k, v)| (k.clone(), v)).collect();

        // Second update - should only evaluate A and B
        let ready_set_2 = computer.update(&snapshot, &runs_ref_2, 0);
        assert_eq!(ready_set_2, vec!["B".to_string()]);

        // CRITICAL ASSERTION: only A and B should have been re-evaluated
        assert!(
            computer.last_eval_count <= 2,
            "Expected at most 2 evaluations (A and B), got {}",
            computer.last_eval_count
        );
    }

    #[test]
    fn incremental_matches_pure_oracle_across_status_changes() {
        // Build a non-trivial graph: chain + diamond + a RetryWait node + a loop body node
        let nodes = vec![
            GraphNode {
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
            },
            GraphNode {
                node_id: "B".into(),
                parent_id: None,
                title: "B".into(),
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
            },
            GraphNode {
                node_id: "C".into(),
                parent_id: None,
                title: "C".into(),
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
            },
            GraphNode {
                node_id: "D".into(),
                parent_id: None,
                title: "D".into(),
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
            },
            // RetryWait node
            GraphNode {
                node_id: "R".into(),
                parent_id: None,
                title: "R".into(),
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
            },
            // Loop node
            GraphNode {
                node_id: "L".into(),
                parent_id: None,
                title: "L".into(),
                description: None,
                node_kind: NodeKind::ControlLoop,
                input_contract: Default::default(),
                output_contract: Default::default(),
                role_requirement: None,
                capability_requirements: vec![],
                agent_assignment_constraint: None,
                policy: Default::default(),
                metadata: Default::default(),
                executable_payload: None,
                loop_config: Some(crate::orchestrator::domain::graph::LoopControllerConfig {
                    body_node_ids: vec!["B".to_string()],
                    evaluator: crate::orchestrator::domain::graph::EvaluatorSpec::Inline {
                        rules: serde_json::Value::Null,
                    },
                    interval_ms: 1000,
                    backoff_multiplier: None,
                    max_interval_ms: None,
                    termination_condition: "test".into(),
                    max_iterations: None,
                    deadline_ms: None,
                    token_budget: None,
                    cost_budget_usd: None,
                    no_progress_threshold: None,
                    escalation_policy: "none".into(),
                }),
                approval_gate_config: None,
            },
        ];

        let edges = vec![
            // Chain: A -> B
            GraphEdge {
                edge_id: "e1".into(),
                source_node_id: "A".into(),
                target_node_id: "B".into(),
                kind: EdgeKind::ControlDependency,
            },
            // Diamond: A -> C, A -> D, C -> B, D -> B
            GraphEdge {
                edge_id: "e2".into(),
                source_node_id: "A".into(),
                target_node_id: "C".into(),
                kind: EdgeKind::ControlDependency,
            },
            GraphEdge {
                edge_id: "e3".into(),
                source_node_id: "A".into(),
                target_node_id: "D".into(),
                kind: EdgeKind::ControlDependency,
            },
            GraphEdge {
                edge_id: "e4".into(),
                source_node_id: "C".into(),
                target_node_id: "B".into(),
                kind: EdgeKind::ControlDependency,
            },
            GraphEdge {
                edge_id: "e5".into(),
                source_node_id: "D".into(),
                target_node_id: "B".into(),
                kind: EdgeKind::ControlDependency,
            },
        ];

        let snapshot = GraphSnapshot { nodes, edges };

        // Build incremental computer
        let mut computer = ReadySetComputer::for_revision(&snapshot, "rev");

        // Step 1: Initial state - all blocked
        let mut all_runs: Vec<NodeRun> = vec![];
        let mut ready_set = computer.update(&snapshot, &std::collections::HashMap::new(), 0);
        let mut oracle = compute_ready_set(&snapshot, &all_runs, 0);
        assert_eq!(sorted(ready_set), sorted(oracle));

        // Step 2: A succeeded
        let mut run_a = NodeRun::new("nr_a", "run", "A", "rev");
        run_a.status = NodeRunStatus::Succeeded;
        all_runs.push(run_a);
        let latest_runs = build_latest_map(&all_runs);
        ready_set = computer.update(&snapshot, &latest_runs, 0);
        oracle = compute_ready_set(&snapshot, &all_runs, 0);
        assert_eq!(sorted(ready_set), sorted(oracle));

        // Step 3: C and D succeeded
        let mut run_c = NodeRun::new("nr_c", "run", "C", "rev");
        run_c.status = NodeRunStatus::Succeeded;
        all_runs.push(run_c);
        let mut run_d = NodeRun::new("nr_d", "run", "D", "rev");
        run_d.status = NodeRunStatus::Succeeded;
        all_runs.push(run_d);
        let latest_runs = build_latest_map(&all_runs);
        ready_set = computer.update(&snapshot, &latest_runs, 0);
        oracle = compute_ready_set(&snapshot, &all_runs, 0);
        assert_eq!(sorted(ready_set), sorted(oracle));

        // Step 4: R in RetryWait before wake time
        let mut run_r = NodeRun::new("nr_r", "run", "R", "rev");
        run_r.status = NodeRunStatus::RetryWait;
        run_r.wake_at = Some(100);
        all_runs.push(run_r);
        let latest_runs = build_latest_map(&all_runs);
        ready_set = computer.update(&snapshot, &latest_runs, 50);
        oracle = compute_ready_set(&snapshot, &all_runs, 50);
        assert_eq!(sorted(ready_set), sorted(oracle));

        // Step 5: R in RetryWait after wake time
        let latest_runs = build_latest_map(&all_runs);
        ready_set = computer.update(&snapshot, &latest_runs, 100);
        oracle = compute_ready_set(&snapshot, &all_runs, 100);
        assert_eq!(sorted(ready_set), sorted(oracle));

        // Step 6: B succeeded
        let mut run_b = NodeRun::new("nr_b", "run", "B", "rev");
        run_b.status = NodeRunStatus::Succeeded;
        run_b.loop_iteration = Some(0);
        all_runs.push(run_b);
        let latest_runs = build_latest_map(&all_runs);
        ready_set = computer.update(&snapshot, &latest_runs, 100);
        oracle = compute_ready_set(&snapshot, &all_runs, 100);
        assert_eq!(sorted(ready_set), sorted(oracle));
    }

    fn build_latest_map(runs: &[NodeRun]) -> std::collections::HashMap<String, &NodeRun> {
        let mut latest = std::collections::HashMap::new();
        for run in runs {
            let replace = latest
                .get(&run.node_id)
                .map(|current: &&NodeRun| {
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
                latest.insert(run.node_id.clone(), run);
            }
        }
        latest
    }

    fn sorted(mut vec: Vec<String>) -> Vec<String> {
        vec.sort();
        vec
    }
}
