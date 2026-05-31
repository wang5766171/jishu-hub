use tauri_plugin_dialog::DialogExt;

const USER_CANCELLED: &str = "USER_CANCELLED";

#[tauri::command]
pub fn export_config_dialog(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Mutex<crate::AppState>>,
) -> Result<(), String> {
    let agent_id = {
        let s = state.lock().map_err(|_| "App state lock poisoned".to_string())?;
        s.registry.active_id().to_string()
    };

    let default_name = format!("{}-settings.json", agent_id);
    let path = app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(&default_name)
        .blocking_save_file()
        .ok_or_else(|| USER_CANCELLED.to_string())?;

    let path_str = path.as_path()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string_lossy()
        .to_string();

    let s = state.lock().map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().export_config(&path_str)
}

#[tauri::command]
pub fn import_config_dialog(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Mutex<crate::AppState>>,
) -> Result<(), String> {
    let path = app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
        .ok_or_else(|| USER_CANCELLED.to_string())?;

    let path_str = path.as_path()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string_lossy()
        .to_string();

    let s = state.lock().map_err(|_| "App state lock poisoned".to_string())?;
    s.registry.active().import_config(&path_str)?;
    Ok(())
}

#[tauri::command]
pub fn export_raw_config_dialog(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Mutex<crate::AppState>>,
) -> Result<(), String> {
    let (content, format) = {
        let s = state.lock().map_err(|_| "App state lock poisoned".to_string())?;
        let active = s.registry.active();
        let content = active.load_raw_config()?;
        let format = active.config_format().unwrap_or_else(|| "json".to_string());
        (content, format)
    };

    let ext = if format == "toml" { "toml" } else { "json" };
    let default_name = format!("agent-config.{}", ext);

    let path = app.dialog()
        .file()
        .add_filter(&ext.to_uppercase(), &[ext])
        .set_file_name(&default_name)
        .blocking_save_file()
        .ok_or_else(|| USER_CANCELLED.to_string())?;

    let path_ref = path.as_path()
        .ok_or_else(|| "Invalid file path".to_string())?;
    std::fs::write(path_ref, &content).map_err(|e| e.to_string())?;
    Ok(())
}
