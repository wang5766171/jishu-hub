//! agent::plugin 子模块（v0.9.5 三轮评审拆分：零逻辑变更纯移动，
//! 来源与拆分说明见 plugin.rs 文件头 §12 处置说明）。

use super::*;

/// 内置组合式插件清单（v0.9.3 需求13 C1）：随包分发的 session-composed
/// manifest，启动幂等部署到 ~/.jishu-hub/plugins/<id>/plugin.toml（系统语义：
/// 重部署覆盖，用户改造需经新建组合插件另存）。
const BUILTIN_COMPOSED_MANIFESTS: &[(&str, &str)] = &[
    (
        "session.mermaid-render",
        include_str!("../../../resources/composed-plugins/mermaid-render.toml"),
    ),
    (
        "session.phase-divider",
        include_str!("../../../resources/composed-plugins/phase-divider.toml"),
    ),
    (
        "session.tool-stats",
        include_str!("../../../resources/composed-plugins/tool-stats.toml"),
    ),
    (
        "session.outline",
        include_str!("../../../resources/composed-plugins/outline.toml"),
    ),
    (
        "session.navigation",
        include_str!("../../../resources/composed-plugins/navigation.toml"),
    ),
    (
        "session.desktop-notify",
        include_str!("../../../resources/composed-plugins/desktop-notify.toml"),
    ),
    // v0.9.3 需求13 C4：pipeline 型样例（编排定义可视化；运行时驱动 C4-slice-2）。
    (
        "session.video-maker",
        include_str!("../../../resources/composed-plugins/video-maker.toml"),
    ),
    // v0.9.3 需求13 C5-slice1：任务看板自 session.flow 组合化（task 源 ×
    // render.task-board × dock；内置 TS 插件随之退役）。
    (
        "session.task-board",
        include_str!("../../../resources/composed-plugins/task-board.toml"),
    ),
    // v0.9.5 需求5 T9：识图路由（纯配置载体组合插件——无挂载无动作，
    // 承载图片委派话术/识图工具/识图模型三项配置，chat.rs 消费；系统
    // 语义随包分发，禁用 = 注入内置兜底话术）。
    (
        "session.image-dispatch",
        include_str!("../../../resources/composed-plugins/image-dispatch.toml"),
    ),
];

fn composed_plugins_root() -> PathBuf {
    crate::agent::manifest::hub_home().join("plugins")
}

/// 组合式插件根目录（v0.9.5 需求1（原需求26）1b：CLI 统一寻址——get/update/remove
/// 需直达 plugins/<id>/plugin.toml）。
pub fn composed_plugins_dir() -> PathBuf {
    composed_plugins_root()
}

/// 内置（随包）组合插件判定（1b：CLI remove 的内置保护——卸载是无操作，
/// 与 agents/ 分支的 is_system_plugin 同纪律）。
pub fn is_builtin_composed(id: &str) -> bool {
    BUILTIN_COMPOSED_MANIFESTS.iter().any(|(bid, _)| *bid == id)
}

/// 幂等部署内置组合清单（lib.rs 启动调用）。
pub fn ensure_builtin_composed_manifests() {
    for (id, toml) in BUILTIN_COMPOSED_MANIFESTS {
        let dir = composed_plugins_root().join(id);
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("plugin.toml");
        if let Ok(existing) = std::fs::read_to_string(&target) {
            if existing == *toml {
                continue;
            }
        }
        if let Err(e) = crate::util::atomic_write(&target, toml.as_bytes()) {
            log::warn!("[composition] deploy {id} failed: {e}");
        }
    }
}

/// 扫描组合式清单（kind=session-composed），toml → JSON 透传（前端引擎装配）。
/// v0.9.3 需求25：附带 `_files`（目录内文件 → 内容指纹，@file: 代码组件的
/// 存在性校验与热更指纹）与 `_dir`（绝对路径，前端构建 asset 加载 URL）。
pub fn composed_session_manifests() -> Vec<(String, serde_json::Value)> {
    let root = composed_plugins_root();
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        let toml_path = entry.path().join("plugin.toml");
        let Ok(content) = std::fs::read_to_string(&toml_path) else {
            continue;
        };
        let Ok(value) = content.parse::<toml::Value>() else {
            log::warn!("[composition] invalid toml: {}", toml_path.display());
            continue;
        };
        if value.get("plugin").and_then(|p| p.get("id")).is_none() {
            continue;
        }
        let id = value
            .get("plugin")
            .and_then(|p| p.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let mut json = serde_json::to_value(&value).unwrap_or(serde_json::Value::Null);
        attach_plugin_files(&mut json, &entry.path());
        out.push((id, json));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// 插件目录元信息注入（`_files`/`_dir`）：_files 取目录内常规文件（浅层）的
/// sha256 前 8 位（热更指纹）；@file: 引用的文件缺失时注入 `_file_error`
/// ——前端校验据此拒绝（错误信息带文件名）。
fn attach_plugin_files(json: &mut serde_json::Value, dir: &std::path::Path) {
    use sha2::{Digest, Sha256};
    let mut files = serde_json::Map::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let name = match entry.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let digest = Sha256::digest(&bytes);
            files.insert(
                name,
                digest
                    .iter()
                    .take(4)
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
                    .into(),
            );
        }
    }
    if let Some(obj) = json.as_object_mut() {
        // @file: 组件存在性（render.component 形如 "@file:component.js"）。
        let file_component = obj
            .get("render")
            .and_then(|r| r.get("component"))
            .and_then(|v| v.as_str())
            .and_then(|s| s.strip_prefix("@file:"))
            .map(str::to_string);
        if let Some(rel) = file_component {
            if !files.contains_key(&rel) {
                obj.insert(
                    "_file_error".into(),
                    format!("代码文件不存在: {rel}").into(),
                );
            }
        }
        obj.insert("_dir".into(), dir.to_string_lossy().to_string().into());
        obj.insert("_files".into(), serde_json::Value::Object(files));
    }
}

/// 混合插件安装待确认项（需求25 P2 安全阀）：CLI `plugins add-hybrid` 落盘
/// 的 `.pending-confirm` 标记内容。字段形状与 CLI 写入端（camelCase JSON，
/// cli/commands/plugins.rs add_hybrid）逐字对齐——serde rename_all 保证
/// 反序列化读标记 / 序列化回前端确认卡（TS PendingHybridPlugin 接口）同形。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingHybridPlugin {
    pub id: String,
    pub name: String,
    pub mount: String,
    pub code_lines: u64,
    pub dir: String,
}

/// 扫描 `~/.jishu-hub/plugins/*/.pending-confirm`（确认卡轮询数据源；CLI 是
/// 独立进程发不了 plugins-changed 广播，标记文件即跨进程信箱）。单个标记
/// 损坏/缺字段 → log warn 跳过（与 manifest 装载同纪律：局部失败不拖垮整表）。
pub fn pending_confirm_list() -> Vec<PendingHybridPlugin> {
    let root = composed_plugins_root();
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        let marker = entry.path().join(".pending-confirm");
        let Ok(content) = std::fs::read_to_string(&marker) else {
            continue;
        };
        match serde_json::from_str::<PendingHybridPlugin>(&content) {
            Ok(p) => out.push(p),
            Err(e) => log::warn!(
                "[plugin] invalid pending-confirm marker {}: {e}",
                marker.display()
            ),
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// 清除混合插件安装待确认标记（确认卡「启用/暂不」动作收尾；幂等，不存在
/// 则无操作）。确认动作复用 plugin_set_enabled——本函数在其成功路径调用。
pub fn clear_pending_confirm_marker(id: &str) {
    let marker = composed_plugins_root().join(id).join(".pending-confirm");
    if marker.is_file() {
        let _ = std::fs::remove_file(&marker);
    }
}

/// 用户组合清单保存（需求13 C3 向导落点）：校验可解析 + id 一致 + 非内置，
/// 原子写 ~/.jishu-hub/plugins/<id>/plugin.toml。
pub fn save_composed_manifest(id: &str, toml: &str) -> Result<(), String> {
    if id.trim().is_empty() || !id.starts_with("session.") {
        return Err("组合插件 id 须以 session. 开头".to_string());
    }
    if BUILTIN_COMPOSED_MANIFESTS.iter().any(|(bid, _)| *bid == id) {
        return Err(format!("内置组合插件 {id} 不可覆盖（可另存新 id）"));
    }
    let value: toml::Value = toml.parse().map_err(|e| format!("TOML 解析失败: {e}"))?;
    let decl_id = value
        .get("plugin")
        .and_then(|p| p.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if decl_id != id {
        return Err(format!("清单 id ({decl_id:?}) 与目标 id ({id:?}) 不一致"));
    }
    // 6c：[[agent-tool]] 名全局唯一（agent 工具名撞名会让 agent 无从
    // 分辨——安装/保存期拒绝，与既有插件 id 冲突检查同纪律）。
    let tool_names: Vec<String> = value
        .get("agent-tool")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if !tool_names.is_empty() {
        ensure_agent_tool_names_free(id, &tool_names)?;
    }
    let dir = composed_plugins_root().join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::util::atomic_write(&dir.join("plugin.toml"), toml.as_bytes())
        .map_err(|e| format!("写入清单失败: {e}"))
}

/// 删除用户组合插件（内置清单拒绝）；目录整体移除（启停记录随 plugins.json
/// 清理由既有 rebuild 语义覆盖）。
pub fn delete_composed_plugin(id: &str) -> Result<(), String> {
    if BUILTIN_COMPOSED_MANIFESTS.iter().any(|(bid, _)| *bid == id) {
        return Err(format!("内置组合插件 {id} 不可删除"));
    }
    let dir = composed_plugins_root().join(id);
    if !dir.join("plugin.toml").is_file() {
        return Err(format!("组合插件 {id} 不存在"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

// ── 声明驱动阶段流水线（v0.9.3 需求13 C4-slice2） ──────────────────────────
// 模板展开与前端 capabilities/pipeline/contracts.ts 的 STAGE_TEMPLATES/
// resolveStages 同义（两处小而稳定，改模板时同步）。

/// 内置阶段模板（Rust 复刻；键与前端 StageTemplateKey 一致）。
fn stage_template(key: &str) -> Option<serde_json::Value> {
    let value = match key {
        "phase.discuss" => serde_json::json!({
            "name": "需求讨论",
            "prompt": "与用户澄清目标/范围/约束，收敛为可执行的需求文档；未澄清前不进入下一阶段。",
            "skills": ["jishu-conductor-dev:discuss"],
            "tools": ["read", "grep", "find", "ls", "lock_requirement", "request_user_input"],
            "gate": "confirm",
            "outputs": [{ "kind": "document" }],
        }),
        "phase.plan" => serde_json::json!({
            "name": "流程规划",
            "prompt": "将需求拆分为有依赖关系的执行节点，产出 flow-plan；简单任务建议直接执行。",
            "skills": ["jishu-conductor-dev:plan"],
            "tools": ["read", "grep", "find", "ls", "commit_plan", "request_user_input"],
            "gate": "confirm",
            "outputs": [{ "kind": "plan" }],
        }),
        "phase.execute" => serde_json::json!({
            "name": "执行",
            "prompt": "按既定方案执行节点；阻塞/失败按重试与跳过策略处理，方案变更走修订。",
            "skills": ["jishu-conductor-dev:execute"],
            "tools": ["read", "bash", "edit", "write", "grep", "find", "ls", "commit_plan", "dispatch_to_node"],
            "gate": "none",
            "outputs": [{ "kind": "artifact" }],
        }),
        "phase.review" => serde_json::json!({
            "name": "评审确认",
            "prompt": "汇总产出请用户评审；通过则收尾，打回则回到指定阶段。",
            "skills": [],
            "tools": ["read", "grep", "find", "ls", "request_user_input"],
            "gate": "confirm",
            "outputs": [],
        }),
        _ => return None,
    };
    Some(value)
}

/// manifest 阶段声明展开（模板默认 ⨯ 声明覆盖）→ 阶段数组（运行时统一形状）。
pub fn resolve_pipeline_stages(
    manifest: &serde_json::Value,
) -> Result<Vec<serde_json::Value>, String> {
    let stages = manifest
        .get("pipeline")
        .and_then(|p| p.get("stages"))
        .and_then(|s| s.as_array())
        .ok_or("清单缺少 [pipeline].stages（非 pipeline 型插件）")?;
    if stages.is_empty() {
        return Err("[pipeline] 至少需要一个阶段".into());
    }
    let mut out = Vec::with_capacity(stages.len());
    for (index, stage) in stages.iter().enumerate() {
        let template_key = stage
            .get("template")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let template = match template_key.as_deref() {
            Some(key) => Some(
                stage_template(key)
                    .ok_or_else(|| format!("阶段 {} 引用了未知模板: {key}", index + 1))?,
            ),
            None => None,
        };
        let t = |field: &str| template.as_ref().and_then(|t| t.get(field).cloned());
        // key 缺省取模板短键（phase.discuss→discuss 等——与 legacy 阶段名一致，
        // 扩展侧深语义（lock_requirement/commit_plan 流）按 phase 名绑定）。
        let key = stage
            .get("key")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| {
                template_key
                    .as_deref()
                    .and_then(|t| t.strip_prefix("phase."))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("stage-{}", index + 1));
        let name = stage
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| t("name").and_then(|v| v.as_str().map(str::to_string)))
            .unwrap_or_else(|| format!("阶段 {}", index + 1));
        let declared_prompt = stage.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
        let template_prompt = t("prompt")
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let prompt = [template_prompt, declared_prompt.to_string()]
            .iter()
            .filter(|p| !p.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let pick_list = |field: &str| -> Option<Vec<serde_json::Value>> {
            let declared = stage.get(field).and_then(|v| v.as_array());
            match (declared, t(field).and_then(|v| v.as_array().cloned())) {
                (Some(values), _) if !values.is_empty() => Some(values.clone()),
                (None, Some(default)) => Some(default),
                _ => None,
            }
        };
        let stage_json = serde_json::json!({
            "key": key,
            "name": name,
            "template": template_key,
            "prompt": prompt,
            "skills": pick_list("skills").unwrap_or_default(),
            "tools": pick_list("tools").unwrap_or_default(),
            "gate": stage
                .get("gate")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| t("gate").and_then(|v| v.as_str().map(str::to_string)))
                .unwrap_or_else(|| "none".into()),
            "outputs": pick_list("outputs").unwrap_or_default(),
        });
        out.push(stage_json);
    }
    Ok(out)
}

/// 按插件 id 取展开后的流水线（`/jishu-pipeline` 扩展命令经 hub_invoke 消费）。
pub fn composed_pipeline_by_id(id: &str) -> Result<serde_json::Value, String> {
    let manifest = composed_session_manifests()
        .into_iter()
        .find(|(mid, _)| mid == id)
        .map(|(_, value)| value)
        .ok_or_else(|| format!("组合插件不存在: {id}"))?;
    let name = manifest
        .get("plugin")
        .and_then(|p| p.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or(id)
        .to_string();
    let stages = resolve_pipeline_stages(&manifest)?;
    Ok(serde_json::json!({ "pluginId": id, "name": name, "stages": stages }))
}

/// 组合式插件的描述符（plugin_list 合并；启停沿 plugins.json 统一禁用集合）。
pub fn composed_session_plugin_specs(disabled: &HashSet<String>) -> Vec<PluginDescriptor> {
    composed_session_manifests()
        .into_iter()
        .map(|(id, manifest)| PluginDescriptor {
            display_name: manifest
                .get("plugin")
                .and_then(|p| p.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string(),
            description: manifest
                .get("plugin")
                .and_then(|p| p.get("description"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            id: id.clone(),
            kind: PluginKind::Session,
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            source_path: None,
            core: false,
            enabled: !disabled.contains(&id),
            has_mcp: false,
            has_panel: false,
            has_skill: false,
            has_pi_extension: false,
            panel: None,
            system: BUILTIN_COMPOSED_MANIFESTS.iter().any(|(bid, _)| *bid == id),
            icon: String::new(),
            composed: false,
            // 1d：声明 [[pipeline.stages]] 的组合式插件归「流水线」分类
            //（video-maker 等编排形态；pipeline+render 共存型同样以流水线
            // 为主导形态分派）。
            has_pipeline: manifest.get("pipeline").is_some(),
        })
        .collect()
}
