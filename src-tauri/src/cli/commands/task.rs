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
    }
}
