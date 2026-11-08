//! v0.9.7 需求3 C2-①/C3：精选插件市场（curated.json 单一真源）与
//! 默认安装集收敛的权威模块。
//!
//! - `curated.json`（include_str 内嵌）同时驱动：市场精选列表、required
//!   19 件默认安装集（`ensure_*` 收敛的物化范围、`plugin_set_enabled`
//!   的拒绝禁用名单）、需求4 首启场景推荐（`scenes[]`）。
//! - 安装/卸载按 kind 分派：composed（+theme）/ agent（agents 清单形态）/
//!   pi-package（toml + npm 包）/ builtin-ts（编译内置，启停即装卸）。
//! - 「不落盘 = 不装」：非必需件默认不物化——不出现在 plugin_list，市场
//!   可见可装；已物化的非必需件升级不覆盖（尊重用户改造）。

use super::*;

const CURATED_JSON: &str = include_str!("../../../resources/plugin-market/curated.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketEntry {
    pub id: String,
    /// agent | pi-package | composed | composed-theme | builtin-ts
    pub kind: String,
    pub title: String,
    pub description: String,
    pub category: String,
    #[serde(default)]
    pub scenes: Vec<String>,
    pub required: bool,
}

#[derive(Debug, Deserialize)]
struct CuratedFile {
    #[serde(default)]
    _meta: serde_json::Value,
    entries: Vec<MarketEntry>,
}

fn curated() -> &'static Vec<MarketEntry> {
    static CURATED: std::sync::OnceLock<Vec<MarketEntry>> = std::sync::OnceLock::new();
    CURATED.get_or_init(|| {
        serde_json::from_str::<CuratedFile>(CURATED_JSON)
            .unwrap_or_else(|e| panic!("curated.json parse failed: {e}"))
            .entries
    })
}

/// 按场景过滤（None = 全量；场景 id 与前端 plugin-scenes.ts 共用）。
pub fn market_list_curated(scene: Option<&str>) -> Vec<MarketEntry> {
    match scene {
        None | Some("custom") => curated().clone(),
        Some(scene) => curated()
            .iter()
            .filter(|e| e.scenes.iter().any(|s| s == scene))
            .cloned()
            .collect(),
    }
}

/// required 插件判定（plugin_set_enabled 拒绝禁用 / 收敛物化范围的单一真源）。
pub fn is_required_plugin(id: &str) -> bool {
    curated().iter().any(|e| e.required && e.id == id)
}

fn entry(id: &str) -> Result<&'static MarketEntry, String> {
    curated()
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("market entry not found: {id}"))
}

// ── 收敛物化（C3：ensure_* 的取材范围）──

/// curated required 且形态为 composed 的 id 集（ensure_builtin_composed_manifests
/// 只物化这些 + 已存在的非必需件不动）。
pub fn required_composed_ids() -> Vec<&'static str> {
    curated()
        .iter()
        .filter(|e| e.required && (e.kind == "composed" || e.kind == "composed-theme"))
        .map(|e| e.id.as_str())
        .collect()
}

/// curated required 且 agents 清单形态的 id 集（ensure_builtin_adaptive_plugins
/// 只物化这些；task-requirements/task-plan 等推荐件默认不落盘）。
pub fn required_agent_ids() -> Vec<&'static str> {
    curated()
        .iter()
        .filter(|e| e.required && e.kind == "agent")
        .map(|e| e.id.as_str())
        .collect()
}

/// pi-package 形态的 required id 集（toml 物化范围；npm 包安装仍由启动
/// 自愈按钉版清单执行——包在而闸门不在 = 能力不注入，语义等价未装）。
pub fn required_pi_package_ids() -> Vec<&'static str> {
    curated()
        .iter()
        .filter(|e| e.required && e.kind == "pi-package")
        .map(|e| e.id.as_str())
        .collect()
}

// ── 安装 / 卸载（市场执行面）──

/// 安装精选条目（幂等）。pi-package 形态含 npm 包安装（异步）。
pub async fn market_install(id: &str) -> Result<String, String> {
    let e = entry(id)?;
    match e.kind.as_str() {
        "composed" | "composed-theme" => {
            composed::materialize_builtin_composed(id)?;
            forget_plugin_disabled(id);
            Ok(format!("{id} installed"))
        }
        "agent" => {
            materialize_agent_toml(id)?;
            forget_plugin_disabled(id);
            Ok(format!("{id} installed"))
        }
        "pi-package" => {
            materialize_agent_toml(id)?;
            forget_plugin_disabled(id);
            // npm 包安装走 pi 侧钉版命令（失败回滚 toml——包不在时闸门
            // 指向不存在的工具，宁可整体失败）。
            if let Some(source) = pinned_source_for_plugin(id) {
                if let Err(err) = super::super::jishu_self::JishuSelfAgent::run_pi_package_command(
                    "install", &source,
                )
                .await
                {
                    let _ = remove_agent_toml(id);
                    return Err(err);
                }
            }
            Ok(format!("{id} installed"))
        }
        "builtin-ts" => {
            // 编译内置件：安装 = 启用（卸载 = 禁用），无盘面动作。
            set_plugin_enabled(id, true)?;
            Ok(format!("{id} enabled"))
        }
        other => Err(format!("unsupported market kind: {other}")),
    }
}

/// 卸载精选条目（还原未部署态）。required 件拒绝。
pub async fn market_uninstall(id: &str) -> Result<String, String> {
    let e = entry(id)?;
    if e.required {
        return Err(format!("{id} 为系统内置插件，不可卸载"));
    }
    match e.kind.as_str() {
        "composed" | "composed-theme" => {
            let dir = composed::composed_plugins_dir().join(id);
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|err| format!("remove {id}: {err}"))?;
            }
            forget_plugin_disabled(id);
            Ok(format!("{id} uninstalled"))
        }
        "agent" => {
            remove_agent_toml(id)?;
            forget_plugin_disabled(id);
            Ok(format!("{id} uninstalled"))
        }
        "pi-package" => {
            // 先禁用（同步摘 settings.json packages 条目），再撤 toml；
            // npm 包保留（重装秒回，且不破坏其余依赖盘面）。
            set_plugin_enabled(id, false)?;
            remove_agent_toml(id)?;
            forget_plugin_disabled(id);
            Ok(format!("{id} uninstalled（npm 包保留，重装即用）"))
        }
        "builtin-ts" => {
            set_plugin_enabled(id, false)?;
            Ok(format!("{id} disabled"))
        }
        other => Err(format!("unsupported market kind: {other}")),
    }
}

// ── 内部助手 ──

fn agent_toml_source(id: &str) -> Option<&'static str> {
    builtin_adaptive_plugins()
        .into_iter()
        .find(|(bid, _)| *bid == id)
        .map(|(_, t)| t)
}

fn materialize_agent_toml(id: &str) -> Result<(), String> {
    let toml =
        agent_toml_source(id).ok_or_else(|| format!("builtin manifest not found for {id}"))?;
    let dir = crate::agent::manifest::manifest_dir();
    let _ = std::fs::create_dir_all(&dir);
    std::fs::write(dir.join(format!("{id}.toml")), toml)
        .map_err(|e| format!("deploy {id}.toml: {e}"))
}

fn remove_agent_toml(id: &str) -> Result<(), String> {
    let target = crate::agent::manifest::manifest_dir().join(format!("{id}.toml"));
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| format!("remove {id}.toml: {e}"))?;
    }
    Ok(())
}

/// 插件 id → 钉版 npm 源（PI_PACKAGE_PLUGIN_MAP + jishu_self 钉版表）。
fn pinned_source_for_plugin(id: &str) -> Option<String> {
    let (_, pkg) = PI_PACKAGE_PLUGIN_MAP.iter().find(|(pid, _)| *pid == id)?;
    super::super::jishu_self::JishuSelfAgent::pinned_source_for_package(pkg).map(|s| s.to_string())
}
