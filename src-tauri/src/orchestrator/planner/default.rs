use super::{PlanContext, PlanError, Planner};
use crate::orchestrator::spec::{RoleAssignment, Step, StepKind, TaskSpec};

pub struct DefaultPlanner;

impl Planner for DefaultPlanner {
    fn id(&self) -> &str {
        "default"
    }

    fn plan(&self, spec: &TaskSpec, ctx: &PlanContext) -> Result<Vec<Step>, PlanError> {
        if !spec.roles.is_empty() {
            let project = spec.project_path.clone().unwrap_or_else(|| ".".to_string());
            return Ok(spec
                .roles
                .iter()
                .enumerate()
                .map(|(idx, role)| Step {
                    step_id: format!("sp_{idx}"),
                    kind: StepKind::Dispatch {
                        role_id: role.role_id.clone(),
                        prompt: build_role_dispatch_message(spec, role),
                        project: project.clone(),
                        session: None,
                    },
                    depends_on: role_dependencies(idx, role, &spec.roles),
                    timeout_ms: spec.deadline_ms,
                })
                .collect());
        }

        // No roles: single-step dispatch with a SYNTHETIC role contract.
        // Without explicit roles, we still inject a default role contract so
        // the agent gets clear constraints (no interactive back-and-forth,
        // single-shot delivery, no browser-based tools).
        let agent = ctx
            .previous_active_agent
            .as_deref()
            .unwrap_or("claude-code")
            .to_string();

        let project = spec.project_path.clone().unwrap_or_else(|| ".".to_string());

        let synthetic_role = RoleAssignment {
            role_id: "default_worker".into(),
            role_name: "Default Worker".into(),
            agent_id: Some(agent.clone()),
            responsibilities: vec![
                "Read and understand the task end-to-end.".into(),
                "Execute the work and produce concrete deliverables in a single response.".into(),
                "Document any assumptions or tradeoffs you make.".into(),
            ],
            acceptance: vec![
                "Output is complete and actionable — no placeholder, no 'let me ask...' prompts.".into(),
                "All claims are backed by code references, file paths, or specific evidence.".into(),
            ],
            can_edit_files: true,
            can_run_commands: true,
            can_receive_rework: true,
        };

        Ok(vec![Step {
            step_id: "sp_0".to_string(),
            kind: StepKind::Dispatch {
                role_id: agent,
                prompt: build_role_dispatch_message(spec, &synthetic_role),
                project,
                session: None,
            },
            depends_on: vec![],
            timeout_ms: spec.deadline_ms,
        }])
    }
}

fn build_role_dispatch_message(spec: &TaskSpec, role: &RoleAssignment) -> String {
    let rework_targets = spec
        .roles
        .iter()
        .filter(|candidate| candidate.role_id != role.role_id && candidate.can_receive_rework)
        .filter(|candidate| role_mentions(role, candidate))
        .map(|candidate| {
            format!(
                "- {} ({})",
                candidate.role_name, candidate.role_id
            )
        })
        .collect::<Vec<_>>();
    let rework_targets = if rework_targets.is_empty() {
        "- No explicit rework target. Report blockers to jishu agent with the responsible role if you can infer it.".to_string()
    } else {
        rework_targets.join("\n")
    };

    format!(
        "[{}] {}\n\n\
Role contract:\n\
Responsibilities:\n- {}\n\n\
Acceptance:\n- {}\n\n\
Collaboration and rework rules:\n\
- Read responsibilities and acceptance as a structured contract.\n\
- If you consume or audit another role's output, name that role in your conclusion.\n\
- If you find an issue, return a rework item with: responsible_role, reason, evidence, suggested_action.\n\
- If you need user input to make progress, emit an approval_request event\n\
  (see the jishu agent integration spec) — the HUB will surface it and relay your reply.\n\
- jishu agent should route rework to:\n{}",
        role.role_name,
        spec.message,
        role.responsibilities.join("\n- "),
        role.acceptance.join("\n- "),
        rework_targets
    )
}

fn role_dependencies(idx: usize, role: &RoleAssignment, roles: &[RoleAssignment]) -> Vec<String> {
    let mut deps = roles
        .iter()
        .enumerate()
        .filter(|(candidate_idx, candidate)| {
            *candidate_idx != idx && role_mentions(role, candidate)
        })
        .map(|(candidate_idx, _)| format!("sp_{candidate_idx}"))
        .collect::<Vec<_>>();
    if deps.is_empty() && idx > 0 {
        deps.push(format!("sp_{}", idx - 1));
    }
    deps.sort();
    deps.dedup();
    deps
}

fn role_mentions(source: &RoleAssignment, target: &RoleAssignment) -> bool {
    let contract = format!(
        "{}\n{}",
        source.responsibilities.join("\n"),
        source.acceptance.join("\n")
    )
    .to_lowercase();
    let target_id = target.role_id.to_lowercase();
    let target_name = target.role_name.to_lowercase();
    contract.contains(&target_id)
        || contract.contains(&target_name)
        || contract.contains(&format!("[{target_name}]"))
        || contract.contains(&format!("{{[{target_name}]}}"))
}
