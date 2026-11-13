//! Pi Index 在线目录与扩展/技能更新（v0.9.7 需求3 补充，2026-11-13）。
//!
//! 数据源：<https://piindex.dev>（Pi 社区资源目录，数据底座为 GitHub
//! `BubblePtr/awesome-pi` 清单，CC0）。站点无公开 JSON API——直接解析
//! awesome-pi 的 raw README（条目行 `- [名称](github) - 描述 \`pi install
//! npm:<pkg>\``，章节标题=分类），本地关键词过滤即"查询接口"。
//!
//! 更新机制设计（skill 与扩展统一）：
//! - **检测更新**：已装清单 → 各源并发查 latest（扩展=npm registry
//!   dist-tags；技能=SkillHub detail.version）→ 与本地记录比对。
//! - **批量更新**：扩展=原子改写 pi `settings.json` 的 `npm:<pkg>@<ver>`
//!   钉定版本（pi 进程启动自装该版，与既有 packages sync 同机制，无需
//!   hub 代装）；技能=逐项重跑 `skillhub_install`（覆盖安装+台账刷新）。
//! - 两种更新都幂等（已是最新则无操作）。

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const LIST_URL: &str = "https://raw.githubusercontent.com/BubblePtr/awesome-pi/main/README.md";
const LIST_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiindexEntry {
    pub name: String,
    pub description: String,
    pub npm_package: Option<String>,
    pub github_url: Option<String>,
    pub category: String,
}

// ── 在线目录（awesome-pi 解析 + 缓存） ──

fn cache() -> &'static Mutex<Option<(Instant, Vec<PiindexEntry>)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<PiindexEntry>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("jishu-hub")
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_list() -> Result<Vec<PiindexEntry>, String> {
    {
        let guard = cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, list)) = guard.as_ref() {
            if at.elapsed() < LIST_TTL && !list.is_empty() {
                return Ok(list.clone());
            }
        }
    }
    let body = http()?
        .get(LIST_URL)
        .send()
        .await
        .map_err(|e| format!("piindex 不可达: {e}"))?
        .error_for_status()
        .map_err(|e| format!("piindex 响应异常: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let list = parse_awesome_readme(&body);
    if list.is_empty() {
        return Err("piindex 清单为空（解析失败或上游格式变化）".to_string());
    }
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), list.clone()));
    Ok(list)
}

/// 解析 awesome-pi README：`## 分类小节` 下 `- [名称](url) - 描述 \`pi
/// install npm:<pkg>\``。非 npm 形态（git: 等）照录（npm_package=None，
/// 前端安装入口按命令展示）。
fn parse_awesome_readme(body: &str) -> Vec<PiindexEntry> {
    let mut out = Vec::new();
    let mut category = String::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("## ") {
            category = rest
                .trim()
                .trim_matches('（')
                .split('（')
                .next()
                .unwrap_or(rest)
                .trim()
                .to_string();
            continue;
        }
        if !trimmed.starts_with("- ") {
            continue;
        }
        let rest = &trimmed[2..];
        // [名称](url) 前可能有 emoji 前缀（🔥 等）。
        let bracket_start = match rest.find('[') {
            Some(i) => i,
            None => continue,
        };
        let Some(name_end) = rest[bracket_start..].find(']') else {
            continue;
        };
        let name = &rest[bracket_start + 1..bracket_start + name_end];
        if name.is_empty() {
            continue;
        }
        let github_url = rest[bracket_start + name_end..]
            .strip_prefix("](")
            .and_then(|tail| tail.split(')').next())
            .filter(|u| u.starts_with("http"))
            .map(str::to_string);
        // 描述与安装命令：取行内反引里的 `pi install ...`；其余 `- 描述`。
        let npm_package = trimmed
            .split('`')
            .nth(1)
            .and_then(|cmd| cmd.strip_prefix("pi install npm:"))
            .map(str::to_string);
        let description = trimmed
            .split_once(" - ")
            .map(|(_, d)| d)
            .unwrap_or("")
            .split(" `")
            .next()
            .unwrap_or("")
            .trim()
            .trim_end_matches('。')
            .to_string();
        out.push(PiindexEntry {
            name: name.to_string(),
            description,
            npm_package,
            github_url,
            category: category.clone(),
        });
    }
    out
}

/// 检索：关键词命中名称/包名/描述（大小写不敏感；空关键词返回全量）。
pub async fn piindex_search(keyword: Option<&str>) -> Result<Vec<PiindexEntry>, String> {
    let list = fetch_list().await?;
    let Some(kw) = keyword.filter(|k| !k.trim().is_empty()) else {
        return Ok(list);
    };
    let kw = kw.trim().to_lowercase();
    Ok(list
        .into_iter()
        .filter(|e| {
            e.name.to_lowercase().contains(&kw)
                || e.description.to_lowercase().contains(&kw)
                || e.npm_package
                    .as_deref()
                    .is_some_and(|p| p.to_lowercase().contains(&kw))
        })
        .collect())
}

// ── 扩展（pi packages）检测/批量更新 ──

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUpdateStatus {
    pub package: String,
    pub installed: String,
    pub latest: String,
    pub has_update: bool,
}

fn agent_settings_path() -> Result<std::path::PathBuf, String> {
    crate::agent::jishu_self::paths::agent_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| e.to_string())
}

fn read_packages() -> Result<Vec<String>, String> {
    let path = agent_settings_path()?;
    let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("pi settings.json 损坏: {e}"))?;
    Ok(settings
        .get("packages")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

async fn npm_latest(pkg: &str) -> Result<String, String> {
    let value: serde_json::Value = http()?
        .get(format!("https://registry.npmjs.org/{pkg}"))
        .send()
        .await
        .map_err(|e| format!("npm registry 不可达: {e}"))?
        .error_for_status()
        .map_err(|e| format!("npm 查询失败（{pkg}）: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    value
        .get("dist-tags")
        .and_then(|t| t.get("latest"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("npm 无 latest 标签（{pkg}）"))
}

fn split_package(entry: &str) -> Option<(&str, &str)> {
    let pkg = entry.strip_prefix("npm:")?;
    pkg.rsplit_once('@').filter(|(name, _)| !name.is_empty())
}

/// 检测更新：settings.json 钉定版本 vs npm latest（并发）。
pub async fn extension_check_updates() -> Result<Vec<ExtensionUpdateStatus>, String> {
    let packages = read_packages()?;
    let futures: Vec<_> = packages
        .iter()
        .filter_map(|entry| {
            let (pkg, ver) = split_package(entry)?;
            Some(async move {
                match npm_latest(pkg).await {
                    Ok(latest) => ExtensionUpdateStatus {
                        package: pkg.to_string(),
                        installed: ver.to_string(),
                        has_update: latest != ver,
                        latest,
                    },
                    Err(e) => {
                        log::warn!("[piindex] {e}");
                        ExtensionUpdateStatus {
                            package: pkg.to_string(),
                            installed: ver.to_string(),
                            has_update: false,
                            latest: ver.to_string(),
                        }
                    }
                }
            })
        })
        .collect();
    Ok(futures_util::future::join_all(futures).await)
}

/// 批量更新：把给定包（空=全部有更新的）钉到 npm latest，原子写回
/// settings.json。pi 进程下次启动按新钉定版本自装；运行中的旧进程由
/// 签名漂移/新会话自然换代。
pub async fn extension_update(
    packages: Option<Vec<String>>,
) -> Result<Vec<ExtensionUpdateStatus>, String> {
    let statuses = extension_check_updates().await?;
    let targets: Vec<_> = statuses
        .iter()
        .filter(|s| match &packages {
            Some(list) => list
                .iter()
                .any(|p| p == &s.package || p == &format!("npm:{}@{}", s.package, s.installed)),
            None => true,
        })
        .filter(|s| s.has_update)
        .collect();
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    // 走 pi 包管理器安装到新版本（npm 装载 + settings.json 钉定注册一步
    // 完成——与安装链 pi_package_install_online 同机制，比我方手改
    // settings.json 更可靠：pi 的 managed install 同步维护 npm/package.json）。
    // 单包失败记 warn 继续（批量语义），全部失败才 Err。
    let mut updated: Vec<ExtensionUpdateStatus> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    for status in &targets {
        let source = format!("npm:{}@{}", status.package, status.latest);
        match crate::agent::jishu_self::JishuSelfAgent::run_pi_package_command("install", &source)
            .await
        {
            Ok(_) => updated.push(ExtensionUpdateStatus {
                package: status.package.clone(),
                installed: status.latest.clone(),
                latest: status.latest.clone(),
                has_update: false,
            }),
            Err(e) => {
                log::warn!("[piindex] 扩展更新失败 {}: {e}", status.package);
                failures.push(format!("{}: {e}", status.package));
            }
        }
    }
    if updated.is_empty() && !failures.is_empty() {
        return Err(failures.join("; "));
    }
    Ok(updated)
}

// ── 技能（SkillHub）检测/批量更新 ──

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateStatus {
    pub slug: String,
    pub installed: String,
    pub latest: String,
    pub has_update: bool,
}

pub async fn skillhub_check_updates() -> Result<Vec<SkillUpdateStatus>, String> {
    let installed: BTreeMap<String, String> = super::skillhub::skillhub_installed();
    let futures: Vec<_> = installed
        .iter()
        .map(|(slug, ver)| {
            let slug = slug.clone();
            let ver = ver.clone();
            async move {
                let latest = match super::skillhub::skillhub_detail(&slug).await {
                    Ok(d) if !d.version.is_empty() => d.version,
                    _ => {
                        return SkillUpdateStatus {
                            slug: slug.clone(),
                            installed: ver.clone(),
                            latest: ver.clone(),
                            has_update: false,
                        }
                    }
                };
                SkillUpdateStatus {
                    slug,
                    has_update: latest != ver,
                    installed: ver,
                    latest,
                }
            }
        })
        .collect();
    Ok(futures_util::future::join_all(futures).await)
}

/// 批量更新：逐项覆盖安装（skillhub_install 幂等——重下 zip 覆盖落盘 +
/// 台账刷新版本）。空=全部有更新的。
pub async fn skillhub_update(slugs: Option<Vec<String>>) -> Result<Vec<SkillUpdateStatus>, String> {
    let statuses = skillhub_check_updates().await?;
    let mut updated = Vec::new();
    for status in statuses {
        if !status.has_update {
            continue;
        }
        if let Some(list) = &slugs {
            if !list.contains(&status.slug) {
                continue;
            }
        }
        match super::skillhub::skillhub_install(&status.slug).await {
            Ok(_) => updated.push(SkillUpdateStatus {
                slug: status.slug,
                installed: status.latest.clone(),
                latest: status.latest,
                has_update: false,
            }),
            Err(e) => log::warn!("[piindex] skill 更新失败 {}: {e}", status.slug),
        }
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 清单解析：分类跟随 + npm 包名提取 + 描述剥离（非 npm 形态照录）。
    #[test]
    fn parses_awesome_entries() {
        let body = "## Subagents（子代理）\n\n- 🔥 [pi-subagents](https://github.com/nicobailon/pi-subagents) - 社区子代理扩展，支持链式。`pi install npm:pi-subagents`\n- [git-tool](https://github.com/x/git-tool) - git 工具。`pi install git:https://github.com/x/git-tool`\n";
        let list = parse_awesome_readme(body);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "pi-subagents");
        assert_eq!(list[0].npm_package.as_deref(), Some("pi-subagents"));
        assert!(list[0].description.contains("社区子代理"));
        assert!(list[0].category.contains("Subagents"));
        assert_eq!(list[1].npm_package, None);
    }

    /// settings.json 条目拆分（npm:pkg@ver）。
    #[test]
    fn splits_pinned_packages() {
        assert_eq!(
            split_package("npm:@juicesharp/rpiv-todo@2.11.0"),
            Some(("@juicesharp/rpiv-todo", "2.11.0"))
        );
        assert_eq!(
            split_package("npm:pi-lens@4.3.0"),
            Some(("pi-lens", "4.3.0"))
        );
        assert_eq!(split_package("git:https://x"), None);
    }
}
