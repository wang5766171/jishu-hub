//! v0.9.7 需求1 T3：pi 运行时按需初始化（zip 解压 + 版本记录 + 启动钩子）。
//!
//! 设计要点（01-设计方案 T3，P0-2 收口）：
//! - **触发点唯一**：`lib.rs .setup` 末尾无条件 spawn `ensure_agent_runtime`；
//!   引导页（需求4）与环境检测页手动安装只消费状态/进度，不承担触发职责。
//! - 版本记录 `~/.jishu-agent/agent-runtime.json`：`{"version": "<PI_AGENT_VERSION>"}`
//!   ——记录 == 编译期 `PI_AGENT_VERSION` → Ready（零动作，hub 升级 pi 不变则秒进）；
//!   否则（首次/老版本升级/pi 变更）解压 resource zip → `install_pi_bundle_from`
//!   （备份/回滚复用）→ MCP/扩展确保 → 写记录。
//! - 过程事件 `agent-runtime-progress`：`{"stage": "extract"|"install"|"extensions", "detail"}`。
//! - 老版本体验已裁决不考虑：无记录或记录版本不符一律重装一次。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// 初始化进行中标志（IPC `agent_runtime_status` 报 init-running / 并发幂等）。
static INIT_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum AgentRuntimeState {
    /// 记录与编译期版本一致——零动作。
    Ready,
    /// 初始化进行中（另一触发点已在跑）。
    InitRunning { recorded: Option<String> },
    /// 记录缺失/版本不符——需要（或即将）安装。
    Mismatch { recorded: Option<String> },
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct RuntimeRecord {
    version: String,
    /// 需求8 修复A：workspace 链接 heal 已完成标志（旧记录缺省 = 未 heal，
    /// 触发一次性自愈——zip 链路曾把 npm workspace junction 写坏成「内容为
    /// 路径文本的文件」，subagent import 即 Cannot find package）。
    #[serde(default)]
    healed: bool,
}

/// `~/.jishu-agent/agent-runtime.json`（记录文件在 agent 根，卸载器不碰——
/// T2 裁决：~/.jishu-agent 完全归 hub 运行时自管）。
pub(crate) fn runtime_record_path() -> Option<PathBuf> {
    crate::agent::jishu_self::paths::agent_root()
        .ok()
        .map(|dir| dir.join("agent-runtime.json"))
}

/// 读取记录版本；文件不存在/损坏一律视为「无记录」（触发重装）。
pub(crate) fn read_recorded_version(record_path: &Path) -> Option<String> {
    std::fs::read_to_string(record_path)
        .ok()
        .and_then(|c| serde_json::from_str::<RuntimeRecord>(&c).ok())
        .map(|r| r.version)
}

/// 需求8 修复A：一次性本地 heal——record 未标记 healed 时修复 zip 链路写坏的
/// workspace 链接（详见 `heal_workspace_links`）。成功或「无坏可修」都置
/// healed；失败不置（下次启动再试）、不阻塞（heal 不影响主对话的 bundle
/// 入口）。Ready「零动作」语义微调为「零网络动作 + 一次性本地 heal 例外」。
fn heal_once_if_needed(record_path: &Path) {
    let Ok(content) = std::fs::read_to_string(record_path) else {
        return;
    };
    let Ok(record) = serde_json::from_str::<RuntimeRecord>(&content) else {
        return;
    };
    if record.healed {
        return;
    }
    let Some(agent_dir) = record_path.parent().map(Path::to_path_buf) else {
        return;
    };
    match crate::commands::agent_install::heal_workspace_links(&agent_dir) {
        Ok(fixed) => {
            log::info!("[agent-runtime] workspace links healed: {fixed} fixed");
            let mut healed_record = record;
            healed_record.healed = true;
            if let Ok(body) = serde_json::to_string_pretty(&healed_record) {
                let _ = std::fs::write(record_path, body);
            }
        }
        Err(e) => log::warn!("[agent-runtime] workspace link heal deferred: {e}"),
    }
}


/// 需求8 修复A：写记录（含 healed 标志）——安装完成后 heal 过即置 true，
/// Ready 路径不再重复 heal。
fn write_record(record_path: &Path, version: &str, healed: bool) -> Result<(), String> {
    if let Some(parent) = record_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create record dir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(&RuntimeRecord {
        version: version.to_string(),
        healed,
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(record_path, body).map_err(|e| format!("write runtime record: {e}"))
}

fn emit_progress(app: &tauri::AppHandle, stage: &str, detail: &str) {
    let _ = app.emit(
        "agent-runtime-progress",
        serde_json::json!({ "stage": stage, "detail": detail }),
    );
}

/// 解析 resource 目录内的 pi-runtime.zip（保留 macOS `_up_` 嵌套回退形态）。
fn bundled_runtime_zip(resource_dir: &Path) -> Result<PathBuf, String> {
    let candidates = [
        resource_dir.join("third_party").join("pi-runtime.zip"),
        resource_dir
            .join("_up_")
            .join("third_party")
            .join("pi-runtime.zip"),
    ];
    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "pi-runtime.zip not found in resources".to_string())
}

/// 把 zip 解压到 `%TEMP%/jishu-agent-init-<uuid>/`（防穿越：拒绝绝对路径与
/// `..` 段；解压结果即 pi-bundle 根：packages/ bin/ node_modules/ …）。
pub(crate) fn extract_zip_to_temp(zip_path: &Path) -> Result<PathBuf, String> {
    let dest = std::env::temp_dir().join(format!("jishu-agent-init-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dest).map_err(|e| format!("create temp dir: {e}"))?;
    let file =
        std::fs::File::open(zip_path).map_err(|e| format!("open {}: {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("open zip: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        // mangled_name 是归档内原始名（不跟随符号链接/盘符变体），用它做穿越判定。
        let raw_name = entry.name().to_string();
        if raw_name.contains("..") || raw_name.starts_with('/') || raw_name.starts_with('\\') {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(format!("zip entry escapes destination: {raw_name}"));
        }
        let Some(enclosed) = entry.enclosed_name() else {
            continue; // 纯目录项或无法定位的条目跳过
        };
        let out_path = dest.join(enclosed);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("mkdir {raw_name}: {e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent {raw_name}: {e}"))?;
        }
        let mut out =
            std::fs::File::create(&out_path).map_err(|e| format!("create {raw_name}: {e}"))?;
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("read {raw_name}: {e}"))?;
        std::io::Write::write_all(&mut out, &buf).map_err(|e| format!("write {raw_name}: {e}"))?;
    }
    Ok(dest)
}

/// 幂等确保 agent 运行时就绪（唯一触发点在 `.setup`；IPC `agent_runtime_init`
/// 与环境检测页手动安装共用）。
pub(crate) async fn ensure_agent_runtime(
    app: &tauri::AppHandle,
) -> Result<AgentRuntimeState, String> {
    let record_path =
        runtime_record_path().ok_or_else(|| "cannot resolve ~/.jishu-agent".to_string())?;
    let recorded = read_recorded_version(&record_path);
    if recorded.as_deref() == Some(crate::agent::jishu_self::PI_AGENT_VERSION) {
        // 需求8 修复A：Ready 秒进不重装 → 存量机器的坏 workspace 链接只能
        // 在这里一次性自愈（详见 heal_once_if_needed）。
        heal_once_if_needed(&record_path);
        return Ok(AgentRuntimeState::Ready);
    }
    if INIT_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        // 另一触发点已在初始化（如启动钩子在跑、用户同时点了「一键更新」）。
        return Ok(AgentRuntimeState::InitRunning { recorded });
    }
    let result = install_runtime_locked(app, &record_path).await;
    INIT_IN_PROGRESS.store(false, Ordering::SeqCst);
    result
}

/// 实际安装序列（持锁段）：解压 → 复制（备份/回滚）→ MCP/扩展确保 → 记录。
async fn install_runtime_locked(
    app: &tauri::AppHandle,
    record_path: &Path,
) -> Result<AgentRuntimeState, String> {
    use tauri::Manager;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resolve resource dir: {e}"))?;
    let zip_path = bundled_runtime_zip(&resource_dir)?;

    emit_progress(app, "extract", &zip_path.display().to_string());
    let temp_bundle = extract_zip_to_temp(&zip_path)?;

    emit_progress(app, "install", "copying pi runtime to ~/.jishu-agent");
    let output = match crate::commands::agent_install::install_pi_bundle_from(&temp_bundle) {
        Ok(msg) => msg,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&temp_bundle);
            return Err(e);
        }
    };
    let _ = std::fs::remove_dir_all(&temp_bundle);
    log::info!("[agent-runtime] {output}");

    // v0.9.5 需求11/需求5 的确保逻辑收编进安装序列（Ready 路径零动作——
    // 按需初始化语义；用户侧误删运行时由 pi 版本变更或手动安装兜底）。
    emit_progress(app, "extensions", "ensuring mcp entry & pi extensions");
    match crate::agent::jishu_self::JishuSelfAgent::ensure_native_mcp_entry().await {
        Ok(msg) => log::info!("[agent-runtime] {msg}"),
        Err(e) => log::warn!("[agent-runtime] MCP native entry ensure deferred: {e}"),
    }
    match crate::agent::jishu_self::JishuSelfAgent::ensure_pi_extensions_installed().await {
        Ok(installed) if !installed.is_empty() => {
            log::info!("[agent-runtime] pi extensions installed: {:?}", installed);
            crate::task_plan::ensure_subagents_runtime_config();
            crate::agent::plugin::sync_pi_packages_with_plugins();
        }
        Ok(_) => {}
        Err(e) => log::warn!("[agent-runtime] pi extensions install deferred: {e}"),
    }

    // 需求8 修复A：安装完成后 heal 一次（老 zip 重装场景兜底；A1 修复后的
    // 新 zip 无坏链时 fixed=0），healed 随记录落盘（Ready 路径不再重复）。
    let healed = match record_path
        .parent()
        .ok_or_else(|| "record path has no parent".to_string())
        .and_then(|dir| crate::commands::agent_install::heal_workspace_links(dir))
    {
        Ok(fixed) => {
            log::info!("[agent-runtime] workspace links healed after install: {fixed} fixed");
            true
        }
        Err(e) => {
            log::warn!("[agent-runtime] workspace link heal deferred: {e}");
            false
        }
    };
    write_record(
        record_path,
        crate::agent::jishu_self::PI_AGENT_VERSION,
        healed,
    )?;
    Ok(AgentRuntimeState::Mismatch {
        // 完成态经状态命令查询即 Ready；此处返回旧记录供调用方判断「刚装完」。
        recorded: None,
    })
}

/// 当前状态推导（T4 `agent_runtime_status` 与前端横幅共用口径）。
pub(crate) fn current_state() -> AgentRuntimeState {
    let recorded = runtime_record_path().and_then(|p| read_recorded_version(&p));
    if INIT_IN_PROGRESS.load(Ordering::SeqCst) {
        return AgentRuntimeState::InitRunning { recorded };
    }
    if recorded.as_deref() == Some(crate::agent::jishu_self::PI_AGENT_VERSION) {
        AgentRuntimeState::Ready
    } else {
        AgentRuntimeState::Mismatch { recorded }
    }
}

/// 手动安装链路共用入口（环境检测页「高级检测」与 `--install-agent` CLI）：
/// zip 解压到临时目录后走同一 `install_pi_bundle_from`（P0-2 附带修复——
/// 原 `install_internal_jishu_agent` 硬编码散目录，resources 单 zip 化后必然
/// 报「bundled pi-bundle not found」）。
pub(crate) fn extract_bundled_runtime_for_manual_install(
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    use tauri::Manager;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resolve resource dir: {e}"))?;
    let zip_path = bundled_runtime_zip(&resource_dir)?;
    extract_zip_to_temp(&zip_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_roundtrip_and_missing_file() {
        let dir =
            std::env::temp_dir().join(format!("jishu-runtime-record-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let record = dir.join("nested").join("agent-runtime.json");
        assert_eq!(read_recorded_version(&record), None);
        write_record(&record, "1.5.0-15", false).unwrap();
        assert_eq!(read_recorded_version(&record).as_deref(), Some("1.5.0-15"));
        // 需求8 修复A：healed 标志 round-trip + 旧格式（无 healed）兼容读取。
        write_record(&record, "1.5.0-15", true).unwrap();
        let body = std::fs::read_to_string(&record).unwrap();
        assert!(body.contains("\"healed\": true"), "healed 应落盘: {body}");
        let legacy = serde_json::to_string_pretty(&serde_json::json!({"version": "1.5.0-15"}))
            .unwrap();
        std::fs::write(&record, legacy).unwrap();
        assert_eq!(
            read_recorded_version(&record).as_deref(),
            Some("1.5.0-15"),
            "旧格式记录（无 healed 字段）应正常读出版本"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_record_reads_as_none() {
        let dir =
            std::env::temp_dir().join(format!("jishu-runtime-record-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let record = dir.join("agent-runtime.json");
        std::fs::write(&record, "not json").unwrap();
        assert_eq!(read_recorded_version(&record), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 构造一个含穿越条目的 zip，extract 必须整体拒绝（zip-slip 防护）。
    #[test]
    fn extract_rejects_zip_slip() {
        let dir = std::env::temp_dir().join(format!("jishu-zipslip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("evil.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options: zip::write::SimpleFileOptions = Default::default();
            writer.start_file("../escape.txt", options).unwrap();
            std::io::Write::write_all(&mut writer, b"evil").unwrap();
            writer.finish().unwrap();
        }
        let err = extract_zip_to_temp(&zip_path).unwrap_err();
        assert!(err.contains("escapes"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 正常 zip：解压出目录结构 + 文件内容正确。
    #[test]
    fn extract_writes_entries() {
        let dir = std::env::temp_dir().join(format!("jishu-zipok-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("good.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options: zip::write::SimpleFileOptions = Default::default();
            writer
                .start_file("packages/coding-agent/dist/cli.js", options)
                .unwrap();
            std::io::Write::write_all(&mut writer, b"console.log(1)").unwrap();
            writer.start_file("bin/node.exe", options).unwrap();
            std::io::Write::write_all(&mut writer, b"bin").unwrap();
            writer.finish().unwrap();
        }
        let out = extract_zip_to_temp(&zip_path).unwrap();
        assert_eq!(
            std::fs::read(out.join("packages/coding-agent/dist/cli.js")).unwrap(),
            b"console.log(1)"
        );
        assert!(out.join("bin/node.exe").is_file());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&out);
    }
}
