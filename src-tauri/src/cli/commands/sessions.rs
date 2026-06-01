use crate::agent::AgentRegistry;
use crate::cli::args::SessionAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;
use crate::session::ContentBlock;

pub fn run(action: SessionAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        SessionAction::List { project } => list(&project, ctx),
        SessionAction::Show {
            session_id,
            project,
        } => show(&session_id, &project, ctx),
        SessionAction::Delete { session_id } => delete(&session_id, ctx),
    }
}

fn list(project: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let resolver = crate::cli::resolver::Resolver::new();
    let path = resolver.resolve_project_path(project)?;
    let encoded_name = registry.active().encode_project_path(&path.to_string_lossy());

    let sessions = registry
        .active()
        .list_sessions(&encoded_name)
        .map_err(|e| CliError::Internal(e))?;

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        for s in &sessions {
            writer.emit(s)?;
        }
        return Ok(());
    }

    if sessions.is_empty() {
        println!("No sessions found for project: {}", encoded_name);
        return Ok(());
    }

    // Load custom names from hub
    let names = crate::hub::get_session_names().unwrap_or_default();

    println!("{:<40} {:<25} {}", "ID", "DISPLAY NAME", "LAST ACTIVE");
    for s in &sessions {
        let display = s
            .display_name
            .as_deref()
            .or_else(|| names.get(&s.id).map(|n| n.as_str()))
            .unwrap_or("(unnamed)");
        let last_active = s
            .last_active
            .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "N/A".to_string());
        println!("{:<40} {:<25} {}", s.id, truncate_str(display, 25), last_active);
    }
    Ok(())
}

fn show(session_id: &str, project: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let resolver = crate::cli::resolver::Resolver::new();
    let path = resolver.resolve_project_path(project)?;
    let encoded_name = registry.active().encode_project_path(&path.to_string_lossy());

    let messages = registry
        .active()
        .get_session_messages(session_id, &encoded_name)
        .map_err(|e| CliError::Internal(e))?;

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        for msg in &messages {
            writer.emit(msg)?;
        }
        return Ok(());
    }

    if messages.is_empty() {
        println!("No messages in session: {}", session_id);
        return Ok(());
    }

    // Load custom names
    let names = crate::hub::get_session_names().unwrap_or_default();
    if let Some(name) = names.get(session_id) {
        println!("Session: {} ({})", name, session_id);
    } else {
        println!("Session: {}", session_id);
    }
    println!("{}", "-".repeat(60));

    for msg in &messages {
        let role_label = match msg.role.as_str() {
            "user" => "You",
            "assistant" => "Assistant",
            other => other,
        };
        println!("[{}]", role_label);
        for block in &msg.content {
            match block {
                ContentBlock::Text { text } => {
                    println!("{}", text);
                }
                ContentBlock::ToolUse { name, input, .. } => {
                    let input_str = serde_json::to_string(input)
                        .unwrap_or_else(|_| "...".to_string());
                    println!("  [tool: {}] {}", name, truncate_str(&input_str, 200));
                }
                ContentBlock::ToolResult { content, .. } => {
                    let content_str = match content {
                        serde_json::Value::String(s) => s.clone(),
                        other => serde_json::to_string(other)
                            .unwrap_or_else(|_| "...".to_string()),
                    };
                    println!("  [result] {}", truncate_str(&content_str, 200));
                }
                ContentBlock::Thinking { thinking } => {
                    println!("  [thinking] {}", truncate_str(thinking, 200));
                }
            }
        }
        println!();
    }
    Ok(())
}

fn delete(session_id: &str, ctx: &ExecutionContext) -> Result<(), CliError> {
    // We only delete the custom name from hub, not the actual session file.
    // This mirrors the hub's delete_session_name behavior.
    crate::hub::delete_session_name(session_id.to_string())
        .map_err(|e| CliError::Internal(e.to_string()))?;

    if ctx.json {
        let mut writer = crate::cli::jsonl::JsonlWriter::stdout();
        writer.emit(&serde_json::json!({ "deleted": session_id }))?;
    } else {
        println!("Deleted session name: {}", session_id);
    }
    Ok(())
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max - 1).collect();
        format!("{}~", truncated)
    }
}
