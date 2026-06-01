use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
struct CheckResult {
    name: &'static str,
    pass: bool,
    detail: Option<String>,
}

pub fn run(fix: bool, format: &str, only: Option<&str>, ctx: &ExecutionContext) -> Result<(), CliError> {
    let mut checks = vec![
        check_hub_dir(fix)?,
        check_agents(),
        check_config(),
    ];

    if let Some(filter) = only {
        checks.retain(|c| c.name == filter);
    }

    let all_pass = checks.iter().all(|c| c.pass);

    match format {
        "json" => {
            println!("{}", serde_json::to_string_pretty(&checks).map_err(CliError::Serde)?);
        }
        _ => {
            for c in &checks {
                let icon = if c.pass { "✓" } else { "✗" };
                if let Some(ref detail) = c.detail {
                    println!(" {icon} {}: {detail}", c.name);
                } else {
                    println!(" {icon} {}", c.name);
                }
            }
            if !all_pass && !ctx.json {
                println!("\nRun with --fix to attempt automatic repairs.");
            }
        }
    }

    if all_pass {
        Ok(())
    } else {
        Err(CliError::Internal("Some checks failed".to_string()))
    }
}

fn check_hub_dir(fix: bool) -> Result<CheckResult, CliError> {
    let home = dirs::home_dir()
        .ok_or_else(|| CliError::Internal("Cannot find home directory".to_string()))?;
    let hub_dir = home.join(".jishu-hub");

    if hub_dir.exists() {
        Ok(CheckResult { name: "paths.hub_dir", pass: true, detail: None })
    } else if fix {
        std::fs::create_dir_all(&hub_dir).map_err(CliError::Io)?;
        Ok(CheckResult {
            name: "paths.hub_dir",
            pass: true,
            detail: Some("created".to_string()),
        })
    } else {
        Ok(CheckResult {
            name: "paths.hub_dir",
            pass: false,
            detail: Some(format!("{} does not exist", hub_dir.display())),
        })
    }
}

fn check_agents() -> CheckResult {
    use crate::agent::AgentRegistry;
    let registry = AgentRegistry::new();
    let agents = registry.list_agents();
    if agents.is_empty() {
        return CheckResult {
            name: "agents.registered",
            pass: false,
            detail: Some("No agents registered".to_string()),
        };
    }
    CheckResult {
        name: "agents.registered",
        pass: true,
        detail: Some(format!("{} agent(s) available", agents.len())),
    }
}

fn check_config() -> CheckResult {
    match crate::config::config_path() {
        Ok(path) => {
            if path.exists() {
                match crate::config::load_config() {
                    Ok(_) => CheckResult { name: "config.file", pass: true, detail: None },
                    Err(e) => CheckResult {
                        name: "config.file",
                        pass: false,
                        detail: Some(format!("Parse error: {e}")),
                    },
                }
            } else {
                CheckResult {
                    name: "config.file",
                    pass: true,
                    detail: Some("not found (will use defaults)".to_string()),
                }
            }
        }
        Err(e) => CheckResult {
            name: "config.file",
            pass: false,
            detail: Some(format!("Cannot resolve config path: {e}")),
        },
    }
}
