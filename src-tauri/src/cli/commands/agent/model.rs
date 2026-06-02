use crate::cli::args::ModelAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;
use crate::llm::config::{ModelPreset, ModelStore};
use crate::llm::http;
use crate::llm::message::{LlmMessage, LlmRequest, LlmRole};
use crate::llm::{create_provider, CancelToken};
use std::sync::{Arc, Mutex};

pub fn run(action: ModelAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ModelAction::List => list(ctx),
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
        println!("No models configured. Configure one in the jishu-hub GUI.");
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

fn test(id: &str, _ctx: &ExecutionContext) -> Result<(), CliError> {
    let store = ModelStore::load().map_err(|e| CliError::Internal(e))?;
    let preset = store
        .presets
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| CliError::NotFound(format!("Model '{id}' not found")))?
        .clone();

    println!("Testing model '{}' ({})...", preset.display_name, preset.model);

    let api_key = http::resolve_api_key(&preset).map_err(|e| CliError::Internal(e.to_string()))?;
    println!("API key resolved.");

    let rt = tokio::runtime::Runtime::new().map_err(|e| CliError::Internal(e.to_string()))?;
    rt.block_on(async_test(&preset, &api_key))
}

async fn async_test(preset: &ModelPreset, _api_key: &str) -> Result<(), CliError> {
    let provider = create_provider(preset).map_err(CliError::Internal)?;
    let req = LlmRequest {
        model: preset.model.clone(),
        messages: vec![LlmMessage {
            role: LlmRole::User,
            content: Some("Say hello in one word.".to_string()),
            tool_calls: None,
            tool_call_id: None,
        }],
        tools: vec![],
        stream: true,
        max_tokens: Some(64),
        temperature: Some(0.0),
    };

    let cancel = CancelToken::new();
    let response_text: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let usage_info: Arc<Mutex<Option<crate::agent::normalized::UsageStats>>> =
        Arc::new(Mutex::new(None));

    let emitter_response = response_text.clone();
    let emitter_usage = usage_info.clone();
    let emitter = Box::new(move |event| match event {
        crate::agent::NormalizedEvent::TextDelta { delta } => {
            print!("{delta}");
            if let Ok(mut s) = emitter_response.lock() {
                s.push_str(&delta);
            }
        }
        crate::agent::NormalizedEvent::Thinking { delta } => {
            print!("[think: {delta}]");
        }
        crate::agent::NormalizedEvent::TurnComplete { usage, .. } => {
            if let Some(u) = usage {
                if let Ok(mut info) = emitter_usage.lock() {
                    *info = Some(u);
                }
            }
        }
        _ => {}
    });

    let result = provider.stream_chat(req, emitter, &cancel);

    match result.await {
        Ok(_turn) => {
            println!();
            println!("Model test passed.");
            if let Ok(guard) = usage_info.lock() {
                if let Some(usage) = guard.as_ref() {
                    if let Some(input) = usage.input_tokens {
                        println!("  Input tokens: {input}");
                    }
                    if let Some(output) = usage.output_tokens {
                        println!("  Output tokens: {output}");
                    }
                }
            }
            Ok(())
        }
        Err(e) => {
            println!();
            Err(CliError::Internal(format!("Model test failed: {e}")))
        }
    }
}
