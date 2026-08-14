use tauri::Manager;

use crate::hub;

#[tauri::command]
pub(crate) fn load_language() -> Result<Option<String>, String> {
    hub::load_language().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn save_language(lang: String) -> Result<(), String> {
    hub::save_language(&lang).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn load_always_on_top() -> Result<bool, String> {
    hub::load_always_on_top().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn toggle_always_on_top(app: tauri::AppHandle) -> Result<bool, String> {
    let current = hub::load_always_on_top().map_err(|e| e.to_string())?;
    let new_value = !current;

    if let Some(window) = app.get_webview_window("main") {
        window
            .set_always_on_top(new_value)
            .map_err(|e| e.to_string())?;
    }

    hub::save_always_on_top(new_value).map_err(|e| e.to_string())?;
    Ok(new_value)
}

#[tauri::command]
pub(crate) fn load_theme() -> Result<String, String> {
    let state = hub::load_state().map_err(|e| e.to_string())?;
    Ok(state.theme.unwrap_or_else(|| "colorful".to_string()))
}

#[tauri::command]
pub(crate) fn save_theme(theme: String) -> Result<(), String> {
    let mut state = hub::load_state().map_err(|e| e.to_string())?;
    state.theme = Some(theme);
    hub::save_state(&state).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn load_last_project() -> Result<Option<String>, String> {
    hub::load_last_project().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("Only http(s) URLs can be opened".to_string());
    }
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn save_last_project(encoded_name: String) -> Result<(), String> {
    hub::save_last_project(&encoded_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn load_font_sizes() -> Result<(Option<String>, Option<String>), String> {
    hub::load_font_sizes().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn save_font_sizes(
    font_size_base: String,
    font_size_prose: String,
) -> Result<(), String> {
    hub::save_font_sizes(&font_size_base, &font_size_prose).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_app_dir() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("No parent dir")?;
    Ok(dir.to_string_lossy().to_string())
}
