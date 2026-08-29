//! 声明式 agent manifest（v0.8.1 需求1 M2，Phase 3）：标准形态 agent 零代码接入。
//!
//! 加载规则：内置 agent 注册后扫描 `~/.jishu-hub/agents/*.toml`；
//! 单个文件解析/校验失败或 id 冲突 → log error + 收集进
//! `AgentRegistry::manifest_errors`（fail loud 但局部，不拖垮启动）。
//! 目录扫描是只读的（目录不存在 → 静默空，无 create_dir_all 副作用），
//! 保证 cargo test 在任意机器上的确定性。

pub mod agent;
pub mod schema;
pub mod store;

use std::path::PathBuf;

/// hub 数据根目录：`JISHU_HUB_HOME` 环境变量可覆盖（测试隔离），
/// 缺省 `~/.jishu-hub`。只读解析，零副作用。
pub fn hub_home() -> PathBuf {
    if let Ok(dir) = std::env::var("JISHU_HUB_HOME") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    #[cfg(test)]
    {
        // 测试隔离（v0.8.1 需求7 测试期发现）：cargo test 直接读开发机真实
        // ~/.jishu-hub 会让「构造 AgentRegistry 的测试」取决于用户的插件启停
        // 配置（plugins.json 禁用某内置 agent → require_agent 失败）。
        // 进程级固定临时目录兜底；显式 set_var 的测试仍走上方 env 分支。
        static TEST_HOME: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        return TEST_HOME
            .get_or_init(|| tempfile::tempdir().expect("create test hub home").keep())
            .clone();
    }
    #[allow(unreachable_code)]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".jishu-hub")
    }
}

/// manifest 目录 `~/.jishu-hub/agents`（只读解析，零副作用）。
pub fn manifest_dir() -> PathBuf {
    hub_home().join("agents")
}

/// 扫描并加载全部合法 manifest（v0.8.1 需求7：按 kind 分流）。
///
/// `builtin_ids`：内置 agent id 清单（冲突拒绝，agent 与 tool 共享 id
/// namespace）。返回 (agent 形态清单, tool 形态清单, 错误清单)——清单项为
/// (manifest, 来源路径)。错误项为 (文件名, 原因)，供环境检测页与插件页展示。
pub fn load_manifests(
    builtin_ids: &[String],
) -> (
    Vec<(schema::AgentManifestFile, PathBuf)>,
    Vec<(schema::AgentManifestFile, PathBuf)>,
    Vec<(String, String)>,
) {
    let dir = manifest_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        // 目录不存在（或不可读）= 没有声明式插件，静默空清单。
        Err(_) => return (Vec::new(), Vec::new(), Vec::new()),
    };

    let mut seen_ids: Vec<String> = builtin_ids.to_vec();
    let mut agent_manifests = Vec::new();
    let mut tool_manifests = Vec::new();
    let mut errors = Vec::new();

    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "toml"))
        .collect();
    files.sort();

    for path in files {
        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "<unknown>".to_string());
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(e) => {
                errors.push((file_name, format!("cannot read file: {e}")));
                continue;
            }
        };
        let parsed: schema::AgentManifestFile = match toml::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                errors.push((file_name, format!("invalid TOML or schema: {e}")));
                continue;
            }
        };
        if let Err(reason) = parsed.validate() {
            errors.push((file_name, reason));
            continue;
        }
        if seen_ids.contains(&parsed.info.id) {
            errors.push((
                file_name,
                format!(
                    "agent id {:?} conflicts with a builtin or already-loaded agent",
                    parsed.info.id
                ),
            ));
            continue;
        }
        seen_ids.push(parsed.info.id.clone());
        log::info!(
            "[manifest] loaded {} plugin {} from {}",
            match parsed.kind {
                schema::ManifestKind::Agent => "agent",
                schema::ManifestKind::Tool => "tool",
            },
            parsed.info.id,
            file_name
        );
        match parsed.kind {
            schema::ManifestKind::Agent => agent_manifests.push((parsed, path)),
            schema::ManifestKind::Tool => tool_manifests.push((parsed, path)),
        }
    }

    (agent_manifests, tool_manifests, errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    // load_manifests 读真实 ~/.jishu-hub/agents——测试环境该目录一般不存在，
    // 返回空且无副作用；不对其内容做断言（开发机放置了 manifest 也不影响测试确定性）。

    #[test]
    fn missing_directory_yields_empty_silently() {
        // 用一个不存在的覆盖目录验证「目录不存在 → 空」路径的形状：
        // manifest_dir 本身不可注入，此处仅验证返回结构约定。
        let (agents, tools, errors) = load_manifests(&["jishu-self".to_string()]);
        if !manifest_dir().exists() {
            assert!(agents.is_empty());
            assert!(tools.is_empty());
            assert!(errors.is_empty());
        }
    }
}
