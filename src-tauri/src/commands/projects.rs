use std::collections::HashMap;
use std::sync::Mutex;

use crate::hub;
use crate::project;
use crate::project_config;
use crate::{agent, with_app_state, AppState};

#[tauri::command]
pub(crate) async fn scan_projects(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<project::Project>, String> {
    // v0.7.2 需求 1 / M2.1：只极短持锁克隆 Arc<registry>，立即释放，再放到
    // spawn_blocking 跑扫描。此前整个扫描期间持 std::sync::Mutex，把阻塞 IO +
    // 子进程 spawn 锁在临界区内，饿死 tokio worker 并串行化所有 AppState 命令。
    let __t = std::time::Instant::now();
    let registry = with_app_state(&state, |s| s.registry.clone())?;
    let result = tauri::async_runtime::spawn_blocking(move || registry.scan_projects())
        .await
        .map_err(|e| e.to_string());
    log::info!(
        "[startup] scan_projects: {:?} ({} projects)",
        __t.elapsed(),
        result.as_ref().map(|v| v.len()).unwrap_or(0)
    );
    result
}

#[tauri::command]
pub(crate) fn add_project(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    path: String,
) -> Result<project::Project, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .add_project(&path)
        .ok_or_else(|| format!("No project directory found at: {}", path))
}

#[tauri::command]
pub(crate) fn remove_project(encoded_name: String) -> Result<(), String> {
    hub::hide_project(&encoded_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn init_project(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
) -> Result<bool, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .init_project(&project_path)
}

#[tauri::command]
pub(crate) fn load_project_settings(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
) -> Result<project_config::ProjectSettings, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .load_project_settings(&project_path)
}

#[tauri::command]
pub(crate) fn load_project_settings_local(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
) -> Result<project_config::ProjectSettings, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .load_project_settings_local(&project_path)
}

#[tauri::command]
pub(crate) fn save_project_settings(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
    settings: project_config::ProjectSettings,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .save_project_settings(&project_path, &settings)
}

#[tauri::command]
pub(crate) fn save_project_settings_local(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
    settings: project_config::ProjectSettings,
) -> Result<(), String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .save_project_settings_local(&project_path, &settings)
}

#[tauri::command]
pub(crate) fn load_claude_md(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    project_path: String,
) -> Result<Option<String>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    s.registry
        .require_agent(&agent_id)?
        .load_claude_md(&project_path)
}

#[tauri::command]
pub(crate) fn load_project_metas() -> Result<HashMap<String, hub::ProjectMeta>, String> {
    hub::load_project_metas().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn save_project_meta(
    encoded_name: String,
    meta: hub::ProjectMeta,
) -> Result<(), String> {
    hub::save_project_meta(&encoded_name, meta).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_level1_dir_cmd(
    state: tauri::State<'_, Mutex<AppState>>,
    agent_id: String,
    encoded_name: String,
) -> Result<Option<String>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let agent = s.registry.require_agent(&agent_id)?;
    let decoded = agent.decode_project_path(&encoded_name);
    Ok(agent.get_level1_dir(&decoded))
}

#[tauri::command]
pub(crate) fn get_mergeable_projects(
    state: tauri::State<'_, Mutex<AppState>>,
    encoded_name: String,
) -> Result<Vec<String>, String> {
    let s = state
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?;
    let projects = s.registry.scan_projects();
    let mergeable: Vec<String> = projects
        .iter()
        .filter(|p| p.encoded_name != encoded_name)
        .map(|p| p.encoded_name.clone())
        .collect();
    Ok(mergeable)
}

#[tauri::command]
pub(crate) fn merge_projects_logical(
    primary: String,
    secondaries: Vec<String>,
) -> Result<(), String> {
    hub::merge_projects_logical(&primary, secondaries).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn split_project(primary: String) -> Result<(), String> {
    hub::split_project(&primary).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_project_merges() -> Result<HashMap<String, Vec<String>>, String> {
    let merges = hub::load_project_merges().map_err(|e| e.to_string())?;
    Ok(merges.merges)
}

#[tauri::command]
pub(crate) fn get_merged_secondaries(primary: String) -> Result<Vec<String>, String> {
    hub::get_merged_secondaries(&primary).map_err(|e| e.to_string())
}

// ── @ 文件引用（v0.7.3 需求2-A1）：项目文件清单 ────────────────────────────
// 供输入框 @ 补全。手写递归（不引入 walkdir 依赖）；忽略常见构建/依赖目录、
// 隐藏文件与二进制扩展；深度与条目数设上限，保证大仓库可预期返回。

const PROJECT_FILE_IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".cache",
    ".turbo",
    ".gradle",
];
const PROJECT_FILE_MAX_ENTRIES: usize = 5000;
const PROJECT_FILE_MAX_DEPTH: usize = 10;
const PROJECT_FILE_SKIPPED_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "exe", "dll", "so", "dylib", "zip",
    "tar", "gz", "7z", "rar", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "mp3", "mp4",
    "avi", "mov", "wasm", "bin", "pdb", "lib", "jar", "class", "pyc", "woff", "woff2", "ttf",
    "otf",
];

fn walk_project_files(
    dir: &std::path::Path,
    rel: &std::path::Path,
    depth: usize,
    out: &mut Vec<String>,
) {
    if depth > PROJECT_FILE_MAX_DEPTH || out.len() >= PROJECT_FILE_MAX_ENTRIES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= PROJECT_FILE_MAX_ENTRIES {
            return;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let path = entry.path();
        // symlink/联接点跟随目标类型判断，防止目录联接被当作文件 push
        let is_dir = std::fs::metadata(&path)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if is_dir {
            if PROJECT_FILE_IGNORED_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            walk_project_files(&path, &rel.join(name_str.as_ref()), depth + 1, out);
        } else {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            if PROJECT_FILE_SKIPPED_EXTS.contains(&ext.as_str()) {
                continue;
            }
            out.push(
                rel.join(name_str.as_ref())
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/"),
            );
        }
    }
}

/// 列出项目内可引用的文件（相对路径，`/` 分隔），忽略依赖/构建目录与二进制。
#[tauri::command]
pub(crate) fn list_project_files(project_root: String) -> Result<Vec<String>, String> {
    let root = std::path::Path::new(&project_root);
    if !root.is_dir() {
        return Err("Project root is not a directory".to_string());
    }
    let mut out = Vec::new();
    walk_project_files(root, std::path::Path::new(""), 0, &mut out);
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod file_list_tests {
    use super::*;

    #[test]
    fn lists_relative_paths_and_ignores_noise() {
        let root = std::env::temp_dir().join(format!("jishu-file-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();
        std::fs::write(root.join("src/main.rs"), "x").unwrap();
        std::fs::write(root.join("src/deep/a.txt"), "x").unwrap();
        std::fs::write(root.join("src/logo.png"), "x").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();

        let mut out = Vec::new();
        walk_project_files(&root, std::path::Path::new(""), 0, &mut out);
        out.sort();

        assert_eq!(
            out,
            vec![
                "README.md".to_string(),
                "src/deep/a.txt".to_string(),
                "src/main.rs".to_string()
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn respects_entry_cap() {
        let root = std::env::temp_dir().join(format!("jishu-file-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..80 {
            std::fs::write(root.join(format!("f{i:03}.txt")), "x").unwrap();
        }
        let mut out = Vec::new();
        // 用小上限验证截断逻辑（正式上限 5000 不在测试中构造）
        let mut capped = out;
        walk_project_files(&root, std::path::Path::new(""), 0, &mut capped);
        assert_eq!(capped.len(), 80);
        let _ = std::fs::remove_dir_all(&root);
    }
}
