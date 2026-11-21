// v0.9.8 需求5（合并版）：匹配层纯函数（L0 本地标签计算 / L1 画像消费）。
// 零推理：任务文本/画像 ∩ 标签库 ∩ 未装 → 星级加权排序。agent（L2）只在
// 这两层覆盖不了时介入——大部分请求不过模型。

import type { CatalogEntry, TaskProfile } from "./api";

/** 星级权重（设计 §3.1：5星=1.2 / 4星=1.1 / 3星=1.0；★2 不进推荐）。 */
const STAR_WEIGHT: Record<number, number> = { 5: 1.2, 4: 1.1, 3: 1.0 };

export interface MatchInput {
  catalog: CatalogEntry[];
  /** 已装 ref 集（派生态：plugin_list ∪ skillhub_installed ∪ pi sources）。 */
  installedRefs: Set<string>;
  /** 仅官方件（配置 third_party=false 时过滤）。 */
  officialOnly?: boolean;
}

export interface MatchHit {
  entry: CatalogEntry;
  score: number;
  /** 命中的标签（展示/测试取证用）。 */
  hitTags: string[];
}

/** 标签命中：任务文本包含标签（子串；英文忽略大小写）。 */
function tagHits(text: string, tags: string[]): string[] {
  const lower = text.toLowerCase();
  return tags.filter((t) => {
    const tag = t.trim();
    if (!tag) return false;
    return lower.includes(tag.toLowerCase());
  });
}

function isCandidate(entry: CatalogEntry, installedRefs: Set<string>, officialOnly: boolean): boolean {
  if (installedRefs.has(entry.ref)) return false;
  if ((entry.stars ?? 3) < 3) return false;
  if (officialOnly && !entry.ref.startsWith("curated:")) return false;
  return entry.tags.length > 0;
}

/** L0：任务文本（输入草稿/最近用户消息）→ 标签命中排序。 */
export function matchByTags(text: string, input: MatchInput, limit = 3): MatchHit[] {
  const trimmed = text.trim();
  if (trimmed.length < 2) return [];
  const hits: MatchHit[] = [];
  for (const entry of input.catalog) {
    if (!isCandidate(entry, input.installedRefs, input.officialOnly ?? false)) continue;
    const hit = tagHits(trimmed, entry.tags);
    if (hit.length === 0) continue;
    hits.push({
      entry,
      score: hit.length * (STAR_WEIGHT[entry.stars] ?? 1.0),
      hitTags: hit,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** L1：任务画像（keywords ×2 权重 + scene 同场景加成）→ 组合候选。 */
export function matchByProfile(profile: TaskProfile, input: MatchInput, limit = 6): MatchHit[] {
  const kwText = profile.keywords.join(" ");
  const hits: MatchHit[] = [];
  for (const entry of input.catalog) {
    if (!isCandidate(entry, input.installedRefs, input.officialOnly ?? false)) continue;
    const hit = tagHits(kwText, entry.tags);
    if (hit.length === 0) continue;
    hits.push({
      entry,
      score: hit.length * 2 * (STAR_WEIGHT[entry.stars] ?? 1.0),
      hitTags: hit,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 兜底：官方入门推荐（无画像无命中时；stars 排序 topN——设计 §4.2）。 */
export function officialFallback(input: MatchInput, limit = 3): CatalogEntry[] {
  return input.catalog
    .filter(
      (e) =>
        e.ref.startsWith("curated:") &&
        !input.installedRefs.has(e.ref) &&
        (e.stars ?? 3) >= 3,
    )
    .sort((a, b) => (b.stars ?? 3) - (a.stars ?? 3) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/**
 * 合并目录：官方 curated 全量（非 required 可装件）+ 第三方标签库行。
 * curated entry 带 kind/tags/stars；skillhub/pi 行以标签库 title/tags/stars 呈现。
 */
export function buildCatalog(
  curated: Array<{
    id: string;
    kind: string;
    title: string;
    description: string;
    required: boolean;
    tags?: string[];
    stars?: number;
  }>,
  tagRows: Array<{ ref: string; title: string; tags: string[]; stars: number }>,
): CatalogEntry[] {
  const entries: CatalogEntry[] = curated
    .filter((c) => !c.required)
    .map((c) => ({
      ref: `curated:${c.id}`,
      title: c.title,
      tags: c.tags ?? [],
      stars: c.stars ?? 3,
      kind: c.kind,
      description: c.description,
    }));
  for (const row of tagRows) {
    // curated 件不入标签库（Rust 侧已保证；此处防御性跳过防双源）。
    if (row.ref.startsWith("curated:")) continue;
    entries.push({
      ref: row.ref,
      title: row.title || row.ref.replace(/^(skillhub:|pi:)/, ""),
      tags: row.tags,
      stars: row.stars,
      description: row.tags.join(" / "),
    });
  }
  return entries;
}

/** ref → 安装命令分派（执行层消费）。 */
export function installCommandFor(
  ref: string,
): { command: string; args: Record<string, unknown> } | null {
  if (ref.startsWith("curated:")) {
    return { command: "market_install", args: { pluginId: ref.slice("curated:".length) } };
  }
  if (ref.startsWith("skillhub:")) {
    return { command: "skillhub_install", args: { slug: ref.slice("skillhub:".length) } };
  }
  if (ref.startsWith("pi:")) {
    return {
      command: "pi_package_install_online",
      args: { source: ref.slice("pi:".length) },
    };
  }
  return null;
}
