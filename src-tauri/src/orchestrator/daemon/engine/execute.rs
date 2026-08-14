use super::*;

pub(super) async fn execute_node(
    node: &GraphNode,
    project_root: &std::path::Path,
    runtime: &dyn TaskAgentRuntime,
    prepared_agent: Result<Option<PreparedAgentExecution>, String>,
    continuation: Option<TaskContinuation>,
    context: RuntimeEventContext,
    cancellation: Arc<AtomicBool>,
    on_session_resolved: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
) -> Result<NodeExecutionOutput, AttemptError> {
    let Some(payload) = &node.executable_payload else {
        return Err(attempt_error(
            ErrorCategory::Deterministic,
            "executable node has no payload",
            false,
        ));
    };

    match payload {
        ExecutablePayload::Shell { .. }
        | ExecutablePayload::Read { .. }
        | ExecutablePayload::Write { .. }
        | ExecutablePayload::Verify { .. } => {
            let mut effective_policy = node.policy.clone();
            effective_policy.approval_policy = ApprovalPolicy::Never;
            let effective_payload = match payload {
                ExecutablePayload::Write { path, content, .. } => ExecutablePayload::Write {
                    path: path.clone(),
                    content: content.clone(),
                    requires_approval: false,
                },
                _ => payload.clone(),
            };
            let output =
                execute_local_action(&effective_payload, project_root, &effective_policy).await?;
            if output.exit_code != Some(0) {
                return Err(attempt_error(
                    ErrorCategory::Deterministic,
                    &format!(
                        "command exited with {:?}: {}",
                        output.exit_code,
                        output.stderr.trim()
                    ),
                    false,
                ));
            }
            Ok(NodeExecutionOutput {
                progress: if output.stdout.is_empty() {
                    vec![]
                } else {
                    vec![ExecutionProgress {
                        actor: "local_os_adapter".into(),
                        message: output.stdout,
                        public: false,
                        usage_delta: AttemptUsage::default(),
                    }]
                },
                usage: AttemptUsage::default(),
                session_id: None,
                interaction: None,
                dispatch_prompt: None,
            })
        }
        ExecutablePayload::Dispatch {
            prompt,
            project,
            session,
            ..
        } => {
            let prepared = required_prepared_agent(prepared_agent)?;
            let resolved_prompt = continuation
                .as_ref()
                .map(|value| value.reply.clone())
                .unwrap_or_else(|| agent_prompt_with_policy(prompt, &node.policy));
            let request = RuntimeInvocationRequest {
                invocation_id: gen_id("invocation"),
                agent_id: prepared.assignment.agent_id.clone(),
                role_id: prepared.assignment.role_id.clone(),
                project_path: project
                    .as_deref()
                    .unwrap_or(project_root)
                    .to_string_lossy()
                    .into_owned(),
                session_id: continuation
                    .as_ref()
                    .and_then(|value| value.session_id.clone())
                    .or_else(|| session.clone()),
                prompt: resolved_prompt.clone(),
                timeout_ms: node.policy.timeout_ms.unwrap_or(600_000),
                cancellation: cancellation.clone(),
            };
            let mut output =
                execute_agent(runtime, prepared, request, context, on_session_resolved).await?;
            output.dispatch_prompt = Some(resolved_prompt);
            Ok(output)
        }
        ExecutablePayload::Reflect { question } => {
            let prepared = required_prepared_agent(prepared_agent)?;
            let resolved_prompt = continuation
                .as_ref()
                .map(|value| value.reply.clone())
                .unwrap_or_else(|| question.clone());
            let request = RuntimeInvocationRequest {
                invocation_id: gen_id("invocation"),
                agent_id: prepared.assignment.agent_id.clone(),
                role_id: prepared.assignment.role_id.clone(),
                project_path: project_root.to_string_lossy().into_owned(),
                session_id: continuation
                    .as_ref()
                    .and_then(|value| value.session_id.clone()),
                prompt: resolved_prompt.clone(),
                timeout_ms: node.policy.timeout_ms.unwrap_or(600_000),
                cancellation,
            };
            let mut output =
                execute_agent(runtime, prepared, request, context, on_session_resolved).await?;
            output.dispatch_prompt = Some(resolved_prompt);
            Ok(output)
        }
    }
}

pub(super) struct ApprovalRequirement {
    pub(super) description: String,
    pub(super) risk_level: String,
    pub(super) scope_marker: String,
}

pub(super) fn approval_requirement(
    node: &GraphNode,
    attempt_number: u32,
) -> Option<ApprovalRequirement> {
    if let Some(config) = &node.approval_gate_config {
        return Some(ApprovalRequirement {
            description: config.description.clone(),
            risk_level: format!("{:?}", config.risk_level).to_ascii_lowercase(),
            scope_marker: format!("approval_gate:{attempt_number}"),
        });
    }

    let payload_requires_approval = matches!(
        node.executable_payload,
        Some(ExecutablePayload::Write {
            requires_approval: true,
            ..
        })
    );
    let high_risk = payload_requires_approval
        || matches!(
            node.executable_payload,
            Some(ExecutablePayload::Shell { .. } | ExecutablePayload::Write { .. })
        )
        || node.policy.permission_scope.can_write_files
        || node.policy.permission_scope.can_run_commands
        || node.policy.permission_scope.can_access_network
        || node.policy.permission_scope.can_deploy;

    let required = match node.policy.approval_policy {
        ApprovalPolicy::Never => payload_requires_approval,
        ApprovalPolicy::Once | ApprovalPolicy::Always => true,
        ApprovalPolicy::OnHighRisk => high_risk,
    };
    required.then(|| ApprovalRequirement {
        description: format!("Approve execution of node '{}'", node.title),
        risk_level: if high_risk { "high" } else { "medium" }.into(),
        scope_marker: if matches!(node.policy.approval_policy, ApprovalPolicy::Always) {
            format!("attempt:{attempt_number}")
        } else {
            "node".into()
        },
    })
}

pub(super) fn agent_prompt_with_policy(
    prompt: &str,
    policy: &crate::orchestrator::domain::policy::NodePolicy,
) -> String {
    let permissions = &policy.permission_scope;
    // v0.7.0 需求二-问题4：用 [JISHU-PROMT:开始]...[JISHU-PROMT:结束] 配对块标记包裹
    // 系统内部契约提示词，前端渲染时统一剥离，不向用户展示。
    format!(
        "[JISHU-PROMT:开始]\n\
Task Orchestrator execution contract:\n\
- read_files: {}\n\
- write_files: {}\n\
- run_commands: {}\n\
- access_network: {}\n\
- deploy: {}\n\
Do not perform or ask a sub-agent to perform any action marked false. \
Stay within the project root and the declared task scope. \
Return concrete output and acceptance evidence.\n\
[JISHU-PROMT:结束]\n\n{}",
        permissions.can_read_files,
        permissions.can_write_files,
        permissions.can_run_commands,
        permissions.can_access_network,
        permissions.can_deploy,
        prompt
    )
}

#[derive(Debug, Clone)]
pub(super) struct PreparedAgentExecution {
    pub(super) assignment: crate::orchestrator::domain::run::AgentAssignment,
    pub(super) transport: String,
}

#[derive(Debug)]
pub(super) struct ExecutionProgress {
    pub(super) actor: String,
    pub(super) message: String,
    pub(super) public: bool,
    pub(super) usage_delta: AttemptUsage,
}

#[derive(Debug)]
pub(super) struct NodeExecutionOutput {
    pub(super) progress: Vec<ExecutionProgress>,
    pub(super) usage: AttemptUsage,
    pub(super) session_id: Option<String>,
    pub(super) interaction: Option<PendingRuntimeInteraction>,
    /// 实际派发给子代理的 prompt（用于落库 node_attempt.dispatch_prompt）。
    /// 仅 Dispatch / Reflect 分支会填充；本地 action 分支为 None。
    pub(super) dispatch_prompt: Option<String>,
}

#[derive(Debug)]
pub(super) struct PendingRuntimeInteraction {
    pub(super) request_id: String,
    pub(super) prompt: String,
    pub(super) options: Vec<crate::agent::normalized::InteractionOption>,
    pub(super) allow_multiple: bool,
    pub(super) allow_custom_text: bool,
    pub(super) required: bool,
}

#[derive(Debug, Clone)]
pub(super) struct TaskContinuation {
    pub(super) session_id: Option<String>,
    pub(super) reply: String,
}

pub(super) fn task_continuation_from_request(
    request: &TaskInteractionRequest,
) -> Option<TaskContinuation> {
    let submission = request.submission.as_ref()?;
    let selected_labels = submission
        .selected_option_ids
        .iter()
        .map(|option_id| {
            request
                .options
                .iter()
                .find(|option| option.option_id == *option_id)
                .map(|option| option.label.as_str())
                .unwrap_or(option_id.as_str())
        })
        .collect::<Vec<_>>();
    let mut parts = Vec::new();
    if !selected_labels.is_empty() {
        parts.push(format!("我的选择：{}", selected_labels.join("、")));
    }
    if let Some(custom_text) = submission
        .custom_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("补充说明：{custom_text}"));
    }
    if parts.is_empty() {
        parts.push("继续执行。".into());
    }
    Some(TaskContinuation {
        session_id: request.session_id.clone(),
        reply: parts.join("\n"),
    })
}

pub(super) fn prepare_agent_execution(
    runtime: &dyn TaskAgentRuntime,
    node: &GraphNode,
    _project_root: &std::path::Path,
) -> Result<Option<PreparedAgentExecution>, String> {
    let resolution = match node.executable_payload.as_ref() {
        Some(ExecutablePayload::Dispatch { role_id, .. }) => Some((node.clone(), role_id.clone())),
        Some(ExecutablePayload::Reflect { .. }) => {
            let mut supervisor_node = node.clone();
            if !supervisor_node
                .capability_requirements
                .iter()
                .any(|capability| capability == "task_supervision")
            {
                supervisor_node
                    .capability_requirements
                    .push("task_supervision".into());
            }
            Some((
                supervisor_node,
                node.role_requirement
                    .as_ref()
                    .map(|role| role.role_id.clone())
                    .unwrap_or_else(|| "supervisor".into()),
            ))
        }
        _ => None,
    };
    resolution
        .map(|(resolution_node, role_id)| {
            // D3（设计 §6.2 / §13）：节点未显式锁定 agent 时，默认执行者是 jishu agent，
            // 而非 registry 的 active_id（那是"聊天页当前选中的智能体"这一 GUI 全局态，
            // 默认值还是 claude-code）。显式传入以免 GUI 状态泄漏进编排语义。
            //
            // 这里用常量而非读 TaskInstance.planner_agent_id：orchestrator 不依赖
            // task_launch 层的概念（保持分层单向）。二者语义一致——planner_agent_id 的
            // 默认值就是 jishu agent，且 resolve_agent_assignment 会对历史别名
            // jishu_agent 做归一化。
            runtime
                .resolve_agent(
                    &resolution_node,
                    &role_id,
                    Some(crate::agent::JISHU_SELF_AGENT_ID),
                )
                .map(|(assignment, transport)| PreparedAgentExecution {
                    assignment,
                    transport,
                })
        })
        .transpose()
}

pub(super) fn required_prepared_agent(
    prepared: Result<Option<PreparedAgentExecution>, String>,
) -> Result<PreparedAgentExecution, AttemptError> {
    prepared
        .map_err(|message| attempt_error(ErrorCategory::Policy, &message, false))?
        .ok_or_else(|| {
            attempt_error(
                ErrorCategory::Deterministic,
                "agent executable was not prepared",
                false,
            )
        })
}

pub(super) async fn execute_agent(
    runtime: &dyn TaskAgentRuntime,
    prepared: PreparedAgentExecution,
    request: RuntimeInvocationRequest,
    context: RuntimeEventContext,
    on_session_resolved: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
) -> Result<NodeExecutionOutput, AttemptError> {
    let mut handle = runtime
        .invoke(request)
        .await
        .map_err(|message| attempt_error(ErrorCategory::Transient, &message, true))?;
    let mut progress = Vec::new();
    let mut usage = AttemptUsage::default();
    let mut session_id = None;
    let mut failure = None;
    let mut completed = false;
    let mut interaction = None;
    let mut exit_success = true;
    let mut exit_code = None;

    while let Some(item) = handle.events.recv().await {
        match item {
            RuntimeStreamItem::Event(event) => match map_normalized_event(&context, &event) {
                RuntimeFact::Progress {
                    message,
                    usage_delta,
                    ..
                } => progress.push(ExecutionProgress {
                    actor: prepared.assignment.agent_id.clone(),
                    message,
                    public: true,
                    usage_delta,
                }),
                RuntimeFact::Diagnostic { payload, .. } => progress.push(ExecutionProgress {
                    actor: prepared.assignment.agent_id.clone(),
                    message: payload.to_string(),
                    public: false,
                    usage_delta: AttemptUsage::default(),
                }),
                RuntimeFact::SessionResolved {
                    session_id: resolved,
                    ..
                } => {
                    session_id = Some(resolved.clone());
                    // 立即落库，使运行中即可进入节点会话实时查看（Issue 2）。
                    if let Some(cb) = &on_session_resolved {
                        cb(resolved);
                    }
                }
                RuntimeFact::Completed {
                    usage: completed_usage,
                    ..
                } => {
                    usage = completed_usage;
                    completed = true;
                }
                RuntimeFact::Failed { error, .. } => failure = Some(error),
                RuntimeFact::ApprovalRequested {
                    request_id,
                    approval_kind,
                    ..
                } => {
                    failure = Some(attempt_error(
                        ErrorCategory::Policy,
                        &format!(
                            "runtime approval {request_id} ({approval_kind}) requires an approval gate"
                        ),
                        false,
                    ));
                }
                RuntimeFact::InteractionRequested {
                    request_id,
                    prompt,
                    options,
                    allow_multiple,
                    allow_custom_text,
                    required,
                    ..
                } => {
                    interaction = Some(PendingRuntimeInteraction {
                        request_id,
                        prompt,
                        options,
                        allow_multiple,
                        allow_custom_text,
                        required,
                    });
                }
            },
            RuntimeStreamItem::RuntimeError(message) => {
                failure = Some(attempt_error(ErrorCategory::Transient, &message, true));
            }
            RuntimeStreamItem::Finished {
                exit_success: ok,
                exit_code: code,
            } => {
                exit_success = ok;
                exit_code = code;
                break;
            }
        }
    }

    if let Some(error) = failure {
        return Err(error);
    }
    if !exit_success {
        return Err(attempt_error(
            ErrorCategory::Transient,
            &format!("agent process exited with {:?}", exit_code),
            true,
        ));
    }
    if !completed && interaction.is_none() {
        progress.push(ExecutionProgress {
            actor: prepared.assignment.agent_id,
            message: "agent process completed without an explicit turn-complete event".into(),
            public: false,
            usage_delta: AttemptUsage::default(),
        });
    }
    Ok(NodeExecutionOutput {
        progress,
        usage,
        session_id,
        interaction,
        dispatch_prompt: None,
    })
}
