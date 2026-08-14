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

    llm::http::resolve_api_key(&preset).map_err(|e| format!("{e}"))?;

    let provider = llm::create_provider(&preset).map_err(|e| e.to_string())?;
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
