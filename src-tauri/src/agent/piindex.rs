//! Pi Index 在线目录与扩展/技能更新（v0.9.7 需求3 补充，2026-11-13 二轮）。
//!
//! 数据源：`GET https://piindex.dev/zh/`（Pi 社区资源目录中文页）——静态
//! HTML 全量内嵌 194 条资源卡片，其中带 `pi install npm:/git:` 安装命令的
//! ≈170 条（扩展包+主题等 pi 包）全量收录，带**中文说明/中文分类/星数/
//! 周下载量/安装命令/piindex 链接**，一次 GET 即结构化清单（站点无 JSON
//! API——页面即接口；robots 允许抓取）。解析规则移植自用户调研文档
//! 《pi-extension-api-spec.md》§11.4（regex 卡片提取）；失败回落 npm
//! pi-package 检索（前端兜底）。
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
use tauri::Emitter;

const LIST_URL: &str = "https://piindex.dev/zh/";
const LIST_TTL: Duration = Duration::from_secs(10 * 60);
/// 预期卡片量级（站点改版/解析漂移的告警线——低于此值视为解析失败回落）。
const MIN_EXPECTED_CARDS: usize = 100;

/// 评审八（camelCase→snake_case 统一）：全仓 JSON 字段口径收敛为
/// snake_case——多词字段源码名本就是 snake_case，仅删 rename 属性即随
/// serde 默认（字段名原样）序列化。磁盘缓存负载随之变 snake（旧 camel
/// 负载由 CACHE_SCHEMA 版本闸整体拒收重拉，见下方注释）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiindexEntry {
    pub name: String,
    /// 中文说明（piindex 中文页，176/192 有；缺失为空串——前端兜底英文）。
    pub description: String,
    pub npm_package: Option<String>,
    pub github_url: Option<String>,
    /// 完整安装命令原文（`pi install npm:<pkg>` / `pi install git:github.com/…`）；
    /// git 源卡无 npm 包名，前端安装按钮直接取命令尾段作安装源。
    pub install_command: String,
    /// 中文分类（resource-tag data-label；多分类以「/」连接）。
    pub category: String,
    /// 资源类型中文名（扩展包/主题等）。
    pub kind_label: String,
    /// piindex 页面链接：详情页 /zh/packages/<slug>/（仅少数卡有）→
    /// 站内检索页 /zh/?q=<name>（站点 JS 读 ?q= 参数，全卡可定位）。
    pub detail_url: Option<String>,
    pub stars: Option<u64>,
    pub weekly_downloads: Option<u64>,
    /// 周下载量涨跌（站点预拼文本，如「▼30%」/「▲1%」；部分卡缺）。
    pub download_trend: Option<String>,
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
        // v0.9.8 需求8 D8-2-3：20s→12s——缩短弱网首判等待（8s 慢载提示出现
        // 后不久即可转入 npm 兜底，重试钮可点时机同步提前）。
        .timeout(Duration::from_secs(12))
        .user_agent("jishu-hub")
        .build()
        .map_err(|e| e.to_string())
}

/// 磁盘缓存（需求3 四轮裁决：扩展列表 DB 缓存，每日首次打开比对更新）：
///  = { schema, fetchedAt, entries }。
///
/// **schema 版本闸**：字段增删即 +1——旧版负载（无标记或版本不符）整体
/// 视为无缓存走网络重拉。否则新增 Option 字段（如 downloadTrend）在旧
/// 缓存上静默反序列化为 None，「重新加载」也救不回来（六轮收版实测：
/// 同日跨版本装包后涨跌数据永不出现，根因即此）。
fn disk_cache_path() -> std::path::PathBuf {
    crate::agent::manifest::hub_home().join("piindex-cache.json")
}

/// 当前缓存结构版本（v1=无 schema 标记的历史负载；v2=camelCase 字段；
/// v3=snake_case 字段——评审八：PiindexEntry 去掉 rename_all 后负载字段
/// 全变 snake_case，旧 camel 负载靠此闸整体拒收走网络重拉，不依赖反序列化
/// 恰好失败）。
const CACHE_SCHEMA: u64 = 3;

/// 磁盘缓存快照：(当日新鲜, 条目)。schema 不符/条目过少/解析失败 → None。
fn disk_cache_snapshot() -> Option<(bool, Vec<PiindexEntry>)> {
    let content = std::fs::read_to_string(disk_cache_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    if value.get("schema").and_then(|v| v.as_u64()) != Some(CACHE_SCHEMA) {
        return None;
    }
    let entries: Vec<PiindexEntry> = serde_json::from_value(value.get("entries")?.clone()).ok()?;
    if entries.len() < MIN_EXPECTED_CARDS {
        return None;
    }
    let fresh = value
        .get("fetchedAt")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|at| {
            // 本地日历日内视为新鲜（每日首次打开触发比对更新）。
            at.with_timezone(&chrono::Local).date_naive() == chrono::Local::now().date_naive()
        });
    Some((fresh, entries))
}

fn write_disk_cache(entries: &[PiindexEntry]) {
    let payload = serde_json::json!({
        "schema": CACHE_SCHEMA,
        "fetchedAt": chrono::Utc::now().to_rfc3339(),
        "entries": entries,
    });
    if let Ok(serialized) = serde_json::to_string_pretty(&payload) {
        let _ = crate::util::atomic_write(&disk_cache_path(), serialized.as_bytes());
    }
}

async fn fetch_list() -> Result<Vec<PiindexEntry>, String> {
    fetch_list_inner(false).await
}

// ── v0.9.8 需求8 A1：启动后台预拉取（每日对齐从「首次打开市场」提前到
//    「应用启动」——公司弱网首开市场不再空白等待）──────────────────────────

/// 单次预拉取：force 直连网络全量拉取（上游无版本号，「增量」的正确形态是
/// 全量拉取+差异判定——写盘一次幂等，无差异时 fetchedAt 更新即当日对齐）。
/// 返回是否有数据变化（决定是否 emit `piindex-updated`）。
async fn prefetch_once() -> Result<bool, String> {
    let prev: Vec<serde_json::Value> = disk_cache_snapshot()
        .map(|(_, entries)| {
            entries
                .iter()
                .map(|e| serde_json::to_value(e).unwrap_or_default())
                .collect()
        })
        .unwrap_or_default();
    let fresh = fetch_list_inner(true).await?;
    let next: Vec<serde_json::Value> = fresh
        .iter()
        .map(|e| serde_json::to_value(e).unwrap_or_default())
        .collect();
    Ok(prev != next)
}

/// 预拉取跳过判定（纯函数可单测）：当日缓存已对齐 → true（零网络）。
fn prefetch_should_skip() -> bool {
    disk_cache_snapshot().is_some_and(|(fresh, _)| fresh)
}

/// 启动后台预拉取（lib.rs setup 延后 ~10s 调用，避开启动高峰）：
/// 1. 无磁盘缓存（首装）→ 全量拉取写盘；
/// 2. 有缓存且 fetchedAt 非当日 → 全量拉取对齐（fetch 内写盘含 fetchedAt，
///    有差异与否都达成「当日对齐」——差异只影响是否通知前端）；
/// 3. 当日已对齐 → 跳过（零网络）；
/// 4. 失败静默重试一次（30s 退避），再失败放弃（下次启动再来）——启动预拉取
///    失败不弹任何 UI。
/// 数据有变化 → emit `piindex-updated`（市场页若开着增量刷新）。
pub async fn piindex_prefetch(app: tauri::AppHandle) {
    if prefetch_should_skip() {
        log::info!("[piindex] prefetch skip: 当日缓存已对齐");
        return;
    }
    let (changed, first_err) = match prefetch_once().await {
        Ok(changed) => (changed, None),
        Err(e) => {
            log::warn!("[piindex] prefetch 首次失败，30s 后静默重试: {e}");
            tokio::time::sleep(Duration::from_secs(30)).await;
            match prefetch_once().await {
                Ok(changed) => (changed, Some(e)),
                Err(e2) => {
                    log::warn!("[piindex] prefetch 重试仍失败，放弃（下次启动再来）: {e2}");
                    return;
                }
            }
        }
    };
    if let Some(e) = first_err {
        log::info!("[piindex] prefetch 重试成功（首次失败: {e}）");
    }
    if changed {
        log::info!("[piindex] prefetch: 目录数据有更新，emit piindex-updated");
        let _ = app.emit("piindex-updated", ());
    } else {
        log::info!("[piindex] prefetch: 目录数据无变化（fetchedAt 已对齐当日）");
    }
}

/// `force=true` 绕过两级缓存直连网络（「重新加载」按钮——只清内存缓存
/// 不够，当日磁盘缓存仍会短路命中，刷新变成空转）。
async fn fetch_list_inner(force: bool) -> Result<Vec<PiindexEntry>, String> {
    if !force {
        // 注意作用域：内存锁必须在此块内释放——下方磁盘命中分支要再次
        // lock 同一 Mutex，std::Mutex 不可重入，合并作用域 = 自锁死锁
        //（15:02 包「扩展生态一直转圈」根因：应用启动首次打开 + 当日磁盘
        // 缓存有效即触发，IPC 永不返回）。
        {
            let guard = cache().lock().unwrap_or_else(|e| e.into_inner());
            if let Some((at, list)) = guard.as_ref() {
                if at.elapsed() < LIST_TTL && list.len() >= MIN_EXPECTED_CARDS {
                    return Ok(list.clone());
                }
            }
        }
        // 内存缓存缺失：当日磁盘缓存命中直接用（不碰网络）。
        if let Some((true, entries)) = disk_cache_snapshot() {
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

/// 查询串百分号编码（RFC 3986 非保留字符直通；UTF-8 字节逐个转义——
/// 作用域包名 `@scope/pkg` 的 @ 与 / 也编码，避免拼进 ?q= 被截断）。
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
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

/// 解析 `<article class="resource">` 卡片（收录全部带 `pi install npm:/git:`
/// 安装命令的资源卡——扩展包 131 + 主题 35 + 其余 4 ≈ 170 条；curl 安装/
/// 无命令卡与 pi 无关不收）。字段提取表见模块头引用的调研文档 §11.3。
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
        // 收录闸：pi 包管理器可安装（npm:/git: 源）。本地路径等其余形态跳过。
        if !(install.starts_with("pi install npm:") || install.starts_with("pi install git:")) {
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
            .map(|m| format!("https://piindex.dev{}", m.as_str()))
            // 无详情页的卡（绝大多数）落 piindex 站内检索页——站点 JS 读
            // ?q= 参数预填搜索框，打开即定位到该卡（查看来源恒落 piindex）。
            .or_else(|| Some(format!("https://piindex.dev/zh/?q={}", url_encode(&name))));
        out.push(PiindexEntry {
            name,
            description,
            npm_package,
            github_url,
            install_command: install,
            category,
            kind_label,
            detail_url,
            stars: attr_of(attrs, "data-stars").and_then(|v| v.parse().ok()),
            weekly_downloads: attr_of(attrs, "data-downloads").and_then(|v| v.parse().ok()),
            // 周下载涨跌（▼30%/▲1%，stats 区 trend span；缺失为 None）。
            download_trend: regex::Regex::new(r#"class="trend (?:up|down)">([^<]+)<"#)
                .ok()
                .and_then(|re| re.captures(inner))
                .and_then(|c| c.get(1))
                .map(|m| html_unescape(m.as_str().trim())),
            search_text: attr_of(attrs, "data-search").unwrap_or_default(),
        });
    }
    out
}

/// 手动触发刷新（「重新加载」按钮）：清内存缓存 → 绕过磁盘缓存强制网络
/// 拉取 → 写盘（两级缓存都换新）。
pub async fn piindex_refresh() -> Result<Vec<PiindexEntry>, String> {
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = None;
    fetch_list_inner(true).await
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

/// 评审八：字段口径随全仓统一为 snake_case（has_update 等），删 rename 属性。
#[derive(Debug, Clone, Serialize)]
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

/// 版本不等判定（评审 P2：替代字符串不等，对齐项目既有 byVersionDesc 风格
/// ——按 `.` 分段数值比较，段缺失补 0；任一段非数字则回退字符串不等）。
/// 修复两误报："1.0" vs "1.0.0"（字符串不等 → 误报有更新）、
/// "1.2.10" vs "1.2.9"（字符串比较 10 < 9 → 误报无更新）。
fn version_ne(a: &str, b: &str) -> bool {
    let segs_a: Vec<&str> = a.trim().split('.').collect();
    let segs_b: Vec<&str> = b.trim().split('.').collect();
    let parsed = |segs: &[&str]| -> Option<Vec<u64>> {
        segs.iter().map(|s| s.parse::<u64>().ok()).collect()
    };
    match (parsed(&segs_a), parsed(&segs_b)) {
        (Some(va), Some(vb)) => {
            let len = va.len().max(vb.len());
            (0..len).any(|i| va.get(i).copied().unwrap_or(0) != vb.get(i).copied().unwrap_or(0))
        }
        // 非数字段（预发布后缀/元数据）无法数值化——回退字符串不等。
        _ => a != b,
    }
}

/// 批量更新报告（评审 P2：partial failure 可见——前端按字段渲染；跨端
/// 契约字段名冻结 updated/failed/name/error。partial failure 仍完成可完成
/// 的项，失败项带原因出现在 failed，不再整批 Err / 静默丢失）。
#[derive(Debug, Serialize)]
pub struct BatchUpdateReport {
    /// 成功更新的包名/slug 列表。
    pub updated: Vec<String>,
    /// 失败项（name + 原因）。
    pub failed: Vec<BatchUpdateFailure>,
}

/// 单个失败项（字段名跨端冻结：name/error）。
#[derive(Debug, Serialize)]
pub struct BatchUpdateFailure {
    pub name: String,
    pub error: String,
}

/// 逐项结果 → 报告（纯函数可单测；保序）。
fn batch_report(results: Vec<(String, Result<String, String>)>) -> BatchUpdateReport {
    let mut updated = Vec::new();
    let mut failed = Vec::new();
    for (name, outcome) in results {
        match outcome {
            Ok(_) => updated.push(name),
            Err(error) => failed.push(BatchUpdateFailure { name, error }),
        }
    }
    BatchUpdateReport { updated, failed }
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
                        has_update: version_ne(&latest, &ver),
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
/// 签名漂移/新会话自然换代。评审 P2：返回 {updated, failed} 双列报告——
/// partial failure 仍完成可完成的项，失败项不再整批 Err 或静默丢失。
pub async fn extension_update(packages: Option<Vec<String>>) -> Result<BatchUpdateReport, String> {
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
        return Ok(BatchUpdateReport {
            updated: Vec::new(),
            failed: Vec::new(),
        });
    }
    // 走 pi 包管理器安装到新版本（npm 装载 + settings.json 钉定注册一步
    // 完成——与安装链 pi_package_install_online 同机制，比我方手改
    // settings.json 更可靠：pi 的 managed install 同步维护 npm/package.json）。
    // 单包失败记 warn 继续（批量语义），失败随 failed 列如实上报。
    let mut results: Vec<(String, Result<String, String>)> = Vec::new();
    for status in &targets {
        let source = format!("npm:{}@{}", status.package, status.latest);
        let outcome =
            crate::agent::jishu_self::JishuSelfAgent::run_pi_package_command("install", &source)
                .await
                .map(|_| status.latest.clone());
        if let Err(e) = &outcome {
            log::warn!("[piindex] 扩展更新失败 {}: {e}", status.package);
        }
        results.push((status.package.clone(), outcome));
    }
    Ok(batch_report(results))
}

// ── 技能（SkillHub）检测/批量更新 ──

/// 评审八：字段口径随全仓统一为 snake_case（has_update 等），删 rename 属性。
#[derive(Debug, Clone, Serialize)]
pub struct SkillUpdateStatus {
    pub slug: String,
    pub installed: String,
    pub latest: String,
    pub has_update: bool,
}

pub async fn skillhub_check_updates() -> Result<Vec<SkillUpdateStatus>, String> {
    // 台账读不出来是「不知道装了什么」，不是「什么都没装」（评审修复轮 R3）。
    let installed: BTreeMap<String, String> =
        super::skillhub::skillhub_installed().map_err(|e| format!("无法检查技能更新：{e}"))?;
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
                    has_update: version_ne(&latest, &ver),
                    installed: ver,
                    latest,
                }
            }
        })
        .collect();
    Ok(futures_util::future::join_all(futures).await)
}

/// 批量更新：逐项覆盖安装（skillhub_install 幂等——重下 zip 覆盖落盘 +
/// 台账刷新版本）。空=全部有更新的。评审 P2：与 extension_update 同形状
/// 返回 {updated, failed}；partial failure 仍完成可完成的项。
pub async fn skillhub_update(slugs: Option<Vec<String>>) -> Result<BatchUpdateReport, String> {
    let statuses = skillhub_check_updates().await?;
    let mut results: Vec<(String, Result<String, String>)> = Vec::new();
    for status in statuses {
        if !status.has_update {
            continue;
        }
        if let Some(list) = &slugs {
            if !list.contains(&status.slug) {
                continue;
            }
        }
        let outcome = super::skillhub::skillhub_install(&status.slug).await;
        if let Err(e) = &outcome {
            log::warn!("[piindex] skill 更新失败 {}: {e}", status.slug);
        }
        results.push((status.slug, outcome));
    }
    Ok(batch_report(results))
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
        has_update: version_ne(&latest, &ver),
        latest,
    })
}

/// 单技能检测更新（已安装页卡片独立检查）。
pub async fn skillhub_check_update(slug: &str) -> Result<SkillUpdateStatus, String> {
    let installed =
        super::skillhub::skillhub_installed().map_err(|e| format!("无法检查技能更新：{e}"))?;
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
        has_update: version_ne(&latest, &ver),
        installed: ver,
        latest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 磁盘缓存文件类测试串行锁（Rust 测试默认并行——两个测试并发读写
    /// 同一 piindex-cache.json 会互踩：一个删文件，另一个落入真实网络
    /// 请求导致超时假失败）。评审 P1-18（M7）：锁内测试同时持有
    /// crate 级 env_test_lock 共享锁——碰 JISHU_HUB_HOME 的测试跨模块互斥，
    /// 防其它模块的 env 测试与本组测试竞态改写 home。
    static CACHE_TESTS_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 清单解析：npm/git 卡收录（主题卡同收）、curl/无命令卡跳过、
    /// git 卡 detail_url 兜底站内检索页、安装命令照录。
    #[test]
    fn parses_piindex_cards() {
        let body = r#"<article class="resource" id="pi-web-access-x" data-kind="packages" data-stars="1779" data-downloads="295964" data-search="pi-web-access 网页与搜索 pi install npm:pi-web-access">
          <div class="resource-heading"><h3><a class="package-link" href="/zh/packages/pi-web-access/">pi-web-access</a></h3></div>
          <div class="resource-description"><p>Web 搜索、URL 获取与 PDF 提取。</p></div>
          <div class="resource-categories"><a class="resource-kind" data-label="扩展包">扩展包</a><a class="resource-tag" data-label="网页与搜索">网页与搜索</a></div>
          <a href="https://github.com/nicobailon/pi-web-access" data-repo-link="true">查看项目</a>
          <span class="resource-stats"><span class="stat" title="npm 每周下载量"><svg></svg>29.6万/周<span class="trend down">▼30%</span></span></span>
          <div class="install-command"><code>pi install npm:pi-web-access</code><button data-copy="pi install npm:pi-web-access"></button></div>
        </article>
        <article class="resource" data-kind="packages" data-search="pi-websearch git">
          <h3><a class="package-link" href="https://github.com/code-yeongyu/pi-websearch" data-package="@code-yeongyu/pi-websearch">@code-yeongyu/pi-websearch</a></h3>
          <div class="resource-categories"><a class="resource-kind" data-label="扩展包">扩展包</a></div>
          <div class="install-command"><code>pi install git:github.com/code-yeongyu/pi-websearch</code><button data-copy="pi install git:github.com/code-yeongyu/pi-websearch"></button></div>
        </article>
        <article class="resource" data-kind="themes" data-search="tokyo night 主题">
          <h3><a class="package-link" href="https://github.com/x/pi-tokyo-night" data-package="pi-tokyo-night">pi-tokyo-night</a></h3>
          <div class="resource-categories"><a class="resource-kind" data-label="主题">主题</a><a class="resource-tag" data-label="暗色主题">暗色主题</a></div>
          <div class="install-command"><code>pi install npm:pi-tokyo-night</code><button data-copy="pi install npm:pi-tokyo-night"></button></div>
        </article>
        <article class="resource" data-kind="clients" data-search="curl 客户端">
          <h3><a class="package-link" href="https://github.com/x/some-client" data-package="some-client">some-client</a></h3>
          <div class="install-command"><code>curl -fsSL https://example.com | sh</code></div>
        </article>
        <article class="resource" data-kind="themes"><h3><a class="package-link" href="/zh/packages/t/">theme-x</a></h3></article>"#;
        let list = parse_piindex_html(body);
        assert_eq!(list.len(), 3, "npm/git 卡收（含主题），curl/无命令卡跳过");
        let e = &list[0];
        assert_eq!(e.name, "pi-web-access");
        assert_eq!(e.npm_package.as_deref(), Some("pi-web-access"));
        assert_eq!(e.install_command, "pi install npm:pi-web-access");
        assert!(e.description.contains("Web 搜索"));
        assert_eq!(e.category, "网页与搜索");
        assert_eq!(e.kind_label, "扩展包");
        assert_eq!(e.stars, Some(1779));
        assert_eq!(e.weekly_downloads, Some(295964));
        assert_eq!(e.download_trend.as_deref(), Some("▼30%"));
        assert!(e
            .detail_url
            .as_deref()
            .unwrap_or("")
            .ends_with("/zh/packages/pi-web-access/"));
        assert!(e.github_url.as_deref().unwrap_or("").contains("github.com"));
        // git 源卡：npm 包名缺失、命令照录、详情页兜底站内检索（?q= 编码）。
        let g = &list[1];
        assert_eq!(g.name, "@code-yeongyu/pi-websearch");
        assert_eq!(g.npm_package, None);
        assert_eq!(
            g.install_command,
            "pi install git:github.com/code-yeongyu/pi-websearch"
        );
        assert_eq!(
            g.detail_url.as_deref(),
            Some("https://piindex.dev/zh/?q=%40code-yeongyu%2Fpi-websearch")
        );
        // 主题 npm 卡同收，类型徽标保留。
        let th = &list[2];
        assert_eq!(th.name, "pi-tokyo-night");
        assert_eq!(th.kind_label, "主题");
        assert_eq!(th.npm_package.as_deref(), Some("pi-tokyo-night"));
    }

    /// 死锁回归（15:02 包事故）：内存缓存空 + 当日 schema:2 磁盘缓存 →
    /// 磁盘命中分支须能再次拿锁并返回（std::Mutex 不可重入；此前内存锁
    /// 作用域与磁盘分支合并 = 同线程自锁，IPC 永久挂起=扩展生态转圈）。
    /// 哨兵式：5s 超时即视为死锁失败。
    #[tokio::test]
    async fn fetch_list_disk_hit_path_does_not_deadlock() {
        let _serial = CACHE_TESTS_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        // P1-18（M7）：碰 disk_cache_path（JISHU_HUB_HOME）的测试持共享 env 锁。
        let _env = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = PiindexEntry {
            name: "pi-x".to_string(),
            description: String::new(),
            npm_package: Some("pi-x".to_string()),
            github_url: None,
            install_command: "pi install npm:pi-x".to_string(),
            category: String::new(),
            kind_label: String::new(),
            detail_url: None,
            stars: None,
            weekly_downloads: None,
            download_trend: None,
            search_text: String::new(),
        };
        let path = disk_cache_path();
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        let current = serde_json::json!({
            "schema": CACHE_SCHEMA,
            "fetchedAt": chrono::Local::now().to_rfc3339(),
            "entries": vec![entry; MIN_EXPECTED_CARDS],
        });
        std::fs::write(&path, current.to_string()).unwrap();
        *cache().lock().unwrap_or_else(|e| e.into_inner()) = None;
        let outcome =
            tokio::time::timeout(std::time::Duration::from_secs(5), fetch_list_inner(false)).await;
        assert!(
            outcome.is_ok(),
            "fetch_list_inner 超时——磁盘缓存命中路径自锁死锁"
        );
        assert!(outcome.unwrap().is_ok());
        *cache().lock().unwrap_or_else(|e| e.into_inner()) = None;
        let _ = std::fs::remove_file(&path);
    }

    /// 磁盘缓存 schema 闸：旧版负载（无 schema 标记）整体拒收——否则新增
    /// Option 字段在旧缓存上静默读出 None，同日跨版本装包后新数据永不出现
    /// （六轮收版实测回归锚点）。
    #[test]
    fn disk_cache_schema_gates_old_payloads() {
        let _serial = CACHE_TESTS_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        // P1-18（M7）：碰 disk_cache_path（JISHU_HUB_HOME）的测试持共享 env 锁。
        let _env = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = PiindexEntry {
            name: "pi-x".to_string(),
            description: String::new(),
            npm_package: Some("pi-x".to_string()),
            github_url: None,
            install_command: "pi install npm:pi-x".to_string(),
            category: String::new(),
            kind_label: String::new(),
            detail_url: None,
            stars: None,
            weekly_downloads: None,
            download_trend: None,
            search_text: String::new(),
        };
        let path = disk_cache_path();
        let dir = path.parent().unwrap().to_path_buf();
        let _ = std::fs::create_dir_all(&dir);
        // 旧版负载（无 schema 标记，其余字段齐备且当日）→ None。
        let legacy = serde_json::json!({
            "fetchedAt": chrono::Local::now().to_rfc3339(),
            "entries": vec![entry.clone(); MIN_EXPECTED_CARDS],
        });
        std::fs::write(&path, legacy.to_string()).unwrap();
        assert!(disk_cache_snapshot().is_none(), "旧 schema 负载必须拒收");
        // 当前 schema → 命中。
        let current = serde_json::json!({
            "schema": CACHE_SCHEMA,
            "fetchedAt": chrono::Local::now().to_rfc3339(),
            "entries": vec![entry; MIN_EXPECTED_CARDS],
        });
        std::fs::write(&path, current.to_string()).unwrap();
        let (fresh, entries) = disk_cache_snapshot().expect("当前 schema 应命中");
        assert!(fresh, "当日 fetchedAt 应视为新鲜");
        assert_eq!(entries.len(), MIN_EXPECTED_CARDS);
        let _ = std::fs::remove_file(&path);
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

    /// 评审 P2：版本数值段比较器——段缺失补 0（"1.0"=="1.0.0" 不误报有
    /// 更新）、数值序正确（"1.2.10"≠"1.2.9" 不误判相等）、非数字段回退
    /// 字符串不等。
    #[test]
    fn version_ne_numeric_segment_compare() {
        // 等价版本不误报（字符串不等曾误报的两类）。
        assert!(!version_ne("1.0", "1.0.0"));
        assert!(!version_ne("4.3", "4.3.0.0"));
        assert!(!version_ne("1.2.10", "1.2.10"));
        // 真实差异不漏报（含数值序：字符串比较 10 < 9 的反例）。
        assert!(version_ne("1.2.10", "1.2.9"));
        assert!(version_ne("1.2.9", "1.2.10"));
        assert!(version_ne("2.0.0", "1.9.9"));
        // 非数字段（预发布/元数据）回退字符串不等。
        assert!(version_ne("1.0.0-beta", "1.0.0"));
        assert!(version_ne("abc", "abd"));
        assert!(!version_ne("abc", "abc"));
    }

    /// 评审 P2：批量更新报告——updated/failed 双列如实分装、保序、
    /// partial failure 不丢失败项也不拦成功项。
    #[test]
    fn batch_report_splits_updated_and_failed() {
        let results = vec![
            ("a".to_string(), Ok("1.0".to_string())),
            ("b".to_string(), Err("boom".to_string())),
            ("c".to_string(), Ok("2.0".to_string())),
            ("d".to_string(), Err("slow".to_string())),
        ];
        let report = batch_report(results);
        assert_eq!(report.updated, vec!["a".to_string(), "c".to_string()]);
        assert_eq!(report.failed.len(), 2);
        assert_eq!(report.failed[0].name, "b");
        assert_eq!(report.failed[0].error, "boom");
        assert_eq!(report.failed[1].name, "d");
        assert_eq!(report.failed[1].error, "slow");
        // 全成功 / 全失败两极。
        let all_ok = batch_report(vec![("x".to_string(), Ok(String::new()))]);
        assert!(all_ok.failed.is_empty() && all_ok.updated == vec!["x".to_string()]);
        let all_bad = batch_report(vec![("y".to_string(), Err("e".to_string()))]);
        assert!(all_bad.updated.is_empty() && all_bad.failed.len() == 1);
        assert_eq!(batch_report(Vec::new()).updated.len(), 0);
    }

    /// v0.9.8 需求8 A1：预拉取跳过判定——当日缓存已对齐跳过（零网络），
    /// 隔日/无缓存触发预拉取。
    #[test]
    fn prefetch_skip_decision_by_day() {
        let _serial = CACHE_TESTS_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let _env = crate::agent::manifest::env_test_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = PiindexEntry {
            name: "pi-x".to_string(),
            description: String::new(),
            npm_package: Some("pi-x".to_string()),
            github_url: None,
            install_command: "pi install npm:pi-x".to_string(),
            category: String::new(),
            kind_label: String::new(),
            detail_url: None,
            stars: None,
            weekly_downloads: None,
            download_trend: None,
            search_text: String::new(),
        };
        let path = disk_cache_path();
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        // 当日 fetchedAt → 跳过
        std::fs::write(
            &path,
            serde_json::json!({
                "schema": CACHE_SCHEMA,
                "fetchedAt": chrono::Local::now().to_rfc3339(),
                "entries": vec![entry.clone(); MIN_EXPECTED_CARDS],
            })
            .to_string(),
        )
        .unwrap();
        assert!(prefetch_should_skip(), "当日缓存应跳过预拉取");
        // 隔日 fetchedAt → 触发
        let yesterday = chrono::Local::now() - chrono::Duration::days(1);
        std::fs::write(
            &path,
            serde_json::json!({
                "schema": CACHE_SCHEMA,
                "fetchedAt": yesterday.to_rfc3339(),
                "entries": vec![entry; MIN_EXPECTED_CARDS],
            })
            .to_string(),
        )
        .unwrap();
        assert!(!prefetch_should_skip(), "隔日缓存应触发预拉取");
        let _ = std::fs::remove_file(&path);
    }
}
