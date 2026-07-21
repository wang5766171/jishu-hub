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
