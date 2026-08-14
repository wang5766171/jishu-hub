use super::*;
use crate::orchestrator::commands::{CreateGraphInput, NodePatch};
use crate::orchestrator::domain::graph::{
    EdgeKind, ExecutablePayload, GraphEdge, GraphNode, NodeKind,
};
use crate::orchestrator::domain::policy::{ApprovalPolicy, NodePolicy};
use std::collections::HashMap;

fn shell_node(node_id: &str, title: &str) -> GraphNode {
    GraphNode {
        node_id: node_id.into(),
        parent_id: Some("goal".into()),
        title: title.into(),
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
            command: format!("echo {node_id}"),
            cwd: None,
            timeout_ms: None,
        }),
        loop_config: None,
        approval_gate_config: None,
    }
}

#[test]
fn attach_repair_attaches_candidate_and_resets_failed_node() {
    let svc = TaskService::open_in_memory().unwrap();
    let (graph, initial_revision) = svc
        .create_graph(&CreateGraphInput {
            title: "Repair test".into(),
            goal: "goal".into(),
            project_root: "/p".into(),
            owner: "user".into(),
            ..Default::default()
        })
        .unwrap();
    let revision = svc
        .apply_commands(
            &graph.graph_id,
            &initial_revision.revision_id,
            &[GraphCommand::AddNode {
                command_id: "add-shell".into(),
                node: shell_node("shell", "Shell node"),
            }],
            "user",
        )
        .unwrap()
        .revision;
    let run = svc
        .start_run(&graph.graph_id, &revision.revision_id)
        .unwrap();
    // Seed a failed node run for the shell node.
    let mut failed = NodeRun::new("nr-shell", &run.run_id, "shell", &revision.revision_id);
    failed.status = NodeRunStatus::Failed;
    failed.error = Some("boom".into());
    svc.store.save_node_run(&failed).unwrap();

    // Repair: adjust the shell node's policy (Supervisor-generated command).
    let repair_revision_id = svc
        .attach_repair(
            &run.run_id,
            "nr-shell",
            &[GraphCommand::UpdatePolicy {
                command_id: "repair-1".into(),
                node_id: "shell".into(),
                policy: NodePolicy::default(),
            }],
            1,
        )
        .unwrap();

    // The run is now on the repaired candidate revision.
    let updated_run = svc.get_run(&run.run_id).unwrap();
    assert_eq!(updated_run.active_revision_id, repair_revision_id);
    // The failed node was reset to re-run under the repaired revision.
    let repaired = svc.store.get_node_run("nr-shell").unwrap();
    assert_eq!(repaired.status, NodeRunStatus::Blocked);
    assert_eq!(repaired.revision_id, repair_revision_id);
    assert_eq!(repaired.error, None);
    // The repair was recorded as an event (event-sourced depth tracking).
    let events = svc.store.all_events(&run.run_id).unwrap();
    assert!(events.iter().any(|event| {
        event.event_type == crate::orchestrator::events::TaskEventType::RepairGraphAttached
    }));
    // The user's draft was not touched by the run-scoped repair.
    let graph_after = svc.get_graph(&graph.graph_id).unwrap();
    assert_ne!(
        graph_after.current_draft_revision.as_deref(),
        Some(repair_revision_id.as_str())
    );
}

#[test]
fn create_graph_and_revision() {
    let svc = TaskService::open_in_memory().unwrap();
    let input = CreateGraphInput {
        title: "Test Task".into(),
        goal: "Build feature X".into(),
        project_root: "/project".into(),
        owner: "user".into(),
        skill_refs: vec![crate::orchestrator::domain::revision::SkillRef {
            skill_id: "superpowers".into(),
            version_or_hash: "sha256:test".into(),
            inputs: serde_json::json!({"mode": "tdd"}),
        }],
        ..Default::default()
    };
    let (graph, revision) = svc.create_graph(&input).unwrap();
    assert_eq!(graph.title, "Test Task");
    assert_eq!(revision.graph_id, graph.graph_id);
    assert_eq!(revision.skill_refs.len(), 1);

    let recovered_graph = svc.get_graph(&graph.graph_id).unwrap();
    assert_eq!(recovered_graph.goal, "Build feature X");
    let recovered_revision = svc.get_revision(&revision.revision_id).unwrap();
    assert_eq!(recovered_revision.skill_refs[0].skill_id, "superpowers");
}

#[test]
fn task_conversations_are_project_scoped_and_public_only() {
    let svc = TaskService::open_in_memory().unwrap();
    let (graph, initial_revision) = svc
        .create_graph(&CreateGraphInput {
            title: "Permission system".into(),
            goal: "Design organization-aware permissions".into(),
            project_root: "/project-a".into(),
            owner: "user".into(),
            ..Default::default()
        })
        .unwrap();
    let revision = svc
        .apply_commands(
            &graph.graph_id,
            &initial_revision.revision_id,
            &[GraphCommand::AddNode {
                command_id: "add-api".into(),
                node: shell_node("api", "Backend API"),
            }],
            "user",
        )
        .unwrap()
        .revision;
    let run = svc
        .start_run(&graph.graph_id, &revision.revision_id)
        .unwrap();
    let mut node_run = NodeRun::new("nr-api", &run.run_id, "api", &revision.revision_id);
    node_run.status = NodeRunStatus::Running;
    node_run.started_at = Some(now_ms());
    svc.store.save_node_run(&node_run).unwrap();
    svc.store
        .append_events(&[build_event(
            gen_id("evt"),
            &run.run_id,
            2,
            TaskEventType::AttemptProgressed,
            "worker",
            now_ms(),
            serde_json::json!({
                "attempt_id": "attempt-1",
                "node_run_id": "nr-api",
                "message": "INTERNAL write_files: false"
            }),
        )])
        .unwrap();

    let summaries = svc
        .list_task_conversations(std::path::Path::new("/project-a"))
        .unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].owner_agent_id, "jishu-self");
    assert_eq!(
        summaries[0].current_node_title.as_deref(),
        Some("Backend API")
    );

    let detail = svc.get_task_conversation(&graph.graph_id, 0).unwrap();
    let serialized = serde_json::to_string(&detail).unwrap();
    assert_eq!(detail.summary.graph_id, graph.graph_id);
    assert!(!serialized.contains("write_files"));
    assert!(!serialized.contains("INTERNAL"));
}

#[test]
fn submit_task_message_appends_public_user_conversation_entry() {
    let svc = TaskService::open_in_memory().unwrap();
    let (graph, initial_revision) = svc
        .create_graph(&CreateGraphInput {
            title: "Permission system".into(),
            goal: "Design organization-aware permissions".into(),
            project_root: "/project-a".into(),
            owner: "user".into(),
            ..Default::default()
        })
        .unwrap();
    let revision = svc
        .apply_commands(
            &graph.graph_id,
            &initial_revision.revision_id,
            &[GraphCommand::AddNode {
                command_id: "add-api".into(),
                node: shell_node("api", "Backend API"),
            }],
            "user",
        )
        .unwrap()
        .revision;
    let run = svc
        .start_run(&graph.graph_id, &revision.revision_id)
        .unwrap();
    let mut node_run = NodeRun::new("nr-api", &run.run_id, "api", &revision.revision_id);
    node_run.status = NodeRunStatus::Running;
    node_run.started_at = Some(now_ms());
    svc.store.save_node_run(&node_run).unwrap();

    let detail = svc
        .submit_task_message(
            &graph.graph_id,
            Some("api"),
            "Please prioritize the permission boundary.",
        )
        .unwrap();

    let user_entry = detail
        .entries
        .iter()
        .find(|entry| {
            entry.kind == crate::orchestrator::conversation::TaskConversationEntryKind::UserMessage
                && entry.actor == "user"
                && entry.node_id.as_deref() == Some("api")
        })
        .expect("task message should become a public user entry");
    assert_eq!(
        user_entry
            .payload
            .get("text")
            .and_then(serde_json::Value::as_str),
        Some("Please prioritize the permission boundary.")
    );
    assert_eq!(svc.get_run(&run.run_id).unwrap().run_seq, 2);
}

#[test]
fn apply_commands_creates_new_revision() {
    let svc = TaskService::open_in_memory().unwrap();
    let input = CreateGraphInput {
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: "/project".into(),
        owner: "user".into(),
        template_refs: vec![crate::orchestrator::domain::revision::TemplateRef {
            template_id: "review".into(),
            version_or_hash: "sha256:review".into(),
            inputs: serde_json::json!({"strict": true}),
        }],
        ..Default::default()
    };
    let (_, revision) = svc.create_graph(&input).unwrap();

    let new_node = GraphNode {
        node_id: "n1".into(),
        parent_id: Some("goal".into()),
        title: "Step 1".into(),
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
    };

    let commands = vec![GraphCommand::AddNode {
        command_id: "c1".into(),
        node: new_node,
    }];

    let result = svc
        .apply_commands(&revision.graph_id, &revision.revision_id, &commands, "user")
        .unwrap();

    assert_ne!(result.revision.revision_id, revision.revision_id);
    assert!(result.diff.is_some());
    let diff = result.diff.unwrap();
    assert!(diff.nodes_added.contains(&"n1".to_string()));
}

#[test]
fn apply_commands_rejected_when_run_is_terminal() {
    // 簇B 完成态只读（设计 §11 done）：图已有终态 run（completed/failed/cancelled）时，
    // apply_commands 必须拒绝，防止已完成/失败/取消的任务被继续改图。
    // 仅终态拦截；运行中/草稿态保留原行为（完成路径在 daemon engine，此处用 store 直写只测守卫）。
    let svc = TaskService::open_in_memory().unwrap();
    let input = CreateGraphInput {
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: "/project".into(),
        owner: "user".into(),
        ..Default::default()
    };
    let (graph, revision) = svc.create_graph(&input).unwrap();
    let run = svc
        .start_run(&graph.graph_id, &revision.revision_id)
        .unwrap();

    // 直接将 run 置为 Completed（完成态）。
    svc.store
        .update_run_status(
            &run.run_id,
            &RunStatus::Completed,
            run.run_seq,
            Some(now_ms()),
        )
        .unwrap();
    assert!(svc.get_run(&run.run_id).unwrap().status.is_terminal());

    let commands = vec![GraphCommand::AddNode {
        command_id: "c1".into(),
        node: GraphNode {
            node_id: "n1".into(),
            parent_id: Some("goal".into()),
            title: "N1".into(),
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
        },
    }];

    let err = svc
        .apply_commands(&graph.graph_id, &revision.revision_id, &commands, "user")
        .expect_err("apply_commands must be rejected in done state");
    assert!(
        matches!(err, TaskServiceError::Conflict { .. }),
        "expected Conflict in done state, got {err:?}"
    );
}

#[test]
fn apply_commands_rejected_when_node_is_frozen() {
    // A8 冻结校验（设计 §10.6 / 10 §3.5.6）：图有非终态 run 时，已租赁/运行中/待审批/
    // 已完成/失败/自愈中的节点不可经 apply_commands 改动——与 propose_run_revision 口径一致。
    // 构造一个 Running（冻结）的 node_run：断言 UpdateNode 它被拒、AddNode 新节点放行。
    let svc = TaskService::open_in_memory().unwrap();
    let (graph, revision) = svc
        .create_graph(&CreateGraphInput {
            title: "Freeze".into(),
            goal: "Edit frozen".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        })
        .unwrap();
    // pre-run 加一个可执行节点（无冻结）。
    let added = svc
        .apply_commands(
            &graph.graph_id,
            &revision.revision_id,
            &[GraphCommand::AddNode {
                command_id: "add".into(),
                node: GraphNode {
                    node_id: "write".into(),
                    parent_id: Some("goal".into()),
                    title: "Write".into(),
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
                },
            }],
            "user",
        )
        .unwrap();
    let draft = added.revision.revision_id.clone();
    let run = svc.start_run(&graph.graph_id, &draft).unwrap();
    // 节点 write 进入 Running（冻结态）。
    let mut node_run = NodeRun::new("nr-write", &run.run_id, "write", &draft);
    node_run.status = NodeRunStatus::Running;
    svc.store.save_node_run(&node_run).unwrap();

    // UpdateNode 冻结节点 → Conflict。
    let frozen_err = svc
        .apply_commands(
            &graph.graph_id,
            &draft,
            &[GraphCommand::UpdateNode {
                command_id: "upd".into(),
                node_id: "write".into(),
                patch: NodePatch {
                    title: Some("Write v2".into()),
                    ..Default::default()
                },
            }],
            "user",
        )
        .expect_err("apply_commands must reject mutating a frozen node");
    assert!(
        matches!(frozen_err, TaskServiceError::Conflict { .. }),
        "expected Conflict on frozen node, got {frozen_err:?}"
    );

    // AddNode 新节点不触碰冻结节点 → 放行（首版 run-前 编排核心场景：无关节点冻结不误伤）。
    svc.apply_commands(
        &graph.graph_id,
        &draft,
        &[GraphCommand::AddNode {
            command_id: "add2".into(),
            node: GraphNode {
                node_id: "extra".into(),
                parent_id: Some("goal".into()),
                title: "Extra".into(),
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
                    command: "echo extra".into(),
                    cwd: None,
                    timeout_ms: None,
                }),
                loop_config: None,
                approval_gate_config: None,
            },
        }],
        "user",
    )
    .expect("AddNode of a new node must not be blocked by an unrelated frozen node");
}

#[test]
fn checkout_draft_revision_uses_optimistic_lock() {
    let svc = TaskService::open_in_memory().unwrap();
    let input = CreateGraphInput {
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: "/project".into(),
        owner: "user".into(),
        ..Default::default()
    };
    let (graph, first_revision) = svc.create_graph(&input).unwrap();
    let second_revision = svc
        .apply_commands(
            &graph.graph_id,
            &first_revision.revision_id,
            &[GraphCommand::AddNode {
                command_id: "add-n1".into(),
                node: GraphNode {
                    node_id: "n1".into(),
                    parent_id: Some("goal".into()),
                    title: "N1".into(),
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
                        command: "echo 1".into(),
                        cwd: None,
                        timeout_ms: None,
                    }),
                    loop_config: None,
                    approval_gate_config: None,
                },
            }],
            "user",
        )
        .unwrap()
        .revision;

    let restored = svc
        .checkout_draft_revision(
            &graph.graph_id,
            &second_revision.revision_id,
            &first_revision.revision_id,
        )
        .unwrap();
    assert_eq!(restored.revision_id, first_revision.revision_id);
    assert_eq!(
        svc.get_graph(&graph.graph_id)
            .unwrap()
            .current_draft_revision
            .as_deref(),
        Some(first_revision.revision_id.as_str())
    );
    assert!(svc
        .checkout_draft_revision(
            &graph.graph_id,
            &second_revision.revision_id,
            &first_revision.revision_id,
        )
        .is_err());
}

#[test]
fn apply_commands_conflict_on_stale_revision() {
    let svc = TaskService::open_in_memory().unwrap();
    let input = CreateGraphInput {
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: "/project".into(),
        owner: "user".into(),
        ..Default::default()
    };
    let (_, revision) = svc.create_graph(&input).unwrap();

    // First command succeeds.
    let node1 = GraphNode {
        node_id: "n1".into(),
        parent_id: Some("goal".into()),
        title: "N1".into(),
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
            command: "echo 1".into(),
            cwd: None,
            timeout_ms: None,
        }),
        loop_config: None,
        approval_gate_config: None,
    };

    let commands1 = vec![GraphCommand::AddNode {
        command_id: "c1".into(),
        node: node1,
    }];

    let result1 = svc
        .apply_commands(
            &revision.graph_id,
            &revision.revision_id,
            &commands1,
            "user",
        )
        .unwrap();

    // Second command using stale revision should fail.
    let node2 = GraphNode {
        node_id: "n2".into(),
        parent_id: Some("goal".into()),
        title: "N2".into(),
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
            command: "echo 2".into(),
            cwd: None,
            timeout_ms: None,
        }),
        loop_config: None,
        approval_gate_config: None,
    };

    let commands2 = vec![GraphCommand::AddNode {
        command_id: "c2".into(),
        node: node2,
    }];

    let result2 = svc.apply_commands(
        &revision.graph_id,
        &revision.revision_id,
        &commands2,
        "user",
    );
    assert!(result2.is_err());

    // Verify the conflict error carries the current revision.
    let task_err: TaskError = result2.unwrap_err().into();
    assert_eq!(task_err.code, "TASK_CONFLICT");
    assert!(task_err.current_revision.is_some());
    assert_eq!(
        task_err.current_revision.unwrap(),
        result1.revision.revision_id
    );
    assert!(task_err.current_run_seq.is_none());
}

#[test]
fn conflict_error_conversion_with_live_values() {
    // Test service-layer Conflict with live values converts through to TaskError.
    let svc_err = TaskServiceError::Conflict {
        message: "test conflict".into(),
        current_revision: Some("rev-123".into()),
        current_run_seq: Some(42),
    };
    let task_err: TaskError = svc_err.into();
    assert_eq!(task_err.code, "TASK_CONFLICT");
    assert_eq!(task_err.current_revision, Some("rev-123".into()));
    assert_eq!(task_err.current_run_seq, Some(42));
}

#[test]
fn conflict_error_conversion_from_store() {
    // Test store-layer Conflict (no live values) converts through to TaskError.
    let store_err = StoreError::Conflict("store conflict".into());
    let svc_err = TaskServiceError::Store(store_err);
    let task_err: TaskError = svc_err.into();
    assert_eq!(task_err.code, "TASK_CONFLICT");
    assert!(task_err.current_revision.is_none());
    assert!(task_err.current_run_seq.is_none());
}

#[test]
fn start_run_emits_event() {
    let svc = TaskService::open_in_memory().unwrap();
    let input = CreateGraphInput {
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: "/project".into(),
        owner: "user".into(),
        template_refs: vec![crate::orchestrator::domain::revision::TemplateRef {
            template_id: "review".into(),
            version_or_hash: "sha256:review".into(),
            inputs: serde_json::json!({"strict": true}),
        }],
        ..Default::default()
    };
    let (graph, revision) = svc.create_graph(&input).unwrap();

    let run = svc
        .start_run(&graph.graph_id, &revision.revision_id)
        .unwrap();
    assert_eq!(run.status, RunStatus::Running);
    assert_eq!(run.planning_snapshot.template_refs.len(), 1);
    assert_eq!(
        run.planning_snapshot.revision_content_hash,
        revision.content_hash.0
    );
    assert!(run.planning_snapshot.node_policies.contains_key("goal"));

    let events = svc.run_events_after(&run.run_id, 0).unwrap();
    assert!(!events.is_empty());
    assert_eq!(events[0].event_type, TaskEventType::RunStarted);
}

#[test]
fn run_revision_proposal_rejects_changes_to_frozen_nodes() {
    let svc = TaskService::open_in_memory().unwrap();
    let (graph, initial_revision) = svc
        .create_graph(&CreateGraphInput {
            title: "Hot update".into(),
            goal: "Test frozen nodes".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        })
        .unwrap();
    let active_revision = svc
        .apply_commands(
            &graph.graph_id,
            &initial_revision.revision_id,
            &[GraphCommand::AddNode {
                command_id: "add-n1".into(),
                node: shell_node("n1", "Original"),
            }],
            "user",
        )
        .unwrap()
        .revision;
    // 候选 revision 必须在 run 启动（节点冻结）之前构建：B4 起 apply_commands 对冻结节点
    // 有 A8 校验（见 apply_commands_rejected_when_node_is_frozen），候选触碰冻结节点会被它
    // 拦下。propose 流程的冻结不变量由 propose_run_revision 在提案时把关，故候选先于 run 建。
    let candidate = svc
        .apply_commands(
            &graph.graph_id,
            &active_revision.revision_id,
            &[GraphCommand::UpdateNode {
                command_id: "rename-n1".into(),
                node_id: "n1".into(),
                patch: NodePatch {
                    title: Some("Changed".into()),
                    ..Default::default()
                },
            }],
            "user",
        )
        .unwrap()
        .revision;
    let run = svc
        .start_run(&graph.graph_id, &active_revision.revision_id)
        .unwrap();
    let mut node_run = NodeRun::new("nr-n1", &run.run_id, "n1", &active_revision.revision_id);
    node_run.status = NodeRunStatus::Running;
    svc.store.save_node_run(&node_run).unwrap();

    let error = svc
        .propose_run_revision(&run.run_id, &candidate.revision_id)
        .unwrap_err()
        .to_string();
    assert!(error.contains("frozen node n1"));
}

#[test]
fn apply_run_revision_supersedes_removed_unstarted_nodes() {
    let svc = TaskService::open_in_memory().unwrap();
    let (graph, initial_revision) = svc
        .create_graph(&CreateGraphInput {
            title: "Hot update".into(),
            goal: "Apply a safe candidate".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        })
        .unwrap();
    let active_revision = svc
        .apply_commands(
            &graph.graph_id,
            &initial_revision.revision_id,
            &[
                GraphCommand::AddNode {
                    command_id: "add-n1".into(),
                    node: shell_node("n1", "Completed"),
                },
                GraphCommand::AddNode {
                    command_id: "add-n2".into(),
                    node: shell_node("n2", "Pending"),
                },
            ],
            "user",
        )
        .unwrap()
        .revision;
    let run = svc
        .start_run(&graph.graph_id, &active_revision.revision_id)
        .unwrap();
    let mut completed = NodeRun::new("nr-n1", &run.run_id, "n1", &active_revision.revision_id);
    completed.status = NodeRunStatus::Succeeded;
    completed.finished_at = Some(now_ms());
    let pending = NodeRun::new("nr-n2", &run.run_id, "n2", &active_revision.revision_id);
    {
        let store = &svc.store;
        store.save_node_run(&completed).unwrap();
        store.save_node_run(&pending).unwrap();
    }

    let candidate = svc
        .apply_commands(
            &graph.graph_id,
            &active_revision.revision_id,
            &[GraphCommand::RemoveNode {
                command_id: "remove-n2".into(),
                node_id: "n2".into(),
            }],
            "user",
        )
        .unwrap()
        .revision;
    let proposal = svc
        .propose_run_revision(&run.run_id, &candidate.revision_id)
        .unwrap();
    assert_eq!(proposal.superseded_node_ids, vec!["n2"]);

    let updated_run = svc
        .apply_run_revision(
            &run.run_id,
            &proposal.proposal_id,
            proposal.expected_run_seq,
        )
        .unwrap();
    assert_eq!(updated_run.active_revision_id, candidate.revision_id);
    assert_eq!(
        svc.get_node_runs(&run.run_id)
            .unwrap()
            .into_iter()
            .find(|node_run| node_run.node_id == "n2")
            .unwrap()
            .status,
        NodeRunStatus::Superseded
    );
    let events = svc.run_events_after(&run.run_id, 0).unwrap();
    // Last event should be RevisionCreated, second-to-last should be RevisionAppliedToRun
    assert_eq!(
        events.last().unwrap().event_type,
        TaskEventType::RevisionCreated
    );
    assert_eq!(
        events.get(events.len() - 2).unwrap().event_type,
        TaskEventType::RevisionAppliedToRun
    );
}

#[test]
fn apply_run_revision_emits_revision_created_event() {
    let svc = TaskService::open_in_memory().unwrap();
    let (graph, initial_revision) = svc
        .create_graph(&CreateGraphInput {
            title: "Hot update".into(),
            goal: "Apply a safe candidate".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        })
        .unwrap();
    let active_revision = svc
        .apply_commands(
            &graph.graph_id,
            &initial_revision.revision_id,
            &[
                GraphCommand::AddNode {
                    command_id: "add-n1".into(),
                    node: shell_node("n1", "Completed"),
                },
                GraphCommand::AddNode {
                    command_id: "add-n2".into(),
                    node: shell_node("n2", "Pending"),
                },
            ],
            "user",
        )
        .unwrap()
        .revision;
    let run = svc
        .start_run(&graph.graph_id, &active_revision.revision_id)
        .unwrap();
    let mut completed = NodeRun::new("nr-n1", &run.run_id, "n1", &active_revision.revision_id);
    completed.status = NodeRunStatus::Succeeded;
    completed.finished_at = Some(now_ms());
    let pending = NodeRun::new("nr-n2", &run.run_id, "n2", &active_revision.revision_id);
    {
        let store = &svc.store;
        store.save_node_run(&completed).unwrap();
        store.save_node_run(&pending).unwrap();
    }

    let candidate = svc
        .apply_commands(
            &graph.graph_id,
            &active_revision.revision_id,
            &[GraphCommand::RemoveNode {
                command_id: "remove-n2".into(),
                node_id: "n2".into(),
            }],
            "user",
        )
        .unwrap()
        .revision;
    let proposal = svc
        .propose_run_revision(&run.run_id, &candidate.revision_id)
        .unwrap();

    let updated_run = svc
        .apply_run_revision(
            &run.run_id,
            &proposal.proposal_id,
            proposal.expected_run_seq,
        )
        .unwrap();
    assert_eq!(updated_run.active_revision_id, candidate.revision_id);

    let events = svc.run_events_after(&run.run_id, 0).unwrap();
    let revision_created_events = events
        .iter()
        .filter(|event| event.event_type == TaskEventType::RevisionCreated)
        .collect::<Vec<_>>();
    assert_eq!(
        revision_created_events.len(),
        1,
        "Expected exactly one RevisionCreated event"
    );
    let event = &revision_created_events[0];
    let payload: crate::orchestrator::events::payloads::RevisionCreatedPayload =
        serde_json::from_value(event.payload.clone()).unwrap();
    assert_eq!(payload.revision_id, candidate.revision_id);
    assert_eq!(payload.run_id, run.run_id);
    assert_eq!(payload.graph_id, graph.graph_id);
    assert_eq!(payload.source, "run_revision_apply");
}

#[test]
fn pause_resume_run() {
    let svc = TaskService::open_in_memory().unwrap();
    let input = CreateGraphInput {
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: "/project".into(),
        owner: "user".into(),
        ..Default::default()
    };
    let (graph, revision) = svc.create_graph(&input).unwrap();
    let run = svc
        .start_run(&graph.graph_id, &revision.revision_id)
        .unwrap();

    svc.pause_run(&run.run_id).unwrap();
    let paused = svc.get_run(&run.run_id).unwrap();
    assert_eq!(paused.status, RunStatus::Paused);

    svc.resume_run(&run.run_id).unwrap();
    let resumed = svc.get_run(&run.run_id).unwrap();
    assert_eq!(resumed.status, RunStatus::Running);
}

#[test]
fn cancel_run_cancels_non_terminal_node_runs_and_emits_node_events() {
    let svc = TaskService::open_in_memory().unwrap();
    let input = CreateGraphInput {
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: "/project".into(),
        owner: "user".into(),
        ..Default::default()
    };
    let (graph, revision) = svc.create_graph(&input).unwrap();
    let run = svc
        .start_run(&graph.graph_id, &revision.revision_id)
        .unwrap();
    let mut node_run = NodeRun::new("node-run-1", &run.run_id, "node-1", &revision.revision_id);
    node_run.status = crate::orchestrator::domain::run::NodeRunStatus::Running;
    node_run.started_at = Some(now_ms());
    svc.store.save_node_run(&node_run).unwrap();

    svc.cancel_run(&run.run_id).unwrap();

    let cancelled = svc.get_run(&run.run_id).unwrap();
    assert_eq!(cancelled.status, RunStatus::Cancelled);
    let node_runs = svc.get_node_runs(&run.run_id).unwrap();
    assert_eq!(
        node_runs[0].status,
        crate::orchestrator::domain::run::NodeRunStatus::Cancelled
    );
    assert!(node_runs[0].finished_at.is_some());

    let events = svc.run_events_after(&run.run_id, 0).unwrap();
    assert_eq!(
        events[events.len() - 2].event_type,
        TaskEventType::NodeCancelled
    );
    assert_eq!(
        events.last().map(|event| &event.event_type),
        Some(&TaskEventType::RunCancelled)
    );
}

#[test]
fn run_projection_replay() {
    let svc = TaskService::open_in_memory().unwrap();
    let input = CreateGraphInput {
        title: "Test".into(),
        goal: "Do X".into(),
        project_root: "/project".into(),
        owner: "user".into(),
        ..Default::default()
    };
    let (graph, revision) = svc.create_graph(&input).unwrap();
    let run = svc
        .start_run(&graph.graph_id, &revision.revision_id)
        .unwrap();

    let proj = svc.run_projection(&run.run_id).unwrap();
    assert_eq!(proj.graph_id, graph.graph_id);
    assert_eq!(proj.status, RunStatus::Running);
}

#[test]
fn approval_resolution_is_persisted_with_node_transition_and_event() {
    let svc = TaskService::open_in_memory().unwrap();
    let (graph, revision) = svc
        .create_graph(&CreateGraphInput {
            title: "Approval".into(),
            goal: "Approve a write".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        })
        .unwrap();
    let mut policy = NodePolicy::default();
    policy.approval_policy = ApprovalPolicy::Always;
    policy.permission_scope.can_write_files = true;
    let result = svc
        .apply_commands(
            &graph.graph_id,
            &revision.revision_id,
            &[GraphCommand::AddNode {
                command_id: "add-write".into(),
                node: GraphNode {
                    node_id: "write".into(),
                    parent_id: Some("goal".into()),
                    title: "Write".into(),
                    description: None,
                    node_kind: NodeKind::Executable,
                    input_contract: Default::default(),
                    output_contract: Default::default(),
                    role_requirement: None,
                    capability_requirements: vec![],
                    agent_assignment_constraint: None,
                    policy,
                    metadata: Default::default(),
                    executable_payload: Some(ExecutablePayload::Write {
                        path: "out.txt".into(),
                        content: "ok".into(),
                        requires_approval: true,
                    }),
                    loop_config: None,
                    approval_gate_config: None,
                },
            }],
            "user",
        )
        .unwrap();
    let run = svc
        .start_run(&graph.graph_id, &result.revision.revision_id)
        .unwrap();
    let mut node_run = NodeRun::new(
        "nr-approval",
        &run.run_id,
        "write",
        &result.revision.revision_id,
    );
    node_run.status = NodeRunStatus::AwaitingApproval;
    let approval = ApprovalRequest {
        approval_id: "approval-1".into(),
        run_id: run.run_id.clone(),
        node_run_id: node_run.node_run_id.clone(),
        description: "Approve write".into(),
        risk_level: "high".into(),
        scope: vec!["attempt:0".into()],
        requester: "test".into(),
        resolver: None,
        resolved: false,
        approved: None,
        created_at: 2,
        resolved_at: None,
    };
    let events = vec![
        build_event(
            "approval-ready",
            &run.run_id,
            2,
            TaskEventType::NodeReady,
            "test",
            2,
            serde_json::to_value(payloads::NodeReadyPayload {
                node_run_id: node_run.node_run_id.clone(),
                node_id: node_run.node_id.clone(),
            })
            .unwrap(),
        ),
        build_event(
            "approval-requested",
            &run.run_id,
            3,
            TaskEventType::ApprovalRequested,
            "test",
            2,
            serde_json::to_value(payloads::ApprovalRequestedPayload {
                approval_id: approval.approval_id.clone(),
                node_run_id: node_run.node_run_id.clone(),
                description: approval.description.clone(),
                risk_level: approval.risk_level.clone(),
                scope: approval.scope.clone(),
            })
            .unwrap(),
        ),
    ];
    svc.store
        .save_approval_execution_update(&node_run, &approval, &events)
        .unwrap();

    let resolved = svc
        .resolve_approval("approval-1", true, "reviewer")
        .unwrap();

    assert_eq!(resolved.approved, Some(true));
    assert!(svc.pending_approvals(&run.run_id).unwrap().is_empty());
    assert_eq!(
        svc.get_node_runs(&run.run_id).unwrap()[0].status,
        NodeRunStatus::Blocked
    );
    assert!(svc
        .run_events_after(&run.run_id, 0)
        .unwrap()
        .iter()
        .any(|event| event.event_type == TaskEventType::ApprovalResolved));
    assert!(svc
        .resolve_approval("approval-1", true, "reviewer")
        .is_err());
}

#[test]
fn resolve_approval_resumes_awaiting_human_run() {
    // 审批通过（非 gate）→ node_run Blocked = 就绪重跑。若 run 当前 AwaitingHuman，
    // resolve_approval 必须显式 resume（对称 choose_recovery:1505 / submit_task_interaction:478），
    // 否则 scheduler 不会重新拾起该节点 → 死锁。闭合 awaiting_human 全链路的审批路径。
    let svc = TaskService::open_in_memory().unwrap();
    let (graph, revision) = svc
        .create_graph(&CreateGraphInput {
            title: "Approval resume".into(),
            goal: "Approve then resume".into(),
            project_root: "/project".into(),
            owner: "user".into(),
            ..Default::default()
        })
        .unwrap();
    let mut policy = NodePolicy::default();
    policy.approval_policy = ApprovalPolicy::Always;
    policy.permission_scope.can_write_files = true;
    let result = svc
        .apply_commands(
            &graph.graph_id,
            &revision.revision_id,
            &[GraphCommand::AddNode {
                command_id: "add-write".into(),
                node: GraphNode {
                    node_id: "write".into(),
                    parent_id: Some("goal".into()),
                    title: "Write".into(),
                    description: None,
                    node_kind: NodeKind::Executable,
                    input_contract: Default::default(),
                    output_contract: Default::default(),
                    role_requirement: None,
                    capability_requirements: vec![],
                    agent_assignment_constraint: None,
                    policy,
                    metadata: Default::default(),
                    executable_payload: Some(ExecutablePayload::Write {
                        path: "out.txt".into(),
                        content: "ok".into(),
                        requires_approval: true,
                    }),
                    loop_config: None,
                    approval_gate_config: None,
                },
            }],
            "user",
        )
        .unwrap();
    let run = svc
        .start_run(&graph.graph_id, &result.revision.revision_id)
        .unwrap();
    let mut node_run = NodeRun::new(
        "nr-resume",
        &run.run_id,
        "write",
        &result.revision.revision_id,
    );
    node_run.status = NodeRunStatus::AwaitingApproval;
    let approval = ApprovalRequest {
        approval_id: "approval-resume".into(),
        run_id: run.run_id.clone(),
        node_run_id: node_run.node_run_id.clone(),
        description: "Approve write".into(),
        risk_level: "high".into(),
        scope: vec!["attempt:0".into()],
        requester: "test".into(),
        resolver: None,
        resolved: false,
        approved: None,
        created_at: 2,
        resolved_at: None,
    };
    let events = vec![build_event(
        "approval-requested",
        &run.run_id,
        2,
        TaskEventType::ApprovalRequested,
        "test",
        2,
        serde_json::to_value(payloads::ApprovalRequestedPayload {
            approval_id: approval.approval_id.clone(),
            node_run_id: node_run.node_run_id.clone(),
            description: approval.description.clone(),
            risk_level: approval.risk_level.clone(),
            scope: approval.scope.clone(),
        })
        .unwrap(),
    )];
    let current_seq = svc
        .store
        .save_approval_execution_update(&node_run, &approval, &events)
        .unwrap();
    // 模拟审批期间 run 因别的原因（如另一节点 HumanGate）进入 AwaitingHuman。
    // 用 save 返回的 current_seq（而非 start_run 返回的旧 run.run_seq），保持
    // run_seq 与已存事件 seq 一致——否则 resolve_approval 按 run_seq+1 插事件会撞
    // task_event 的 (run_id, run_seq) UNIQUE 约束。
    svc.store
        .update_run_status(&run.run_id, &RunStatus::AwaitingHuman, current_seq, None)
        .unwrap();

    svc.resolve_approval("approval-resume", true, "reviewer")
        .unwrap();

    // node_run → Blocked（就绪重跑），且 run 已 resume 回 Running。
    assert_eq!(
        svc.get_node_runs(&run.run_id).unwrap()[0].status,
        NodeRunStatus::Blocked
    );
    assert_eq!(
        svc.store.get_run(&run.run_id).unwrap().status,
        RunStatus::Running
    );
}
