use crate::agent::jishu_self::jishu_settings;
use crate::agent::jishu_self::pi_models_config;
use crate::cli::args::ModelAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;
use crate::llm::http;
use crate::llm::message::{LlmMessage, LlmRequest, LlmRole};
use crate::llm::{create_provider, CancelToken};
use std::sync::{Arc, Mutex};

// v0.7.4 清理：CLI 模型命令改读 Pi 格式 models.json（{providers:{...}}）。
// v0.6 旧版 ModelStore（presets/active）解析器已删除。

pub fn run(action: ModelAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    match action {
        ModelAction::List => list(ctx),
        ModelAction::Test { target } => test(&target, ctx),
    }
}

fn list(ctx: &ExecutionContext) -> Result<(), CliError> {
    let config = pi_models_config::load().map_err(CliError::Internal)?;
    let active = jishu_settings::get_active()
        .map_err(|e| CliError::Internal(format!("Cannot read active model: {e}")))?;

    if ctx.json {
        let mut value = serde_json::to_value(&config).map_err(CliError::Serde)?;
        // 密钥不落 CLI 输出。
        if let Some(providers) = value.get_mut("providers").and_then(|p| p.as_object_mut()) {
            for provider in providers.values_mut() {
                if let Some(obj) = provider.as_object_mut() {
                    if obj.get("apiKey").and_then(|k| k.as_str()).is_some() {
                        obj.insert("apiKey".to_string(), serde_json::json!("***"));
                    }
                }
            }
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(CliError::Serde)?
        );
        return Ok(());
    }

    if config.providers.is_empty() {
        println!("No models configured. Configure one in the jishu-hub GUI.");
        return Ok(());
    }
    for (key, provider) in &config.providers {
        let display = provider.name.as_deref().unwrap_or("");
        let label = if display.is_empty() {
            key.clone()
        } else {
            format!("{display} ({key})")
        };
        println!("[{label}] {}", provider.base_url.as_deref().unwrap_or("-"));
        for model in provider.models.iter().flatten() {
            let marker = if active
                .as_ref()
                .map(|a| a.provider == *key && a.model == model.id)
                .unwrap_or(false)
            {
                "*"
            } else {
                " "
            };
            println!("  {marker} {} — {}", model.id, model.name);
        }
    }
    Ok(())
}

fn test(target: &str, _ctx: &ExecutionContext) -> Result<(), CliError> {
    let (provider, id) = target.split_once('/').ok_or_else(|| {
        CliError::InvalidArg(format!(
            "expected <provider>/<model>, e.g. zhipu/glm-5.3 (see `list`)"
        ))
    })?;
    let config = pi_models_config::load().map_err(CliError::Internal)?;
    let provider_cfg = config.providers.get(provider).ok_or_else(|| {
        CliError::NotFound(format!("Provider '{provider}' not found (see `list`)"))
    })?;
    let model = provider_cfg
        .models
        .as_ref()
        .and_then(|ms| ms.iter().find(|m| m.id == id))
        .ok_or_else(|| {
            CliError::NotFound(format!("Model '{id}' not found in provider '{provider}'"))
        })?;
    let preset = pi_models_config::to_test_preset(provider, provider_cfg, model)
        .map_err(CliError::Internal)?;

    println!(
        "Testing model '{}' ({})...",
        preset.display_name, preset.model
    );
    let api_key = http::resolve_api_key(&preset).map_err(|e| CliError::Internal(e.to_string()))?;
    println!("API key resolved.");

    let rt = tokio::runtime::Runtime::new().map_err(|e| CliError::Internal(e.to_string()))?;
    rt.block_on(async_test(&preset, &api_key))
}

async fn async_test(
    preset: &crate::llm::config::ModelPreset,
    _api_key: &str,
) -> Result<(), CliError> {
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
