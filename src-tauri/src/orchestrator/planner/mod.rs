use std::collections::{HashMap, HashSet};
use std::sync::{atomic::AtomicBool, Arc};

use serde::{Deserialize, Serialize};

use crate::agent::normalized::ContentBlock;
use crate::agent::{AgentRegistry, NormalizedEvent};
use crate::orchestrator::commands::{apply_commands, graph_validate, GraphCommand};
use crate::orchestrator::conversation::{TaskInteractionRequest, TaskInteractionSubmission};
use crate::orchestrator::domain::graph::{
    Contract, EdgeKind, ExecutablePayload, GraphEdge, GraphNode, NodeKind, RoleRequirement,
};
use crate::orchestrator::domain::policy::{ApprovalPolicy, NodePolicy, PermissionScope};
use crate::orchestrator::domain::revision::{
    diff_snapshots, PlannerPolicyRef, RevisionDiff, SkillRef, TemplateRef,
};
use crate::orchestrator::domain::run::AgentAssignment;
use crate::orchestrator::runtime_bridge::{
    capability_snapshot, RuntimeInvocationRequest, RuntimeStreamItem, TaskAgentRuntime,
};
use crate::orchestrator::store::TaskStore;
use crate::util::{gen_id, now_ms};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningRequest {
    pub graph_id: String,
    pub base_revision_id: String,
    pub instruction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanningProgress {
    pub graph_id: String,
    pub stage: String,
    pub attempt: Option<u8>,
    pub max_attempts: Option<u8>,
    /// Real-time agent text delta (from text_delta / thinking_delta events).
    /// When present, the frontend appends it to the planning conversation view.
    /// `None` for stage-only updates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphProposal {
    pub proposal_id: String,
    pub graph_id: String,
    pub base_revision_id: String,
    pub commands: Vec<GraphCommand>,
    pub rationale: String,
    pub expected_benefits: Vec<String>,
    pub risks: Vec<String>,
    pub warnings: Vec<String>,
    pub diff: RevisionDiff,
    pub planner_assignment: AgentAssignment,
    pub skill_refs: Vec<SkillRef>,
    pub template_refs: Vec<TemplateRef>,
    pub planner_policy_refs: Vec<PlannerPolicyRef>,
}

#[derive(Clone)]
pub struct PlannerService {
    store: Arc<TaskStore>,
    runtime: Arc<dyn TaskAgentRuntime>,
    registry: Arc<AgentRegistry>,
    /// The invocation_id of the current planning session (for steering).
    current_invocation: Arc<std::sync::Mutex<Option<String>>>,
}

impl PlannerService {
    pub fn new(
        store: Arc<TaskStore>,
        runtime: Arc<dyn TaskAgentRuntime>,
        registry: Arc<AgentRegistry>,
    ) -> Self {
        Self {
            store,
            runtime,
            registry,
            current_invocation: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Steer the in-flight planning session (mid-turn text injection).
    pub fn steer(&self, message: String) -> Result<(), String> {
        let invocation_id = {
            let guard = self.current_invocation.lock().map_err(|e| e.to_string())?;
            guard
                .clone()
                .ok_or_else(|| "No planning session is currently active".to_string())?
        };
        self.runtime.steer(&invocation_id, message)
    }

    pub async fn generate(&self, request: PlanningRequest) -> Result<GraphProposal, String> {
        self.generate_with_progress(request, |_| {}).await
    }

    pub async fn generate_with_progress<F>(
        &self,
        request: PlanningRequest,
        progress: F,
    ) -> Result<GraphProposal, String>
    where
        F: Fn(PlanningProgress),
    {
        let report = |stage: &str, attempt: Option<u8>| {
            progress(PlanningProgress {
                graph_id: request.graph_id.clone(),
                stage: stage.into(),
                attempt,
                max_attempts: Some(2),
                text: None,
            });
        };
        report("preparing_context", None);
        if request.instruction.trim().is_empty() {
            return Err("planning instruction cannot be empty".into());
        }
        let graph = self
            .store
            .get_graph(&request.graph_id)
            .map_err(|error| error.to_string())?;
        let revision = self
            .store
            .get_revision(&request.base_revision_id)
            .map_err(|error| error.to_string())?;
        if revision.graph_id != request.graph_id {
            return Err(format!(
                "revision {} does not belong to graph {}",
                request.base_revision_id, request.graph_id
            ));
        }
        let snapshot = revision.snapshot().map_err(|error| error.to_string())?;

        let skill_manifests = load_skill_manifests(&revision.skill_refs)?;
        let available_agents = self
            .registry
            .agents_info()
            .into_iter()
            .map(|(id, adapter)| {
                serde_json::json!({
                    "agent_id": id,
                    "transport": adapter.transport_surface().as_str(),
                    "capabilities": capability_snapshot(adapter.capabilities()),
                })
            })
            .collect::<Vec<_>>();
        report("resolving_agent", None);
        let planning_node = planning_node();
        let (planner_assignment, _transport) = self
            .runtime
            .resolve_agent(&planning_node, "planner")
            .map_err(|error| format!("planner resolution failed: {error}"))?;
        let required_roles = required_role_ids(&skill_manifests);
        let prompt = build_prompt(
            &request,
            &graph.project_root.to_string_lossy(),
            &snapshot,
            &skill_manifests,
            &available_agents,
        )?;
        let project_path = graph.project_root.to_string_lossy().to_string();
        let mut next_prompt = prompt.clone();
        let mut accepted = None;
        let mut last_error = None;
        let mut planner_session_id = None;

        for attempt in 0..2 {
            report("generating", Some(attempt + 1));
            let mut invocation_prompt = next_prompt.clone();
            let response = loop {
                let this_invocation_id = gen_id("planner-invocation");
                // Store for steering — the frontend can call steer() while
                // the Pi RPC session is live.
                if let Ok(mut guard) = self.current_invocation.lock() {
                    *guard = Some(this_invocation_id.clone());
                }
                let mut handle = self
                    .runtime
                    .invoke(RuntimeInvocationRequest {
                        invocation_id: this_invocation_id,
                        agent_id: planner_assignment.agent_id.clone(),
                        role_id: "planner".into(),
                        project_path: project_path.clone(),
                        session_id: planner_session_id.clone(),
                        prompt: invocation_prompt.clone(),
                        timeout_ms: 180_000,
                        cancellation: Arc::new(AtomicBool::new(false)),
                    })
                    .await
                    .map_err(|error| format!("planner invocation failed: {error}"))?;
                let mut events = Vec::new();
                let mut exit_success = true;
                let mut exit_code = None;
                let mut runtime_error = None;
                while let Some(item) = handle.events.recv().await {
                    match item {
                        RuntimeStreamItem::Event(event) => {
                            // Forward text/thinking deltas to the frontend in
                            // real-time so the user sees the agent's output
                            // during planning (not just stage labels).
                            match &event {
                                NormalizedEvent::TextDelta { delta } => {
                                    progress(PlanningProgress {
                                        graph_id: request.graph_id.clone(),
                                        stage: "generating".into(),
                                        attempt: Some(attempt + 1),
                                        max_attempts: Some(2),
                                        text: Some(delta.clone()),
                                    });
                                }
                                NormalizedEvent::Thinking { delta } => {
                                    progress(PlanningProgress {
                                        graph_id: request.graph_id.clone(),
                                        stage: "generating".into(),
                                        attempt: Some(attempt + 1),
                                        max_attempts: Some(2),
                                        text: Some(delta.clone()),
                                    });
                                }
                                _ => {}
                            }
                            events.push(event);
                        }
                        RuntimeStreamItem::RuntimeError(message) => runtime_error = Some(message),
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
                if let Some(error) = runtime_error {
                    return Err(format!("planner invocation failed: {error}"));
                }
                if !exit_success {
                    return Err(format!(
                        "planner process exited unsuccessfully ({:?})",
                        exit_code
                    ));
                }
                if let Some(session_id) = resolved_session_id(&events) {
                    planner_session_id = Some(session_id);
                }
                if let Some(mut interaction) =
                    planning_interaction_request(&request.graph_id, &events)
                {
                    interaction.session_id = planner_session_id.clone();
                    self.store
                        .save_task_interaction(&interaction)
                        .map_err(|error| error.to_string())?;
                    report("awaiting_input", Some(attempt + 1));
                    let resolved =
                        wait_for_planning_interaction(&self.store, &interaction.request_id).await?;
                    invocation_prompt = planning_interaction_reply(&resolved)?;
                    report("generating", Some(attempt + 1));
                    continue;
                }
                break collect_text(&events);
            };
            report("validating", Some(attempt + 1));
            let parsed = parse_draft(&response).and_then(|draft| {
                validate_plan_shape(&snapshot, &draft, &required_roles)?;
                let commands = draft_to_commands(&snapshot, &draft)?;
                Ok((draft, commands))
            });
            match parsed {
                Ok(value) => {
                    accepted = Some(value);
                    break;
                }
                Err(error) if attempt == 0 => {
                    report("retrying", Some(2));
                    next_prompt = correction_prompt(&prompt, &error);
                    last_error = Some(error);
                }
                Err(error) => last_error = Some(error),
            }
        }

        let (draft, commands) = accepted.ok_or_else(|| {
            format!(
                "planner proposal remained invalid after one correction attempt: {}",
                last_error.unwrap_or_else(|| "unknown validation error".into())
            )
        })?;
        report("building_proposal", None);
        let candidate = apply_commands(&snapshot, &commands).map_err(|error| error.to_string())?;
        let warnings = graph_validate(&candidate).map_err(|error| error.to_string())?;
        let proposal_id = gen_id("proposal");
        let diff = diff_snapshots(
            &snapshot,
            &candidate,
            &request.base_revision_id,
            &proposal_id,
        );

        let proposal = GraphProposal {
            proposal_id,
            graph_id: request.graph_id.clone(),
            base_revision_id: request.base_revision_id,
            commands,
            rationale: draft.rationale,
            expected_benefits: draft.expected_benefits,
            risks: draft.risks,
            warnings,
            diff,
            planner_assignment,
            skill_refs: revision.skill_refs,
            template_refs: revision.template_refs,
            planner_policy_refs: revision.planner_policy_refs,
        };
        report("completed", None);
        // Clear the invocation — steering is no longer available.
        if let Ok(mut guard) = self.current_invocation.lock() {
            *guard = None;
        }
        Ok(proposal)
    }
}

fn resolved_session_id(events: &[NormalizedEvent]) -> Option<String> {
    events.iter().rev().find_map(|event| match event {
        NormalizedEvent::SessionResolved { session_id } => Some(session_id.clone()),
        _ => None,
    })
}

fn planning_interaction_request(
    graph_id: &str,
    events: &[NormalizedEvent],
) -> Option<TaskInteractionRequest> {
    events.iter().find_map(|event| match event {
        NormalizedEvent::InteractionRequest {
            request_id,
            prompt,
            options,
            allow_multiple,
            allow_custom_text,
            required,
        } => Some(TaskInteractionRequest {
            request_id: request_id.clone(),
            graph_id: graph_id.to_string(),
            run_id: None,
            node_id: None,
            node_run_id: None,
            session_id: None,
            prompt: prompt.clone(),
            options: options.clone(),
            allow_multiple: *allow_multiple,
            allow_custom_text: *allow_custom_text,
            required: *required,
            created_at: now_ms(),
            resolved_at: None,
            consumed_at: None,
            submission: None,
        }),
        _ => None,
    })
}

async fn wait_for_planning_interaction(
    store: &TaskStore,
    request_id: &str,
) -> Result<TaskInteractionRequest, String> {
    loop {
        if let Some(request) = store
            .take_resolved_task_interaction_by_id(request_id, now_ms())
            .map_err(|error| error.to_string())?
        {
            return Ok(request);
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

fn planning_interaction_reply(request: &TaskInteractionRequest) -> Result<String, String> {
    let TaskInteractionSubmission {
        selected_option_ids,
        custom_text,
    } = request
        .submission
        .as_ref()
        .ok_or_else(|| "planning interaction has no submission".to_string())?;
    let selected_labels = selected_option_ids
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
    if let Some(custom_text) = custom_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("补充说明：{custom_text}"));
    }
    if parts.is_empty() {
        parts.push("继续规划。".into());
    }
    Ok(parts.join("\n"))
}

#[derive(Debug, Deserialize)]
struct PlannerDraft {
    commands: Vec<PlannerDraftCommand>,
    rationale: String,
    #[serde(default)]
    expected_benefits: Vec<String>,
    #[serde(default)]
    risks: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum PlannerDraftCommand {
    AddAgentNode {
        node_id: String,
        title: String,
        #[serde(default)]
        description: Option<String>,
        role_id: String,
        prompt: String,
        #[serde(default)]
        depends_on: Vec<String>,
        #[serde(default)]
        required_capabilities: Vec<String>,
        #[serde(default)]
        acceptance: Vec<String>,
        #[serde(default)]
        permissions: PermissionScope,
    },
    AddSupervisorNode {
        node_id: String,
        title: String,
        question: String,
        #[serde(default)]
        depends_on: Vec<String>,
        #[serde(default)]
        acceptance: Vec<String>,
    },
}

fn planning_node() -> GraphNode {
    GraphNode {
        node_id: "planner_request".into(),
        parent_id: None,
        title: "Task planning".into(),
        description: None,
        node_kind: NodeKind::Executable,
        input_contract: Contract::default(),
        output_contract: Contract::default(),
        role_requirement: Some(RoleRequirement {
            role_id: "planner".into(),
            responsibility: "Produce a validated task graph proposal".into(),
            required_capabilities: vec!["task_planning".into()],
            preferred_capabilities: vec![],
        }),
        capability_requirements: vec!["task_planning".into()],
        agent_assignment_constraint: None,
        policy: NodePolicy::default(),
        metadata: HashMap::new(),
        executable_payload: Some(ExecutablePayload::Reflect {
            question: "Plan the task graph".into(),
        }),
        loop_config: None,
        approval_gate_config: None,
    }
}

fn load_skill_manifests(skill_refs: &[SkillRef]) -> Result<Vec<serde_json::Value>, String> {
    let dir = crate::task_plan::task_plan_dir()?;
    skill_refs
        .iter()
        .map(|skill_ref| {
            let skill = crate::task_plan::read_installed_skill(&dir, &skill_ref.skill_id)?
                .ok_or_else(|| {
                    format!(
                        "planning skill '{}' is referenced but not installed",
                        skill_ref.skill_id
                    )
                })?;
            if !skill.valid {
                return Err(skill.error.unwrap_or_else(|| {
                    format!("planning skill '{}' is invalid", skill_ref.skill_id)
                }));
            }
            if skill.content_hash != skill_ref.version_or_hash {
                return Err(format!(
                    "planning skill '{}' changed: revision={}, installed={}",
                    skill_ref.skill_id, skill_ref.version_or_hash, skill.content_hash
                ));
            }
            Ok(serde_json::json!({
                "id": skill.id,
                "content_hash": skill.content_hash,
                "description": skill.description,
                "workflow_hints": skill.workflow_hints,
                "roles": skill.roles,
                "inputs": skill_ref.inputs,
            }))
        })
        .collect()
}

fn required_role_ids(skills: &[serde_json::Value]) -> Vec<String> {
    let mut role_ids = skills
        .iter()
        .flat_map(|skill| {
            skill
                .get("roles")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|role| role.get("role_id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    role_ids.sort();
    role_ids.dedup();
    role_ids
}

fn build_prompt(
    request: &PlanningRequest,
    project_root: &str,
    snapshot: &crate::orchestrator::domain::graph::GraphSnapshot,
    skills: &[serde_json::Value],
    available_agents: &[serde_json::Value],
) -> Result<String, String> {
    let required_roles = required_role_ids(skills);
    let minimum_agent_nodes = required_roles.len().max(4);
    let (existing_agent_nodes, existing_roles, existing_supervisor_nodes) =
        existing_plan_shape(snapshot);
    let missing_role_ids = required_roles
        .iter()
        .filter(|role| !existing_roles.contains(*role))
        .cloned()
        .collect::<Vec<_>>();
    let mut existing_role_ids = existing_roles.into_iter().collect::<Vec<_>>();
    existing_role_ids.sort();
    let context = serde_json::json!({
        "instruction": request.instruction,
        "project_root": project_root,
        "base_revision_id": request.base_revision_id,
        "current_graph": snapshot,
        "skills": skills,
        "available_agents": available_agents,
        "plan_quality": {
            "minimum_total_agent_nodes": minimum_agent_nodes,
            "minimum_new_agent_nodes": minimum_agent_nodes.saturating_sub(existing_agent_nodes),
            "existing_agent_nodes": existing_agent_nodes,
            "existing_role_ids": existing_role_ids,
            "required_role_ids": required_roles,
            "missing_role_ids": missing_role_ids,
            "existing_supervisor_nodes": existing_supervisor_nodes,
            "require_supervisor_node": existing_supervisor_nodes == 0,
            "require_specific_acceptance_per_node": true,
        },
    });
    let context = serde_json::to_string_pretty(&context).map_err(|error| error.to_string())?;
    Ok(format!(
        r#"You are the task planner. Produce a proposed executable DAG, not prose and not a linear plan document.

Return exactly one JSON object and no markdown fences:
{{
  "commands": [
    {{
      "op": "add_agent_node",
      "node_id": "stable_snake_case_id",
      "title": "short user-facing title",
      "description": "purpose and expected outcome",
      "role_id": "role_from_selected_skill",
      "prompt": "complete non-interactive execution contract",
      "depends_on": ["other_node_id"],
      "required_capabilities": [],
      "acceptance": ["observable acceptance criterion"],
      "permissions": {{
        "can_read_files": true,
        "can_write_files": false,
        "can_run_commands": false,
        "can_access_network": false,
        "can_deploy": false
      }}
    }}
    OR
    {{
      "op": "add_supervisor_node",
      "node_id": "verify_outcome",
      "title": "Evaluate outcome",
      "question": "Return a structured semantic evaluation of progress and acceptance.",
      "depends_on": ["implementation"],
      "acceptance": ["Evaluation identifies pass, rework, stop, or human decision"]
    }}
  ],
  "rationale": "why this graph shape is appropriate",
  "expected_benefits": ["benefit"],
  "risks": ["risk"]
}}

Rules:
- Use only add_agent_node and add_supervisor_node commands.
- Keep node_id unique, stable, ASCII, and limited to letters, digits, underscore, and hyphen.
- depends_on may reference existing graph nodes or nodes in this proposal.
- Maximize safe parallelism; add a dependency only for a real control or data dependency.
- Apply every selected skill's methodology in node roles, prompts, and acceptance criteria.
- Make the resulting graph cover every required_role_id and satisfy minimum_total_agent_nodes. Use existing graph nodes where they already satisfy the requirement.
- Make the resulting graph contain at least one supervisor node after the terminal work branches.
- Decompose distinct concerns, subsystems, interfaces, implementation workstreams, tests, and acceptance. Never collapse a non-trivial goal into one generic "implement the system" node.
- Every agent node needs a goal-specific description, a complete execution prompt, and at least one observable acceptance criterion.
- Request the least permissions needed. Write, command, network, and deploy permissions are high risk.
- Include explicit verification or review work where the task needs it.
- Do not call tools, edit files, or start execution. Planning only.

Planning context:
{context}"#
    ))
}

fn correction_prompt(original_prompt: &str, validation_error: &str) -> String {
    format!(
        "{original_prompt}\n\nThe previous proposal was rejected by the deterministic task-graph quality gate:\n{validation_error}\n\nReturn a completely regenerated JSON object that fixes every listed issue. Do not explain the correction."
    )
}

fn collect_text(events: &[NormalizedEvent]) -> String {
    let mut text = String::new();
    for event in events {
        match event {
            NormalizedEvent::TextDelta { delta } | NormalizedEvent::Thinking { delta } => {
                text.push_str(delta)
            }
            NormalizedEvent::Message { content } => {
                for block in content {
                    if let ContentBlock::Text { text: value } = block {
                        text.push_str(value);
                    }
                }
            }
            _ => {}
        }
    }
    text
}

fn parse_draft(response: &str) -> Result<PlannerDraft, String> {
    let trimmed = strip_code_fence(response).trim();
    if trimmed.is_empty() {
        return Err("planner response did not contain a JSON object".to_string());
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(value) => {
            if !value.is_object() {
                return Err(format!(
                    "invalid planner proposal JSON: top-level value is {:?}, expected an object",
                    classify_top_level(&value)
                ));
            }
            let draft: PlannerDraft = serde_json::from_value(value)
                .map_err(|error| format!("invalid planner proposal JSON: {error}"))?;
            return ensure_non_empty_commands(draft);
        }
        Err(_) => {}
    }
    if let Some(slice) = first_top_level_object(trimmed) {
        let draft: PlannerDraft = serde_json::from_str(slice)
            .map_err(|error| format!("invalid planner proposal JSON: {error}"))?;
        return ensure_non_empty_commands(draft);
    }
    Err("planner response did not contain a JSON object".to_string())
}

fn ensure_non_empty_commands(draft: PlannerDraft) -> Result<PlannerDraft, String> {
    if draft.commands.is_empty() {
        return Err("planner proposal must contain at least one command".into());
    }
    Ok(draft)
}

fn classify_top_level(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

fn strip_code_fence(response: &str) -> &str {
    let trimmed = response.trim_start();
    let stripped = if let Some(rest) = trimmed.strip_prefix("```json") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("```JSON") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("```") {
        rest
    } else {
        trimmed
    };
    let stripped = stripped.trim_start_matches('\r').trim_start_matches('\n');
    let stripped = stripped.trim_start();
    stripped.trim_end_matches("```").trim_end()
}

fn first_top_level_object(input: &str) -> Option<&str> {
    let bytes = input.as_bytes();
    let mut in_string = false;
    let mut escape = false;
    let mut depth: i32 = 0;
    let mut start: Option<usize> = None;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if in_string {
            if escape {
                escape = false;
            } else if byte == b'\\' {
                escape = true;
            } else if byte == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = true;
                i += 1;
            }
            b'{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
                i += 1;
            }
            b'}' => {
                if depth == 0 {
                    i += 1;
                    continue;
                }
                depth -= 1;
                if depth == 0 {
                    let begin = start?;
                    return Some(&input[begin..=i]);
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    None
}

fn existing_plan_shape(
    snapshot: &crate::orchestrator::domain::graph::GraphSnapshot,
) -> (usize, HashSet<String>, usize) {
    let mut agent_count = 0usize;
    let mut agent_roles = HashSet::new();
    let mut supervisor_count = 0usize;

    for node in &snapshot.nodes {
        if node.node_kind != NodeKind::Executable {
            continue;
        }
        let is_supervisor = node
            .role_requirement
            .as_ref()
            .is_some_and(|role| role.role_id == "supervisor")
            || matches!(
                node.executable_payload.as_ref(),
                Some(ExecutablePayload::Reflect { .. })
            );
        if is_supervisor {
            supervisor_count += 1;
            continue;
        }
        agent_count += 1;
        if let Some(role) = &node.role_requirement {
            agent_roles.insert(role.role_id.clone());
        } else if let Some(ExecutablePayload::Dispatch { role_id, .. }) = &node.executable_payload {
            agent_roles.insert(role_id.clone());
        }
    }

    (agent_count, agent_roles, supervisor_count)
}

fn validate_plan_shape<S: AsRef<str>>(
    snapshot: &crate::orchestrator::domain::graph::GraphSnapshot,
    draft: &PlannerDraft,
    required_roles: &[S],
) -> Result<(), String> {
    let (mut agent_count, mut agent_roles, mut supervisor_count) = existing_plan_shape(snapshot);
    let mut incomplete_nodes = Vec::new();

    for command in &draft.commands {
        match command {
            PlannerDraftCommand::AddAgentNode {
                node_id,
                description,
                role_id,
                prompt,
                acceptance,
                ..
            } => {
                agent_count += 1;
                agent_roles.insert(role_id.clone());
                if description
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                    || prompt.trim().is_empty()
                    || acceptance.is_empty()
                    || acceptance.iter().any(|item| item.trim().is_empty())
                {
                    incomplete_nodes.push(node_id.as_str());
                }
            }
            PlannerDraftCommand::AddSupervisorNode {
                node_id,
                question,
                acceptance,
                ..
            } => {
                supervisor_count += 1;
                if question.trim().is_empty()
                    || acceptance.is_empty()
                    || acceptance.iter().any(|item| item.trim().is_empty())
                {
                    incomplete_nodes.push(node_id.as_str());
                }
            }
        }
    }

    let minimum_agent_nodes = required_roles.len().max(4);
    let missing_roles = required_roles
        .iter()
        .map(AsRef::as_ref)
        .filter(|role| !agent_roles.contains(*role))
        .collect::<Vec<_>>();
    let mut issues = Vec::new();
    if agent_count < minimum_agent_nodes {
        issues.push(format!(
            "plan is too shallow: expected at least {minimum_agent_nodes} goal-specific agent nodes, got {agent_count}"
        ));
    }
    if supervisor_count == 0 {
        issues.push("plan must include at least one supervisor node".into());
    }
    if !missing_roles.is_empty() {
        issues.push(format!(
            "plan does not cover required skill roles: {}",
            missing_roles.join(", ")
        ));
    }
    if !incomplete_nodes.is_empty() {
        issues.push(format!(
            "nodes need specific descriptions, prompts, and acceptance criteria: {}",
            incomplete_nodes.join(", ")
        ));
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "task graph quality check failed: {}",
            issues.join("; ")
        ))
    }
}

fn draft_to_commands(
    snapshot: &crate::orchestrator::domain::graph::GraphSnapshot,
    draft: &PlannerDraft,
) -> Result<Vec<GraphCommand>, String> {
    let goal_id = snapshot
        .nodes
        .iter()
        .find(|node| node.node_kind == NodeKind::Goal)
        .map(|node| node.node_id.clone())
        .ok_or_else(|| "base graph has no goal node".to_string())?;
    let existing_ids = snapshot
        .nodes
        .iter()
        .map(|node| node.node_id.clone())
        .collect::<HashSet<_>>();
    let mut proposed_ids = HashSet::new();
    for command in &draft.commands {
        let node_id = match command {
            PlannerDraftCommand::AddAgentNode { node_id, .. }
            | PlannerDraftCommand::AddSupervisorNode { node_id, .. } => node_id,
        };
        if node_id.is_empty()
            || !node_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
            || existing_ids.contains(node_id)
            || !proposed_ids.insert(node_id.clone())
        {
            return Err(format!(
                "planner proposed invalid or duplicate node id '{node_id}'"
            ));
        }
    }

    let all_ids = existing_ids
        .union(&proposed_ids)
        .cloned()
        .collect::<HashSet<_>>();
    let mut commands = Vec::new();
    for command in &draft.commands {
        let (
            node_id,
            title,
            description,
            role_id,
            prompt,
            depends_on,
            required_capabilities,
            acceptance,
            permissions,
            payload,
        ) = match command {
            PlannerDraftCommand::AddAgentNode {
                node_id,
                title,
                description,
                role_id,
                prompt,
                depends_on,
                required_capabilities,
                acceptance,
                permissions,
            } => (
                node_id,
                title,
                description.clone(),
                role_id.clone(),
                prompt.clone(),
                depends_on,
                required_capabilities.clone(),
                acceptance,
                permissions.clone(),
                ExecutablePayload::Dispatch {
                    role_id: role_id.clone(),
                    prompt: prompt.clone(),
                    project: None,
                    session: None,
                },
            ),
            PlannerDraftCommand::AddSupervisorNode {
                node_id,
                title,
                question,
                depends_on,
                acceptance,
            } => (
                node_id,
                title,
                Some(question.clone()),
                "supervisor".into(),
                question.clone(),
                depends_on,
                vec!["task_supervision".into()],
                acceptance,
                PermissionScope::default(),
                ExecutablePayload::Reflect {
                    question: question.clone(),
                },
            ),
        };
        if title.trim().is_empty() || role_id.trim().is_empty() || prompt.trim().is_empty() {
            return Err(format!(
                "planner node '{node_id}' has an incomplete execution contract"
            ));
        }
        if depends_on
            .iter()
            .any(|dependency| !all_ids.contains(dependency))
        {
            return Err(format!(
                "planner node '{node_id}' references an unknown dependency"
            ));
        }
        let mut policy = NodePolicy::default();
        policy.permission_scope = permissions;
        policy.approval_policy = ApprovalPolicy::OnHighRisk;
        commands.push(GraphCommand::AddNode {
            command_id: gen_id("planner_cmd"),
            node: GraphNode {
                node_id: node_id.clone(),
                parent_id: Some(goal_id.clone()),
                title: title.trim().to_string(),
                description: description.clone(),
                node_kind: NodeKind::Executable,
                input_contract: Contract::default(),
                output_contract: Contract {
                    description: (!acceptance.is_empty()).then(|| acceptance.join("\n")),
                    artifacts: vec![],
                    schema: Some(serde_json::json!({ "acceptance": acceptance })),
                },
                role_requirement: Some(RoleRequirement {
                    role_id: role_id.clone(),
                    responsibility: description.clone().unwrap_or_else(|| title.clone()),
                    required_capabilities: required_capabilities.clone(),
                    preferred_capabilities: vec![],
                }),
                capability_requirements: required_capabilities,
                agent_assignment_constraint: None,
                policy,
                metadata: HashMap::from([(
                    "planner_acceptance".into(),
                    serde_json::json!(acceptance),
                )]),
                executable_payload: Some(payload),
                loop_config: None,
                approval_gate_config: None,
            },
        });
        for dependency in depends_on {
            commands.push(GraphCommand::AddEdge {
                command_id: gen_id("planner_cmd"),
                edge: GraphEdge {
                    edge_id: format!("edge_{}_{}", dependency, node_id),
                    source_node_id: dependency.clone(),
                    target_node_id: node_id.clone(),
                    kind: EdgeKind::ControlDependency,
                },
            });
        }
    }
    Ok(commands)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::commands::{graph_create, CreateGraphInput};

    #[test]
    fn planner_draft_becomes_valid_graph_commands() {
        let snapshot = graph_create(&CreateGraphInput {
            title: "Task".into(),
            goal: "Ship safely".into(),
            project_root: ".".into(),
            owner: "test".into(),
            ..Default::default()
        });
        let draft: PlannerDraft = serde_json::from_value(serde_json::json!({
            "commands": [
                {
                    "op": "add_agent_node",
                    "node_id": "implement",
                    "title": "Implement",
                    "role_id": "developer",
                    "prompt": "Implement the requested behavior.",
                    "acceptance": ["Tests pass"],
                    "permissions": {
                        "can_read_files": true,
                        "can_write_files": true,
                        "can_run_commands": true,
                        "can_access_network": false,
                        "can_deploy": false
                    }
                },
                {
                    "op": "add_agent_node",
                    "node_id": "review",
                    "title": "Review",
                    "role_id": "auditor",
                    "prompt": "Review the implementation.",
                    "depends_on": ["implement"]
                }
            ],
            "rationale": "Implementation followed by review",
            "expected_benefits": ["Auditable"],
            "risks": []
        }))
        .unwrap();
        let commands = draft_to_commands(&snapshot, &draft).unwrap();
        let candidate = apply_commands(&snapshot, &commands).unwrap();
        graph_validate(&candidate).unwrap();
        assert_eq!(candidate.nodes.len(), 3);
        assert_eq!(candidate.edges.len(), 1);
    }

    #[test]
    fn planner_draft_rejects_unknown_dependencies() {
        let snapshot = graph_create(&CreateGraphInput {
            title: "Task".into(),
            goal: "Ship safely".into(),
            project_root: ".".into(),
            owner: "test".into(),
            ..Default::default()
        });
        let draft: PlannerDraft = serde_json::from_value(serde_json::json!({
            "commands": [{
                "op": "add_agent_node",
                "node_id": "review",
                "title": "Review",
                "role_id": "auditor",
                "prompt": "Review.",
                "depends_on": ["missing"]
            }],
            "rationale": "Review",
            "expected_benefits": [],
            "risks": []
        }))
        .unwrap();
        assert!(draft_to_commands(&snapshot, &draft).is_err());
    }

    #[test]
    fn initial_planning_rejects_a_single_generic_node() {
        let snapshot = graph_create(&CreateGraphInput {
            title: "Permission platform".into(),
            goal: "Design frontend and backend permission management".into(),
            project_root: ".".into(),
            owner: "test".into(),
            ..Default::default()
        });
        let draft: PlannerDraft = serde_json::from_value(serde_json::json!({
            "commands": [{
                "op": "add_agent_node",
                "node_id": "implement",
                "title": "Implement permission management",
                "role_id": "developer",
                "prompt": "Implement the requested system.",
                "acceptance": ["The system exists"]
            }],
            "rationale": "One node",
            "expected_benefits": [],
            "risks": []
        }))
        .unwrap();

        let error = validate_plan_shape(
            &snapshot,
            &draft,
            &[
                "requirements_owner",
                "architect",
                "developer",
                "tester",
                "auditor",
            ],
        )
        .unwrap_err();

        assert!(error.contains("too shallow"));
        assert!(error.contains("supervisor"));
    }

    #[test]
    fn shallow_existing_graph_still_requires_real_expansion() {
        let mut snapshot = graph_create(&CreateGraphInput {
            title: "Permission platform".into(),
            goal: "Design frontend and backend permission management".into(),
            project_root: ".".into(),
            owner: "test".into(),
            ..Default::default()
        });
        snapshot.nodes.push(GraphNode {
            node_id: "permission_management".into(),
            parent_id: None,
            title: "Permission management".into(),
            description: Some("Implement the whole permission system.".into()),
            node_kind: NodeKind::Executable,
            input_contract: Contract::default(),
            output_contract: Contract::default(),
            role_requirement: Some(RoleRequirement {
                role_id: "developer".into(),
                responsibility: "Implement everything".into(),
                required_capabilities: vec![],
                preferred_capabilities: vec![],
            }),
            capability_requirements: vec![],
            agent_assignment_constraint: None,
            policy: NodePolicy::default(),
            metadata: HashMap::new(),
            executable_payload: Some(ExecutablePayload::Dispatch {
                role_id: "developer".into(),
                prompt: "Implement the whole permission system.".into(),
                project: None,
                session: None,
            }),
            loop_config: None,
            approval_gate_config: None,
        });
        let draft: PlannerDraft = serde_json::from_value(serde_json::json!({
            "commands": [{
                "op": "add_agent_node",
                "node_id": "finish",
                "title": "Finish permission management",
                "role_id": "developer",
                "prompt": "Finish the requested system.",
                "acceptance": ["The system exists"]
            }],
            "rationale": "Small patch",
            "expected_benefits": [],
            "risks": []
        }))
        .unwrap();

        let error = validate_plan_shape(
            &snapshot,
            &draft,
            &[
                "requirements_owner",
                "architect",
                "developer",
                "tester",
                "auditor",
            ],
        )
        .unwrap_err();

        assert!(error.contains("too shallow"));
        assert!(error.contains("requirements_owner"));
        assert!(error.contains("supervisor"));
    }

    #[test]
    fn initial_planning_accepts_role_coverage_and_supervision() {
        let snapshot = graph_create(&CreateGraphInput {
            title: "Permission platform".into(),
            goal: "Design frontend and backend permission management".into(),
            project_root: ".".into(),
            owner: "test".into(),
            ..Default::default()
        });
        let draft: PlannerDraft = serde_json::from_value(serde_json::json!({
            "commands": [
                {
                    "op": "add_agent_node",
                    "node_id": "requirements",
                    "title": "Clarify permission boundaries",
                    "description": "Define operation and data permission scenarios.",
                    "role_id": "requirements_owner",
                    "prompt": "Produce explicit permission scenarios and acceptance criteria.",
                    "acceptance": ["Operation and data permission cases are explicit"]
                },
                {
                    "op": "add_agent_node",
                    "node_id": "architecture",
                    "title": "Design authorization architecture",
                    "description": "Define organization, role, policy, and enforcement boundaries.",
                    "role_id": "architect",
                    "prompt": "Design the authorization model and interfaces.",
                    "depends_on": ["requirements"],
                    "acceptance": ["Frontend and backend contracts are explicit"]
                },
                {
                    "op": "add_agent_node",
                    "node_id": "implementation",
                    "title": "Implement permission services",
                    "description": "Build operation and data permission enforcement.",
                    "role_id": "developer",
                    "prompt": "Implement the planned services and management UI.",
                    "depends_on": ["architecture"],
                    "acceptance": ["Permission enforcement is implemented"]
                },
                {
                    "op": "add_agent_node",
                    "node_id": "testing",
                    "title": "Test permission boundaries",
                    "description": "Verify authorization and data isolation.",
                    "role_id": "tester",
                    "prompt": "Run positive, negative, and isolation tests.",
                    "depends_on": ["implementation"],
                    "acceptance": ["Unauthorized access is denied"]
                },
                {
                    "op": "add_agent_node",
                    "node_id": "audit",
                    "title": "Audit security and traceability",
                    "description": "Review policy correctness and audit evidence.",
                    "role_id": "auditor",
                    "prompt": "Audit the completed permission system.",
                    "depends_on": ["testing"],
                    "acceptance": ["Security findings are resolved or recorded"]
                },
                {
                    "op": "add_supervisor_node",
                    "node_id": "supervise",
                    "title": "Evaluate goal completion",
                    "question": "Evaluate the graph outputs against the goal and acceptance criteria.",
                    "depends_on": ["audit"],
                    "acceptance": ["Return pass, rework, stop, or human decision"]
                }
            ],
            "rationale": "Role-complete engineering flow",
            "expected_benefits": ["Traceable"],
            "risks": []
        }))
        .unwrap();

        validate_plan_shape(
            &snapshot,
            &draft,
            &[
                "requirements_owner",
                "architect",
                "developer",
                "tester",
                "auditor",
            ],
        )
        .unwrap();
    }

    #[test]
    fn parse_draft_strips_markdown_fence_and_surrounding_prose() {
        let response = r#"Here is the plan you asked for:

```json
{
  "commands": [
    {
      "op": "add_agent_node",
      "node_id": "implement",
      "title": "Implement",
      "role_id": "developer",
      "prompt": "Implement the requested behavior.",
      "acceptance": ["Tests pass"]
    }
  ],
  "rationale": "Single node implementation",
  "expected_benefits": [],
  "risks": []
}
```

Let me know if you want any changes."#;
        let draft = parse_draft(response).expect("fenced JSON with prose must parse");
        assert_eq!(draft.commands.len(), 1);
        assert_eq!(draft.rationale, "Single node implementation");
    }

    #[test]
    fn parse_draft_ignores_braces_inside_string_literals() {
        let response = r#"{"commands":[{"op":"add_agent_node","node_id":"implement","title":"Implement","role_id":"developer","prompt":"Use {} placeholder when emitting JSON literals","acceptance":["done"]}],"rationale":"contains } and { characters","expected_benefits":[],"risks":[]}"#;
        let draft = parse_draft(response)
            .expect("braces inside string literals must not terminate the object");
        assert_eq!(draft.commands.len(), 1);
        assert!(draft.rationale.contains('}'));
        assert!(draft.rationale.contains('{'));
    }

    #[test]
    fn parse_draft_handles_escaped_quotes_and_braces() {
        let response = r#"{
  "commands": [
    {
      "op": "add_agent_node",
      "node_id": "implement",
      "title": "Implement",
      "role_id": "developer",
      "prompt": "Emit \"quoted\" string with \\\"nested\\\" braces like {a}",
      "acceptance": ["ok"]
    }
  ],
  "rationale": "Escaped \"quote\" should not break scanning",
  "expected_benefits": [],
  "risks": []
}"#;
        let draft =
            parse_draft(response).expect("escaped quotes must not terminate the string early");
        assert_eq!(draft.commands.len(), 1);
        assert!(draft.rationale.contains("Escaped"));
    }

    #[test]
    fn parse_draft_extracts_json_embedded_after_prose() {
        let response = r#"I considered several designs but here is the final one:
{"commands":[{"op":"add_agent_node","node_id":"audit","title":"Audit","role_id":"auditor","prompt":"Audit","acceptance":["ok"]}],"rationale":"embedded","expected_benefits":[],"risks":[]}
Hope this works for you."#;
        let draft = parse_draft(response).expect("JSON embedded in prose must be extracted");
        assert_eq!(draft.commands.len(), 1);
        assert_eq!(draft.rationale, "embedded");
    }

    #[test]
    fn parse_draft_rejects_top_level_array() {
        let response = r#"[{"op":"add_agent_node","node_id":"x","title":"x","role_id":"developer","prompt":"x","acceptance":["ok"]}]"#;
        let error = parse_draft(response).expect_err("top-level array must be rejected");
        assert!(
            error.contains("top-level value is \"array\""),
            "expected diagnostic about top-level array, got: {error}"
        );
    }

    #[test]
    fn parse_draft_rejects_empty_response() {
        let error = parse_draft("   \n  ").expect_err("empty response must be rejected");
        assert!(error.contains("did not contain a JSON object"));
    }

    #[test]
    fn planning_interaction_is_project_owned_and_keeps_public_question_only() {
        let request = planning_interaction_request(
            "graph-1",
            &[
                NormalizedEvent::SessionResolved {
                    session_id: "session-1".into(),
                },
                NormalizedEvent::InteractionRequest {
                    request_id: "request-1".into(),
                    prompt: "请选择规划范围".into(),
                    options: vec![crate::agent::normalized::InteractionOption {
                        option_id: "a".into(),
                        label: "后端优先".into(),
                        description: None,
                    }],
                    allow_multiple: false,
                    allow_custom_text: true,
                    required: true,
                },
            ],
        )
        .expect("interaction should be extracted");

        assert_eq!(request.graph_id, "graph-1");
        assert!(request.run_id.is_none());
        assert!(request.node_id.is_none());
        assert_eq!(request.prompt, "请选择规划范围");
    }

    #[test]
    fn planning_interaction_reply_contains_only_the_visible_answer() {
        let request = TaskInteractionRequest {
            request_id: "request-1".into(),
            graph_id: "graph-1".into(),
            run_id: None,
            node_id: None,
            node_run_id: None,
            session_id: Some("session-1".into()),
            prompt: "请选择规划范围".into(),
            options: vec![crate::agent::normalized::InteractionOption {
                option_id: "a".into(),
                label: "后端优先".into(),
                description: None,
            }],
            allow_multiple: false,
            allow_custom_text: true,
            required: true,
            created_at: 1,
            resolved_at: Some(2),
            consumed_at: Some(3),
            submission: Some(TaskInteractionSubmission {
                selected_option_ids: vec!["a".into()],
                custom_text: Some("保留前端扩展点".into()),
            }),
        };

        let reply = planning_interaction_reply(&request).unwrap();
        assert!(reply.contains("后端优先"));
        assert!(reply.contains("保留前端扩展点"));
        assert!(!reply.contains("JSON"));
        assert!(!reply.contains("execution contract"));
    }
}
