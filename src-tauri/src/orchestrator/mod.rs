pub mod bus;
pub mod daemon;
pub mod dispatcher;
pub mod planner;
pub mod proposal;
pub mod result;
pub mod spec;
pub mod trace;

use crate::agent::normalized::{NormalizedEvent, TaskStepKind};
use crate::agent::AgentRegistry;
use dispatcher::{DefaultDispatcher, DispatchContext, Dispatcher};
use planner::PlanContext;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[allow(unused_imports)]
pub use bus::EventBus;
#[allow(unused_imports)]
pub use proposal::EvolutionProposal;
#[allow(unused_imports)]
pub use result::{RunResult, RunStatus, StepOutcome, UsageSummary};
#[allow(unused_imports)]
pub use spec::{Step, StepKind, TaskKind, TaskSpec};
#[allow(unused_imports)]
pub use trace::TraceRecorder;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSubmitResult {
    pub task_id: String,
    pub run_id: String,
    pub status: RunStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub run_id: String,
    pub task_id: String,
    pub status: RunStatus,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub run_id: String,
    pub spec: TaskSpec,
    pub plan: Vec<Step>,
    pub result: RunResult,
    #[serde(default)]
    pub timeline: Vec<TaskTimelineEvent>,
    #[serde(default)]
    pub rework_routes: Vec<RoleContractRoute>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleContractRoute {
    pub from_role_id: String,
    pub from_role_name: String,
    pub from_agent_id: String,
    pub target_role_id: String,
    pub target_role_name: String,
    pub target_agent_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskTimelineEvent {
    pub event_id: String,
    pub kind: String,
    pub title: String,
    pub detail: Option<serde_json::Value>,
    pub step_id: Option<String>,
    pub role_id: Option<String>,
    pub agent_id: Option<String>,
    pub at: Option<i64>,
}

pub fn submit_task(spec: TaskSpec) -> Result<TaskSubmitResult, String> {
    let root = default_runs_root();
    submit_task_in_root(spec, &root)
}

pub fn list_runs() -> Result<Vec<RunSummary>, String> {
    list_runs_in_root(&default_runs_root())
}

pub fn get_run(run_id: &str) -> Result<RunRecord, String> {
    get_run_in_root(&default_runs_root(), run_id)
}

pub fn cancel_run(run_id: &str) -> Result<RunResult, String> {
    cancel_run_in_root(&default_runs_root(), run_id)
}

pub fn submit_task_in_root(mut spec: TaskSpec, root: &Path) -> Result<TaskSubmitResult, String> {
    let started_at = now_ms();
    if spec.task_id.trim().is_empty() {
        spec.task_id = format!("ts_{started_at}");
    }
    let run_id = format!("r_{}_{}", started_at, sanitize_id(&spec.task_id));
    let trace = TraceRecorder::create_in_root(root, &run_id)?;
    trace.write_spec(&spec)?;

    let registry = Arc::new(AgentRegistry::new());
    let plan_ctx = PlanContext {
        registry: registry.clone(),
        previous_active_agent: None,
    };
    let planner = planner::create_planner(&spec.policy);
    let steps = planner.plan(&spec, &plan_ctx).map_err(|e| e.to_string())?;
    trace.write_plan(&steps)?;
    let rework_routes = derive_rework_routes(&spec);
    trace.append_event(&NormalizedEvent::TaskStep {
        run_id: run_id.clone(),
        step_id: "sp_plan".to_string(),
        kind: TaskStepKind::Plan,
        title: "Plan generated".to_string(),
        detail: Some(serde_json::json!({
            "roles": spec.roles.clone(),
            "steps": steps.len(),
            "rework_routes": rework_routes.clone(),
        })),
    })?;
    for route in &rework_routes {
        trace.append_event(&NormalizedEvent::TaskStep {
            run_id: run_id.clone(),
            step_id: format!("route_{}_to_{}", route.from_role_id, route.target_role_id),
            kind: TaskStepKind::Reflect,
            title: format!(
                "Rework route: {} -> {}",
                route.from_role_name, route.target_role_name
            ),
            detail: Some(serde_json::json!(route)),
        })?;
    }

    let (status, outcomes, error) = if matches!(spec.kind, TaskKind::Plan) {
        (RunStatus::Complete, Vec::new(), None)
    } else {
        execute_steps(&spec, &run_id, &steps, registry, &trace)
    };

    let result = RunResult {
        run_id: run_id.clone(),
        task_id: spec.task_id.clone(),
        status: status.clone(),
        started_at,
        finished_at: Some(now_ms()),
        steps: outcomes,
        usage: UsageSummary::default(),
        error,
    };
    trace.write_result(&result)?;

    Ok(TaskSubmitResult {
        task_id: spec.task_id,
        run_id,
        status,
    })
}

fn execute_steps(
    spec: &TaskSpec,
    run_id: &str,
    steps: &[Step],
    registry: Arc<AgentRegistry>,
    trace: &TraceRecorder,
) -> (RunStatus, Vec<StepOutcome>, Option<String>) {
    let dispatcher = DefaultDispatcher::new();
    let mut outcomes = Vec::new();
    let mut first_error = None;

    for step in steps {
        let _ = trace.append_event(&NormalizedEvent::TaskStep {
            run_id: run_id.to_string(),
            step_id: step.step_id.clone(),
            kind: TaskStepKind::Dispatch,
            title: format!("Executing {}", step.step_id),
            detail: None,
        });
        let mut emitter = |event: &NormalizedEvent| {
            let _ = trace.append_event(event);
        };
        let mut ctx = DispatchContext {
            registry: registry.clone(),
            run_id,
            task_id: &spec.task_id,
            trace,
            emitter: &mut emitter,
        };
        match dispatcher.execute(step, &mut ctx) {
            Ok(outcome) => {
                let failed = outcome.status != "complete";
                outcomes.push(outcome);
                let _ = trace.append_event(&NormalizedEvent::TaskStep {
                    run_id: run_id.to_string(),
                    step_id: step.step_id.clone(),
                    kind: if failed {
                        TaskStepKind::Failed
                    } else {
                        TaskStepKind::Done
                    },
                    title: if failed {
                        format!("{} failed", step.step_id)
                    } else {
                        format!("{} complete", step.step_id)
                    },
                    detail: None,
                });
                if failed && first_error.is_none() {
                    first_error = Some(format!("{} failed", step.step_id));
                }
            }
            Err(err) => {
                let message = err.to_string();
                outcomes.push(StepOutcome {
                    step_id: step.step_id.clone(),
                    agent_id: "unknown".to_string(),
                    status: "error".to_string(),
                    output: Some(serde_json::json!({ "error": message })),
                });
                let _ = trace.append_event(&NormalizedEvent::TaskStep {
                    run_id: run_id.to_string(),
                    step_id: step.step_id.clone(),
                    kind: TaskStepKind::Failed,
                    title: format!("{} failed: {err}", step.step_id),
                    detail: None,
                });
                first_error.get_or_insert_with(|| err.to_string());
                break;
            }
        }
    }

    if let Some(error) = first_error {
        (RunStatus::Error, outcomes, Some(error))
    } else {
        (RunStatus::Complete, outcomes, None)
    }
}

pub fn list_runs_in_root(root: &Path) -> Result<Vec<RunSummary>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut runs = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let run_id = entry.file_name().to_string_lossy().to_string();
        let spec_path = path.join("spec.json");
        let result_path = path.join("result.json");
        if !spec_path.exists() || !result_path.exists() {
            continue;
        }
        let spec: TaskSpec = read_json(&spec_path)?;
        let result: RunResult = read_json(&result_path)?;
        runs.push(RunSummary {
            run_id,
            task_id: result.task_id,
            status: result.status,
            started_at: result.started_at,
            finished_at: result.finished_at,
            title: spec.message,
        });
    }
    runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(runs)
}

pub fn get_run_in_root(root: &Path, run_id: &str) -> Result<RunRecord, String> {
    let run_dir = root.join(run_id);
    if !run_dir.exists() {
        return Err(format!("Run not found: {run_id}"));
    }
    let spec: TaskSpec = read_json(&run_dir.join("spec.json"))?;
    let plan: Vec<Step> = read_json(&run_dir.join("plan.json"))?;
    let result: RunResult = read_json(&run_dir.join("result.json"))?;
    let trace_events = read_trace_events(&run_dir.join("trace.jsonl"))?;
    let rework_routes = derive_rework_routes(&spec);
    let timeline = build_timeline(&spec, &plan, &result, &trace_events, &rework_routes);
    Ok(RunRecord {
        run_id: run_id.to_string(),
        spec,
        plan,
        result,
        timeline,
        rework_routes,
    })
}

pub fn cancel_run_in_root(root: &Path, run_id: &str) -> Result<RunResult, String> {
    let mut record = get_run_in_root(root, run_id)?;
    record.result.status = RunStatus::Aborted;
    record.result.finished_at = Some(now_ms());
    record.result.error = Some("Cancelled by user".to_string());
    let json = serde_json::to_string_pretty(&record.result).map_err(|e| e.to_string())?;
    std::fs::write(root.join(run_id).join("result.json"), json).map_err(|e| e.to_string())?;
    Ok(record.result)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    serde_json::from_str(&content).map_err(|e| format!("Cannot parse {}: {e}", path.display()))
}

fn read_trace_events(path: &Path) -> Result<Vec<NormalizedEvent>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut events = Vec::new();
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        if let Ok(event) = serde_json::from_str::<NormalizedEvent>(line) {
            events.push(event);
        }
    }
    Ok(events)
}

fn build_timeline(
    spec: &TaskSpec,
    plan: &[Step],
    result: &RunResult,
    trace_events: &[NormalizedEvent],
    rework_routes: &[RoleContractRoute],
) -> Vec<TaskTimelineEvent> {
    let mut timeline = Vec::new();
    timeline.push(TaskTimelineEvent {
        event_id: "task_created".to_string(),
        kind: "task_created".to_string(),
        title: "Task submitted from HUB".to_string(),
        detail: Some(serde_json::json!({
            "task_id": &spec.task_id,
            "message": &spec.message,
            "roles": &spec.roles,
        })),
        step_id: None,
        role_id: None,
        agent_id: spec.agent_hint.clone(),
        at: Some(spec.created_at),
    });

    for (idx, role) in spec.roles.iter().enumerate() {
        timeline.push(TaskTimelineEvent {
            event_id: format!("role_assigned_{idx}"),
            kind: "role_assigned".to_string(),
            title: format!("{} assigned to {}", role.role_name, role.agent_id),
            detail: Some(serde_json::json!({
                "responsibilities": &role.responsibilities,
                "acceptance": &role.acceptance,
                "can_receive_rework": role.can_receive_rework,
            })),
            step_id: Some(format!("sp_{idx}")),
            role_id: Some(role.role_id.clone()),
            agent_id: Some(role.agent_id.clone()),
            at: Some(spec.created_at),
        });
    }

    for route in rework_routes {
        timeline.push(TaskTimelineEvent {
            event_id: format!(
                "rework_route_{}_{}",
                route.from_role_id, route.target_role_id
            ),
            kind: "rework_route".to_string(),
            title: format!(
                "{} findings route to {}",
                route.from_role_name, route.target_role_name
            ),
            detail: Some(serde_json::json!(route)),
            step_id: None,
            role_id: Some(route.from_role_id.clone()),
            agent_id: Some(route.from_agent_id.clone()),
            at: Some(spec.created_at),
        });
    }

    for (idx, step) in plan.iter().enumerate() {
        let (agent_id, role_id) = match &step.kind {
            StepKind::Dispatch { agent, .. } => {
                let role = spec.roles.get(idx);
                (Some(agent.clone()), role.map(|role| role.role_id.clone()))
            }
            _ => (None, None),
        };
        timeline.push(TaskTimelineEvent {
            event_id: format!("plan_step_{}", step.step_id),
            kind: "plan_step".to_string(),
            title: format!("Plan step {}", step.step_id),
            detail: Some(serde_json::json!(step)),
            step_id: Some(step.step_id.clone()),
            role_id,
            agent_id,
            at: Some(result.started_at),
        });
    }

    for (idx, event) in trace_events.iter().enumerate() {
        if let NormalizedEvent::TaskStep {
            step_id,
            kind,
            title,
            detail,
            ..
        } = event
        {
            timeline.push(TaskTimelineEvent {
                event_id: format!("trace_{idx}"),
                kind: format!("{kind:?}").to_lowercase(),
                title: title.clone(),
                detail: detail.clone(),
                step_id: Some(step_id.clone()),
                role_id: None,
                agent_id: None,
                at: None,
            });
        }
    }

    timeline.push(TaskTimelineEvent {
        event_id: "task_finished".to_string(),
        kind: "task_finished".to_string(),
        title: format!("Task finished with status {:?}", result.status),
        detail: result
            .error
            .as_ref()
            .map(|error| serde_json::json!({ "error": error })),
        step_id: None,
        role_id: None,
        agent_id: None,
        at: result.finished_at,
    });
    timeline
}

fn derive_rework_routes(spec: &TaskSpec) -> Vec<RoleContractRoute> {
    let mut routes = Vec::new();
    for source in &spec.roles {
        let contract = format!(
            "{}\n{}",
            source.responsibilities.join("\n"),
            source.acceptance.join("\n")
        )
        .to_lowercase();
        for target in &spec.roles {
            if source.role_id == target.role_id || !target.can_receive_rework {
                continue;
            }
            let mentioned = contract.contains(&target.role_id.to_lowercase())
                || contract.contains(&target.role_name.to_lowercase())
                || contract.contains(&format!("[{}]", target.role_name.to_lowercase()))
                || contract.contains(&format!("{{[{}]}}", target.role_name.to_lowercase()));
            if mentioned {
                routes.push(RoleContractRoute {
                    from_role_id: source.role_id.clone(),
                    from_role_name: source.role_name.clone(),
                    from_agent_id: source.agent_id.clone(),
                    target_role_id: target.role_id.clone(),
                    target_role_name: target.role_name.clone(),
                    target_agent_id: target.agent_id.clone(),
                    reason:
                        "role contract mentions the target role and the target can receive rework"
                            .to_string(),
                });
            }
        }
    }
    routes
}

fn default_runs_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".jishu-hub")
        .join("runs")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn hub_plan_task_submit_writes_spec_plan_and_result() {
        let root = std::env::temp_dir().join(format!("jishu_core_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let spec = TaskSpec {
            task_id: "ts_hub_roles".into(),
            kind: TaskKind::Plan,
            message: "Implement the task".into(),
            project_path: Some("D:/project".into()),
            agent_hint: None,
            roles: vec![
                spec::RoleAssignment {
                    role_id: "architect".into(),
                    role_name: "架构师".into(),
                    agent_id: "claude1".into(),
                    responsibilities: vec!["架构设计".into()],
                    acceptance: vec!["设计完成".into()],
                    can_edit_files: false,
                    can_run_commands: false,
                    can_receive_rework: true,
                },
                spec::RoleAssignment {
                    role_id: "auditor".into(),
                    role_name: "审计员".into(),
                    agent_id: "codex".into(),
                    responsibilities: vec!["最终审计".into()],
                    acceptance: vec!["无 P0/P1".into()],
                    can_edit_files: false,
                    can_run_commands: true,
                    can_receive_rework: false,
                },
            ],
            policy: "default".into(),
            depth: 0,
            parent_task_id: None,
            created_at: 1,
            deadline_ms: None,
            labels: HashMap::new(),
        };

        let submitted = submit_task_in_root(spec.clone(), &root).unwrap();
        let run_dir = root.join(&submitted.run_id);

        assert_eq!(submitted.task_id, "ts_hub_roles");
        assert!(run_dir.join("spec.json").exists());
        assert!(run_dir.join("plan.json").exists());
        assert!(run_dir.join("result.json").exists());

        let stored_spec: TaskSpec =
            serde_json::from_str(&std::fs::read_to_string(run_dir.join("spec.json")).unwrap())
                .unwrap();
        assert_eq!(stored_spec.roles.len(), 2);

        let plan: Vec<Step> =
            serde_json::from_str(&std::fs::read_to_string(run_dir.join("plan.json")).unwrap())
                .unwrap();
        assert_eq!(plan.len(), 2);
        assert!(matches!(&plan[0].kind, StepKind::Dispatch { agent, .. } if agent == "claude1"));
        assert!(matches!(&plan[1].kind, StepKind::Dispatch { agent, .. } if agent == "codex"));

        let result: RunResult =
            serde_json::from_str(&std::fs::read_to_string(run_dir.join("result.json")).unwrap())
                .unwrap();
        assert!(matches!(result.status, RunStatus::Complete));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hub_can_list_get_and_cancel_submitted_runs() {
        let root =
            std::env::temp_dir().join(format!("jishu_core_query_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let spec = TaskSpec {
            task_id: "ts_query".into(),
            kind: TaskKind::Plan,
            message: "Track me".into(),
            project_path: Some("D:/project".into()),
            agent_hint: None,
            roles: Vec::new(),
            policy: "default".into(),
            depth: 0,
            parent_task_id: None,
            created_at: 1,
            deadline_ms: None,
            labels: HashMap::new(),
        };

        let submitted = submit_task_in_root(spec, &root).unwrap();

        let runs = list_runs_in_root(&root).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, submitted.run_id);
        assert_eq!(runs[0].task_id, "ts_query");

        let record = get_run_in_root(&root, &submitted.run_id).unwrap();
        assert_eq!(record.spec.task_id, "ts_query");
        assert_eq!(record.plan.len(), 1);
        assert!(matches!(record.result.status, RunStatus::Complete));

        let cancelled = cancel_run_in_root(&root, &submitted.run_id).unwrap();
        assert!(matches!(cancelled.status, RunStatus::Aborted));
        let record = get_run_in_root(&root, &submitted.run_id).unwrap();
        assert!(matches!(record.result.status, RunStatus::Aborted));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn role_contract_rework_routes_are_exposed_in_timeline() {
        let root =
            std::env::temp_dir().join(format!("jishu_rework_route_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let spec = TaskSpec {
            task_id: "ts_rework".into(),
            kind: TaskKind::Plan,
            message: "Audit implementation".into(),
            project_path: Some("D:/project".into()),
            agent_hint: None,
            roles: vec![
                spec::RoleAssignment {
                    role_id: "developer".into(),
                    role_name: "Developer".into(),
                    agent_id: "claude2".into(),
                    responsibilities: vec!["Implement the feature".into()],
                    acceptance: vec!["Feature works".into()],
                    can_edit_files: true,
                    can_run_commands: true,
                    can_receive_rework: true,
                },
                spec::RoleAssignment {
                    role_id: "auditor".into(),
                    role_name: "Auditor".into(),
                    agent_id: "codex".into(),
                    responsibilities: vec!["Review [Developer] code quality".into()],
                    acceptance: vec!["Route defects to {[Developer]}".into()],
                    can_edit_files: false,
                    can_run_commands: true,
                    can_receive_rework: false,
                },
            ],
            policy: "default".into(),
            depth: 0,
            parent_task_id: None,
            created_at: 1,
            deadline_ms: None,
            labels: HashMap::new(),
        };

        let submitted = submit_task_in_root(spec, &root).unwrap();
        let record = get_run_in_root(&root, &submitted.run_id).unwrap();

        assert_eq!(record.rework_routes.len(), 1);
        assert_eq!(record.rework_routes[0].from_role_id, "auditor");
        assert_eq!(record.rework_routes[0].target_role_id, "developer");
        assert!(record
            .timeline
            .iter()
            .any(|event| event.kind == "rework_route"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn task_spec_roundtrip() {
        let spec = TaskSpec {
            task_id: "ts_1234_abcd".into(),
            kind: TaskKind::Run,
            message: "Fix the bug".into(),
            project_path: Some("/tmp/proj".into()),
            agent_hint: None,
            roles: Vec::new(),
            policy: "default".into(),
            depth: 0,
            parent_task_id: None,
            created_at: 1700000000,
            deadline_ms: None,
            labels: HashMap::new(),
        };
        let json = serde_json::to_string(&spec).unwrap();
        let de: TaskSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(spec.task_id, de.task_id);
    }

    #[test]
    fn step_kind_tagged_union() {
        let step = Step {
            step_id: "sp_0".into(),
            kind: StepKind::Dispatch {
                agent: "claude-code".into(),
                message: "hello".into(),
                project: "/tmp".into(),
                session: None,
            },
            depends_on: vec![],
            timeout_ms: None,
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"type\":\"dispatch\""));
        let de: Step = serde_json::from_str(&json).unwrap();
        assert_eq!(step.step_id, de.step_id);
    }

    #[test]
    fn evolution_proposal_roundtrip() {
        let p = EvolutionProposal {
            proposal_id: "ep_1234".into(),
            created_at: 1700000000,
            source_task_id: "ts_1234".into(),
            target: "Fix auth".into(),
            kind: proposal::ProposalKind::CodeEdit,
            diff: None,
            rationale: "Security fix".into(),
            risk: proposal::RiskLevel::Low,
            status: proposal::ProposalStatus::Draft,
        };
        let json = serde_json::to_string(&p).unwrap();
        let de: EvolutionProposal = serde_json::from_str(&json).unwrap();
        assert_eq!(p.proposal_id, de.proposal_id);
    }
}
