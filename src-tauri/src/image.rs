use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct InputFile {
    pub data: String,
    pub filename: String,
    pub label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SavedFile {
    pub path: String,
    pub label: String,
    pub index: u32,
    pub batch_id: String,
}

fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c })
        .collect::<String>()
        .replace("..", "_")
}

fn session_files_dir(project_path: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".jishu_hub")
        .join("session_files")
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        // Images
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        // Documents
        "pdf" => "application/pdf",
        "doc" | "docx" => "application/msword",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        "ppt" | "pptx" => "application/vnd.ms-powerpoint",
        // Text / code
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "xml" => "application/xml",
        "yaml" | "yml" => "text/yaml",
        "toml" => "text/toml",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "ts" | "tsx" | "jsx" => "text/typescript",
        "py" => "text/x-python",
        "rs" => "text/x-rust",
        "go" => "text/x-go",
        "java" => "text/x-java",
        "c" | "h" => "text/x-c",
        "cpp" | "hpp" | "cc" => "text/x-c++",
        "cs" => "text/x-csharp",
        "rb" => "text/x-ruby",
        "php" => "text/x-php",
        "swift" => "text/x-swift",
        "kt" => "text/x-kotlin",
        "sh" | "bash" | "zsh" => "text/x-shellscript",
        "sql" => "text/x-sql",
        // Archives
        "zip" => "application/zip",
        "gz" | "tar" => "application/gzip",
        "rar" => "application/x-rar-compressed",
        "7z" => "application/x-7z-compressed",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub fn save_session_files(
    project_path: String,
    files: Vec<InputFile>,
) -> Result<Vec<SavedFile>, String> {
    let batch_id = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let dir = session_files_dir(&project_path).join(&batch_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;

    let mut saved = Vec::new();

    for (i, file) in files.iter().enumerate() {
        let index = (i + 1) as u32;
        let raw_label = file
            .label
            .clone()
            .unwrap_or_else(|| format!("文件{}", index));
        let label = sanitize_label(&raw_label);
        let ext = PathBuf::from(&file.filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_string();
        let filename = format!("{}_{}.{}", index, label, ext);
        let filepath = dir.join(&filename);

        let bytes = BASE64
            .decode(&file.data)
            .map_err(|e| format!("Decode failed for {}: {}", file.filename, e))?;
        fs::write(&filepath, bytes).map_err(|e| format!("Write failed for {}: {}", filename, e))?;

        saved.push(SavedFile {
            path: filepath.to_string_lossy().to_string(),
            label,
            index,
            batch_id: batch_id.clone(),
        });
    }
    Ok(saved)
}

#[tauri::command]
pub fn read_file_as_base64(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    if !p.starts_with(&home) {
        return Err("Access denied: path outside home directory".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(BASE64.encode(&bytes))
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn get_clipboard_file_paths() -> Result<Vec<String>, String> {
    let mut command = std::process::Command::new("powershell");
    let output = crate::process_command::std_no_window(
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }",
        ]),
    )
        .output()
        .map_err(|e| format!("Failed to query clipboard: {}", e))?;
    let paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(paths)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn get_clipboard_file_paths() -> Result<Vec<String>, String> {
    Ok(vec![])
}

#[tauri::command]
pub fn read_image_as_data_url(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    if !p.starts_with(&home) {
        return Err("Access denied: path outside home directory".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read image: {}", e))?;
    let pb = PathBuf::from(&path);
    let ext = pb.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let mime = mime_for_ext(ext);
    let b64 = BASE64.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}
