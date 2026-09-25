//! pi 扩展导入（v0.9.5 需求1（原需求26）V4-P7）——扫描未注册扩展 + 安全
//! 摘要 + 导入（默认不启用）+ 静态形状检查。
//!
//! 三层导入体验（01 §七设计）：层一自动检测（放文件即发现）、层二导入
//! 按钮（hub 内文件选择）、层三 CLI（`plugins import-extension`）。
//!
//! 安全边界（评审 P1-7 加固，全部为设计承诺而非技术保证）：
//! - 摘要**不是沙箱**——正则提取有已知绕过面（动态 import、eval、
//!   new Function、字符串拼接调用、经第三方依赖间接调用）；
//! - pi 扩展在 agent 进程内运行 = 本地任意代码执行，摘要结论必含不可
//!   绕过的兜底警告；
//! - 导入后**默认不启用**（复制文件即止；启用=显式注册 settings.json，
//!   对齐混合插件确认卡策略）。

use serde::Serialize;

/// 未注册扩展（扫描产物：文件在 extensions/ 但 settings.json 未声明）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnregisteredExtension {
    /// 扩展文件名（如 my-extension.ts）。
    pub file_name: String,
    /// 绝对路径。
    pub path: String,
    /// 文件大小（字节）。
    pub size: u64,
    /// 安全摘要（7b）。
    pub summary: ExtensionSummary,
}

/// 安全摘要（正则提取的「静态发现的能力」——非沙箱结论）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSummary {
    /// 注册的工具（pi.registerTool({ name: "xxx"）。
    pub tools: Vec<String>,
    /// 注册的命令（pi.registerCommand("xxx"）。
    pub commands: Vec<String>,
    /// 监听的事件（pi.on("xxx"）。
    pub events: Vec<String>,
    /// 文件读写迹象。
    pub file_ops: bool,
    /// 网络请求迹象。
    pub network: bool,
    /// 子进程执行迹象。
    pub subprocess: bool,
    /// 导出形状检查（7d：default export function 存在——静态近似，
    /// 真实加载由 agent 进程的 pi 运行时裁决）。
    pub has_default_export: bool,
}

/// 兜底警告（摘要展示必含——不可绕过）。
pub const ARBITRARY_CODE_WARNING: &str =
    "此扩展将在 agent 进程中执行任意代码——摘要只是静态发现，未发现风险不代表没有风险";

/// 已知绕过面（文档与摘要卡显式声明——评审 P1-7）。
pub const KNOWN_BYPASS_SURFACE: &str =
    "正则提取的已知绕过面：动态 import()、eval、new Function、字符串拼接调用、经第三方依赖间接调用均不会被发现";

fn extensions_dir() -> Result<std::path::PathBuf, String> {
    let agent_dir = crate::agent::jishu_self::paths::agent_dir().map_err(|e| e.to_string())?;
    Ok(agent_dir.join("extensions"))
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    let agent_dir = crate::agent::jishu_self::paths::agent_dir().map_err(|e| e.to_string())?;
    Ok(agent_dir.join("settings.json"))
}

/// 已注册的扩展相对路径集合（settings.json extensions 数组）。
fn registered_rel_paths() -> Vec<String> {
    let Ok(path) = settings_path() else {
        return Vec::new();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    settings
        .get("extensions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 安全摘要解析（7b）：正则提取静态能力。输入为扩展源码。
pub fn parse_extension_summary(source: &str) -> ExtensionSummary {
    let mut summary = ExtensionSummary::default();
    // registerTool({ name: "xxx" / name: 'xxx'
    let mut rest = source;
    while let Some(idx) = rest.find("registerTool") {
        let window = &rest[idx..rest.len().min(idx + 160)];
        if let Some(name) = extract_quoted_after(window, "name:") {
            if !summary.tools.contains(&name) {
                summary.tools.push(name);
            }
        }
        rest = &rest[idx + 12..];
    }
    let mut rest = source;
    while let Some(idx) = rest.find("registerCommand") {
        let window = &rest[idx..rest.len().min(idx + 80)];
        // registerCommand("xxx"
        if let Some(q) = window.find(['"', '\'']) {
            let quote = window.as_bytes()[q] as char;
            if let Some(end) = window[q + 1..].find(quote) {
                let name = window[q + 1..q + 1 + end].to_string();
                if !name.is_empty() && !summary.commands.contains(&name) {
                    summary.commands.push(name);
                }
            }
        }
        rest = &rest[idx + 15..];
    }
    let mut rest = source;
    while let Some(idx) = rest.find("pi.on(") {
        let window = &rest[idx..rest.len().min(idx + 60)];
        if let Some(q) = window.find(['"', '\'']) {
            let quote = window.as_bytes()[q] as char;
            if let Some(end) = window[q + 1..].find(quote) {
                let name = window[q + 1..q + 1 + end].to_string();
                if !name.is_empty() && !summary.events.contains(&name) {
                    summary.events.push(name);
                }
            }
        }
        rest = &rest[idx + 6..];
    }
    summary.file_ops = source.contains("readFileSync")
        || source.contains("writeFileSync")
        || source.contains("node:fs")
        || source.contains("fs.writeFile")
        || source.contains("fs.readFile");
    summary.network = source.contains("fetch(")
        || source.contains("https://")
        || source.contains("http://")
        || source.contains("axios");
    summary.subprocess = source.contains("spawn")
        || source.contains("child_process")
        || source.contains("execSync")
        || source.contains("execFile");
    summary.has_default_export =
        source.contains("export default function") || source.contains("export default async function");
    summary
}

fn extract_quoted_after(window: &str, key: &str) -> Option<String> {
    let idx = window.find(key)?;
    let tail = &window[idx + key.len()..];
    let trimmed = tail.trim_start();
    let q = trimmed.find(['"', '\''])?;
    let quote = trimmed.as_bytes()[q] as char;
    let after = &trimmed[q + 1..];
    let end = after.find(quote)?;
    let name = after[..end].to_string();
    if name.is_empty() || name.contains(['\n', '{', '(', ';']) {
        return None;
    }
    Some(name)
}

/// 扫描 extensions/ 目录的未注册 .ts 扩展（7a：启动一次 + 手动刷新，
/// 不引入新轮询——扫描是按需拉取命令）。
pub fn scan_unregistered_extensions() -> Vec<UnregisteredExtension> {
    let mut out = Vec::new();
    let Ok(dir) = extensions_dir() else {
        return out;
    };
    let registered = registered_rel_paths();
    let ignored = ignored_extensions();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "ts") {
            let rel = format!("extensions/{}", entry.file_name().to_string_lossy());
            if registered.iter().any(|r| r == &rel) {
                continue; // 已注册（含 hub 自动部署的 conductor/html-preview 等）。
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if ignored.iter().any(|x| x == &file_name) {
                continue; // 用户已忽略（提示卡「忽略」——文件不动，不再打扰）。
            }
            let Ok(source) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            out.push(UnregisteredExtension {
                file_name,
                path: path.to_string_lossy().into_owned(),
                size: meta.len(),
                summary: parse_extension_summary(&source),
            });
        }
    }
    out.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    out
}

/// 导入扩展文件（7c）：复制到 extensions/ 目录——**默认不启用**（不写
/// settings.json；启用走 [`enable_pi_extension`] 显式动作）。返回目标路径。
pub fn import_pi_extension(src_path: &str) -> Result<String, String> {
    let src = std::path::Path::new(src_path);
    if !src.is_file() {
        return Err(format!("源文件不存在: {src_path}"));
    }
    if src.extension().is_some_and(|e| e != "ts") {
        return Err("仅支持 .ts 扩展文件".to_string());
    }
    let source = std::fs::read_to_string(src)
        .map_err(|e| format!("无法读取源文件: {e}"))?;
    // 7d 静态形状检查：default export function（真实加载由 pi 运行时裁决）。
    let summary = parse_extension_summary(&source);
    if !summary.has_default_export {
        return Err(
            "扩展缺少 default export function（pi 扩展契约：export default function(pi) {...}）"
                .to_string(),
        );
    }
    let dir = extensions_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(src.file_name().unwrap_or_default());
    std::fs::copy(src, &target).map_err(|e| format!("复制失败: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 启用已导入的扩展（7c：显式确认动作——注册 settings.json extensions
/// 数组；下次 agent 会话启动生效）。
pub fn enable_pi_extension(file_name: &str) -> Result<(), String> {
    // 文件名安全：不含路径分隔（防目录穿越）。
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("非法文件名".to_string());
    }
    let dir = extensions_dir()?;
    if !dir.join(file_name).exists() {
        return Err(format!("扩展文件不存在: {file_name}（先导入）"));
    }
    let agent_dir = crate::agent::jishu_self::paths::agent_dir().map_err(|e| e.to_string())?;
    let rel = format!("extensions/{file_name}");
    let settings_path = agent_dir.join("settings.json");
    let content = std::fs::read_to_string(&settings_path).unwrap_or_else(|_| "{}".to_string());
    let mut settings: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("settings.json 解析失败: {e}"))?;
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    let arr = settings
        .as_object_mut()
        .ok_or("settings.json 形态异常")?
        .entry("extensions")
        .or_insert_with(|| serde_json::json!([]));
    if !arr
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(&rel)))
    {
        arr.as_array_mut()
            .ok_or("extensions 数组形态异常")?
            .push(serde_json::Value::String(rel));
    }
    std::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入 settings.json 失败: {e}"))?;
    Ok(())
}

/// 忽略指定扩展（层一提示卡「忽略」动作）：记录忽略名单（hub 侧文件），
/// 扫描时过滤——非删除（用户文件不动）。
pub fn ignore_pi_extension(file_name: &str) -> Result<(), String> {
    let path = crate::agent::manifest::hub_home().join(".ignored-extensions.json");
    let mut list: Vec<String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    if !list.iter().any(|x| x == file_name) {
        list.push(file_name.to_string());
    }
    std::fs::write(&path, serde_json::to_string_pretty(&list).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ignored_extensions() -> Vec<String> {
    let path = crate::agent::manifest::hub_home().join(".ignored-extensions.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 7b：摘要提取（工具/命令/事件/文件/网络/子进程/导出形状）。
    #[test]
    fn summary_extraction() {
        let src = r#"
import * as fs from "node:fs";
export default function(pi) {
  pi.registerTool({ name: "export_file", label: "导出", execute: async () => {} });
  pi.registerTool({ name: 'import_file', execute: async () => {} });
  pi.registerCommand("my-cmd", () => {});
  pi.on("agent_start", () => {});
  pi.on("turn_end", () => {});
  fs.writeFileSync("/tmp/x", "1");
  await fetch("https://api.example.com");
  const { execSync } = require("child_process");
}
"#;
        let s = parse_extension_summary(src);
        assert_eq!(s.tools, vec!["export_file", "import_file"]);
        assert_eq!(s.commands, vec!["my-cmd"]);
        assert_eq!(s.events, vec!["agent_start", "turn_end"]);
        assert!(s.file_ops);
        assert!(s.network);
        assert!(s.subprocess);
        assert!(s.has_default_export);
    }

    /// 绕过面样本：动态调用不触发迹象位（已知限制——摘要非沙箱）。
    #[test]
    fn summary_known_bypass_surface() {
        let s = parse_extension_summary("const f = globalThis['ev' + 'al']; export default function(pi){}");
        assert!(!s.subprocess && !s.network && !s.file_ops);
    }

    /// 7d：缺 default export 的形状检查拒绝。
    #[test]
    fn shape_check_rejects_missing_export() {
        let s = parse_extension_summary("export function notDefault(pi) {}");
        assert!(!s.has_default_export);
    }
}
