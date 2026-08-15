use super::*;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::agent::normalized::{InteractionOption, NormalizedEvent, TurnEndReason, UsageStats};
use crate::agent_runtime::AgentTurnOutput;
use crate::orchestrator::domain::graph::{
    EvaluatorSpec, GraphNode, GraphSnapshot, LoopControllerConfig, NodeKind, TaskGraph,
};
use crate::orchestrator::domain::policy::{ApprovalPolicy, NodePolicy};
use crate::orchestrator::domain::revision::GraphRevision;
use crate::orchestrator::domain::run::{BudgetState, GraphRun};
use crate::orchestrator::runtime_bridge::{
    materialize_handle, DefaultTaskAgentRuntime, InvocationHandle,
};

struct FakeAgentRuntime;

impl TaskAgentRuntime for FakeAgentRuntime {
    fn resolve_agent(
        &self,
        _node: &GraphNode,
        role_id: &str,
        _default_agent_id: Option<&str>,
    ) -> Result<(crate::orchestrator::domain::run::AgentAssignment, String), String> {
        Ok((
            crate::orchestrator::domain::run::AgentAssignment {
                agent_id: "fake-agent".into(),
                role_id: role_id.into(),
                adapter_capability_snapshot: vec!["stream_text_delta".into()],
            },
            "test".into(),
        ))
    }

    fn invoke(
        &self,
        request: RuntimeInvocationRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<InvocationHandle, String>> + Send>>
    {
        Box::pin(async move {
            assert_eq!(request.agent_id, "fake-agent");
            assert_eq!(request.role_id, "implementer");
            assert!(request.prompt.contains("Implement the feature"));
            // 节点 policy 走 NodePolicy::default()，PermissionScope::default() 现授予
            // can_write_files=true（执行节点默认能写，见 policy.rs）。断言契约注入如实反映。
            assert!(request.prompt.contains("write_files: true"));
            let invocation_id = request.invocation_id.clone();
            Ok(materialize_handle(
                invocation_id,
                Ok(AgentTurnOutput {
                    events: vec![
                        NormalizedEvent::SessionResolved {
                            session_id: "native-session".into(),
                        },
                        NormalizedEvent::TextDelta {
                            delta: "implemented".into(),
                        },
                        NormalizedEvent::TurnComplete {
                            reason: TurnEndReason::Complete,
                            usage: Some(UsageStats {
                                input_tokens: Some(10),
                                output_tokens: Some(20),
                                total_cost: Some(0.1),
                                context_remaining: None,
                                context_window_total: None,
                            }),
                        },
                    ],
                    exit_success: true,
                    exit_code: Some(0),
                }),
            ))
        })
    }
}

struct InteractionAgentRuntime;

impl TaskAgentRuntime for InteractionAgentRuntime {
    fn resolve_agent(
        &self,
        _node: &GraphNode,
        role_id: &str,
        _default_agent_id: Option<&str>,
    ) -> Result<(crate::orchestrator::domain::run::AgentAssignment, String), String> {
        Ok((
            crate::orchestrator::domain::run::AgentAssignment {
                agent_id: "jishu-self".into(),
                role_id: role_id.into(),
                adapter_capability_snapshot: vec!["rpc_bidirectional".into()],
            },
            "pi_rpc".into(),
        ))
    }

    fn invoke(
        &self,
        request: RuntimeInvocationRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<InvocationHandle, String>> + Send>>
    {
        Box::pin(async move {
            let invocation_id = request.invocation_id.clone();
            Ok(materialize_handle(
                invocation_id,
                Ok(AgentTurnOutput {
                    events: vec![
                        NormalizedEvent::SessionResolved {
                            session_id: "task-session-1".into(),
                        },
                        NormalizedEvent::InteractionRequest {
                            request_id: "request-1".into(),
                            prompt: "请选择实现方案".into(),
                            options: vec![
                                InteractionOption {
                                    option_id: "a".into(),
                                    label: "方案 A".into(),
                                    description: None,
                                },
                                InteractionOption {
                                    option_id: "b".into(),
                                    label: "方案 B".into(),
                                    description: None,
                                },
                            ],
                            allow_multiple: false,
                            allow_custom_text: true,
                            required: true,
                            transport: crate::agent::normalized::InteractionTransport::PiRpc,
                            origin: crate::agent::normalized::InteractionOrigin::ExtensionUi,
                            delivery_hint:
                                crate::agent::normalized::InteractionDeliveryHint::MidTurn,
                            correlation: None,
                        },
                    ],
                    exit_success: true,
                    exit_code: None,
                }),
            ))
        })
    }
}

#[tokio::test]
async fn agent_interaction_pauses_without_fake_completion_progress() {
    let prepared = PreparedAgentExecution {
        assignment: crate::orchestrator::domain::run::AgentAssignment {
            agent_id: "jishu-self".into(),
            role_id: "planner".into(),
            adapter_capability_snapshot: vec!["rpc_bidirectional".into()],
        },
        transport: "pi_rpc".into(),
    };
    let output = execute_agent(
        &InteractionAgentRuntime,
        prepared,
        RuntimeInvocationRequest {
            invocation_id: "test-invocation".into(),
            agent_id: "jishu-self".into(),
            role_id: "planner".into(),
            project_path: ".".into(),
            session_id: None,
            prompt: "plan".into(),
            timeout_ms: 1_000,
            cancellation: Arc::new(AtomicBool::new(false)),
        },
        RuntimeEventContext {
            run_id: "run-1".into(),
            node_run_id: "node-run-1".into(),
            attempt_id: "attempt-1".into(),
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(output.session_id.as_deref(), Some("task-session-1"));
    assert!(output.progress.is_empty());
    let interaction = output.interaction.expect("interaction should be captured");
    assert_eq!(interaction.request_id, "request-1");
    assert_eq!(interaction.options.len(), 2);
}

#[test]
fn resolved_interaction_builds_a_visible_same_session_reply() {
    let request = TaskInteractionRequest {
        request_id: "request-1".into(),
        graph_id: "graph-1".into(),
        run_id: Some("run-1".into()),
        node_id: Some("node-1".into()),
        node_run_id: Some("node-run-1".into()),
        session_id: Some("task-session-1".into()),
        prompt: "请选择实现方案".into(),
        options: vec![InteractionOption {
            option_id: "a".into(),
            label: "方案 A".into(),
            description: None,
        }],
        allow_multiple: false,
        allow_custom_text: true,
        required: true,
        created_at: 1,
        resolved_at: Some(2),
        consumed_at: None,
        submission: Some(
            crate::orchestrator::conversation::TaskInteractionSubmission {
                selected_option_ids: vec!["a".into()],
                custom_text: Some("优先保证兼容性".into()),
            },
        ),
    };

    let continuation =
        task_continuation_from_request(&request).expect("resolved request should continue");
    assert_eq!(continuation.session_id.as_deref(), Some("task-session-1"));
    assert!(continuation.reply.contains("方案 A"));
    assert!(continuation.reply.contains("优先保证兼容性"));
    assert!(!continuation.reply.contains("execution contract"));
}

#[test]
fn agent_prompt_reflects_permission_scope() {
    // 契约注入（agent_prompt_with_policy）把 permission_scope 拼成硬执行契约。
    // default 现授予 read/write=true —— 执行节点默认能读写文件，不再因全 false 空转。
    let policy = NodePolicy::default();
    let prompt = agent_prompt_with_policy("do work", &policy);
    assert!(prompt.contains("read_files: true"));
    assert!(prompt.contains("write_files: true"));
    assert!(prompt.contains("run_commands: false"));
    assert!(prompt.contains("access_network: false"));
    assert!(prompt.contains("deploy: false"));
    assert!(prompt.ends_with("do work"));

    // 显式关闭写权限 → 契约注入 write_files:false（覆盖 review-only 节点路径）。
    let mut review_policy = NodePolicy::default();
    review_policy.permission_scope.can_write_files = false;
    let review_prompt = agent_prompt_with_policy("review only", &review_policy);
    assert!(review_prompt.contains("write_files: false"));
    assert!(review_prompt.contains("read_files: true"));
}

#[test]
fn agent_write_or_command_permissions_require_high_risk_approval() {
    let mut node = GraphNode {
        node_id: "agent".into(),
        parent_id: None,
        title: "Agent".into(),
        description: None,
        node_kind: NodeKind::Executable,
        input_contract: Default::default(),
        output_contract: Default::default(),
        role_requirement: None,
        capability_requirements: vec![],
        agent_assignment_constraint: None,
        policy: NodePolicy::default(),
        metadata: HashMap::new(),
        executable_payload: Some(ExecutablePayload::Dispatch {
            role_id: "implementer".into(),
            prompt: "Implement".into(),
            project: None,
            session: None,
        }),
        loop_config: None,
        approval_gate_config: None,
    };
    node.policy.permission_scope.can_write_files = true;
    assert_eq!(
        approval_requirement(&node, 0)
            .expect("write-capable agent node should require approval")
            .risk_level,
        "high"
    );

    node.policy.permission_scope.can_write_files = false;
    node.policy.permission_scope.can_run_commands = true;
    assert!(approval_requirement(&node, 0).is_some());
}

#[tokio::test]
async fn engine_executes_shell_and_completes_run() {
    let store = Arc::new(TaskStore::open_in_memory().unwrap());
    let mut policy = NodePolicy::default();
    policy.permission_scope.can_run_commands = true;
    policy.approval_policy = ApprovalPolicy::Never;
    let snapshot = GraphSnapshot {
        nodes: vec![
            GraphNode {
                node_id: "goal".into(),
                parent_id: None,
                title: "Goal".into(),
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
            },
            GraphNode {
                node_id: "shell".into(),
                parent_id: Some("goal".into()),
                title: "Shell".into(),
                description: None,
                node_kind: NodeKind::Executable,
                input_contract: Default::default(),
                output_contract: Default::default(),
                role_requirement: None,
                capability_requirements: vec![],
                agent_assignment_constraint: None,
                policy,
                metadata: HashMap::new(),
                executable_payload: Some(ExecutablePayload::Shell {
                    command: "echo engine-ok".into(),
                    cwd: None,
                    timeout_ms: Some(5_000),
                }),
                loop_config: None,
                approval_gate_config: None,
            },
        ],
        edges: vec![],
    };
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Test".into(),
        goal: "Run shell".into(),
        project_root: PathBuf::from("."),
        owner: "test".into(),
        current_draft_revision: Some("r1".into()),
        created_at: 1,
        updated_at: 1,
    };
    let revision = GraphRevision::from_snapshot("r1", "g1", None, &snapshot, "test", 1).unwrap();
    let run = GraphRun {
        run_id: "run1".into(),
        graph_id: "g1".into(),
        active_revision_id: "r1".into(),
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: BudgetState::default(),
        planning_snapshot: Default::default(),
        started_at: 1,
        finished_at: None,
    };
    let started = build_event(
        "e1",
        "run1",
        1,
        TaskEventType::RunStarted,
        "test",
        1,
        serde_json::to_value(payloads::RunStartedPayload {
            run_id: "run1".into(),
            graph_id: "g1".into(),
            revision_id: "r1".into(),
            initial_status: RunStatus::Running,
            budget_state: BudgetState::default(),
        })
        .unwrap(),
    );
    {
        store.create_graph_with_revision(&graph, &revision).unwrap();
        store.create_run_with_event(&run, &started).unwrap();
    }

    let runtime: Arc<dyn TaskAgentRuntime> = Arc::new(DefaultTaskAgentRuntime::new(Arc::new(
        crate::agent::AgentRegistry::new(),
    )));
    let arbiter = Arc::new(ResourceArbiter::new(ResourceLimits::default()));
    let tick_counter = Arc::new(AtomicU64::new(0));
    let ready_caches: Arc<std::sync::Mutex<std::collections::HashMap<String, ReadySetComputer>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
        .await
        .unwrap();
    for _ in 0..40 {
        let finished = {
            store
                .get_node_runs("run1")
                .unwrap()
                .iter()
                .any(|node_run| node_run.status == NodeRunStatus::Succeeded)
        };
        if finished {
            break;
        }
        sleep(Duration::from_millis(25)).await;
        tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
            .await
            .unwrap();
    }

    let store = store;
    assert_eq!(store.get_run("run1").unwrap().status, RunStatus::Completed);
    let events = store.all_events("run1").unwrap();
    assert!(events
        .iter()
        .any(|event| event.event_type == TaskEventType::AttemptStarted));
    assert!(events
        .iter()
        .any(|event| event.event_type == TaskEventType::NodeResolved));
    assert_eq!(
        events.last().map(|event| &event.event_type),
        Some(&TaskEventType::RunCompleted)
    );
}

#[tokio::test]
async fn engine_dispatches_agent_through_runtime_and_records_assignment() {
    let store = Arc::new(TaskStore::open_in_memory().unwrap());
    let snapshot = GraphSnapshot {
        nodes: vec![GraphNode {
            node_id: "dispatch".into(),
            parent_id: None,
            title: "Dispatch".into(),
            description: None,
            node_kind: NodeKind::Executable,
            input_contract: Default::default(),
            output_contract: Default::default(),
            role_requirement: None,
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: NodePolicy {
                approval_policy: ApprovalPolicy::Never,
                ..Default::default()
            },
            metadata: HashMap::new(),
            executable_payload: Some(ExecutablePayload::Dispatch {
                role_id: "implementer".into(),
                prompt: "Implement the feature".into(),
                project: None,
                session: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        }],
        edges: vec![],
    };
    let graph = TaskGraph {
        graph_id: "g-agent".into(),
        title: "Agent Test".into(),
        goal: "Dispatch".into(),
        project_root: PathBuf::from("."),
        owner: "test".into(),
        current_draft_revision: Some("r-agent".into()),
        created_at: 1,
        updated_at: 1,
    };
    let revision =
        GraphRevision::from_snapshot("r-agent", "g-agent", None, &snapshot, "test", 1).unwrap();
    let run = GraphRun {
        run_id: "run-agent".into(),
        graph_id: "g-agent".into(),
        active_revision_id: "r-agent".into(),
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: BudgetState {
            token_limit: Some(100),
            cost_limit_usd: Some(1.0),
            ..Default::default()
        },
        planning_snapshot: Default::default(),
        started_at: 1,
        finished_at: None,
    };
    let started = build_event(
        "e-agent",
        "run-agent",
        1,
        TaskEventType::RunStarted,
        "test",
        1,
        serde_json::to_value(payloads::RunStartedPayload {
            run_id: "run-agent".into(),
            graph_id: "g-agent".into(),
            revision_id: "r-agent".into(),
            initial_status: RunStatus::Running,
            budget_state: run.budget_state.clone(),
        })
        .unwrap(),
    );
    {
        store.create_graph_with_revision(&graph, &revision).unwrap();
        store.create_run_with_event(&run, &started).unwrap();
    }

    let runtime: Arc<dyn TaskAgentRuntime> = Arc::new(FakeAgentRuntime);
    let arbiter = Arc::new(ResourceArbiter::new(ResourceLimits::default()));
    let tick_counter = Arc::new(AtomicU64::new(0));
    let ready_caches: Arc<std::sync::Mutex<std::collections::HashMap<String, ReadySetComputer>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
        .await
        .unwrap();
    for _ in 0..40 {
        let finished = store
            .get_node_runs("run-agent")
            .unwrap()
            .iter()
            .any(|node_run| node_run.status == NodeRunStatus::Succeeded);
        if finished {
            break;
        }
        sleep(Duration::from_millis(25)).await;
        tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
            .await
            .unwrap();
    }

    let store = store;
    assert_eq!(
        store.get_run("run-agent").unwrap().status,
        RunStatus::Completed
    );
    let persisted_run = store.get_run("run-agent").unwrap();
    assert_eq!(persisted_run.budget_state.token_used, 30);
    assert_eq!(persisted_run.budget_state.cost_used_usd, 0.1);
    let events = store.all_events("run-agent").unwrap();
    let started = events
        .iter()
        .find(|event| event.event_type == TaskEventType::AttemptStarted)
        .unwrap();
    let payload: payloads::AttemptStartedPayload =
        serde_json::from_value(started.payload.clone()).unwrap();
    assert_eq!(payload.agent_assignment.unwrap().agent_id, "fake-agent");
    assert_eq!(payload.transport.as_deref(), Some("test"));
    assert!(events.iter().any(|event| {
        event.event_type == TaskEventType::AttemptProgressed
            && event.payload.to_string().contains("implemented")
    }));
    let projection = crate::orchestrator::events::rebuild_projection("run-agent", &events).unwrap();
    assert_eq!(projection.budget_state.token_used, 30);
    assert_eq!(projection.budget_state.cost_used_usd, 0.1);
}

#[tokio::test]
async fn durable_loop_runs_body_and_completes_from_inline_evaluator() {
    let store = Arc::new(TaskStore::open_in_memory().unwrap());
    let mut shell_policy = NodePolicy::default();
    shell_policy.permission_scope.can_run_commands = true;
    shell_policy.approval_policy = ApprovalPolicy::Never;
    let snapshot = GraphSnapshot {
        nodes: vec![
            GraphNode {
                node_id: "goal".into(),
                parent_id: None,
                title: "Goal".into(),
                description: None,
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
            },
            GraphNode {
                node_id: "loop".into(),
                parent_id: Some("goal".into()),
                title: "Check until healthy".into(),
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
                loop_config: Some(LoopControllerConfig {
                    body_node_ids: vec!["check".into()],
                    evaluator: EvaluatorSpec::Inline {
                        rules: serde_json::json!({
                            "complete_when": {"all_succeeded": true},
                            "result": {"healthy": true}
                        }),
                    },
                    interval_ms: 10,
                    backoff_multiplier: None,
                    max_interval_ms: None,
                    termination_condition: "healthy".into(),
                    max_iterations: Some(3),
                    deadline_ms: None,
                    token_budget: None,
                    cost_budget_usd: None,
                    no_progress_threshold: None,
                    escalation_policy: "pause".into(),
                }),
                approval_gate_config: None,
            },
            GraphNode {
                node_id: "check".into(),
                parent_id: Some("loop".into()),
                title: "Health check".into(),
                description: None,
                node_kind: NodeKind::Executable,
                input_contract: Default::default(),
                output_contract: Default::default(),
                role_requirement: None,
                capability_requirements: vec![],
                agent_assignment_constraint: None,
                policy: shell_policy,
                metadata: Default::default(),
                executable_payload: Some(ExecutablePayload::Shell {
                    command: "echo healthy".into(),
                    cwd: None,
                    timeout_ms: Some(5_000),
                }),
                loop_config: None,
                approval_gate_config: None,
            },
        ],
        edges: vec![],
    };
    let graph = TaskGraph {
        graph_id: "g-loop".into(),
        title: "Loop".into(),
        goal: "Check".into(),
        project_root: PathBuf::from("."),
        owner: "test".into(),
        current_draft_revision: Some("r-loop".into()),
        created_at: 1,
        updated_at: 1,
    };
    let revision =
        GraphRevision::from_snapshot("r-loop", "g-loop", None, &snapshot, "test", 1).unwrap();
    let run = GraphRun {
        run_id: "run-loop".into(),
        graph_id: "g-loop".into(),
        active_revision_id: "r-loop".into(),
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: BudgetState::default(),
        planning_snapshot: Default::default(),
        started_at: 1,
        finished_at: None,
    };
    let started = build_event(
        "e-loop",
        "run-loop",
        1,
        TaskEventType::RunStarted,
        "test",
        1,
        serde_json::to_value(payloads::RunStartedPayload {
            run_id: "run-loop".into(),
            graph_id: "g-loop".into(),
            revision_id: "r-loop".into(),
            initial_status: RunStatus::Running,
            budget_state: BudgetState::default(),
        })
        .unwrap(),
    );
    {
        store.create_graph_with_revision(&graph, &revision).unwrap();
        store.create_run_with_event(&run, &started).unwrap();
    }
    let runtime: Arc<dyn TaskAgentRuntime> = Arc::new(FakeAgentRuntime);
    let arbiter = Arc::new(ResourceArbiter::new(ResourceLimits::default()));
    let tick_counter = Arc::new(AtomicU64::new(0));
    let ready_caches: Arc<std::sync::Mutex<std::collections::HashMap<String, ReadySetComputer>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

    tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
        .await
        .unwrap();
    tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
        .await
        .unwrap();
    for _ in 0..40 {
        if store
            .get_node_runs("run-loop")
            .unwrap()
            .iter()
            .any(|node_run| {
                node_run.node_id == "check" && node_run.status == NodeRunStatus::Succeeded
            })
        {
            break;
        }
        sleep(Duration::from_millis(25)).await;
        tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
            .await
            .unwrap();
    }
    tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
        .await
        .unwrap();
    tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
        .await
        .unwrap();

    let store = store;
    assert_eq!(
        store.get_run("run-loop").unwrap().status,
        RunStatus::Completed
    );
    let events = store.all_events("run-loop").unwrap();
    assert!(events
        .iter()
        .any(|event| event.event_type == TaskEventType::LoopStarted));
    assert!(events
        .iter()
        .any(|event| event.event_type == TaskEventType::IterationStarted));
    assert!(events
        .iter()
        .any(|event| event.event_type == TaskEventType::LoopCompleted));
}

#[tokio::test]
async fn budgetless_control_loop_is_failed_not_started() {
    let store = Arc::new(TaskStore::open_in_memory().unwrap());
    let shell_policy = {
        let mut p = NodePolicy::default();
        p.permission_scope.can_run_commands = true;
        p.approval_policy = ApprovalPolicy::Never;
        p
    };
    let snapshot = GraphSnapshot {
        nodes: vec![
            GraphNode {
                node_id: "goal".into(),
                parent_id: None,
                title: "Goal".into(),
                description: None,
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
            },
            GraphNode {
                node_id: "loop".into(),
                parent_id: Some("goal".into()),
                title: "Budgetless loop".into(),
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
                // ALL budgets None - should fail immediately
                loop_config: Some(LoopControllerConfig {
                    body_node_ids: vec!["body".into()],
                    evaluator: EvaluatorSpec::Inline {
                        rules: serde_json::json!({"outcome": "continue"}),
                    },
                    interval_ms: 100,
                    backoff_multiplier: None,
                    max_interval_ms: None,
                    termination_condition: "none".into(),
                    max_iterations: None,
                    deadline_ms: None,
                    token_budget: None,
                    cost_budget_usd: None,
                    no_progress_threshold: None,
                    escalation_policy: "pause".into(),
                }),
                approval_gate_config: None,
            },
            GraphNode {
                node_id: "body".into(),
                parent_id: Some("loop".into()),
                title: "Body".into(),
                description: None,
                node_kind: NodeKind::Executable,
                input_contract: Default::default(),
                output_contract: Default::default(),
                role_requirement: None,
                capability_requirements: vec![],
                agent_assignment_constraint: None,
                policy: shell_policy,
                metadata: Default::default(),
                executable_payload: Some(ExecutablePayload::Shell {
                    command: "echo test".into(),
                    cwd: None,
                    timeout_ms: Some(5000),
                }),
                loop_config: None,
                approval_gate_config: None,
            },
        ],
        edges: vec![],
    };
    let graph = TaskGraph {
        graph_id: "g-budgetless".into(),
        title: "Budgetless".into(),
        goal: "Test".into(),
        project_root: PathBuf::from("."),
        owner: "test".into(),
        current_draft_revision: Some("r-budgetless".into()),
        created_at: 1,
        updated_at: 1,
    };
    let revision =
        GraphRevision::from_snapshot("r-budgetless", "g-budgetless", None, &snapshot, "test", 1)
            .unwrap();
    let run = GraphRun {
        run_id: "run-budgetless".into(),
        graph_id: "g-budgetless".into(),
        active_revision_id: "r-budgetless".into(),
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: Default::default(),
        planning_snapshot: Default::default(),
        started_at: now_ms(),
        finished_at: None,
    };
    store.create_graph(&graph).unwrap();
    store.save_revision(&revision).unwrap();
    store.create_run(&run).unwrap();

    let runtime: Arc<dyn TaskAgentRuntime> = Arc::new(FakeAgentRuntime);
    let arbiter = Arc::new(ResourceArbiter::new(ResourceLimits::default()));
    let tick_counter = Arc::new(AtomicU64::new(0));
    let ready_caches: Arc<std::sync::Mutex<std::collections::HashMap<String, ReadySetComputer>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

    tick(&store, &runtime, &arbiter, &tick_counter, &ready_caches)
        .await
        .unwrap();

    // The loop should have failed immediately without starting
    let loop_runs = store
        .get_node_runs("run-budgetless")
        .unwrap()
        .into_iter()
        .filter(|nr| nr.node_id == "loop")
        .collect::<Vec<_>>();
    assert_eq!(loop_runs.len(), 1);
    let loop_run = &loop_runs[0];
    assert_eq!(loop_run.status, NodeRunStatus::Failed);
    assert!(loop_run.error.as_ref().unwrap().contains("no hard budget"));

    // NO IterationStarted event should have been emitted
    let events = store.all_events("run-budgetless").unwrap();
    assert!(!events
        .iter()
        .any(|e| e.event_type == TaskEventType::IterationStarted));
}

#[test]
fn retry_policy_only_retries_transient_idempotent_attempts() {
    let mut node = GraphNode {
        node_id: "retry".into(),
        parent_id: None,
        title: "Retry".into(),
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
    };
    let attempt = NodeAttempt {
        attempt_id: "a".into(),
        node_run_id: "nr".into(),
        attempt_number: 0,
        agent_assignment: None,
        transport: None,
        session_id: None,
        lease: None,
        usage: Default::default(),
        error: None,
        idempotency_key: Some("key".into()),
        checkpoint: None,
        dispatch_prompt: None,
        started_at: 1,
        finished_at: None,
    };
    let transient = attempt_error(ErrorCategory::Transient, "temporary", true);
    assert!(should_retry(&node, &attempt, &transient));
    assert!(should_retry(
        &node,
        &attempt,
        &attempt_error(ErrorCategory::LostLease, "lost", true)
    ));
    node.policy.idempotency_policy = IdempotencyPolicy::NoRetry;
    assert!(!should_retry(&node, &attempt, &transient));
    assert!(!should_retry(
        &node,
        &attempt,
        &attempt_error(ErrorCategory::Deterministic, "bad input", false)
    ));
}

#[test]
fn recover_lost_lease_recovers_expired_leased_node() {
    let store = Arc::new(TaskStore::open_in_memory().unwrap());
    let snapshot = GraphSnapshot {
        nodes: vec![GraphNode {
            node_id: "n1".into(),
            parent_id: None,
            title: "Node 1".into(),
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
                command: "echo test".into(),
                cwd: None,
                timeout_ms: Some(5_000),
            }),
            loop_config: None,
            approval_gate_config: None,
        }],
        edges: vec![],
    };
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Test".into(),
        goal: "Test lease recovery".into(),
        project_root: PathBuf::from("."),
        owner: "test".into(),
        current_draft_revision: Some("r1".into()),
        created_at: 1,
        updated_at: 1,
    };
    let revision = GraphRevision::from_snapshot("r1", "g1", None, &snapshot, "test", 1).unwrap();
    let run = GraphRun {
        run_id: "run1".into(),
        graph_id: "g1".into(),
        active_revision_id: "r1".into(),
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: BudgetState::default(),
        planning_snapshot: Default::default(),
        started_at: 1,
        finished_at: None,
    };
    let started = build_event(
        "e1",
        "run1",
        1,
        TaskEventType::RunStarted,
        "test",
        1,
        serde_json::to_value(payloads::RunStartedPayload {
            run_id: "run1".into(),
            graph_id: "g1".into(),
            revision_id: "r1".into(),
            initial_status: RunStatus::Running,
            budget_state: BudgetState::default(),
        })
        .unwrap(),
    );
    store.create_graph_with_revision(&graph, &revision).unwrap();
    store.create_run_with_event(&run, &started).unwrap();

    // Create a Leased node_run with an expired lease
    let mut node_run = NodeRun::new("nr1", "run1", "n1", "r1");
    node_run.status = NodeRunStatus::Leased;
    let past_deadline = now_ms() - 10_000;
    let attempt = NodeAttempt {
        attempt_id: "att1".into(),
        node_run_id: "nr1".into(),
        attempt_number: 0,
        agent_assignment: None,
        transport: None,
        session_id: None,
        lease: Some(Lease {
            lease_id: "lease1".into(),
            node_run_id: "nr1".into(),
            attempt_id: "att1".into(),
            owner: "local_execution_engine".into(),
            resources: vec![],
            expires_at: past_deadline,
            heartbeat_deadline: past_deadline,
        }),
        usage: AttemptUsage::default(),
        error: None,
        idempotency_key: None,
        checkpoint: None,
        dispatch_prompt: None,
        started_at: 1,
        finished_at: None,
    };
    let node_ready = build_event(
        "evt1",
        "run1",
        2,
        TaskEventType::NodeReady,
        "test",
        2,
        serde_json::to_value(payloads::NodeReadyPayload {
            node_run_id: "nr1".into(),
            node_id: "n1".into(),
        })
        .unwrap(),
    );
    store
        .save_execution_update(&node_run, Some(&attempt), &[], &[node_ready], None, None)
        .unwrap();

    // Use a fresh ResourceArbiter (lease not registered)
    let arbiter = ResourceArbiter::new(ResourceLimits::default());

    // First recovery should succeed
    let recovered = recover_lost_lease(&store, &arbiter, &run, &snapshot, &[node_run.clone()])
        .expect("recovery should succeed");
    assert!(recovered, "expired leased node should be recovered");

    // Check events were emitted
    let events = store.all_events("run1").unwrap();
    assert!(
        events
            .iter()
            .any(|e| e.event_type == TaskEventType::LeaseExpired),
        "should emit LeaseExpired event"
    );
    assert!(
        events
            .iter()
            .any(|e| e.event_type == TaskEventType::AttemptFailed),
        "should emit AttemptFailed event"
    );

    // Check status is no longer Leased
    let latest_runs = store.get_node_runs("run1").unwrap();
    let latest = latest_runs
        .iter()
        .find(|nr| nr.node_run_id == "nr1")
        .expect("node_run should exist");
    assert_ne!(latest.status, NodeRunStatus::Leased);

    // Idempotency: second recovery should return false (no longer eligible)
    let recovered_again = recover_lost_lease(&store, &arbiter, &run, &snapshot, &[latest.clone()])
        .expect("recovery should succeed");
    assert!(
        !recovered_again,
        "already recovered node should not be recovered again"
    );

    // Negative case: Leased node with live heartbeat should not be recovered
    let mut node_run_live = NodeRun::new("nr2", "run1", "n1", "r1");
    node_run_live.status = NodeRunStatus::Leased;
    let future_deadline = now_ms() + 60_000;
    let attempt_live = NodeAttempt {
        attempt_id: "att2".into(),
        node_run_id: "nr2".into(),
        attempt_number: 0,
        agent_assignment: None,
        transport: None,
        session_id: None,
        lease: Some(Lease {
            lease_id: "lease2".into(),
            node_run_id: "nr2".into(),
            attempt_id: "att2".into(),
            owner: "local_execution_engine".into(),
            resources: vec![],
            expires_at: future_deadline,
            heartbeat_deadline: future_deadline,
        }),
        usage: AttemptUsage::default(),
        error: None,
        idempotency_key: None,
        checkpoint: None,
        dispatch_prompt: None,
        started_at: 1,
        finished_at: None,
    };
    // Get the current run_seq to avoid conflicts
    let current_run = store.get_run("run1").unwrap();
    let next_run_seq = current_run.run_seq + 1;
    let next_occurred_at = next_run_seq as i64;
    let node_ready_live = build_event(
        "evt2",
        "run1",
        next_run_seq,
        TaskEventType::NodeReady,
        "test",
        next_occurred_at,
        serde_json::to_value(payloads::NodeReadyPayload {
            node_run_id: "nr2".into(),
            node_id: "n1".into(),
        })
        .unwrap(),
    );
    store
        .save_execution_update(
            &node_run_live,
            Some(&attempt_live),
            &[],
            &[node_ready_live],
            None,
            None,
        )
        .unwrap();

    let recovered_live =
        recover_lost_lease(&store, &arbiter, &run, &snapshot, &[node_run_live.clone()])
            .expect("recovery should succeed");
    assert!(
        !recovered_live,
        "node with live heartbeat should not be recovered"
    );

    // Verify no LeaseExpired was emitted for the live case
    let events_after = store.all_events("run1").unwrap();
    let lease_expired_count = events_after
        .iter()
        .filter(|e| e.event_type == TaskEventType::LeaseExpired)
        .count();
    assert_eq!(
        lease_expired_count, 1,
        "should only have one LeaseExpired (from the first recovery)"
    );
}

#[test]
fn refresh_lease_heartbeat_updates_deadline() {
    let store = Arc::new(TaskStore::open_in_memory().unwrap());
    let snapshot = GraphSnapshot {
        nodes: vec![GraphNode {
            node_id: "n1".into(),
            parent_id: None,
            title: "Node 1".into(),
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
                command: "echo test".into(),
                cwd: None,
                timeout_ms: Some(5_000),
            }),
            loop_config: None,
            approval_gate_config: None,
        }],
        edges: vec![],
    };
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Test".into(),
        goal: "Test heartbeat refresh".into(),
        project_root: PathBuf::from("."),
        owner: "test".into(),
        current_draft_revision: Some("r1".into()),
        created_at: 1,
        updated_at: 1,
    };
    let revision = GraphRevision::from_snapshot("r1", "g1", None, &snapshot, "test", 1).unwrap();
    let run = GraphRun {
        run_id: "run1".into(),
        graph_id: "g1".into(),
        active_revision_id: "r1".into(),
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: BudgetState::default(),
        planning_snapshot: Default::default(),
        started_at: 1,
        finished_at: None,
    };
    let started = build_event(
        "e1",
        "run1",
        1,
        TaskEventType::RunStarted,
        "test",
        1,
        serde_json::to_value(payloads::RunStartedPayload {
            run_id: "run1".into(),
            graph_id: "g1".into(),
            revision_id: "r1".into(),
            initial_status: RunStatus::Running,
            budget_state: BudgetState::default(),
        })
        .unwrap(),
    );
    store.create_graph_with_revision(&graph, &revision).unwrap();
    store.create_run_with_event(&run, &started).unwrap();

    // Create a Leased node_run with an attempt that has a lease
    let mut node_run = NodeRun::new("nr1", "run1", "n1", "r1");
    node_run.status = NodeRunStatus::Leased;
    let attempt = NodeAttempt {
        attempt_id: "att1".into(),
        node_run_id: "nr1".into(),
        attempt_number: 0,
        agent_assignment: None,
        transport: None,
        session_id: None,
        lease: Some(Lease {
            lease_id: "lease1".into(),
            node_run_id: "nr1".into(),
            attempt_id: "att1".into(),
            owner: "local_execution_engine".into(),
            resources: vec![],
            expires_at: 5000,
            heartbeat_deadline: 1000,
        }),
        usage: AttemptUsage::default(),
        error: None,
        idempotency_key: None,
        checkpoint: None,
        dispatch_prompt: None,
        started_at: 1,
        finished_at: None,
    };
    let node_ready = build_event(
        "evt1",
        "run1",
        2,
        TaskEventType::NodeReady,
        "test",
        2,
        serde_json::to_value(payloads::NodeReadyPayload {
            node_run_id: "nr1".into(),
            node_id: "n1".into(),
        })
        .unwrap(),
    );
    store
        .save_execution_update(&node_run, Some(&attempt), &[], &[node_ready], None, None)
        .unwrap();

    // Refresh the heartbeat
    store
        .refresh_lease_heartbeat("nr1", 99_999)
        .expect("refresh should succeed");

    // Verify the heartbeat was updated
    let updated_attempt = store
        .latest_attempt("nr1")
        .unwrap()
        .expect("attempt should exist");
    let updated_lease = updated_attempt.lease.as_ref().expect("lease should exist");
    assert_eq!(updated_lease.heartbeat_deadline, 99_999);

    // No-op safety: refreshing a nonexistent node_run should not error
    store
        .refresh_lease_heartbeat("nonexistent_node_run", 5)
        .expect("refresh on nonexistent should be ok (no-op)");

    // Refreshing a node_run with no attempt should not error
    store
        .refresh_lease_heartbeat("nr_no_attempt", 10)
        .expect("refresh on node_run with no attempt should be ok (no-op)");
}

#[tokio::test]
async fn drive_loops_skips_when_active_revision_changed() {
    let store = Arc::new(TaskStore::open_in_memory().unwrap());
    let mut shell_policy = NodePolicy::default();
    shell_policy.permission_scope.can_run_commands = true;
    shell_policy.approval_policy = ApprovalPolicy::Never;
    let snapshot = GraphSnapshot {
        nodes: vec![
            GraphNode {
                node_id: "goal".into(),
                parent_id: None,
                title: "Goal".into(),
                description: None,
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
            },
            GraphNode {
                node_id: "loop1".into(),
                parent_id: Some("goal".into()),
                title: "Test loop".into(),
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
                loop_config: Some(LoopControllerConfig {
                    body_node_ids: vec!["body".into()],
                    evaluator: EvaluatorSpec::Inline {
                        rules: serde_json::json!({"outcome": "continue"}),
                    },
                    interval_ms: 10,
                    backoff_multiplier: None,
                    max_interval_ms: None,
                    termination_condition: "none".into(),
                    max_iterations: Some(5),
                    deadline_ms: None,
                    token_budget: None,
                    cost_budget_usd: None,
                    no_progress_threshold: None,
                    escalation_policy: "pause".into(),
                }),
                approval_gate_config: None,
            },
            GraphNode {
                node_id: "body".into(),
                parent_id: Some("loop1".into()),
                title: "Body".into(),
                description: None,
                node_kind: NodeKind::Executable,
                input_contract: Default::default(),
                output_contract: Default::default(),
                role_requirement: None,
                capability_requirements: vec![],
                agent_assignment_constraint: None,
                policy: shell_policy,
                metadata: Default::default(),
                executable_payload: Some(ExecutablePayload::Shell {
                    command: "echo test".into(),
                    cwd: None,
                    timeout_ms: Some(5000),
                }),
                loop_config: None,
                approval_gate_config: None,
            },
        ],
        edges: vec![],
    };
    let graph = TaskGraph {
        graph_id: "g1".into(),
        title: "Test".into(),
        goal: "Test".into(),
        project_root: PathBuf::from("."),
        owner: "test".into(),
        current_draft_revision: Some("r1".into()),
        created_at: 1,
        updated_at: 1,
    };
    let revision = GraphRevision::from_snapshot("r1", "g1", None, &snapshot, "test", 1).unwrap();

    // Create run on r2 in store (simulating mid-tick revision switch)
    let store_run = GraphRun {
        run_id: "run1".into(),
        graph_id: "g1".into(),
        active_revision_id: "r2".into(), // Different from graph's r1
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: BudgetState::default(),
        planning_snapshot: Default::default(),
        started_at: 1,
        finished_at: None,
    };
    let started = build_event(
        "e1",
        "run1",
        1,
        TaskEventType::RunStarted,
        "test",
        1,
        serde_json::to_value(payloads::RunStartedPayload {
            run_id: "run1".into(),
            graph_id: "g1".into(),
            revision_id: "r2".into(), // Event reflects the run's revision
            initial_status: RunStatus::Running,
            budget_state: BudgetState::default(),
        })
        .unwrap(),
    );
    store.create_graph_with_revision(&graph, &revision).unwrap();
    store.create_run_with_event(&store_run, &started).unwrap();

    // Build tick_run with stale revision r1 (the tick's view)
    let tick_run = GraphRun {
        run_id: "run1".into(),
        graph_id: "g1".into(),
        active_revision_id: "r1".into(), // Stale revision
        status: RunStatus::Running,
        run_seq: 1,
        budget_state: BudgetState::default(),
        planning_snapshot: Default::default(),
        started_at: 1,
        finished_at: None,
    };

    // Create a Running loop_run in the store so that WITHOUT the guard
    // drive_loops WOULD drive it (body succeeded, evaluator path reachable)
    // These node_runs use r2 to match the store run's active_revision_id
    let mut loop_run = NodeRun::new("nr_loop", "run1", "loop1", "r2");
    loop_run.status = NodeRunStatus::Running;
    loop_run.loop_iteration = Some(0);
    loop_run.started_at = Some(1);
    store.save_node_run(&loop_run).unwrap();
    let mut body_run = NodeRun::new("nr_body", "run1", "body", "r2");
    body_run.status = NodeRunStatus::Succeeded;
    body_run.loop_iteration = Some(0);
    body_run.started_at = Some(1);
    body_run.finished_at = Some(2);
    store.save_node_run(&body_run).unwrap();

    // Call drive_loops with the stale tick_run
    let node_runs = store.get_node_runs("run1").unwrap();
    let result = drive_loops(&store, &tick_run, &snapshot, &node_runs)
        .await
        .unwrap();

    // Assert the guard returns false (bails early)
    assert!(
        !result,
        "drive_loops must bail when the run's active revision changed"
    );

    // Assert NO driving events were emitted
    let events = store.all_events("run1").unwrap();
    assert!(
        events
            .iter()
            .all(|e| e.event_type != TaskEventType::ProgressEvaluated),
        "should not emit ProgressEvaluated when guard fires"
    );
    assert!(
        events
            .iter()
            .all(|e| e.event_type != TaskEventType::IterationStarted),
        "should not emit IterationStarted when guard fires"
    );
}

// 拆分后补充：兄弟模块中的被测函数（原同模块可见）
use super::execute::{
    agent_prompt_with_policy, approval_requirement, execute_agent, required_prepared_agent,
    task_continuation_from_request, PreparedAgentExecution,
};
use super::lease::recover_lost_lease;
use super::loops::drive_loops;
use super::schedule::should_retry;
