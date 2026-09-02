//! 声明式插件面板执行命令（v0.9.0 需求8 MVP：list 只读模板）。
//!
//! [panel] 声明的命令由 hub 按需执行并返回输出——与 [tool].usage 注入
//! agent prompt 的 CLI 命令同级信任（用户安装插件即信任其声明）。仅展示
//! 用途：无窗执行 + 超时护栏 + 输出截断。

use crate::AppState;
use std::sync::Mutex;
use tauri::State;

#[derive(serde::Serialize)]
pub(crate) struct PanelRunResult {
    pub label: String,
    pub output: String,
    pub ok: bool,
}

fn tail(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    format!("…{}", &text[text.len() - max..])
}

#[tauri::command]
pub(crate) async fn plugin_panel_run(
    state: State<'_, Mutex<AppState>>,
    plugin_id: String,
    item_index: usize,
) -> Result<PanelRunResult, String> {
    // 锁内只取声明快照，执行在锁外。
    let (label, command) = {
        let s = state
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        let plugins = s
            .tool_plugins
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let plugin = plugins
            .iter()
            .find(|p| p.id() == plugin_id)
            .ok_or_else(|| format!("plugin not found: {plugin_id}"))?;
        let panel = plugin
            .file
            .panel
            .as_ref()
            .ok_or_else(|| format!("plugin {plugin_id} has no [panel] section"))?;
        let item = panel
            .items
            .get(item_index)
            .ok_or_else(|| format!("panel item index out of range: {item_index}"))?;
        (item.label.clone(), item.command.clone())
    };

    // 面板命令按 shell 单命令执行（声明即整行命令；Windows 需 cmd /C 解析
    // npm/npx 等 .cmd 别名，与 install_mcp_standalone 同纪律）。
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", &command]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    crate::process_command::tokio_no_window(&mut cmd);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .map_err(|_| "panel command timed out (10s)".to_string())?
        .map_err(|e| format!("failed to run panel command: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = if stderr.trim().is_empty() {
        stdout
    } else {
        format!("{stdout}\n[stderr]\n{stderr}")
    };
    Ok(PanelRunResult {
        label,
        output: tail(combined, 4000),
        ok: output.status.success(),
    })
}
