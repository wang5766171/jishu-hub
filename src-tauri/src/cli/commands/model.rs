use crate::cli::args::ModelAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;
use crate::llm::config::{ModelPreset, ModelStore};

pub fn run(action: ModelAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ModelAction::List => list(ctx),
        ModelAction::Add {
            id,
            provider,
            base_url,
            api_key,
        } => add(id, provider, base_url, api_key, ctx),
        ModelAction::Remove { id } => remove(&id),
        ModelAction::Test { id } => test(&id, ctx),
    }
}

fn list(ctx: &ExecutionContext) -> Result<(), CliError> {
    let store = ModelStore::load().map_err(|e| CliError::Internal(e))?;
    if ctx.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&store).map_err(CliError::Serde)?
        );
    } else if store.presets.is_empty() {
        println!("No models configured. Use `jishu model add` to add one.");
    } else {
        for p in &store.presets {
            let marker = if store.active.as_deref() == Some(&p.id) {
                "*"
            } else {
                " "
            };
            println!("{marker} {} ({}) — {}", p.display_name, p.id, p.model);
        }
    }
    Ok(())
}

fn add(
    id: String,
    provider: String,
    base_url: Option<String>,
    _api_key: Option<String>,
    _ctx: &ExecutionContext,
) -> Result<(), CliError> {
    let mut store = ModelStore::load().map_err(|e| CliError::Internal(e))?;
    let protocol = provider.to_lowercase();
    let base_url = base_url.unwrap_or_else(|| match protocol.as_str() {
        "openai" => "https://api.openai.com/v1".to_string(),
        "anthropic" => "https://api.anthropic.com".to_string(),
        _ => "https://api.example.com/v1".to_string(),
    });
    let api_key_env = format!(
        "JISHU_MODEL_{}_KEY",
        id.to_uppercase().replace('-', "_")
    );

    let preset = ModelPreset {
        id: id.clone(),
        display_name: id.clone(),
        protocol,
        base_url,
        model: id.clone(),
        api_key_env,
        max_tokens: 4096,
        temperature: 0.7,
        supports_tools: true,
        supports_thinking: false,
    };
    store.add(preset).map_err(|e| CliError::Internal(e))?;
    println!("Model '{id}' added.");
    Ok(())
}

fn remove(id: &str) -> Result<(), CliError> {
    let mut store = ModelStore::load().map_err(|e| CliError::Internal(e))?;
    store.remove(id).map_err(|e| CliError::Internal(e))?;
    println!("Model '{id}' removed.");
    Ok(())
}

fn test(id: &str, _ctx: &ExecutionContext) -> Result<(), CliError> {
    let store = ModelStore::load().map_err(|e| CliError::Internal(e))?;
    let preset = store
        .presets
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| CliError::NotFound(format!("Model '{id}' not found")))?;
    println!(
        "Testing model '{}' ({})...",
        preset.display_name, preset.model
    );
    // Actual HTTP test is deferred to when reqwest is integrated
    println!("Model test is not yet implemented (requires HTTP client).");
    Ok(())
}
