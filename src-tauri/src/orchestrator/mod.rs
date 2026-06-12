pub mod commands;
pub mod daemon;
pub mod domain;
pub mod events;
pub mod local_actions;
pub mod loop_controller;
pub mod planner;
pub mod projections;
pub mod recovery;
pub mod resources;
pub mod runtime_bridge;
pub mod scheduler;
pub mod service;
pub mod store;

// ── Public re-exports ────────────────────────────────────────────────────

pub use commands::{
    apply_commands, graph_create, graph_diff, graph_validate, CreateGraphInput, GraphCommand,
    NodePatch, RevisionResult,
};
pub use domain::graph::{
    AgentAssignmentConstraint, ApprovalGateConfig, ApprovalRisk, Contract, EdgeKind, EvaluatorSpec,
    ExecutablePayload, GraphEdge, GraphNode, GraphSnapshot, LoopControllerConfig, NodeKind,
    RoleRequirement, TaskGraph, VerifyCheck,
};
pub use domain::policy::{
    ApprovalPolicy, IdempotencyPolicy, NodePolicy, PermissionScope, ResourceRequirements,
    RetryPolicy,
};
pub use domain::revision::{
    diff_snapshots, CanonicalSnapshot, ContentHash, GraphRevision, NodeDiff, PlannerPolicyRef,
    PolicyChange, RevisionDiff, SkillRef, TemplateRef, CURRENT_SCHEMA_VERSION,
};
pub use domain::run::{
    AgentAssignment, ApprovalRequest, ArtifactRef, ArtifactSensitivity, AttemptError, AttemptUsage,
    BudgetState, ErrorCategory, GraphRun, Lease, LeasedResource, LockMode, NodeAttempt, NodeRun,
    NodeRunStatus, RunPlanningSnapshot, RunStatus, TaskError, TaskErrorCategory,
};
pub use domain::state_machine::{
    validate_node_run_transition, validate_run_transition, NodeRunTransitionError,
    RunTransitionError, ValidationError, ValidationResult,
};
pub use events::{
    build_event, rebuild_projection, EventBatch, RunProjection, TaskEvent, TaskEventType,
    EVENT_SCHEMA_VERSION,
};
pub use planner::{GraphProposal, PlannerService, PlanningRequest};
pub use service::{TaskService, TaskServiceError};
pub use store::{default_data_dir, default_db_path, StoreError, TaskStore};
