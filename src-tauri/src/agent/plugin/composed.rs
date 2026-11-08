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
    // 需求14 M5 批1：html/interaction 自 TS 内置件组合化（mermaid 先例——
    // 组件经渲染键注册，描述符/挂载由本清单承载）。
    (
        "session.html-render",
        include_str!("../../../resources/composed-plugins/html-render.toml"),
    ),
    (
        "session.interaction-render",
        include_str!("../../../resources/composed-plugins/interaction-render.toml"),
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
        || BUILTIN_THEME_PLUGINS.iter().any(|(bid, _, _)| *bid == id)
}

/// 需求14 M2/P5 批2：内置主题插件（官方示范——「内置 = 注册表默认条目」
/// 的主题形态样例；内置三档基座保留在 index.css，K9 启动闪烁风险见 05 §12）。
/// 三元组 = (id, plugin.toml, theme.css)——部署时两文件成对落盘。
const BUILTIN_THEME_PLUGINS: &[(&str, &str, &str)] = &[(
    "session.theme-midnight",
    include_str!("../../../resources/composed-plugins/theme-midnight.toml"),
    include_str!("../../../resources/composed-plugins/theme-midnight.css"),
)];

/// 幂等部署内置组合清单（lib.rs 启动调用）。
/// v0.9.7 需求3 C3：**只物化 curated required 集**（默认安装 19 件中的
/// composed 形态）——非必需件不落盘 = 不在 plugin_list = 市场可见可装；
/// 用户已物化的非必需件**不覆盖**（尊重改造）、不删除；必需件保留覆写
/// 自愈（系统语义）。phase-divider 随需求2 去阶段化退出默认集（已物化
/// 用户侧残留不删——市场不再提供，重启后由 plugin_list 照常呈现）。
pub fn ensure_builtin_composed_manifests() {
    let required = market::required_composed_ids();
    for (id, toml) in BUILTIN_COMPOSED_MANIFESTS {
        let dir = composed_plugins_root().join(id);
        let target = dir.join("plugin.toml");
        // 非必需件且未物化 → 跳过（不落盘）；已物化 → 不覆盖（用户可能改造）。
        let is_required = required.contains(id);
        if !is_required && !target.is_file() {
            continue;
        }
        if !is_required {
            continue; // 已存在的非必需件：原样保留
        }
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(existing) = std::fs::read_to_string(&target) {
            if existing == *toml {
                continue;
            }
        }
        if let Err(e) = crate::util::atomic_write(&target, toml.as_bytes()) {
            log::warn!("[composition] deploy {id} failed: {e}");
        }
    }
    // 内置主题插件：清单 + theme.css 成对部署（幂等同判；同样按 required
    // 收敛——午夜蓝主题 v0.9.7 起进市场，默认不物化）。
    for (id, toml, css) in BUILTIN_THEME_PLUGINS {
        let dir = composed_plugins_root().join(id);
        let target = dir.join("plugin.toml");
        let is_required = required.contains(id);
        if !is_required && !target.is_file() {
            continue;
        }
        if !is_required {
            continue;
        }
        let _ = std::fs::create_dir_all(&dir);
        let needs_toml = match std::fs::read_to_string(&target) {
            Ok(existing) => existing != *toml,
            Err(_) => true,
        };
        if needs_toml {
            if let Err(e) = crate::util::atomic_write(&target, toml.as_bytes()) {
                log::warn!("[composition] deploy {id} failed: {e}");
            }
        }
        let css_target = dir.join("theme.css");
        let needs_css = match std::fs::read_to_string(&css_target) {
            Ok(existing) => existing != *css,
            Err(_) => true,
        };
        if needs_css {
            if let Err(e) = crate::util::atomic_write(&css_target, css.as_bytes()) {
                log::warn!("[composition] deploy {id} theme.css failed: {e}");
            }
        }
    }
}

/// v0.9.7 需求3 C2-①：市场安装——从内置清单物化单件（composed/composed-theme）。
pub fn materialize_builtin_composed(id: &str) -> Result<(), String> {
    if let Some((_, toml)) = BUILTIN_COMPOSED_MANIFESTS
        .iter()
        .find(|(bid, _)| *bid == id)
    {
        let dir = composed_plugins_root().join(id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {id}: {e}"))?;
        crate::util::atomic_write(&dir.join("plugin.toml"), toml.as_bytes())
            .map_err(|e| format!("write {id}: {e}"))?;
        return Ok(());
    }
    if let Some((_, toml, css)) = BUILTIN_THEME_PLUGINS.iter().find(|(bid, _, _)| *bid == id) {
        let dir = composed_plugins_root().join(id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {id}: {e}"))?;
        crate::util::atomic_write(&dir.join("plugin.toml"), toml.as_bytes())
            .map_err(|e| format!("write {id}: {e}"))?;
        crate::util::atomic_write(&dir.join("theme.css"), css.as_bytes())
            .map_err(|e| format!("write {id} theme.css: {e}"))?;
        return Ok(());
    }
    Err(format!("builtin composed manifest not found: {id}"))
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
    // 需求14 M1（02 §3.3「用户插件 > 内置」遮蔽）：用户件排前、内置组合件
    // 殿后（同组内仍按 id）。前端 matchBlockRenderer 首命中语义下，用户
    // 插件由此遮蔽同语言的内置渲染（mermaid 可被自建渲染器接管）；组合族
    // 与内置 TS 件之间的排序由前端 BlockRenderersProvider 按 source 分区
    // 完成（use-block-renderers.tsx），两配合成完整遮蔽链。
    out.sort_by(|a, b| {
        let a_builtin = is_builtin_composed(&a.0);
        let b_builtin = is_builtin_composed(&b.0);
        a_builtin.cmp(&b_builtin).then_with(|| a.0.cmp(&b.0))
    });
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
        // @file: 引用存在性（需求14 M2 泛化：render.component（混合代码件）
        // 与 theme.css（主题件）都查——缺失注入 _file_error 供前端装载期拒绝）。
        let file_refs = ["component", "css"]
            .iter()
            .filter_map(|key| {
                let section = if *key == "css" { "theme" } else { "render" };
                obj.get(section)
                    .and_then(|s| s.get(*key))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.strip_prefix("@file:"))
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();
        for rel in file_refs {
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
    /// 需求14 M1（02 §7 确认卡增强）：资产文件清单（名/字节数/sha256 前
    /// 8 位）——echarts.min.js 这类随插件分发的库对用户可见可核对。
    #[serde(default)]
    pub assets: Vec<PendingAssetInfo>,
    /// 能力接管范围摘要（如「将接管 echarts, chart 语言代码块渲染」）；
    /// 非渲染接管型插件为 None。
    #[serde(default)]
    pub takeover: Option<String>,
    /// 需求14 M3（B4/02 §5.2）：桥插件携带的可执行体清单（bridge.js 等
    /// ——确认卡**最高警示级**：启用即随插件启动第三方可执行体）。
    #[serde(default)]
    pub bridges: Vec<String>,
}

/// 待确认标记的资产条目（浅层常规文件；.pending-confirm 自身排除）。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAssetInfo {
    pub name: String,
    pub size: u64,
    pub sha8: String,
}

/// 标记增强数据（需求14 M1）：插件目录资产清单 + 语言接管摘要——CLI
/// finalize 与 GUI hybrid_plugin_save 两写入端共用，保证确认卡同形。
pub fn pending_confirm_extras(
    dir: &std::path::Path,
    manifest: &toml::Value,
) -> (Vec<PendingAssetInfo>, Option<String>) {
    use sha2::{Digest, Sha256};
    let mut assets = Vec::new();
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
            if name == ".pending-confirm" || name == "plugin.toml" {
                continue;
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let sha8 = Sha256::digest(&bytes)
                .iter()
                .take(4)
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            assets.push(PendingAssetInfo {
                name,
                size: bytes.len() as u64,
                sha8,
            });
        }
    }
    assets.sort_by(|a, b| a.name.cmp(&b.name));
    let source = manifest.get("source");
    let is_code_block = source
        .and_then(|s| s.get("type"))
        .and_then(|v| v.as_str())
        .is_some_and(|t| t == "code-block");
    let takeover = if is_code_block {
        let langs: Vec<String> = source
            .and_then(|s| s.get("languages"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| l.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if langs.is_empty() {
            None
        } else {
            Some(format!("将接管 {} 语言代码块渲染", langs.join(", ")))
        }
    } else if manifest.get("theme").is_some() {
        // 需求14 M2：主题插件确认卡摘要（外观是全局接管——警示级别同代码件）。
        Some("将应用全局外观主题".to_string())
    } else {
        None
    };
    (assets, takeover)
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
    // v0.9.7 需求3 C3.2：覆盖拒绝仅对 curated required 内置件保留；
    // 非必需内置件（如午夜蓝主题）允许被用户另存覆盖（市场可还原）。
    if is_builtin_composed(id) && market::is_required_plugin(id) {
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
    // 需求14 M1（02 §3.3）：code-block 语言接管冲突守卫——用户插件之间的
    // 语言集不得相交（先装先得，装第二个时 fail loud 指认接管者）；与内置
    // 组合件相交 = 遮蔽（用户>内置），不受此限。只对启用集校验（对方已
    // 禁用则不占语言位，禁用/移除对方即可化解冲突）。
    let source_type = value
        .get("source")
        .and_then(|s| s.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if source_type == "code-block" {
        let languages: Vec<String> = value
            .get("source")
            .and_then(|s| s.get("languages"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| l.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if !languages.is_empty() {
            let disabled = load_plugin_config().disabled;
            for (other_id, other) in composed_session_manifests() {
                if other_id == id || is_builtin_composed(&other_id) || disabled.contains(&other_id)
                {
                    continue;
                }
                let other_langs: Vec<String> = other
                    .get("source")
                    .and_then(|s| s.get("languages"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|l| l.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                if let Some(hit) = languages.iter().find(|l| other_langs.contains(l)) {
                    return Err(format!(
                        "语言接管冲突：语言「{hit}」已由插件 {other_id} 接管——请改语言集，或先禁用/移除对方（用户插件之间不允许同语言并存；遮蔽内置渲染不受限）"
                    ));
                }
            }
        }
    }
    let dir = composed_plugins_root().join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::util::atomic_write(&dir.join("plugin.toml"), toml.as_bytes())
        .map_err(|e| format!("写入清单失败: {e}"))
}

/// 删除用户组合插件；目录整体移除（启停记录随 plugins.json 清理由既有
/// rebuild 语义覆盖）。
/// v0.9.7 需求3 C3.2：守卫放宽——curated required 内置件拒绝删除（默认
/// 安装集不可拆）；**非必需内置件允许删除**（= 还原未部署态，市场恢复
/// 「安装」），并 forget 启停记录。
pub fn delete_composed_plugin(id: &str) -> Result<(), String> {
    if is_builtin_composed(id) && market::is_required_plugin(id) {
        return Err(format!(
            "内置组合插件 {id} 为系统内置，不可删除（可在市场查看）"
        ));
    }
    let dir = composed_plugins_root().join(id);
    if !dir.join("plugin.toml").is_file() {
        return Err(format!("组合插件 {id} 不存在"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    forget_plugin_disabled(id);
    Ok(())
}

// ── 声明驱动阶段流水线（v0.9.3 需求13 C4-slice2） ──────────────────────────
// 模板展开与前端 capabilities/pipeline/contracts.ts 的 STAGE_TEMPLATES/
// resolveStages 同义（两处小而稳定，改模板时同步）。
// v0.9.7 需求2 砍除#8：内置 phase.* 阶段模板随三阶段概念退役——引用即报错
//（存量 pipeline 插件的自定义 prompt 段不受影响）。

/// manifest 阶段声明展开 → 阶段数组（运行时统一形状）。
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
        if let Some(key) = stage.get("template").and_then(|v| v.as_str()) {
            return Err(format!(
                "阶段 {} 引用了已退役的阶段模板 {key}（v0.9.7 任务模式去阶段化）——请改为自定义 prompt 段",
                index + 1
            ));
        }
        let key = stage
            .get("key")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("stage-{}", index + 1));
        let name = stage
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("阶段 {}", index + 1));
        let prompt = stage
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let pick_list = |field: &str| -> Option<Vec<serde_json::Value>> {
            stage
                .get(field)
                .and_then(|v| v.as_array())
                .filter(|values| !values.is_empty())
                .map(|values| values.clone())
        };
        let stage_json = serde_json::json!({
            "key": key,
            "name": name,
            "prompt": prompt,
            "skills": pick_list("skills").unwrap_or_default(),
            "tools": pick_list("tools").unwrap_or_default(),
            "gate": stage
                .get("gate")
                .and_then(|v| v.as_str())
                .map(str::to_string)
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
        .map(|(id, manifest)| {
            let plugin_sec = manifest.get("plugin");
            let get_str = |key: &str| {
                plugin_sec
                    .and_then(|p| p.get(key))
                    .and_then(|v| v.as_str())
                    .map(String::from)
            };
            PluginDescriptor {
                display_name: get_str("name").unwrap_or_else(|| id.clone()),
                description: get_str("description"),
                id: id.clone(),
                kind: PluginKind::Session,
                // 需求14 M4（B9）：版本透出 [plugin].version 声明值——此前恒为
                // hub 版本（CARGO_PKG_VERSION），用户件「看版本」是假数据；
                // 未声明为 None（卡片 tooltip 不再显示误导版本）。
                version: get_str("version"),
                // 需求14 M4：source_path = 插件目录（详情「打开所在位置」与
                // 源码视图寻址；此前 None，目录信息无处可看）。
                source_path: Some(
                    composed_plugins_root()
                        .join(&id)
                        .to_string_lossy()
                        .to_string(),
                ),
                core: false,
                enabled: !disabled.contains(&id),
                has_mcp: false,
                has_panel: false,
                has_skill: false,
                has_pi_extension: false,
                panel: None,
                system: is_builtin_composed(&id),
                // 需求14 M4（04 §2.3-5/B15）：icon 透传 [plugin].icon——此前
                // 硬编码空串，新插件在管理面/能力中心一律回退同一图标。
                icon: get_str("icon").unwrap_or_default(),
                // 需求14 M4（G9 连带修复）：composed 此前恒 false——前端
                // 卸载按钮的 `plugin.composed` 分支是死代码（用户组合件在
                // GUI 一直删不了，只能 CLI）。置 true 后走 composed_plugin_
                // delete（内置守卫不变）。
                composed: true,
                // 1d：声明 [[pipeline.stages]] 的组合式插件归「流水线」分类
                //（video-maker 等编排形态；pipeline+render 共存型同样以流水线
                // 为主导形态分派）。
                has_pipeline: manifest.get("pipeline").is_some(),
                // 需求14 M4（G10 分类显式化）：显式声明优先于前端推断链。
                category: get_str("category"),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::manifest::env_test_lock;

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        env_test_lock().lock().unwrap_or_else(|e| e.into_inner())
    }

    fn code_block_toml(id: &str, languages: &[&str]) -> String {
        let langs = languages
            .iter()
            .map(|l| format!("\"{l}\""))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            r#"[plugin]
id = "{id}"
name = "{id}"
kind = "session-composed"

[source]
type = "code-block"
languages = [{langs}]

[render]
component = "@file:component.js"
mount = "block-renderer"
"#
        )
    }

    /// 需求14 M1（02 §3.3）：用户插件之间同语言互斥（fail loud 指认先装者）；
    /// 与内置组合件相交 = 遮蔽，不受限；对方已禁用则不占语言位。
    #[test]
    fn save_composed_manifest_language_conflict_guard() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());

        // 先装 A（echarts）→ 成功。
        save_composed_manifest(
            "session.a-charts",
            &code_block_toml("session.a-charts", &["echarts"]),
        )
        .expect("first install ok");

        // B 同语言 → 拒绝并指认 A。
        let err = save_composed_manifest(
            "session.b-charts",
            &code_block_toml("session.b-charts", &["echarts", "chart"]),
        )
        .expect_err("overlap must be rejected");
        assert!(err.contains("语言接管冲突"), "got: {err}");
        assert!(err.contains("session.a-charts"), "got: {err}");

        // B 改不相交语言 → 成功。
        save_composed_manifest(
            "session.b-charts",
            &code_block_toml("session.b-charts", &["chart"]),
        )
        .expect("disjoint languages ok");

        // 与内置组合件（mermaid）相交 = 遮蔽，允许。
        std::fs::create_dir_all(composed_plugins_root().join("session.mermaid-render")).unwrap();
        std::fs::write(
            composed_plugins_root()
                .join("session.mermaid-render")
                .join("plugin.toml"),
            code_block_toml("session.mermaid-render", &["mermaid", "mmd"])
                .replace("@file:component.js", "render.mermaid"),
        )
        .unwrap();
        save_composed_manifest(
            "session.my-mermaid",
            &code_block_toml("session.my-mermaid", &["mermaid"]),
        )
        .expect("shadowing builtin must be allowed");

        // 对方禁用后不占语言位：禁用 a-charts，c-charts 用 echarts → 成功。
        let mut cfg = load_plugin_config();
        cfg.disabled.push("session.a-charts".to_string());
        save_plugin_config(&cfg).unwrap();
        save_composed_manifest(
            "session.c-charts",
            &code_block_toml("session.c-charts", &["echarts"]),
        )
        .expect("disabled holder frees the language");

        std::env::remove_var("JISHU_HUB_HOME");
    }

    /// 需求14 M1（02 §3.3 遮蔽链后端半边）：组合清单排序 = 用户件在前
    ///（按 id）、内置组合件殿后——前端 matchBlockRenderer 首命中语义下
    /// 用户件由此遮蔽同语言内置渲染。
    #[test]
    fn composed_manifests_user_before_builtin_ordering() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());

        for (id, component) in [
            ("session.mermaid-render", "render.mermaid"),
            ("session.a-user", "@file:component.js"),
            ("session.z-user", "@file:component.js"),
        ] {
            let dir = composed_plugins_root().join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("plugin.toml"),
                code_block_toml(id, &["x"]).replace("@file:component.js", component),
            )
            .unwrap();
        }

        let order: Vec<String> = composed_session_manifests()
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert_eq!(
            order,
            vec![
                "session.a-user".to_string(),
                "session.z-user".to_string(),
                "session.mermaid-render".to_string(),
            ],
            "用户件须排在内置组合件之前（同组内按 id）"
        );

        std::env::remove_var("JISHU_HUB_HOME");
    }

    /// 需求14 M1（02 §7 确认卡增强）：资产清单（浅层、排除清单/标记）+
    /// 语言接管摘要。
    #[test]
    fn pending_confirm_extras_assets_and_takeover() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("session.echarts-render");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("plugin.toml"),
            code_block_toml("session.echarts-render", &["echarts", "chart"]),
        )
        .unwrap();
        std::fs::write(dir.join("component.js"), "JishuPlugin.register(...)").unwrap();
        std::fs::write(dir.join("echarts.min.js"), "fake-lib-bytes").unwrap();
        std::fs::write(dir.join(".pending-confirm"), "{}").unwrap();

        let manifest: toml::Value =
            code_block_toml("session.echarts-render", &["echarts", "chart"])
                .parse()
                .unwrap();
        let (assets, takeover) = pending_confirm_extras(&dir, &manifest);
        let names: Vec<&str> = assets.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["component.js", "echarts.min.js"]);
        assert!(assets.iter().all(|a| a.sha8.len() == 8 && a.size > 0));
        assert_eq!(
            takeover.as_deref(),
            Some("将接管 echarts, chart 语言代码块渲染")
        );

        // 非渲染接管型（messages 面板）→ 无接管摘要。
        let panel = r#"[plugin]
id = "session.panel"
name = "p"
kind = "session-composed"
[source]
type = "messages"
[render]
component = "render.list"
mount = "dock-panel"
"#;
        let (_, takeover_none) =
            pending_confirm_extras(&dir, &panel.parse::<toml::Value>().unwrap());
        assert!(takeover_none.is_none());
    }
}

/// 需求14 M4：plugin_read_file（G9 源码视图 IPC）——双落点寻址、浅层白名单
/// 与越界拒绝；CLI edit --field 定点编辑（R9）。
#[cfg(test)]
mod read_and_edit_tests {
    use super::*;

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn plugin_read_file_dual_location_and_traversal_guard() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        // 目录形态组合件：plugins/<id>/plugin.toml + component.js。
        save_composed_manifest(
            "session.read-hy",
            &format!(
                "[plugin]\nid = \"session.read-hy\"\nname = \"r\"\nkind = \"session-composed\"\n[source]\ntype = \"messages\"\n[render]\ncomponent = \"@file:component.js\"\nmount = \"dock-panel\"\n{}", 
                ""
            ),
        )
        .unwrap();
        let dir = composed_plugins_root().join("session.read-hy");
        std::fs::write(dir.join("component.js"), "JishuPlugin.register(...)\n").unwrap();
        // 单文件形态：agents/<id>.toml（虚拟名 plugin.toml）。
        std::fs::create_dir_all(crate::agent::manifest::manifest_dir()).unwrap();
        std::fs::write(
            crate::agent::manifest::manifest_dir().join("read-tool.toml"),
            "schema = 1\nkind = \"tool\"\n[info]\nid = \"read-tool\"\ndisplay_name = \"rt\"\n[tool]\nusage = \"x\"\ndescription = \"d\"\n",
        )
        .unwrap();

        let toml = crate::commands::agents::plugin_read_file(
            "session.read-hy".to_string(),
            "plugin.toml".to_string(),
        )
        .expect("dir-form toml");
        assert!(toml.content.contains("session-composed"));
        assert!(toml.path.ends_with("plugin.toml"));

        let js = crate::commands::agents::plugin_read_file(
            "session.read-hy".to_string(),
            "component.js".to_string(),
        )
        .expect("dir-form js");
        assert!(js.content.contains("JishuPlugin.register"));

        let single = crate::commands::agents::plugin_read_file(
            "read-tool".to_string(),
            "plugin.toml".to_string(),
        )
        .expect("single-form virtual name");
        assert!(single.path.ends_with("read-tool.toml"));

        // 越界/非法名拒绝：路径分隔、父目录段、点开头、不存在的单文件形态名。
        for bad in ["../x.toml", "sub/a.js", ".pending-confirm", "a/b"] {
            let err = crate::commands::agents::plugin_read_file(
                "session.read-hy".to_string(),
                bad.to_string(),
            )
            .expect_err(bad);
            assert!(
                err.contains("非法文件名") || err.contains("文件不存在"),
                "{bad}: {err}"
            );
        }
        let err = crate::commands::agents::plugin_read_file(
            "read-tool".to_string(),
            "component.js".to_string(),
        )
        .expect_err("single-form rejects non-manifest");
        assert!(err.contains("文件不存在"));

        std::env::remove_var("JISHU_HUB_HOME");
    }
}

/// 需求14 M2：[theme].css 的 @file: 存在性检查进 _file_error 链。
#[cfg(test)]
mod theme_tests {
    use super::*;

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn theme_css_missing_yields_file_error() {
        let _guard = lock_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("JISHU_HUB_HOME", tmp.path());
        save_composed_manifest(
            "session.theme-missing",
            r#"[plugin]
id = "session.theme-missing"
name = "t"
kind = "session-composed"
[theme]
css = "@file:theme.css"
base = "dark"
[render]
mount = "app-theme"
"#,
        )
        .unwrap();
        // 未落 theme.css → _file_error 注入（前端装载期拒绝并提示文件名）。
        let (_, manifest) = composed_session_manifests()
            .into_iter()
            .find(|(id, _)| id == "session.theme-missing")
            .expect("manifest present");
        assert_eq!(
            manifest.get("_file_error").and_then(|v| v.as_str()),
            Some("代码文件不存在: theme.css")
        );
        // 落盘后消除。
        std::fs::write(
            composed_plugins_root()
                .join("session.theme-missing")
                .join("theme.css"),
            "[data-jishu-theme=\"session.theme-missing\"]{}",
        )
        .unwrap();
        let (_, manifest) = composed_session_manifests()
            .into_iter()
            .find(|(id, _)| id == "session.theme-missing")
            .expect("manifest present");
        assert!(manifest.get("_file_error").is_none());
        std::env::remove_var("JISHU_HUB_HOME");
    }
}
