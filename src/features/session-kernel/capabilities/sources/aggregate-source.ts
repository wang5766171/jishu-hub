/**
 * messages 源聚合器注册表（需求13 C2）：消息流 → payload.data 的压缩算子。
 * tool-stats 聚合器迁自 builtin/tool-stats.tsx（排序不截断——TopN 由渲染层
 * 按配置切，配置面直通）。
 */
import type { Aggregator } from "../types";

const aggregators = new Map<string, Aggregator>();

export function registerAggregator(key: string, fn: Aggregator): void {
  aggregators.set(key, fn);
}

export function getAggregator(key: string | undefined): Aggregator | undefined {
  return key ? aggregators.get(key) : undefined;
}

export interface ToolStats {
  total: number;
  errors: number;
  byName: Array<{ name: string; count: number }>;
}

export const toolStatsAggregator: Aggregator = (messages) => {
  const agg: { total: number; errors: number } = { total: 0, errors: 0 };
  const counts = new Map<string, number>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_use") {
        agg.total += 1;
        const name = block.text || "tool";
        counts.set(name, (counts.get(name) ?? 0) + 1);
      } else if (block.type === "tool_result" && block.isError) {
        agg.errors += 1;
      }
    }
  }
  const byName = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { total: agg.total, errors: agg.errors, byName } satisfies ToolStats;
};

registerAggregator("tool-stats", toolStatsAggregator);
