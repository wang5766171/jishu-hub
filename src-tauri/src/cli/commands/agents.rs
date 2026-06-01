use crate::agent::{AgentRegistry, AgentStatus};
use crate::cli::args::AgentAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: AgentAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        AgentAction::List => list(ctx),
        AgentAction::Health { agent } => health(agent.as_deref(), ctx),
        AgentAction::Probe { agent } => probe(&agent, ctx),
    }
}

fn list(ctx: &ExecutionContext) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let active_id = registry.active_id().to_string();
    let agents = registry.list_agents();

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        for agent in &agents {
            let mut entry = serde_json::to_value(agent)?;
            let map = entry.as_object_mut().expect("AgentInfo serializes to object");
            map.insert(
                "active".into(),
                serde_json::Value::Bool(agent.id == active_id),
            );
            writer.emit(&entry)?;
        }
        return Ok(());
    }

    // Human-readable table
    for agent in &agents {
        let marker = if agent.id == active_id { "*" } else { " " };
        println!(
            "{} {:<20} ({})  v{}",
            marker, agent.display_name, agent.id, agent.version
        );
    }
    Ok(())
}

fn health(agent_id: Option<&str>, ctx: &ExecutionContext) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let statuses = registry.list_agent_statuses();

    let filtered: Vec<&AgentStatus> = if let Some(id) = agent_id {
        statuses
            .iter()
            .filter(|s| s.id == id)
            .collect::<Vec<_>>()
    } else {
        statuses.iter().collect()
    };

    if filtered.is_empty() {
        if let Some(id) = agent_id {
            return Err(CliError::NotFound(format!("agent not found: {}", id)));
        }
    }

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        for status in &filtered {
            writer.emit(status)?;
        }
        return Ok(());
    }

    for status in &filtered {
        let health = &status.health;
        let installed_icon = if health.installed { "OK" } else { "--" };
        println!(
            "{:<15} {}  {}  v{}",
            status.id,
            installed_icon,
            status.display_name,
            health.version.as_deref().unwrap_or("N/A"),
        );
        if let Some(err) = &health.error {
            println!("  error: {}", err);
        }
        if let Some(path) = &health.binary_path {
            println!("  binary: {}", path);
        }
    }
    Ok(())
}

fn probe(agent_id: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let agents = registry.agents_info();

    let target = agents
        .iter()
        .find(|(id, _)| id == agent_id)
        .ok_or_else(|| CliError::NotFound(format!("agent not found: {}", agent_id)))?;

    let health = target.1.probe_sync();

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        writer.emit(&health)?;
        return Ok(());
    }

    let installed = if health.installed { "yes" } else { "no" };
    println!("agent:  {}", agent_id);
    println!("installed: {}", installed);
    if let Some(v) = &health.version {
        println!("version:   {}", v);
    }
    if let Some(p) = &health.binary_path {
        println!("binary:    {}", p);
    }
    if let Some(e) = &health.error {
        println!("error:     {}", e);
    }
    Ok(())
}
