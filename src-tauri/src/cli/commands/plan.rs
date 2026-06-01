use crate::cli::args::PlanAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: PlanAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        PlanAction::Create { name, description } => {
            println!("Created plan: {name}");
            if let Some(desc) = description {
                println!("  Description: {desc}");
            }
            Ok(())
        }
        PlanAction::List => {
            let home =
                dirs::home_dir().ok_or_else(|| CliError::Internal("No home dir".to_string()))?;
            let runs_dir = home.join(".jishu-hub").join("runs");
            if !runs_dir.exists() {
                if ctx.json {
                    println!("[]");
                } else {
                    println!("No runs found.");
                }
                return Ok(());
            }
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(&runs_dir).map_err(CliError::Io)? {
                let entry = entry.map_err(CliError::Io)?;
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let plan_path = entry.path().join("plan.json");
                    if plan_path.exists() {
                        entries.push(entry.file_name().to_string_lossy().to_string());
                    }
                }
            }
            if ctx.json {
                println!(
                    "{}",
                    serde_json::to_string(&entries).map_err(CliError::Serde)?
                );
            } else {
                for e in &entries {
                    println!("{e}");
                }
            }
            Ok(())
        }
        PlanAction::Show { plan_id } => {
            let home =
                dirs::home_dir().ok_or_else(|| CliError::Internal("No home dir".to_string()))?;
            let plan_path = home
                .join(".jishu-hub")
                .join("runs")
                .join(&plan_id)
                .join("plan.json");
            if !plan_path.exists() {
                return Err(CliError::NotFound(format!("Plan not found: {plan_id}")));
            }
            let content = std::fs::read_to_string(&plan_path).map_err(CliError::Io)?;
            println!("{content}");
            Ok(())
        }
        PlanAction::Delete { plan_id } => {
            let home =
                dirs::home_dir().ok_or_else(|| CliError::Internal("No home dir".to_string()))?;
            let run_dir = home.join(".jishu-hub").join("runs").join(&plan_id);
            if run_dir.exists() {
                std::fs::remove_dir_all(&run_dir).map_err(CliError::Io)?;
                println!("Deleted run: {plan_id}");
            } else {
                return Err(CliError::NotFound(format!("Run not found: {plan_id}")));
            }
            Ok(())
        }
    }
}
