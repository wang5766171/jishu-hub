/** 需求10 B2：工具调用统计提取——tool_use 计数 / tool_result 错误口径 / top 截断。 */
import { describe, expect, it } from "vitest";
import { toolStatsAggregator } from "./aggregate-source";
import type { PluginBlock } from "../../plugins/types";

const use = (name: string): PluginBlock => ({ type: "tool_use", text: name });
const res = (isError: boolean): PluginBlock => ({ type: "tool_result", isError });

describe("extractToolStatsBlocks", () => {
  it("counts tool_use blocks and ranks top tools", () => {
    const stats = toolStatsAggregator([{ blocks: [use("bash"), use("edit"), use("bash")] }]) as { total: number; byName: Array<{ name: string; count: number }> };
    expect(stats.total).toBe(3);
    expect(stats.byName[0]).toEqual({ name: "bash", count: 2 });
  });

  it("counts errors from tool_result blocks only", () => {
    const stats = toolStatsAggregator([{ blocks: [use("bash"), res(true), res(false)] }]) as { total: number; errors: number };
    expect(stats.errors).toBe(1);
    expect(stats.total).toBe(1);
  });

  it("ranks breakdown and tolerates unnamed tools (no cap — renderer slices)", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => use(`t${i}`));
    // 无名 tool_use 计 3 次——频次高于单次工具，必然进入 top6。
    blocks.push({ type: "tool_use" }, { type: "tool_use" }, { type: "tool_use" });
    const stats = toolStatsAggregator([{ blocks }]) as { total: number; byName: Array<{ name: string; count: number }> };
    expect(stats.total).toBe(9);
    // 需求13 C2：聚合器只排序不截断——TopN 由渲染层按配置切。
    expect(stats.byName).toHaveLength(7);
    expect(stats.byName[0]).toEqual({ name: "tool", count: 3 });
  });
});
