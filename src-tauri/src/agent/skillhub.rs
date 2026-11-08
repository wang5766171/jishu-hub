//! v0.9.7 需求3 C2-③：技能市场（腾讯 SkillHub <https://skillhub.cn>）。
//!
//! 契约（评审二轮 §9 实测核实，无需鉴权）：
//! - 列表 `GET /api/skills?sortBy=score&keyword=&category=&pageSize=&page=`
//! - 详情 `GET /api/v1/skills/{slug}`
//! - 安装包 `GET /api/v1/download?slug=&source=dsh`（zip）
//! - 内容签名 `GET /api/v1/open/skills/{slug}/versions/{ver}/signature`（首版
//!   记 TODO，不阻塞安装）
//!
//! 安全约束：zip 拒绝路径穿越、必须含 `SKILL.md`、技能包不执行其中代码。
//! 落点：直接写到各 agent 技能目录（skill_deploy 同款目标清单——终态与
//! sync 等价：SKILL.md 在 agent skills 目录即被原生发现）；安装台账
//! `~/.jishu-hub/skillhub-installed.json` 驱动市场「已安装」态与卸载。

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://api.skillhub.cn";

/// 场景 id → SkillHub category（与前端 plugin-scenes.ts、curated.json scenes
/// 共用同一组场景 id；映射依据 场景分类与插件推荐.md §2）。
pub fn skillhub_category_for_scene(scene: &str) -> Option<&'static str> {
    match scene {
        "programming" => Some("dev-programming"),
        "office" => Some("office-efficiency"),
        "education" => Some("education"),
        "video" => Some("design-media"),
        "data" => Some("data-analysis"),
        "content" => Some("content-creation"),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SkillhubEntry {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub downloads: serde_json::Value,
    #[serde(default)]
    pub score: serde_json::Value,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub requires_api_key: bool,
    #[serde(default)]
    pub publisher_verified: bool,
    #[serde(default)]
    pub publisher_name: String,
}

#[derive(Debug, Serialize, Default)]
pub struct SkillhubListResult {
    pub entries: Vec<SkillhubEntry>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
}

fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("jishu-hub/0.9.7")
        .build()
}

/// 字段宽容提取（API 字段形态随版本可能有出入，缺失给默认值）。
fn entry_from_value(v: &serde_json::Value) -> SkillhubEntry {
    let as_str = |path: &[&str]| -> String {
        let mut cur = v;
        for key in path {
            cur = cur.get(*key).unwrap_or(&serde_json::Value::Null);
        }
        cur.as_str().unwrap_or_default().to_string()
    };
    SkillhubEntry {
        slug: as_str(&["slug"]),
        name: as_str(&["name"]),
        description: as_str(&["description_zh"])
            .is_empty()
            .then(|| as_str(&["description"]))
            .unwrap_or_else(|| as_str(&["description_zh"])),
        category: as_str(&["category"]),
        downloads: v
            .get("downloads")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        score: v.get("score").cloned().unwrap_or(serde_json::Value::Null),
        version: as_str(&["version"]),
        requires_api_key: v
            .get("labels")
            .and_then(|l| l.get("requires_api_key"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        publisher_verified: v
            .get("publisher")
            .and_then(|p| p.get("verified"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        publisher_name: as_str(&["publisher", "name"]),
    }
}

/// 列表（场景分组 / 关键词搜索 / 分页）。网络失败返回 Err（前端给重试态，
/// 不阻塞其它两源）。
pub async fn skillhub_list(
    scene: Option<&str>,
    keyword: Option<&str>,
    page: u32,
    page_size: u32,
) -> Result<SkillhubListResult, String> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 50);
    let mut url = format!("{API_BASE}/api/skills?sortBy=score&page={page}&pageSize={page_size}");
    if let Some(category) = scene.and_then(skillhub_category_for_scene) {
        url.push_str(&format!("&category={category}"));
    }
    if let Some(kw) = keyword.filter(|k| !k.trim().is_empty()) {
        url.push_str(&format!("&keyword={}", urlencode(kw.trim())));
    }
    let response = client()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("网络不可用: {e}"))?;
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    // 宽容定位列表字段（R1 生产实测修正：真实形状为 {code, data: {skills: [...]}}，
    // 兼容顶层或 data 内层的 skills/list/items 数组）。
    let arr = ["skills", "list", "items"]
        .iter()
        .find_map(|k| {
            body.get(*k)
                .and_then(|v| v.as_array())
                .or_else(|| body.get("data").and_then(|d| d.get(*k)).and_then(|v| v.as_array()))
        })
        .ok_or_else(|| "响应结构异常（无列表字段）".to_string())?;
    Ok(SkillhubListResult {
        entries: arr
            .iter()
            .map(entry_from_value)
            .filter(|e| !e.slug.is_empty())
            .collect(),
        total: body
            .get("total")
            .and_then(|t| t.as_u64())
            .unwrap_or(arr.len() as u64),
        page,
        page_size,
    })
}

/// 详情（含版本历史首项即最新版）。
pub async fn skillhub_detail(slug: &str) -> Result<SkillhubEntry, String> {
    let url = format!("{API_BASE}/api/v1/skills/{slug}");
    let response = client()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("网络不可用: {e}"))?;
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    let node = body.get("data").unwrap_or(&body);
    Ok(entry_from_value(node))
}

// ── 安装台账 ──

fn installed_registry_path() -> PathBuf {
    crate::agent::manifest::hub_home().join("skillhub-installed.json")
}

fn load_installed() -> BTreeMap<String, String> {
    std::fs::read_to_string(installed_registry_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_installed(map: &BTreeMap<String, String>) {
    let path = installed_registry_path();
    if let Ok(json) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(path, json);
    }
}

/// 已安装技能台账（市场「已安装」态）。
pub fn skillhub_installed() -> BTreeMap<String, String> {
    load_installed()
}

/// 各 agent 技能目录（与 skill_deploy::skill_targets 同族目标；直写终态
/// 与 sync 等价——SKILL.md 在 agent skills 目录即被原生发现）。
fn skill_target_dirs() -> Vec<PathBuf> {
    let mut targets = Vec::new();
    if let Some(home) = dirs::home_dir() {
        targets.push(home.join(".claude").join("skills"));
        targets.push(home.join(".codex").join("skills"));
        targets.push(home.join(".config").join("opencode").join("skills"));
    }
    if let Some(agent_dir) = crate::agent::jishu_self::pi_config_dir() {
        targets.push(PathBuf::from(agent_dir).join("skills"));
    }
    targets
}

/// 安装：下载 zip → 校验（拒穿越 + 必含 SKILL.md）→ 解压到各 agent 技能
/// 目录 `<dir>/<slug>/` → 记台账。
pub async fn skillhub_install(slug: &str) -> Result<String, String> {
    let detail = skillhub_detail(slug).await?;
    let version = if detail.version.is_empty() {
        "latest".to_string()
    } else {
        detail.version
    };
    let url = format!("{API_BASE}/api/v1/download?slug={slug}&source=dsh");
    let bytes = client()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
        .to_vec();
    // 解压到内存结构（先校验后落盘）。
    let reader = std::io::Cursor::new(&bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("安装包损坏: {e}"))?;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut has_skill_md = false;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("安装包损坏: {e}"))?;
        let name = entry.name().to_string();
        if name.contains("..") || name.starts_with('/') || name.starts_with('\\') {
            return Err(format!("安装包含可疑路径，已拒绝: {name}"));
        }
        if entry.is_dir() {
            continue;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("安装包读取失败: {e}"))?;
        let normalized = name.trim_start_matches("./").replace('\\', "/");
        if normalized == "SKILL.md" || normalized.ends_with("/SKILL.md") {
            has_skill_md = true;
        }
        files.push((normalized, buf));
    }
    if !has_skill_md {
        return Err("安装包缺少 SKILL.md，已拒绝（不是有效技能）".to_string());
    }
    // 剥可能的顶层目录（官方包常为 <slug>/SKILL.md 形态，统一收到 <slug>/ 下）。
    let strip_prefix = {
        let first = files.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>();
        common_top_dir(&first).filter(|top| !files.iter().any(|(n, _)| n == top))
    };
    let mut targets_written = 0;
    for dir in skill_target_dirs() {
        let target_root = dir.join(slug);
        // 幂等：重装先清旧目录。
        if target_root.exists() {
            let _ = std::fs::remove_dir_all(&target_root);
        }
        let mut ok = true;
        for (name, content) in &files {
            let rel = strip_prefix
                .as_ref()
                .and_then(|p| name.strip_prefix(&format!("{p}/")))
                .unwrap_or(name);
            let out = target_root.join(rel);
            if !out.starts_with(&target_root) {
                ok = false;
                break;
            }
            if let Some(parent) = out.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    ok = false;
                    break;
                }
            }
            if std::fs::write(&out, content).is_err() {
                ok = false;
                break;
            }
        }
        if ok {
            targets_written += 1;
        }
    }
    if targets_written == 0 {
        return Err("技能目录均不可写，安装失败".to_string());
    }
    let mut installed = load_installed();
    installed.insert(slug.to_string(), version.clone());
    save_installed(&installed);
    Ok(format!(
        "{slug}@{version} 已安装（{targets_written} 个智能体目录）"
    ))
}

/// 卸载：从各 agent 技能目录移除 + 销台账。
pub fn skillhub_uninstall(slug: &str) -> Result<String, String> {
    for dir in skill_target_dirs() {
        let target = dir.join(slug);
        if target.exists() {
            std::fs::remove_dir_all(&target)
                .map_err(|e| format!("remove {}: {e}", target.display()))?;
        }
    }
    let mut installed = load_installed();
    installed.remove(slug);
    save_installed(&installed);
    Ok(format!("{slug} 已卸载"))
}

fn common_top_dir<'a>(names: &[&'a str]) -> Option<String> {
    let first = names.first()?;
    let top = first.split('/').next()?;
    if top.is_empty() {
        return None;
    }
    if names.iter().all(|n| n.starts_with(&format!("{top}/"))) {
        Some(top.to_string())
    } else {
        None
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn scene_category_mapping() {
        assert_eq!(
            super::skillhub_category_for_scene("programming"),
            Some("dev-programming")
        );
        assert_eq!(
            super::skillhub_category_for_scene("video"),
            Some("design-media")
        );
        assert_eq!(super::skillhub_category_for_scene("custom"), None);
    }

    #[test]
    fn common_top_dir_detects_wrapper() {
        assert_eq!(
            super::common_top_dir(&["wps-office-suite/SKILL.md", "wps-office-suite/scripts/a.js"]),
            Some("wps-office-suite".to_string())
        );
        assert_eq!(super::common_top_dir(&["SKILL.md", "scripts/a.js"]), None);
    }

    #[test]
    fn entry_from_value_tolerates_shapes() {
        let v: serde_json::Value = serde_json::json!({
            "slug": "demo", "name": "Demo",
            "description_zh": "演示",
            "labels": {"requires_api_key": true},
            "publisher": {"verified": true, "name": "官方"}
        });
        let e = super::entry_from_value(&v);
        assert_eq!(e.slug, "demo");
        assert_eq!(e.description, "演示");
        assert!(e.requires_api_key);
        assert!(e.publisher_verified);
        assert_eq!(e.publisher_name, "官方");
    }
}
