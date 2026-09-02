//! 插件基础能力命令面（v0.8.1 需求8 P1）：项目记忆 KV 的 GUI 读写入口。
//! CLI 侧同名能力在 cli/commands/memory.rs（插件脚本/智能体经 shell 消费）。

use std::sync::Mutex;

use crate::{memory_store, AppState};

#[tauri::command]
pub(crate) fn memory_set(
    _state: tauri::State<'_, Mutex<AppState>>,
    project: String,
    key: String,
    value: String,
) -> Result<(), String> {
    memory_store::set(&project, &key, &value)
}

#[tauri::command]
pub(crate) fn memory_get(
    _state: tauri::State<'_, Mutex<AppState>>,
    project: String,
    key: String,
) -> Result<Option<String>, String> {
    memory_store::get(&project, &key)
}

#[tauri::command]
pub(crate) fn memory_list(
    _state: tauri::State<'_, Mutex<AppState>>,
    project: String,
) -> Result<Vec<memory_store::MemoryEntry>, String> {
    memory_store::list(&project)
}

#[tauri::command]
pub(crate) fn memory_delete(
    _state: tauri::State<'_, Mutex<AppState>>,
    project: String,
    key: String,
) -> Result<(), String> {
    memory_store::delete(&project, &key)
}
