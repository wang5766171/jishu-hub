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
/// 三轮评审 P1-7：跨端序列化一律 snake_case（§4——修前 camelCase；前端
/// 消费接口 pi-extension-import-card.tsx 同步改）。
#[derive(Debug, Clone, Serialize)]
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
    Ok(agent_dir_for_tests()?.join("extensions"))
}

/// 测试隔离（v0.9.5 需求2 测试期教训：bundle 测试曾把测试扩展写进真实
/// ~/.jishu-agent/agent/extensions/ 导致用户 pi 启动崩溃——JISHU_HUB_HOME
/// 只隔离 hub 目录，agent 目录无隔离）。与 hub_home 同款双模式：
/// JISHU_AGENT_DIR env 显式覆盖；cfg(test) 自动落进程级临时目录。
fn agent_dir_for_tests() -> Result<std::path::PathBuf, String> {
    if let Ok(dir) = std::env::var("JISHU_AGENT_DIR") {
        if !dir.trim().is_empty() {
            return Ok(std::path::PathBuf::from(dir));
        }
    }
    #[cfg(test)]
    {
        static TEST_AGENT_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
        return Ok(TEST_AGENT_DIR
            .get_or_init(|| {
                tempfile::tempdir()
                    .expect("create test agent dir")
                    .keep()
                    .join("agent")
            })
            .clone());
    }
    #[allow(unreachable_code)]
    {
        crate::agent::jishu_self::paths::agent_dir().map_err(|e| e.to_string())
    }
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    Ok(agent_dir_for_tests()?.join("settings.json"))
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
    summary.has_default_export = source.contains("export default function")
        || source.contains("export default async function");
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
    let source = std::fs::read_to_string(src).map_err(|e| format!("无法读取源文件: {e}"))?;
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
    // 三轮评审新增：同名覆盖防护——extensions/ 已有同名文件且内容不同时
    // 拒绝静默覆盖（旧版覆盖新版/反之都无提示）；相同内容幂等放行。启用前
    // 删除旧文件或换名后重导。
    if target.exists() {
        let existing = std::fs::read(&target).unwrap_or_default();
        let incoming = std::fs::read(src).unwrap_or_default();
        if existing != incoming {
            return Err(format!(
                "已存在同名扩展且内容不同（{}）——如需覆盖请先删除旧文件或重命名后再导入",
                target.display()
            ));
        }
        return Ok(target.to_string_lossy().into_owned());
    }
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
    // 三轮评审 C8：settings 写入统一走 settings_path()（与上方存在性检查的
    // extensions_dir() 同源 agent_dir_for_tests——修前检查走测试隔离目录、
    // 写入直拼真实目录，单测一旦触达本函数会写真实用户 settings.json）。
    let rel = format!("extensions/{file_name}");
    let settings_path = settings_path()?;
    let content = std::fs::read_to_string(&settings_path).unwrap_or_else(|_| "{}".to_string());
    let mut settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("settings.json 解析失败: {e}"))?;
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
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&list).unwrap_or_default(),
    )
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
        let s = parse_extension_summary(
            "const f = globalThis['ev' + 'al']; export default function(pi){}",
        );
        assert!(!s.subprocess && !s.network && !s.file_ops);
    }

    /// 7d：缺 default export 的形状检查拒绝。
    #[test]
    fn shape_check_rejects_missing_export() {
        let s = parse_extension_summary("export function notDefault(pi) {}");
        assert!(!s.has_default_export);
    }
}

/// 成套导入（8d）：目录含 extension.ts + plugin.toml + renderer.toml 三件
/// 一次装——pi 扩展（复制，默认不启用）+ 工具插件（agents/ 安装）+ 会话
/// 渲染插件（plugins/ 安装 + 确认卡）。单文件路径回落普通扩展导入。
pub fn import_extension_bundle(path: &str) -> Result<ExtensionBundleReport, String> {
    let p = std::path::Path::new(path);
    if !p.is_dir() {
        // 单文件回落（普通扩展导入）。
        let target = import_pi_extension(path)?;
        return Ok(ExtensionBundleReport {
            kind: "extension-only",
            extension: Some(target),
            tool_plugin: None,
            renderer_plugin: None,
        });
    }
    let has_ext = p.join("extension.ts").is_file();
    let has_tool = p.join("plugin.toml").is_file();
    let has_renderer = p.join("renderer.toml").is_file();
    if !has_ext && !has_tool && !has_renderer {
        return Err(format!(
            "目录 {path} 不含可导入件（期望 extension.ts / plugin.toml / renderer.toml 任一）"
        ));
    }
    let mut report = ExtensionBundleReport {
        kind: "bundle",
        extension: None,
        tool_plugin: None,
        renderer_plugin: None,
    };
    if has_ext {
        report.extension = Some(import_pi_extension(
            &p.join("extension.ts").to_string_lossy(),
        )?);
    }
    if has_tool {
        let content = std::fs::read_to_string(p.join("plugin.toml"))
            .map_err(|e| format!("读取 plugin.toml 失败: {e}"))?;
        let parsed: crate::agent::manifest::schema::AgentManifestFile =
            toml::from_str(&content).map_err(|e| format!("plugin.toml 解析失败: {e}"))?;
        parsed
            .validate()
            .map_err(|e| format!("plugin.toml 校验失败: {e}"))?;
        let (id, _target) = crate::agent::plugin::install_manifest_file(&parsed, &content)
            .map_err(|e| format!("工具插件安装失败: {e}"))?;
        report.tool_plugin = Some(id);
    }
    if has_renderer {
        let content = std::fs::read_to_string(p.join("renderer.toml"))
            .map_err(|e| format!("读取 renderer.toml 失败: {e}"))?;
        let value: toml::Value = content
            .parse()
            .map_err(|e| format!("renderer.toml 解析失败: {e}"))?;
        let id = value
            .get("plugin")
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str())
            .ok_or("renderer.toml 缺少 [plugin].id")?
            .to_string();
        crate::agent::plugin::save_composed_manifest(&id, &content)
            .map_err(|e| format!("渲染插件安装失败: {e}"))?;
        // 默认禁用 + 确认卡（与 add 组合臂同策略——CLI/导入通道统一安全阀）。
        let _ = crate::agent::plugin::set_plugin_enabled(&id, false);
        let dir = crate::agent::plugin::composed_plugins_dir().join(&id);
        let pending = serde_json::json!({
            "id": id,
            "name": value.get("plugin").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or(&id),
            "mount": value.get("render").and_then(|r| r.get("mount")).and_then(|v| v.as_str()).unwrap_or("unknown"),
            "codeLines": 0,
            "dir": dir.to_string_lossy(),
        });
        let _ = crate::util::atomic_write(
            &dir.join(".pending-confirm"),
            pending.to_string().as_bytes(),
        );
        report.renderer_plugin = Some(id);
    }
    Ok(report)
}

/// 成套导入报告。
#[derive(Debug, Serialize)]
pub struct ExtensionBundleReport {
    pub kind: &'static str,
    pub extension: Option<String>,
    pub tool_plugin: Option<String>,
    pub renderer_plugin: Option<String>,
}

#[cfg(test)]
mod bundle_tests {
    use super::*;

    /// 8d：成套导入（三件一次装——扩展复制/工具安装/渲染确认卡）。
    #[test]
    fn import_bundle_installs_all_three() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("extension.ts"), "export default function(pi) {\n  pi.registerTool({ name: \"bundle_tool\", execute: async () => ({}) });\n}\n").unwrap();
        std::fs::write(
            src.path().join("plugin.toml"),
            "schema = 1\nkind = \"tool\"\n\n[info]\nid = \"bundle-tool\"\ndisplay_name = \"Bundle Tool\"\n\n[tool]\nusage = \"echo hi\"\ndescription = \"test\"\nexample = \"echo hi\"\n",
        )
        .unwrap();
        std::fs::write(
            src.path().join("renderer.toml"),
            "[plugin]\nid = \"session.bundle-renderer\"\nname = \"Bundle Renderer\"\nkind = \"session-composed\"\n\n[source]\ntype = \"tool-result\"\ntool_name = \"bundle_tool\"\n\n[render]\ncomponent = \"render.table\"\nmount = \"tool-output\"\n",
        )
        .unwrap();

        let report = import_extension_bundle(src.path().to_str().unwrap()).unwrap();
        assert_eq!(report.kind, "bundle");
        assert!(report.extension.is_some());
        assert_eq!(report.tool_plugin.as_deref(), Some("bundle-tool"));
        assert_eq!(
            report.renderer_plugin.as_deref(),
            Some("session.bundle-renderer")
        );
        // 渲染插件默认禁用 + 确认卡标记。
        assert!(crate::agent::plugin::load_plugin_config()
            .disabled
            .iter()
            .any(|x| x == "session.bundle-renderer"));
        assert!(crate::agent::plugin::composed_plugins_dir()
            .join("session.bundle-renderer")
            .join(".pending-confirm")
            .exists());
        std::env::remove_var("JISHU_HUB_HOME");
    }

    /// 空目录拒绝（无可导入件）。
    #[test]
    fn import_bundle_rejects_empty_dir() {
        let _guard = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        let empty = tempfile::tempdir().unwrap();
        let err = import_extension_bundle(empty.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("不含可导入件"), "got: {err}");
        std::env::remove_var("JISHU_HUB_HOME");
    }
}
