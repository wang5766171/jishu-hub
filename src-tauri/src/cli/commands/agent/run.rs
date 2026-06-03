use crate::agent::normalized::{NormalizedEvent, TaskStepKind};
use crate::agent::AgentRegistry;
use crate::cli::error::CliError;
use crate::cli::jsonl::JsonlWriter;
use crate::cli::output::ExecutionContext;
use crate::orchestrator::dispatcher::{DefaultDispatcher, DispatchContext, Dispatcher};
use crate::orchestrator::planner;
use crate::orchestrator::result::{RunResult, RunStatus, StepOutcome, UsageSummary};
use crate::orchestrator::spec::{TaskKind, TaskSpec};
use crate::orchestrator::trace::TraceRecorder;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn run(
    prompt: &str,
    agent: Option<&str>,
    project: &str,
    ctx: &ExecutionContext,
) -> Result<(), CliError> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let spec = TaskSpec {
        task_id: format!("ts_{now_ms}_run"),
        kind: TaskKind::Run,
        message: prompt.to_string(),
        project_path: Some(project.to_string()),
        agent_hint: agent.map(|s| s.to_string()),
        roles: Vec::new(),
        policy: "default".to_string(),
        depth: 0,
        parent_task_id: None,
        created_at: now_ms,
        deadline_ms: None,
        labels: HashMap::new(),
    };

    let run_id = format!("r_{now_ms}_run");
    let trace = TraceRecorder::create(&run_id).map_err(|e| CliError::Internal(e.to_string()))?;
    trace
        .write_spec(&spec)
        .map_err(|e| CliError::Internal(e.to_string()))?;

    let registry = Arc::new(AgentRegistry::new());
    let plan_ctx = planner::PlanContext {
        registry: registry.clone(),
        previous_active_agent: None,
    };

    let p = planner::create_planner(&spec.policy);
    let steps = p
        .plan(&spec, &plan_ctx)
        .map_err(|e| CliError::Orchestrator(e.to_string()))?;
    trace
        .write_plan(&steps)
        .map_err(|e| CliError::Internal(e.to_string()))?;

    // Emit plan event
    let mut writer = JsonlWriter::stdout();
    emit_step(
        &mut writer,
        &run_id,
        "sp_plan",
        TaskStepKind::Plan,
        "Plan generated",
    )?;

    // Execute steps
    let dispatcher = DefaultDispatcher::new();
    let mut step_outcomes = Vec::new();

    for step in &steps {
        emit_step(
            &mut writer,
            &run_id,
            &step.step_id,
            TaskStepKind::Dispatch,
            &format!("Executing step {}", step.step_id),
        )?;

        let mut emitter = |ev: &NormalizedEvent| {
            writer.emit(ev).ok();
            trace.append_event(ev).ok();
        };

        let mut dctx = DispatchContext {
            registry: registry.clone(),
            run_id: &run_id,
            task_id: &spec.task_id,
            trace: &trace,
            emitter: &mut emitter,
        };

        match dispatcher.execute(step, &mut dctx) {
            Ok(outcome) => {
                emit_step(
                    &mut writer,
                    &run_id,
                    &step.step_id,
                    TaskStepKind::Done,
                    &format!("Step {} complete", step.step_id),
                )?;
                step_outcomes.push(outcome);
            }
            Err(e) => {
                emit_step(
                    &mut writer,
                    &run_id,
                    &step.step_id,
                    TaskStepKind::Failed,
                    &format!("Step {} failed: {e}", step.step_id),
                )?;
                step_outcomes.push(StepOutcome {
                    step_id: step.step_id.clone(),
                    agent_id: "unknown".to_string(),
                    status: "error".to_string(),
                    output: Some(serde_json::json!({ "error": e.to_string() })),
                });
            }
        }
    }

    // Write result
    let result = RunResult {
        run_id: run_id.clone(),
        task_id: spec.task_id.clone(),
        status: RunStatus::Complete,
        started_at: now_ms,
        finished_at: Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        ),
        steps: step_outcomes,
        usage: UsageSummary::default(),
        error: None,
    };
    trace
        .write_result(&result)
        .map_err(|e| CliError::Internal(e.to_string()))?;

    if !ctx.json {
        println!("Run {} completed.", run_id);
    }

    Ok(())
}

fn emit_step(
    writer: &mut JsonlWriter,
    run_id: &str,
    step_id: &str,
    kind: TaskStepKind,
    title: &str,
) -> Result<(), CliError> {
    writer
        .emit(&NormalizedEvent::TaskStep {
            run_id: run_id.to_string(),
            step_id: step_id.to_string(),
            kind,
            title: title.to_string(),
            detail: None,
        })
        .map_err(|e| CliError::Internal(e.to_string()))
}
