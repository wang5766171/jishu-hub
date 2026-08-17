use crate::agent;
use crate::llm;

// ── Model test IPC commands ──────────────────────────────────────────────────
// v0.7.4 清理：v0.6 旧版模型库命令（list/add/update/remove/set_active/
// deactivate/set_key/mask，基于 {presets,active} 格式）已删除——前端自
// v0.6.x 起走 get_models_config/set_models_config/get_active/set_active
// （Pi 格式），旧命令若被调用会把 models.json 覆盖回旧格式。

/// 按 Pi 格式 models.json 解析被测模型并连通性测试（解析规则见
/// pi_models_config::to_test_preset）。
#[tauri::command]
pub(crate) async fn test_model(provider: String, id: String) -> Result<serde_json::Value, String> {
    let config = crate::agent::jishu_self::pi_models_config::load()?;
    let provider_cfg = config
        .providers
        .get(&provider)
        .ok_or_else(|| format!("Provider '{provider}' not found"))?;
    let model = provider_cfg
        .models
        .as_ref()
        .and_then(|ms| ms.iter().find(|m| m.id == id))
        .ok_or_else(|| format!("Model '{id}' not found in provider '{provider}'"))?;
    let preset =
        crate::agent::jishu_self::pi_models_config::to_test_preset(&provider, provider_cfg, model)?;
    stream_minimal_chat(&preset).await
}

/// v0.7.4 需求2：草稿态连通性测试。用前端表单当前值构造临时 preset
/// 发一条最小消息，不落盘（区别于 test_model 按渠道+模型测试已保存模型）。
#[tauri::command]
pub(crate) async fn test_llm_connection(
    api: String,
    base_url: String,
    api_key: String,
    model: String,
) -> Result<serde_json::Value, String> {
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("Base URL is required for connection test".to_string());
    }
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("Select at least one model before testing".to_string());
    }
    let preset = llm::config::ModelPreset {
        id: "connection-test".to_string(),
        display_name: "connection test".to_string(),
        protocol: llm::config::protocol_for_pi_api(api.trim())?.to_string(),
        base_url,
        model,
        api_key: if api_key.trim().is_empty() {
            None
        } else {
            Some(api_key.trim().to_string())
        },
        api_key_env: None,
        max_tokens: 64,
        temperature: 0.0,
        supports_tools: false,
        supports_thinking: false,
    };

    let started = std::time::Instant::now();
    let mut result = stream_minimal_chat(&preset).await?;
    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "latency_ms".to_string(),
            serde_json::Value::from(started.elapsed().as_millis() as u64),
        );
    }
    Ok(result)
}

/// Send a one-message minimal chat request and collect the reply text,
/// stop reason and usage. Shared by test_model (saved provider model)
/// and test_llm_connection (ad-hoc draft preset).
async fn stream_minimal_chat(
    preset: &llm::config::ModelPreset,
) -> Result<serde_json::Value, String> {
    llm::http::resolve_api_key(preset).map_err(|e| format!("{e}"))?;

    let provider = llm::create_provider(preset).map_err(|e| e.to_string())?;
    let req = llm::message::LlmRequest {
        model: preset.model.clone(),
        messages: vec![llm::message::LlmMessage {
            role: llm::message::LlmRole::User,
            content: Some("Say hello in one word.".to_string()),
            tool_calls: None,
            tool_call_id: None,
        }],
        tools: vec![],
        stream: true,
        max_tokens: Some(64),
        temperature: Some(0.0),
    };

    let cancel = llm::CancelToken::new();
    let response = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let usage = std::sync::Arc::new(std::sync::Mutex::new(None::<agent::normalized::UsageStats>));

    let resp_clone = response.clone();
    let usage_clone = usage.clone();
    let emitter = Box::new(move |event| match event {
        agent::NormalizedEvent::TextDelta { delta } => {
            if let Ok(mut s) = resp_clone.lock() {
                s.push_str(&delta);
            }
        }
        agent::NormalizedEvent::TurnComplete { usage: Some(u), .. } => {
            if let Ok(mut info) = usage_clone.lock() {
                *info = Some(u);
            }
        }
        _ => {}
    });

    let turn = provider
        .stream_chat(req, emitter, &cancel)
        .await
        .map_err(|e| e.to_string())?;

    let resp_text = response.lock().map_err(|e| e.to_string())?.clone();
    let usage_val = usage.lock().map_err(|e| e.to_string())?.clone();

    Ok(serde_json::json!({
        "response": resp_text,
        "stop_reason": format!("{:?}", turn.stop_reason),
        "usage": usage_val,
    }))
}
