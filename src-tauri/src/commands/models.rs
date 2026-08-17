use crate::agent;
use crate::llm;

// 鈹€鈹€ Model management IPC commands 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

#[tauri::command]
pub(crate) fn list_models() -> Result<serde_json::Value, String> {
    let store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let mut val = serde_json::to_value(store).map_err(|e| e.to_string())?;
    // Mask api_key before sending to frontend 鈥?plaintext never leaves the backend
    if let Some(presets) = val.get_mut("presets").and_then(|p| p.as_array_mut()) {
        for preset in presets {
            if let Some(key) = preset.get("api_key").and_then(|k| k.as_str()) {
                if !key.is_empty() {
                    preset["api_key"] = serde_json::Value::String(llm::http::mask_key(key));
                }
            }
        }
    }
    Ok(val)
}

#[tauri::command]
pub(crate) fn add_model(preset: serde_json::Value) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let preset: llm::config::ModelPreset =
        serde_json::from_value(preset).map_err(|e| e.to_string())?;
    store.add(preset).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn update_model(id: String, preset: serde_json::Value) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let preset: llm::config::ModelPreset =
        serde_json::from_value(preset).map_err(|e| e.to_string())?;
    store.update(&id, preset).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn remove_model(id: String) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    store.remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn set_active_model(id: String) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    store.set_active(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn deactivate_model() -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    store.clear_active().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn test_model(id: String) -> Result<serde_json::Value, String> {
    let store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let preset = store
        .presets
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Model '{id}' not found"))?
        .clone();

    stream_minimal_chat(&preset).await
}

/// Map a pi-style provider `api` value to the internal llm protocol id.
/// Only the two protocols the internal llm client implements are testable.
fn llm_protocol_for_api(api: &str) -> Result<&'static str, String> {
    match api {
        "anthropic-messages" => Ok("anthropic"),
        "openai-completions" | "openai-responses" => Ok("openai"),
        other => Err(format!(
            "Connection test does not support protocol '{other}'"
        )),
    }
}

/// v0.7.4 需求2：草稿态连通性测试。用前端表单当前值构造临时 preset
/// 发一条最小消息，不落盘（区别于 test_model 按 id 测试已保存模型）。
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
        protocol: llm_protocol_for_api(api.trim())?.to_string(),
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
/// stop reason and usage. Shared by test_model (saved preset) and
/// test_llm_connection (ad-hoc draft preset).
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

#[tauri::command]
pub(crate) fn set_model_key(id: String, key: String) -> Result<(), String> {
    let mut store = llm::config::ModelStore::load().map_err(|e| e.to_string())?;
    let preset = store
        .presets
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Model '{id}' not found"))?;
    preset.api_key = if key.is_empty() { None } else { Some(key) };
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn mask_model_key(key: String) -> String {
    llm::http::mask_key(&key)
}
