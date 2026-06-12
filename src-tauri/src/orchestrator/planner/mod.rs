use std::collections::{HashMap, HashSet};
use std::sync::{atomic::AtomicBool, Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::agent::normalized::ContentBlock;
use crate::agent::{AgentRegistry, NormalizedEvent};
use crate::orchestrator::commands::{apply_commands, graph_validate, GraphCommand};
use crate::orchestrator::domain::graph::{
    Contract, EdgeKind, ExecutablePayload, GraphEdge, GraphNode, NodeKind, RoleRequirement,
};
use crate::orchestrator::domain::policy::{ApprovalPolicy, NodePolicy, PermissionScope};
use crate::orchestrator::domain::revision::{
    diff_snapshots, PlannerPolicyRef, RevisionDiff, SkillRef, TemplateRef,
};
use crate::orchestrator::domain::run::AgentAssignment;
use crate::orchestrator::runtime_bridge::{
    capability_snapshot, RuntimeInvocationRequest, TaskAgentRuntime,
};
use crate::orchestrator::store::TaskStore;
use crate::util::gen_id;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningRequest {
    pub graph_id: String,
    pub base_revision_id: String,
    pub instruction: String,
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
        }
    }

    pub async fn generate(&self, request: PlanningRequest) -> Result<GraphProposal, String> {
        if request.instruction.trim().is_empty() {
            return Err("planning instruction cannot be empty".into());
        }
        let (graph, revision, snapshot) = {
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
            (graph, revision, snapshot)
        };

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
        let planning_node = planning_node();
        let (planner_assignment, _transport) = self
            .runtime
            .resolve_agent(&planning_node, "planner")
            .map_err(|error| format!("planner resolution failed: {error}"))?;
        let prompt = build_prompt(
            &request,
            &graph.project_root.to_string_lossy(),
            &snapshot,
            &skill_manifests,
            &available_agents,
        )?;
        let output = self
            .runtime
            .invoke(RuntimeInvocationRequest {
                agent_id: planner_assignment.agent_id.clone(),
                role_id: "planner".into(),
                project_path: graph.project_root.to_string_lossy().to_string(),
                session_id: None,
                prompt,
                timeout_ms: 180_000,
                cancellation: Arc::new(AtomicBool::new(false)),
            })
            .await
            .map_err(|error| format!("planner invocation failed: {error}"))?;
        if !output.exit_success {
            return Err(format!(
                "planner process exited unsuccessfully ({:?})",
                output.exit_code
            ));
        }
        let response = collect_text(&output.events);
        let draft = parse_draft(&response)?;
        let commands = draft_to_commands(&snapshot, &draft)?;
        let candidate = apply_commands(&snapshot, &commands).map_err(|error| error.to_string())?;
        let warnings = graph_validate(&candidate).map_err(|error| error.to_string())?;
        let proposal_id = gen_id("proposal");
        let diff = diff_snapshots(
            &snapshot,
            &candidate,
            &request.base_revision_id,
            &proposal_id,
        );

        Ok(GraphProposal {
            proposal_id,
            graph_id: request.graph_id,
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
        })
    }
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

fn build_prompt(
    request: &PlanningRequest,
    project_root: &str,
    snapshot: &crate::orchestrator::domain::graph::GraphSnapshot,
    skills: &[serde_json::Value],
    available_agents: &[serde_json::Value],
) -> Result<String, String> {
    let context = serde_json::json!({
        "instruction": request.instruction,
        "project_root": project_root,
        "base_revision_id": request.base_revision_id,
        "current_graph": snapshot,
        "skills": skills,
        "available_agents": available_agents,
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
- Request the least permissions needed. Write, command, network, and deploy permissions are high risk.
- Include explicit verification or review work where the task needs it.
- Do not call tools, edit files, or start execution. Planning only.

Planning context:
{context}"#
    ))
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
    let trimmed = response
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let json = if serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
        trimmed
    } else {
        let start = trimmed
            .find('{')
            .ok_or_else(|| "planner response did not contain a JSON object".to_string())?;
        let end = trimmed
            .rfind('}')
            .ok_or_else(|| "planner response did not contain a complete JSON object".to_string())?;
        &trimmed[start..=end]
    };
    let draft: PlannerDraft = serde_json::from_str(json)
        .map_err(|error| format!("invalid planner proposal JSON: {error}"))?;
    if draft.commands.is_empty() {
        return Err("planner proposal must contain at least one command".into());
    }
    Ok(draft)
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
}
