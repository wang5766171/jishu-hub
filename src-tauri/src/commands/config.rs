use std::sync::Mutex;

use crate::config;
use crate::history;
use crate::{agent, AppState};

#[tauri::command]
pub(crate) fn load_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    // Each adapter owns its typed config surface. The frontend decides
    // which command to call from AgentStatus.config_surface.
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.require_agent(&agent_id)?.load_config()
}

/// v0.8.0 需求3：模型选择聚合——models.json 的 thinkingLevelMap/reasoning
/// 解析唯一化在后端，前端（会话页 picker/模型表单/行为页）消费聚合结果。
/// 仅 model-store surface 支持（能力路由，不出现 agentId 分支）。
#[tauri::command]
pub(crate) fn get_model_picker_options(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Vec<agent::jishu_self::model_picker::ModelPickerOption>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    let store = agent
        .as_model_store()
        .ok_or("Agent does not support model store")?;
    let config = store.load_model_store()?;
    Ok(agent::jishu_self::model_picker::picker_options_from_config(&config))
}

/// Read the agent's model store config (routes through adapter).
#[tauri::command]
pub(crate) fn get_models_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    let store = agent
        .as_model_store()
        .ok_or("Agent does not support model store")?;
    store.load_model_store()
}

/// Write the agent's model store config (routes through adapter).
#[tauri::command]
pub(crate) fn set_models_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    config: serde_json::Value,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    let store = agent
        .as_model_store()
        .ok_or("Agent does not support model store")?;
    store.save_model_store(&config)
}

/// Read the agent's active model selection (routes through adapter).
#[tauri::command]
pub(crate) fn get_active(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    let store = agent
        .as_model_store()
        .ok_or("Agent does not support model store")?;
    store.get_active_model()
}

/// Persist the active model selection (routes through adapter).
#[tauri::command]
pub(crate) fn set_active(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    active: Option<serde_json::Value>,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    let store = agent
        .as_model_store()
        .ok_or("Agent does not support model store")?;
    store.set_active_model(active.as_ref())
}

#[derive(serde::Serialize)]
pub(crate) struct RawConfigInfo {
    content: String,
    format: String,
}

#[tauri::command]
pub(crate) fn load_raw_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<RawConfigInfo, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    let raw = agent
        .as_raw_config()
        .ok_or("Agent does not support raw config")?;
    let format = raw
        .config_format()
        .unwrap_or_else(|| "unknown".to_string());
    let content = raw.load_raw_config()?;
    Ok(RawConfigInfo { content, format })
}

#[tauri::command]
pub(crate) fn save_raw_config(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    content: String,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .as_raw_config()
        .ok_or("Agent does not support raw config")?
        .save_raw_config(&content)
}

#[tauri::command]
pub(crate) async fn load_history(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Vec<history::HistoryEntry>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    Ok(s.registry.require_agent(&agent_id)?.load_history())
}

#[tauri::command]
pub(crate) async fn save_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    config: serde_json::Value,
) -> Result<(), String> {
    {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        s.registry.require_agent(&agent_id)?.save_config(&config)?;
    }

    // v0.8.0 需求9 收尾：保存含 compaction 键时，向该 agent 的活跃会话热推
    // 出现的字段（运行中的 pi 进程不重读配置文件，阈值改动须经 RPC 下发才
    // 能对进行中的会话生效）。两字段均可选，只推送保存值里出现的字段。
    if let Some(compaction) = config.get("compaction").and_then(|v| v.as_object()) {
        let enabled = compaction.get("enabled").and_then(|v| v.as_bool());
        let threshold_percent = compaction
            .get("thresholdPercent")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        if enabled.is_some() || threshold_percent.is_some() {
            for acp in crate::chat::live_acp_controls_for_agent(&app, &agent_id) {
                let _ = acp
                    .set_auto_compaction(enabled, threshold_percent)
                    .await;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn list_backups(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
) -> Result<Vec<config::BackupEntry>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .as_backup_store()
        .ok_or("Agent does not support config backups")?
        .list_backups()
}

#[tauri::command]
pub(crate) fn restore_backup(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    backup_path: String,
) -> Result<(), String> {
    {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let store = s.registry
            .require_agent(&agent_id)?
            .as_backup_store()
            .ok_or("Agent does not support config backups")?;
        let backups = store.list_backups()?;
        let valid = backups.iter().any(|b| b.path == backup_path);
        if !valid {
            return Err("Backup path not found in backup list".to_string());
        }
    }
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .as_backup_store()
        .ok_or("Agent does not support config backups")?
        .restore_backup(&backup_path)
}
