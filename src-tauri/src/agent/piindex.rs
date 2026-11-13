//! Pi Index 在线目录与扩展/技能更新（v0.9.7 需求3 补充，2026-11-13 二轮）。
//!
//! 数据源：`GET https://piindex.dev/zh/`（Pi 社区资源目录中文页）——静态
//! HTML 全量内嵌 192 条资源卡片（其中 133 条扩展包 data-kind=packages），
//! 带**中文说明/中文分类/星数/周下载量/安装命令/详情页链接**，一次 GET
//! 即结构化清单（站点无 JSON API——页面即接口；robots 允许抓取）。
//! 解析规则移植自用户调研文档《pi-extension-api-spec.md》§11.4（regex
//! 卡片提取）；失败回落 npm pi-package 检索（前端兜底）。
//!
//! 更新机制（skill 与扩展统一）：
//! - **检测更新**：已装清单 → 各源并发查 latest（扩展=npm registry
//!   dist-tags；技能=SkillHub detail.version）→ 与本地记录比对。
//! - **批量更新**：扩展走 pi 包管理器 install npm:pkg@latest（装载+
//!   settings.json 钉定注册一步完成）；技能=逐项重跑 `skillhub_install`
//!   （覆盖安装+台账刷新）。两种更新都幂等。

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const LIST_URL: &str = "https://piindex.dev/zh/";
const LIST_TTL: Duration = Duration::from_secs(10 * 60);
/// 预期卡片量级（站点改版/解析漂移的告警线——低于此值视为解析失败回落）。
const MIN_EXPECTED_CARDS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiindexEntry {
    pub name: String,
    /// 中文说明（piindex 中文页，176/192 有；缺失为空串——前端兜底英文）。
    pub description: String,
    pub npm_package: Option<String>,
    pub github_url: Option<String>,
    /// 中文分类（resource-tag data-label；多分类以「/」连接）。
    pub category: String,
    /// 资源类型中文名（扩展包/主题等）。
    pub kind_label: String,
    /// piindex 详情页（相对路径 /zh/packages/<slug>/ → 绝对 URL）。
    pub detail_url: Option<String>,
    pub stars: Option<u64>,
    pub weekly_downloads: Option<u64>,
    /// 站点预拼接的中英文检索全文（data-search）。
    #[serde(default)]
    pub search_text: String,
}

// ── 在线目录（piindex.dev/zh/ 卡片解析 + 缓存） ──

fn cache() -> &'static Mutex<Option<(Instant, Vec<PiindexEntry>)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<PiindexEntry>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("jishu-hub")
        .build()
        .map_err(|e| e.to_string())
}

/// 磁盘缓存（需求3 四轮裁决：扩展列表 DB 缓存，每日首次打开比对更新）：
///  = { fetchedAt, entries }。
fn disk_cache_path() -> std::path::PathBuf {
    crate::agent::manifest::hub_home().join("piindex-cache.json")
}

fn read_disk_cache() -> Option<Vec<PiindexEntry>> {
    let content = std::fs::read_to_string(disk_cache_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    let entries: Vec<PiindexEntry> = serde_json::from_value(value.get("entries")?.clone()).ok()?;
    (entries.len() >= MIN_EXPECTED_CARDS).then_some(entries)
}

fn write_disk_cache(entries: &[PiindexEntry]) {
    let payload = serde_json::json!({
        "fetchedAt": chrono::Utc::now().to_rfc3339(),
        "entries": entries,
    });
    if let Ok(serialized) = serde_json::to_string_pretty(&payload) {
        let _ = crate::util::atomic_write(&disk_cache_path(), serialized.as_bytes());
    }
}

fn disk_cache_fresh_today() -> bool {
    let Ok(content) = std::fs::read_to_string(disk_cache_path()) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    let fetched = value
        .get("fetchedAt")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
    match fetched {
        // 本地日历日内的缓存视为新鲜（每日首次打开触发比对更新）。
        Some(at) => {
            at.with_timezone(&chrono::Local).date_naive() == chrono::Local::now().date_naive()
        }
        None => false,
    }
}

async fn fetch_list() -> Result<Vec<PiindexEntry>, String> {
    {
        let guard = cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, list)) = guard.as_ref() {
            if at.elapsed() < LIST_TTL && list.len() >= MIN_EXPECTED_CARDS {
                return Ok(list.clone());
            }
        }
    }
    // 内存缓存缺失：当日磁盘缓存命中直接用（不碰网络）。
    if disk_cache_fresh_today() {
        if let Some(entries) = read_disk_cache() {
            *cache().lock().unwrap_or_else(|e| e.into_inner()) =
                Some((Instant::now(), entries.clone()));
            return Ok(entries);
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
    let list = parse_piindex_html(&body);
    if list.len() < MIN_EXPECTED_CARDS {
        // 站点改版/结构漂移——宁可回落 npm 检索也不给残缺清单。
        return Err(format!(
            "piindex 清单解析异常（{} 条 < 预期 {}）——可能站点改版",
            list.len(),
            MIN_EXPECTED_CARDS
        ));
    }
    write_disk_cache(&list);
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), list.clone()));
    Ok(list)
}

/// 提取 HTML 属性值（已 HTML 实体反转义）。
fn attr_of(html: &str, name: &str) -> Option<String> {
    let pattern = regex::Regex::new(&format!(r#"{name}="([^"]*)""#)).ok()?;
    pattern
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| html_unescape(m.as_str()))
}

/// 剥标签取纯文本（压缩空白）。
fn text_of(html: &str) -> String {
    let stripped = regex::Regex::new(r"<[^>]+>")
        .map(|re| re.replace_all(html, " "))
        .unwrap_or_default();
    let squashed = regex::Regex::new(r"\s+")
        .map(|re| re.replace_all(&stripped, " "))
        .unwrap_or_default();
    html_unescape(squashed.trim())
}

fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// 解析 `<article class="resource">` 卡片（只留扩展包 data-kind=packages）。
/// 字段提取表见模块头引用的调研文档 §11.3。
fn parse_piindex_html(body: &str) -> Vec<PiindexEntry> {
    let card_re = match regex::Regex::new(r#"(?s)<article class="resource"([^>]*)>(.*?)</article>"#)
    {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for caps in card_re.captures_iter(body) {
        let attrs = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if attr_of(attrs, "data-kind").as_deref() != Some("packages") {
            continue;
        }
        // 名称：package-link 文本 → 标题链接 data-package（132/135 卡是 GitHub
        // 直链形态，带 data-package 属性——收版反馈：大量卡片只有编码名，
        // 根因即此处只认 package-link）→ 安装命令尾段反解。
        let name = regex::Regex::new(r#"class="package-link"[^>]*>([^<]+)</a>"#)
            .ok()
            .and_then(|re| re.captures(inner))
            .and_then(|c| c.get(1))
            .map(|m| html_unescape(m.as_str().trim()))
            .or_else(|| attr_of(inner, "data-package"));
        // 安装命令（data-copy；缺失回退 code 文本）。
        let install = attr_of(inner, "data-copy")
            .or_else(|| {
                regex::Regex::new(r"(?s)<code>(.*?)</code>")
                    .ok()
                    .and_then(|re| re.captures(inner))
                    .and_then(|c| c.get(1))
                    .map(|m| html_unescape(m.as_str().trim()))
            })
            .unwrap_or_default();
        let name = name.unwrap_or_else(|| {
            install
                .split_whitespace()
                .last()
                .unwrap_or_default()
                .trim_start_matches("npm:")
                .to_string()
        });
        if name.is_empty() {
            continue;
        }
        // npm 包名：仅 `pi install npm:<pkg>` 形态提供一键安装。
        let npm_package = install
            .strip_prefix("pi install npm:")
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
        // 中文说明：直接 <p> → <details> 折叠形态（description-full /
        // description-preview——收版反馈：pi-better-web-search 等 10 张卡
        // 无说明即此结构）。
        let description = regex::Regex::new(r"(?s)resource-description[^>]*>\s*<p>(.*?)</p>")
            .ok()
            .and_then(|re| re.captures(inner))
            .and_then(|c| c.get(1))
            .map(|m| text_of(m.as_str()))
            .or_else(|| {
                regex::Regex::new(r#"(?s)<p class="description-full">(.*?)</p>"#)
                    .ok()
                    .and_then(|re| re.captures(inner))
                    .and_then(|c| c.get(1))
                    .map(|m| text_of(m.as_str()))
            })
            .or_else(|| {
                regex::Regex::new(r#"(?s)<span class="description-preview">(.*?)</span>"#)
                    .ok()
                    .and_then(|re| re.captures(inner))
                    .and_then(|c| c.get(1))
                    .map(|m| text_of(m.as_str()))
            })
            .unwrap_or_default();
        // 中文分类（多个以 / 连接）+ 类型中文名。
        let category = regex::Regex::new(r#"class="resource-tag"[^>]*data-label="([^"]+)""#)
            .ok()
            .map(|re| {
                re.captures_iter(inner)
                    .filter_map(|c| c.get(1))
                    .map(|m| html_unescape(m.as_str()))
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default();
        let kind_label = regex::Regex::new(r#"class="resource-kind"[^>]*data-label="([^"]+)""#)
            .ok()
            .and_then(|re| re.captures(inner))
            .and_then(|c| c.get(1))
            .map(|m| html_unescape(m.as_str()))
            .unwrap_or_default();
        // GitHub 仓库 + 详情页链接（相对 → 绝对）。
        let github_url =
            regex::Regex::new(r#"href="(https://github.com/[^"]+)"[^>]*data-repo-link"#)
                .ok()
                .and_then(|re| re.captures(inner))
                .and_then(|c| c.get(1))
                .map(|m| html_unescape(m.as_str()));
        let detail_url = regex::Regex::new(r#"class="package-link"\s+href="(/zh/packages/[^"]+)""#)
            .ok()
            .and_then(|re| re.captures(inner))
            .and_then(|c| c.get(1))
            .map(|m| format!("https://piindex.dev{}", m.as_str()));
        out.push(PiindexEntry {
            name,
            description,
            npm_package,
            github_url,
            category,
            kind_label,
            detail_url,
            stars: attr_of(attrs, "data-stars").and_then(|v| v.parse().ok()),
            weekly_downloads: attr_of(attrs, "data-downloads").and_then(|v| v.parse().ok()),
            search_text: attr_of(attrs, "data-search").unwrap_or_default(),
        });
    }
    out
}

/// 手动触发刷新（「重新加载」按钮）：清两级缓存 → 强制网络拉取 → 写盘。
pub async fn piindex_refresh() -> Result<Vec<PiindexEntry>, String> {
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = None;
    fetch_list().await
}

/// 检索：关键词命中站点预拼的中文英文全文（data-search）+ 名称/包名
/// （大小写不敏感；空关键词返回全量）。
pub async fn piindex_search(keyword: Option<&str>) -> Result<Vec<PiindexEntry>, String> {
    let list = fetch_list().await?;
    let Some(kw) = keyword.filter(|k| !k.trim().is_empty()) else {
        return Ok(list);
    };
    let kw = kw.trim().to_lowercase();
    Ok(list
        .into_iter()
        .filter(|e| {
            e.search_text.to_lowercase().contains(&kw)
                || e.name.to_lowercase().contains(&kw)
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

/// 单包检测更新（已安装页卡片独立检查）。
pub async fn extension_check_update(package: &str) -> Result<ExtensionUpdateStatus, String> {
    let packages = read_packages()?;
    let entry = packages
        .iter()
        .find(|e| split_package(e).is_some_and(|(pkg, _)| pkg == package))
        .ok_or_else(|| format!("未安装: {package}"))?;
    let (pkg, ver) = split_package(entry).unwrap();
    let latest = npm_latest(pkg).await?;
    Ok(ExtensionUpdateStatus {
        package: pkg.to_string(),
        installed: ver.to_string(),
        has_update: latest != ver,
        latest,
    })
}

/// 单技能检测更新（已安装页卡片独立检查）。
pub async fn skillhub_check_update(slug: &str) -> Result<SkillUpdateStatus, String> {
    let installed = super::skillhub::skillhub_installed();
    let ver = installed
        .get(slug)
        .ok_or_else(|| format!("未安装: {slug}"))?
        .clone();
    let latest = super::skillhub::skillhub_detail(slug)
        .await
        .map_err(|e| format!("市场查询失败: {e}"))?
        .version;
    if latest.is_empty() {
        return Ok(SkillUpdateStatus {
            slug: slug.to_string(),
            installed: ver.clone(),
            latest: ver,
            has_update: false,
        });
    }
    Ok(SkillUpdateStatus {
        slug: slug.to_string(),
        has_update: latest != ver,
        installed: ver,
        latest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 清单解析：分类跟随 + npm 包名提取 + 描述剥离（非 npm 形态照录）。
    #[test]
    fn parses_piindex_cards() {
        let body = r#"<article class="resource" id="pi-web-access-x" data-kind="packages" data-stars="1779" data-downloads="295964" data-search="pi-web-access 网页与搜索 pi install npm:pi-web-access">
          <div class="resource-heading"><h3><a class="package-link" href="/zh/packages/pi-web-access/">pi-web-access</a></h3></div>
          <div class="resource-description"><p>Web 搜索、URL 获取与 PDF 提取。</p></div>
          <div class="resource-categories"><a class="resource-kind" data-label="扩展包">扩展包</a><a class="resource-tag" data-label="网页与搜索">网页与搜索</a></div>
          <a href="https://github.com/nicobailon/pi-web-access" data-repo-link="true">查看项目</a>
          <div class="install-command"><code>pi install npm:pi-web-access</code><button data-copy="pi install npm:pi-web-access"></button></div>
        </article>
        <article class="resource" data-kind="themes" data-stars="1" data-downloads="2"><h3><a class="package-link" href="/zh/packages/t/">theme-x</a></h3></article>"#;
        let list = parse_piindex_html(body);
        assert_eq!(list.len(), 1, "只留 packages 卡");
        let e = &list[0];
        assert_eq!(e.name, "pi-web-access");
        assert_eq!(e.npm_package.as_deref(), Some("pi-web-access"));
        assert!(e.description.contains("Web 搜索"));
        assert_eq!(e.category, "网页与搜索");
        assert_eq!(e.kind_label, "扩展包");
        assert_eq!(e.stars, Some(1779));
        assert_eq!(e.weekly_downloads, Some(295964));
        assert!(e
            .detail_url
            .as_deref()
            .unwrap_or("")
            .ends_with("/zh/packages/pi-web-access/"));
        assert!(e.github_url.as_deref().unwrap_or("").contains("github.com"));
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
