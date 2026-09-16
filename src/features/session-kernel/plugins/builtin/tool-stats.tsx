/**
 * 工具调用统计插件（v0.9.3 需求10 / B2，规划目标2「工具调用统计」条件已
 * 具备项——messages() 完整数据）：rail-widget 贴右缘细条，鼠标悬停弹统计
 * 卡——本会话工具调用总数、错误数、top 工具分布（测试期修复18：初版贴
 * 左缘与导航列重叠，改右缘避让）。
 * 卡——本会话工具调用总数、错误数、top 工具分布。数据全部来自受控上下文
 * ctx.messages（tool_use 块），零 IPC、零新数据面。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import { cfgBool, cfgNum, usePluginConfig, type PluginConfigField } from "../config-plane";
import type { SessionPluginDescriptor, SessionKernelContext, PluginBlock } from "../types";

interface ToolStats {
  total: number;
  errors: number;
  byName: Array<{ name: string; count: number }>;
}

/** v0.9.3 需求12 P1：top N 截断（原 6）与错误率显示配置化。 */
const TOOL_STATS_CONFIG_SCHEMA: PluginConfigField[] = [
  { key: "topN", type: "number", label: "Top 工具数", description: "悬停统计卡显示的调用最多的工具数量", default: 6, min: 3, max: 15 },
  { key: "showErrorRatio", type: "switch", label: "显示错误率", default: true },
];

function ToolStatsWidget({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const { values: cfg } = usePluginConfig("session.tool-stats", TOOL_STATS_CONFIG_SCHEMA);
  const [hovered, setHovered] = useState(false);
  const stats = useMemo(
    () => extractToolStatsBlocks(ctx.messages, cfgNum(cfg, "topN", 6)),
    [ctx.messages, cfg],
  );

  if (stats.total === 0) return null;
  const errorRatio = Math.round((stats.errors / stats.total) * 100);
  const title = t("sessionPlugins.toolStats.hoverTitle", "本会话工具调用统计");
  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        title={title}
        className={cn(
          "flex h-4 items-center gap-1 rounded-full px-1.5 text-[9px] font-medium transition-colors",
          stats.errors > 0
            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Wrench className="h-2.5 w-2.5" />
        <span className="tabular-nums">
          {stats.total}
          {stats.errors > 0 ? `/${stats.errors}` : ""}
        </span>
      </div>
      {hovered ? (
        <div className="absolute left-0 top-5 z-30 w-48 rounded-lg border border-border/70 bg-popover/95 p-2 shadow-lg backdrop-blur">
          <div className="mb-1 text-[10px] font-medium text-foreground">{title}</div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{t("sessionPlugins.toolStats.total", "调用总数")}</span>
            <span className="tabular-nums">{stats.total}</span>
          </div>
          {cfgBool(cfg, "showErrorRatio", true) ? (
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{t("sessionPlugins.toolStats.errors", "失败（回放口径）")}</span>
              <span className="tabular-nums text-amber-600 dark:text-amber-400">
                {stats.errors}（{errorRatio}%）
              </span>
            </div>
          ) : null}
          <div className="mt-1 border-t border-border/50 pt-1">
            {stats.byName.map((item) => (
              <div key={item.name} className="flex justify-between text-[10px] text-muted-foreground">
                <span className="truncate">{item.name}</span>
                <span className="ml-2 shrink-0 tabular-nums">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function extractToolStatsBlocks(messages: { blocks: PluginBlock[] }[], topN = 6): ToolStats {
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
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
  return { total: agg.total, errors: agg.errors, byName };
}

export const toolStatsPlugin: SessionPluginDescriptor = {
  id: "session.tool-stats",
  displayNameKey: "sessionPlugins.toolStats.name",
  displayNameFallback: "工具调用统计",
  descriptionKey: "sessionPlugins.toolStats.description",
  descriptionFallback: "会话左缘细条：本会话工具调用总数/失败数，悬停看工具分布",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:blocks"],
  configSchema: TOOL_STATS_CONFIG_SCHEMA,
  mounts: [
    {
      kind: "rail-widget",
      Component: ToolStatsWidget,
      defaultSide: "right",
    },
  ],
};
