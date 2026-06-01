use crate::agent::AgentRegistry;
use crate::cli::args::ProjectAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: ProjectAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ProjectAction::List => list(ctx),
        ProjectAction::Add { path } => add(&path, ctx),
        ProjectAction::Remove { project } => remove(&project, ctx),
        ProjectAction::Info { project } => info(&project, ctx),
    }
}

fn list(ctx: &ExecutionContext) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let projects = registry.scan_projects();

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        for p in &projects {
            writer.emit(p)?;
        }
        return Ok(());
    }

    if projects.is_empty() {
        println!("No projects found.");
        return Ok(());
    }

    // Header
    println!("{:<30} {:<6} {}", "NAME", "SESSIONS", "PATH");
    for p in &projects {
        println!(
            "{:<30} {:<6} {}",
            truncate_str(&p.name, 30),
            p.session_count,
            p.path.display(),
        );
    }
    Ok(())
}

fn add(path: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let path = resolve_project_path(path)?;
    let path_str = path.to_string_lossy().to_string();

    if !path.is_dir() {
        return Err(CliError::InvalidArg(format!(
            "path does not exist or is not a directory: {}",
            path_str
        )));
    }

    let registry = AgentRegistry::new();
    let result = registry
        .active()
        .add_project(&path_str)
        .ok_or_else(|| CliError::NotFound(format!("no .claude directory found at: {}", path_str)))?;

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        writer.emit(&result)?;
    } else {
        println!("Added project: {} ({})", result.name, result.path.display());
    }
    Ok(())
}

fn remove(project: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    // `project` can be either an encoded name or a path; try to encode it.
    let registry = AgentRegistry::new();
    let encoded = if is_encoded_name(project) {
        project.to_string()
    } else {
        let path = resolve_project_path(project)?;
        registry.active().encode_project_path(&path.to_string_lossy())
    };

    crate::hub::hide_project(&encoded)
        .map_err(|e| CliError::Internal(e.to_string()))?;

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        writer.emit(&serde_json::json!({ "removed": encoded }))?;
    } else {
        println!("Removed project: {}", encoded);
    }
    Ok(())
}

fn info(project: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let projects = registry.scan_projects();

    // Match by encoded name or by path
    let found = projects.iter().find(|p| {
        p.encoded_name == project
            || p.path.to_string_lossy() == project
            || p.name == project
    });

    let p = found.ok_or_else(|| CliError::NotFound(format!("project not found: {}", project)))?;

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        writer.emit(p)?;
        return Ok(());
    }

    println!("name:          {}", p.name);
    println!("path:          {}", p.path.display());
    println!("encoded_name:  {}", p.encoded_name);
    println!("session_count: {}", p.session_count);
    println!("last_active:   {}", p.last_active.as_deref().unwrap_or("N/A"));
    println!("has_claude_md: {}", p.has_claude_md);
    println!("agents:        {}", p.agent_ids.join(", "));
    println!("initialized:   {}", p.initialized);
    Ok(())
}

/// Resolve a user-supplied path string. If it is ".", resolve to cwd.
fn resolve_project_path(input: &str) -> Result<std::path::PathBuf, CliError> {
    let resolver = crate::cli::resolver::Resolver::new();
    resolver.resolve_project_path(input)
}

/// Heuristic: if the input contains "--" (drive separator) and no backslashes,
/// treat it as an already-encoded name.
fn is_encoded_name(s: &str) -> bool {
    s.contains("--") && !s.contains('\\') && !s.contains('/')
}

/// Truncate a string for table display.
fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max - 1).collect();
        format!("{}~", truncated)
    }
}
