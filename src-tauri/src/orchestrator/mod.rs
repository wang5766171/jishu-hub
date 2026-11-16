//! 编排器（在建子系统，v0.9.4 起）：领域模型/事件/投影/调度等部分预留面
//! 尚未接线——模块级放行 dead_code，接线完成后再收紧。
#![allow(dead_code)]
pub mod commands;
pub mod conversation;
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

pub use commands::graph_validate;
pub use domain::graph::{
    AgentAssignmentConstraint, EdgeKind, ExecutablePayload, GraphEdge, GraphNode, GraphSnapshot,
    NodeKind, RoleRequirement, TaskGraph,
};
pub use domain::revision::GraphRevision;
pub use domain::run::{BudgetState, GraphRun, NodeRun, RunPlanningSnapshot, RunStatus};
pub use events::{build_event, TaskEvent, TaskEventType};
pub use service::TaskService;
pub use store::{default_db_path, TaskStore};
