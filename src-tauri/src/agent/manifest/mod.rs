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

/// 测试共享锁：所有改 `JISHU_HUB_HOME` 的测试经此串行（M7）——各模块此
/// 前各持私有锁，跨模块并行时 env 互相踩踏（tool_plugin/chat_tests/
/// memory_store/plugin.rs 的迁移与落盘断言随机挂）。
#[cfg(test)]
pub fn env_test_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

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

/// 目录形式插件（plugins/<id>/plugin.toml）是否携带 skill 目录源
///（skills/<name>/SKILL.md，v0.9.4 需求3）：落盘链路剥离 [skill] 段后
/// 的“裸骨架”合法性依据（validate_with_bare_tool）。轻量探测不解析内容
///——只看一级子目录有无 SKILL.md；agents/ 单文件形式恒 false。
pub fn dir_form_has_skill_source(toml_path: &std::path::Path) -> bool {
    if toml_path.file_name().and_then(|n| n.to_str()) != Some("plugin.toml") {
        return false;
    }
    let Some(plugin_root) = toml_path.parent() else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(plugin_root.join("skills")) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.path().join("SKILL.md").is_file())
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
    // v0.9.4 需求3 修复：agents/ 不存在时不再 early return——否则全新
    // 环境（从未装过单文件插件）下 plugins/<id>/ 目录形式插件全部静默
    // 不加载（skill 插件导入后“失联”被回收链删除的直接诱因之一）。
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "toml"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();

    let mut seen_ids: Vec<String> = builtin_ids.to_vec();
    let mut agent_manifests = Vec::new();
    let mut tool_manifests = Vec::new();
    let mut errors = Vec::new();

    // v0.9.0 需求2：目录形式插件 `~/.jishu-hub/plugins/<id>/plugin.toml`
    //（pi 扩展插件的 entry TS 与插件目录同放；agents/ 单文件形式优先——
    // 同 id 时目录形式跳过）。
    let mut dir_form: Vec<PathBuf> = Vec::new();
    let plugins_dir = hub_home().join("plugins");
    if let Ok(subs) = std::fs::read_dir(&plugins_dir) {
        let mut sub_paths: Vec<PathBuf> = subs.flatten().map(|e| e.path()).collect();
        sub_paths.sort();
        for sub in sub_paths {
            let candidate = sub.join("plugin.toml");
            if candidate.is_file() {
                dir_form.push(candidate);
            }
        }
    }
    files.extend(dir_form);

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
        // v0.9.3 需求13：同域共存（设计决策 1）——组合式会话插件清单
        //（kind=session-composed，[plugin]/[source]/[render] 段）与本扫描器
        // 的 AgentManifestFile schema 不同形。此处前置识别并跳过（由
        // composed_session_manifests 扫描装载）；不做 kind 预判会因
        // deny_unknown_fields 报「unknown field `plugin`」刷屏插件中心。
        let composed = content
            .parse::<toml::Value>()
            .ok()
            .and_then(|v| {
                v.get("plugin")
                    .and_then(|p| p.get("id"))
                    .and_then(|v| v.as_str())
                    .map(|id| id.starts_with("session."))
            })
            .unwrap_or(false)
            && content.contains("session-composed");
        if composed {
            continue;
        }
        let parsed: schema::AgentManifestFile = match toml::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                errors.push((file_name, format!("invalid TOML or schema: {e}")));
                continue;
            }
        };
        if let Err(reason) = parsed.validate_with_bare_tool(dir_form_has_skill_source(&path)) {
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
        // 持 env 锁：JISHU_HUB_HOME 被并行测试临时改写时，本测试会读到他人
        // 临时 home（v0.9.4 需求6 全量跑测实际踩中 tools 非空断言）。
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (agents, tools, errors) = load_manifests(&["jishu-self".to_string()]);
        if !manifest_dir().exists() {
            assert!(agents.is_empty());
            assert!(tools.is_empty());
            assert!(errors.is_empty());
        }
    }

    /// 目录形式 skill 骨架插件（plugin_create_skill_folder 落盘产物：
    /// 剥离 [skill] 段、能力声明在 skills/<name>/SKILL.md）——修复前
    /// load_manifests 以 "requires a [tool] section" 拒绝，插件中心报错
    /// 且分发回收链把已分发 skill 目录回收删除；修复后凭目录源放行。
    /// agents/ 单文件骨架（无目录源佐证）仍被拒绝。
    #[test]
    fn dir_form_bare_skeleton_loads_with_skill_source() {
        let _guard = env_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());

        // 1) 目录形式骨架 + skills/<name>/SKILL.md → 装载成功。
        let plugin_root = tmp.path().join("plugins").join("my-pack");
        let skill_dir = plugin_root.join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: d\n---\nbody",
        )
        .unwrap();
        std::fs::write(
            plugin_root.join("plugin.toml"),
            "schema = 1\nkind = \"tool\"\n\n[info]\nid = \"my-pack\"\ndisplay_name = \"My Pack\"\n",
        )
        .unwrap();

        let (agents, tools, errors) = load_manifests(&[]);
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert!(agents.is_empty());
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].0.info.id, "my-pack");
        assert!(tools[0].0.tool.is_none());
        assert_eq!(
            tools[0].1,
            plugin_root.join("plugin.toml"),
            "source_path 指向目录形式 plugin.toml（目录源分发依赖 parent 目录名 = id）"
        );

        // 2) 同骨架无 skills/ 目录源 → 拒绝（凭空裸骨架不合法）。
        let bare_root = tmp.path().join("plugins").join("bare-pack");
        std::fs::create_dir_all(&bare_root).unwrap();
        std::fs::write(
            bare_root.join("plugin.toml"),
            "schema = 1\nkind = \"tool\"\n\n[info]\nid = \"bare-pack\"\ndisplay_name = \"Bare\"\n",
        )
        .unwrap();
        let (_agents, tools, errors) = load_manifests(&[]);
        assert_eq!(tools.len(), 1, "bare-pack 不应装载");
        assert!(errors
            .iter()
            .any(|(f, r)| f == "plugin.toml" && r.contains("requires a [tool] section")));

        // 3) agents/ 单文件骨架（目录源探测恒 false）→ 拒绝。
        std::fs::create_dir_all(tmp.path().join("agents")).unwrap();
        std::fs::write(
            tmp.path().join("agents").join("single.toml"),
            "schema = 1\nkind = \"tool\"\n\n[info]\nid = \"single\"\ndisplay_name = \"Single\"\n",
        )
        .unwrap();
        let (_agents, tools, errors) = load_manifests(&[]);
        assert_eq!(tools.len(), 1, "single 不应装载");
        assert!(errors
            .iter()
            .any(|(f, r)| f == "single.toml" && r.contains("requires a [tool] section")));

        std::env::remove_var("JISHU_HUB_HOME");
    }
}
