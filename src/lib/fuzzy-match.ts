/**
 * 轻量 fuzzy 匹配（v0.7.3 需求2-A1，对齐 Pi TUI @ 补全的子序列匹配）。
 *
 * 打分规则（越高越靠前）：
 * - 子序列不命中返回 null（大小写不敏感）；
 * - 每个命中字符基础 1 分；连续命中额外 +2（奖励前缀/整词）；
 * - 命中位置在路径分隔符或驼峰边界后 +3（奖励词首命中）；
 * - 短目标轻微加分（同分时短路径优先）。
 */

function isBoundary(prev: string | undefined, ch: string): boolean {
  if (prev === undefined) return true;
  if (prev === "/" || prev === "_" || prev === "-" || prev === ".") return true;
  return prev === prev.toLowerCase() && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      streak = 0;
      continue;
    }
    streak += 1;
    score += 1 + (streak > 1 ? 2 : 0);
    if (isBoundary(ti > 0 ? target[ti - 1] : undefined, target[ti])) {
      score += 3;
    }
    qi += 1;
  }
  if (qi < q.length) return null;
  return score + Math.max(0, 4 - Math.floor(target.length / 32));
}

/** 按匹配得分降序返回前 `limit` 个候选。空查询原样返回前 limit 项（保持稳定序）。 */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  keyOf: (item: T) => string,
  limit = 12,
): Array<{ item: T; score: number }> {
  if (!query.trim()) {
    return items.slice(0, limit).map((item) => ({ item, score: 0 }));
  }
  const ranked: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = fuzzyScore(query.trim(), keyOf(item));
    if (score != null) {
      ranked.push({ item, score });
    }
  }
  ranked.sort((a, b) => b.score - a.score || keyOf(a.item).length - keyOf(b.item).length);
  return ranked.slice(0, limit);
}
