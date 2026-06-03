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
                        agent: role.agent_id.clone(),
                        message: build_role_dispatch_message(spec, role),
                        project: project.clone(),
                        session: None,
                    },
                    depends_on: role_dependencies(idx, role, &spec.roles),
                    timeout_ms: spec.deadline_ms,
                })
                .collect());
        }

        let agent = spec
            .agent_hint
            .as_deref()
            .or(ctx.previous_active_agent.as_deref())
            .unwrap_or("claude-code")
            .to_string();

        let project = spec.project_path.clone().unwrap_or_else(|| ".".to_string());

        Ok(vec![Step {
            step_id: "sp_0".to_string(),
            kind: StepKind::Dispatch {
                agent,
                message: spec.message.clone(),
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
                "- {} ({}) via agent {}",
                candidate.role_name, candidate.role_id, candidate.agent_id
            )
        })
        .collect::<Vec<_>>();
    let rework_targets = if rework_targets.is_empty() {
        "- No explicit rework target. Report blockers to jishu agent with the responsible role if you can infer it.".to_string()
    } else {
        rework_targets.join("\n")
    };

    format!(
        "[{}] {}\n\nRole contract:\nResponsibilities:\n- {}\n\nAcceptance:\n- {}\n\nCollaboration and rework rules:\n- Read responsibilities and acceptance as a structured contract.\n- If you consume or audit another role's output, name that role in your conclusion.\n- If you find an issue, return a rework item with: responsible_role, reason, evidence, suggested_action.\n- jishu agent should route rework to:\n{}",
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
