use crate::cli::args::TaskAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: TaskAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        TaskAction::Add { plan, description } => {
            println!("Added task to plan {plan}: {description}");
            Ok(())
        }
        TaskAction::Update { task_id, status } => {
            println!("Updated task {task_id} to status: {status}");
            Ok(())
        }
        TaskAction::List { plan_id } => {
            let home =
                dirs::home_dir().ok_or_else(|| CliError::Internal("No home dir".to_string()))?;
            let result_path = home
                .join(".jishu-hub")
                .join("runs")
                .join(&plan_id)
                .join("result.json");
            if result_path.exists() {
                let content = std::fs::read_to_string(&result_path).map_err(CliError::Io)?;
                println!("{content}");
            } else if ctx.json {
                println!("[]");
            } else {
                println!("No tasks found for plan: {plan_id}");
            }
            Ok(())
        }
        TaskAction::Advance {
            task_id,
            phase,
            project,
            requirement,
            session,
        } => run_advance(
            &task_id,
            &phase,
            &project,
            requirement.as_deref(),
            session.as_deref(),
            ctx,
        ),
        TaskAction::Find { session, project } => run_find(&session, &project, ctx),
    }
}

/// Find a task instance by session ID.
fn run_find(session: &str, project: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let project_root = std::path::absolute(project)
        .map_err(|e| CliError::Internal(format!("Cannot resolve project path: {e}")))?
        .to_string_lossy()
        .to_string();

    match crate::task_launch::find_by_session(&project_root, session) {
        Ok(Some(instance)) => {
            if ctx.json {
                println!("{}", serde_json::to_string(&instance).unwrap_or_default());
            } else {
                println!("task_id: {}", instance.task_id);
                println!("status: {}", instance.status);
                println!("phase: {}", instance.current_phase);
            }
            Ok(())
        }
        Ok(None) => {
            if ctx.json {
                println!("null");
            } else {
                println!("No task found for session: {session}");
            }
            Ok(())
        }
        Err(e) => Err(CliError::Internal(e)),
    }
}

/// Execute task phase advancement.
///
/// Calls `task_launch::advance_phase` (shared library, same SQLite file as Hub GUI).
/// Outputs the result as JSON-lines (if --json) or human-readable text.
/// For requirements→planning, the planning instruction is included so the Hub
/// frontend can use it to start the new planning session after user confirmation.
fn run_advance(
    task_id: &str,
    phase: &str,
    project: &str,
    requirement: Option<&str>,
    session: Option<&str>,
    ctx: &ExecutionContext,
) -> Result<(), CliError> {
    // Resolve project path to absolute.
    let project_root = std::path::absolute(project)
        .map_err(|e| CliError::Internal(format!("Cannot resolve project path: {e}")))?
        .to_string_lossy()
        .to_string();

    // For planning phase, requirement markdown is required.
    let requirement_markdown = if phase == "planning" {
        let raw = requirement.ok_or_else(|| {
            CliError::Internal("--requirement is required for planning phase".to_string())
        })?;
        // Support "-" to read from stdin.
        if raw == "-" {
            use std::io::Read;
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| CliError::Io(e))?;
            Some(buf)
        } else {
            Some(raw.to_string())
        }
    } else {
        None
    };

    let request = crate::task_launch::AdvancePhaseRequest {
        task_id: task_id.to_string(),
        phase: phase.to_string(),
        requirement_markdown,
        requirement_session_id: session.map(|s| s.to_string()),
    };

    let result = crate::task_launch::advance_phase(&project_root, request)
        .map_err(|e| CliError::Internal(e))?;

    if ctx.json {
        // Output as JSON-lines so the Hub frontend can parse it.
        let json = serde_json::json!({
            "instance": result.instance,
            "planning_instruction": result.planning_instruction,
        });
        println!("{json}");
    } else {
        println!("Task {} advanced to phase: {}", task_id, phase);
        println!("Status: {}", result.instance.status);
        if let Some(ref instruction) = result.planning_instruction {
            println!("\n--- planning_instruction ---\n{instruction}");
        }
    }

    Ok(())
}
