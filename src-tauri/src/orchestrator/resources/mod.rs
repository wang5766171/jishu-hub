use std::collections::HashMap;
use std::path::{Component, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use crate::orchestrator::domain::graph::GraphNode;
use crate::orchestrator::domain::run::{LeasedResource, LockMode};

#[derive(Debug, Clone)]
pub struct ResourceLimits {
    pub global_concurrency: usize,
    pub capability_concurrency: usize,
    pub cpu_weight: u32,
    pub memory_mb: u64,
    pub network_concurrency_per_quota: usize,
    pub max_parallel_nodes_per_run: usize,
    /// Aggregate token budget cap across all concurrently-held leases.
    /// `None` (default) = unbounded (preserves prior behavior). When set,
    /// a node's `token_budget` is reserved up-front and summed with all held
    /// token quotas, exactly like CPU weight / memory — acquire is refused if
    /// the running total would exceed the cap.
    pub token_budget_cap: Option<u64>,
    /// Aggregate cost cap (USD) across concurrently-held leases, same semantics.
    pub cost_budget_cap_usd: Option<f64>,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            global_concurrency: 8,
            capability_concurrency: 1,
            cpu_weight: 100,
            memory_mb: 8 * 1024,
            network_concurrency_per_quota: 1,
            max_parallel_nodes_per_run: 4,
            token_budget_cap: None,
            cost_budget_cap_usd: None,
        }
    }
}

#[derive(Default)]
struct ResourceState {
    leases: HashMap<String, Vec<LeasedResource>>,
}

#[derive(Clone)]
pub struct ResourceArbiter {
    inner: Arc<ResourceArbiterInner>,
}

struct ResourceArbiterInner {
    limits: ResourceLimits,
    state: Mutex<ResourceState>,
}

pub struct ResourcePermit {
    lease_id: String,
    resources: Vec<LeasedResource>,
    arbiter: Weak<ResourceArbiterInner>,
}

impl ResourcePermit {
    pub fn resources(&self) -> &[LeasedResource] {
        &self.resources
    }
}

impl Drop for ResourcePermit {
    fn drop(&mut self) {
        let Some(arbiter) = self.arbiter.upgrade() else {
            return;
        };
        arbiter
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .leases
            .remove(&self.lease_id);
    }
}

impl ResourceArbiter {
    pub fn new(limits: ResourceLimits) -> Self {
        Self {
            inner: Arc::new(ResourceArbiterInner {
                limits,
                state: Mutex::new(ResourceState::default()),
            }),
        }
    }

    pub fn try_acquire(
        &self,
        lease_id: &str,
        node: &GraphNode,
        project_root: &std::path::Path,
    ) -> Option<ResourcePermit> {
        let requested = requested_resources(node, project_root);
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !can_acquire(&state, &requested, &self.inner.limits) {
            return None;
        }
        state.leases.insert(lease_id.to_string(), requested.clone());
        Some(ResourcePermit {
            lease_id: lease_id.to_string(),
            resources: requested,
            arbiter: Arc::downgrade(&self.inner),
        })
    }

    pub fn is_held(&self, lease_id: &str) -> bool {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .leases
            .contains_key(lease_id)
    }

    pub fn max_parallel_nodes_per_run(&self) -> usize {
        self.inner.limits.max_parallel_nodes_per_run
    }
}

fn requested_resources(node: &GraphNode, project_root: &std::path::Path) -> Vec<LeasedResource> {
    let mut resources = vec![LeasedResource::GlobalConcurrencySlot];
    for capability in &node.policy.resource_requirements.capability_slots {
        resources.push(LeasedResource::CapabilitySlot {
            capability: capability.clone(),
        });
    }
    for path in &node.policy.read_set {
        resources.push(LeasedResource::DirectoryLock {
            path: resolve_resource_path(project_root, path),
            mode: LockMode::Shared,
        });
    }
    for path in node
        .policy
        .write_set
        .iter()
        .chain(node.policy.resource_requirements.directory_locks.iter())
    {
        resources.push(LeasedResource::DirectoryLock {
            path: resolve_resource_path(project_root, path),
            mode: LockMode::Exclusive,
        });
    }
    if let Some(weight) = node.policy.resource_requirements.cpu_weight {
        resources.push(LeasedResource::CpuWeight { weight });
    }
    if let Some(mb) = node.policy.resource_requirements.memory_mb {
        resources.push(LeasedResource::MemoryMb { mb });
    }
    if let Some(tokens) = node.policy.token_budget {
        resources.push(LeasedResource::TokenQuota { tokens });
    }
    if let Some(usd) = node.policy.cost_budget_usd {
        resources.push(LeasedResource::CostQuota { usd });
    }
    if let Some(name) = &node.policy.resource_requirements.network_quota {
        resources.push(LeasedResource::NetworkQuota { name: name.clone() });
    }
    resources.sort_by_key(resource_key);
    resources
}

fn can_acquire(
    state: &ResourceState,
    requested: &[LeasedResource],
    limits: &ResourceLimits,
) -> bool {
    let held = state.leases.values().flatten().collect::<Vec<_>>();
    let global_held = held
        .iter()
        .filter(|resource| matches!(resource, LeasedResource::GlobalConcurrencySlot))
        .count();
    if requested
        .iter()
        .any(|resource| matches!(resource, LeasedResource::GlobalConcurrencySlot))
        && global_held >= limits.global_concurrency
    {
        return false;
    }

    let held_cpu = held
        .iter()
        .filter_map(|resource| match resource {
            LeasedResource::CpuWeight { weight } => Some(*weight as u64),
            _ => None,
        })
        .sum::<u64>();
    let requested_cpu = requested
        .iter()
        .filter_map(|resource| match resource {
            LeasedResource::CpuWeight { weight } => Some(*weight as u64),
            _ => None,
        })
        .sum::<u64>();
    if held_cpu.saturating_add(requested_cpu) > limits.cpu_weight as u64 {
        return false;
    }

    let held_memory = held
        .iter()
        .filter_map(|resource| match resource {
            LeasedResource::MemoryMb { mb } => Some(*mb),
            _ => None,
        })
        .sum::<u64>();
    let requested_memory = requested
        .iter()
        .filter_map(|resource| match resource {
            LeasedResource::MemoryMb { mb } => Some(*mb),
            _ => None,
        })
        .sum::<u64>();
    if held_memory.saturating_add(requested_memory) > limits.memory_mb {
        return false;
    }

    if let Some(cap) = limits.token_budget_cap {
        let held_tokens = held
            .iter()
            .filter_map(|r| match r {
                LeasedResource::TokenQuota { tokens } => Some(*tokens),
                _ => None,
            })
            .sum::<u64>();
        let requested_tokens = requested
            .iter()
            .filter_map(|r| match r {
                LeasedResource::TokenQuota { tokens } => Some(*tokens),
                _ => None,
            })
            .sum::<u64>();
        if held_tokens.saturating_add(requested_tokens) > cap {
            return false;
        }
    }
    if let Some(cap) = limits.cost_budget_cap_usd {
        let held_cost = held
            .iter()
            .filter_map(|r| match r {
                LeasedResource::CostQuota { usd } => Some(*usd),
                _ => None,
            })
            .sum::<f64>();
        let requested_cost = requested
            .iter()
            .filter_map(|r| match r {
                LeasedResource::CostQuota { usd } => Some(*usd),
                _ => None,
            })
            .sum::<f64>();
        if held_cost + requested_cost > cap {
            return false;
        }
    }

    for resource in requested {
        match resource {
            LeasedResource::CapabilitySlot { capability } => {
                let count = held
                    .iter()
                    .filter(|held| {
                        matches!(
                            held,
                            LeasedResource::CapabilitySlot {
                                capability: held_capability
                            } if held_capability == capability
                        )
                    })
                    .count();
                if count >= limits.capability_concurrency {
                    return false;
                }
            }
            LeasedResource::DirectoryLock { path, mode } => {
                let conflict = held.iter().any(|held| {
                    matches!(
                        held,
                        LeasedResource::DirectoryLock {
                            path: held_path,
                            mode: held_mode
                        } if paths_overlap(path, held_path)
                            && (*mode == LockMode::Exclusive
                                || *held_mode == LockMode::Exclusive)
                    )
                });
                if conflict {
                    return false;
                }
            }
            LeasedResource::NetworkQuota { name } => {
                // Rate-quota modeling: per-name concurrency (limit defaults to 1 = exclusive).
                let count = held
                    .iter()
                    .filter(|held| {
                        matches!(
                            held,
                            LeasedResource::NetworkQuota { name: held_name }
                                if held_name == name
                        )
                    })
                    .count();
                if count >= limits.network_concurrency_per_quota {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

fn resolve_resource_path(project_root: &std::path::Path, path: &std::path::Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        project_root.join(path)
    }
}

/// Lexically normalize `path` without touching the filesystem: drop `.` components and
/// resolve `..` against the previous `Normal` component (so `./src` and `src` compare
/// equal, and `a/../b` collapses to `b`). Unlike `canonicalize`, this works for project
/// dirs that do not yet exist on disk.
///
/// Edge case: a bare root such as `/` (or `\` on Windows) normalizes to an empty
/// `PathBuf`, which the `is_empty()` guard turns into `.` — so `/` and `.` are treated
/// as overlapping. This is intentional (both denote "the whole root") and consistent
/// with how read/write sets resolve against `project_root`.
fn normalize_lexical(path: &std::path::Path) -> PathBuf {
    let mut stack: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match stack.last() {
                Some(Component::Normal(_)) => {
                    stack.pop();
                }
                _ => stack.push(component),
            },
            other => stack.push(other),
        }
    }
    let mut result = PathBuf::new();
    for component in stack {
        result.push(component.as_os_str());
    }
    if result.as_os_str().is_empty() {
        result.push(Component::CurDir.as_os_str());
    }
    result
}

fn paths_overlap(left: &std::path::Path, right: &std::path::Path) -> bool {
    let left = normalize_lexical(left);
    let right = normalize_lexical(right);
    left.starts_with(&right) || right.starts_with(&left)
}

fn resource_key(resource: &LeasedResource) -> String {
    match resource {
        LeasedResource::GlobalConcurrencySlot => "00:global".into(),
        LeasedResource::CapabilitySlot { capability } => format!("10:{capability}"),
        LeasedResource::DirectoryLock { path, mode } => {
            format!("20:{}:{mode:?}", path.to_string_lossy())
        }
        LeasedResource::CpuWeight { weight } => format!("30:{weight}"),
        LeasedResource::MemoryMb { mb } => format!("40:{mb}"),
        LeasedResource::TokenQuota { tokens } => format!("50:{tokens}"),
        LeasedResource::CostQuota { usd } => format!("60:{usd}"),
        LeasedResource::NetworkQuota { name } => format!("70:{name}"),
        LeasedResource::ApprovalPermit { scope } => format!("80:{scope}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::domain::graph::{GraphNode, NodeKind};

    fn node(id: &str) -> GraphNode {
        GraphNode {
            node_id: id.into(),
            parent_id: None,
            title: id.into(),
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
        }
    }

    #[test]
    fn exclusive_directory_lock_is_atomic_and_released_with_permit() {
        let arbiter = ResourceArbiter::new(ResourceLimits::default());
        let mut writer = node("writer");
        writer.policy.write_set = vec![PathBuf::from("src")];
        let mut reader = node("reader");
        reader.policy.read_set = vec![PathBuf::from("src/lib.rs")];

        let permit = arbiter.try_acquire("lease-1", &writer, std::path::Path::new("project"));
        assert!(permit.is_some());
        assert!(arbiter
            .try_acquire("lease-2", &reader, std::path::Path::new("project"))
            .is_none());

        drop(permit);
        assert!(arbiter
            .try_acquire("lease-2", &reader, std::path::Path::new("project"))
            .is_some());
    }

    #[test]
    fn capability_slots_respect_configured_limit() {
        let arbiter = ResourceArbiter::new(ResourceLimits {
            global_concurrency: 4,
            capability_concurrency: 1,
            ..ResourceLimits::default()
        });
        let mut first = node("first");
        first.policy.resource_requirements.capability_slots = vec!["browser".into()];
        let second = first.clone();

        let permit = arbiter
            .try_acquire("lease-1", &first, std::path::Path::new("."))
            .unwrap();
        assert!(arbiter
            .try_acquire("lease-2", &second, std::path::Path::new("."))
            .is_none());
        drop(permit);
    }

    #[test]
    fn aggregate_cpu_and_memory_limits_are_enforced() {
        let arbiter = ResourceArbiter::new(ResourceLimits {
            global_concurrency: 4,
            capability_concurrency: 2,
            cpu_weight: 100,
            memory_mb: 1024,
            ..ResourceLimits::default()
        });
        let mut first = node("first");
        first.policy.resource_requirements.cpu_weight = Some(70);
        first.policy.resource_requirements.memory_mb = Some(700);
        let mut second = node("second");
        second.policy.resource_requirements.cpu_weight = Some(40);
        second.policy.resource_requirements.memory_mb = Some(400);

        let permit = arbiter
            .try_acquire("lease-1", &first, std::path::Path::new("."))
            .unwrap();
        assert!(arbiter
            .try_acquire("lease-2", &second, std::path::Path::new("."))
            .is_none());
        drop(permit);
    }

    #[test]
    fn named_network_quota_is_exclusive_by_default() {
        let arbiter = ResourceArbiter::new(ResourceLimits::default());
        let mut first = node("first");
        first.policy.resource_requirements.network_quota = Some("deploy-api".into());
        let second = first.clone();

        let permit = arbiter
            .try_acquire("lease-1", &first, std::path::Path::new("."))
            .unwrap();
        assert!(arbiter
            .try_acquire("lease-2", &second, std::path::Path::new("."))
            .is_none());
        drop(permit);
    }

    #[test]
    fn resource_limits_default_max_parallel_per_run() {
        assert_eq!(ResourceLimits::default().max_parallel_nodes_per_run, 4);
    }

    #[test]
    fn paths_overlap_detects_dot_prefixed_duplicate() {
        let arbiter = ResourceArbiter::new(ResourceLimits::default());
        let mut writer = node("writer");
        writer.policy.write_set = vec![PathBuf::from("./src")];
        let mut reader = node("reader");
        reader.policy.read_set = vec![PathBuf::from("src/lib.rs")];

        let permit = arbiter.try_acquire("lease-1", &writer, std::path::Path::new("project"));
        assert!(permit.is_some());
        assert!(arbiter
            .try_acquire("lease-2", &reader, std::path::Path::new("project"))
            .is_none());

        drop(permit);
        assert!(arbiter
            .try_acquire("lease-2", &reader, std::path::Path::new("project"))
            .is_some());
    }

    #[test]
    fn aggregate_token_cap_rejects_acquisition() {
        let arbiter = ResourceArbiter::new(ResourceLimits {
            token_budget_cap: Some(1000),
            ..ResourceLimits::default()
        });
        let mut node_a = node("node-a");
        node_a.policy.token_budget = Some(600);
        let mut node_b = node("node-b");
        node_b.policy.token_budget = Some(600);

        let permit_a = arbiter.try_acquire("lease-1", &node_a, std::path::Path::new("."));
        assert!(permit_a.is_some());
        assert!(arbiter
            .try_acquire("lease-2", &node_b, std::path::Path::new("."))
            .is_none());

        drop(permit_a);
        assert!(arbiter
            .try_acquire("lease-2", &node_b, std::path::Path::new("."))
            .is_some());
    }
}
