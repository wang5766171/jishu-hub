import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, SessionKernelContext } from "../types";

/**
 * 用量成本面板（v0.9.2 需求1 M4，用户圈定首期 #26）——数据源 usage.db
 * （权威记账在 Rust turn_end 侧），面板只读展示：总览 / 会话排行 / 近 7 日
 * token 趋势。首个纯数据型 dock-panel（无任务依赖）。
 */

interface UsageTotals {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  total_cost: number;
  tool_calls: number;
}

interface UsageSessionRow {
  session_id: string;
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  total_cost: number;
  updated_at: number;
}

interface UsageDailyRow {
  day: string;
  input_tokens: number;
  output_tokens: number;
  /** v0.9.3 需求7：当日成本（记账值或套餐计价覆盖）。 */
  cost: number;
}

interface UsageOverview {
  totals: UsageTotals;
  top_sessions: UsageSessionRow[];
  daily: UsageDailyRow[];
  /** false 且记账成本为 0 时隐藏金额（不显示无意义的 0）。 */
  pricing_applied?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function UsagePanelBody({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const [data, setData] = useState<UsageOverview | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await invoke<UsageOverview>("usage_overview"));
    } catch (error) {
      console.warn("usage overview failed:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const maxDaily = Math.max(1, ...(data?.daily.map((d) => d.input_tokens + d.output_tokens) ?? [1]));
  const maxDailyCost = Math.max(...(data?.daily.map((d) => d.cost) ?? [0]), 0.0001);
  // 金额显隐：配置了套餐价格、或记账成本非 0 才显示
  const showCost = Boolean(data?.pricing_applied) || (data?.totals.total_cost ?? 0) > 0;

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex items-center gap-2 px-1 py-1">
        <span className="font-medium text-foreground">
          {t("sessionPlugins.usage.title", "用量总览")}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("sessionPlugins.usage.refresh", "刷新")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
      {data ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label={t("sessionPlugins.usage.totalTokens", "累计 Token")} value={formatTokens(data.totals.input_tokens + data.totals.output_tokens)} />
            {showCost ? (
              <Stat label={t("sessionPlugins.usage.totalCost", "累计成本")} value={`¥${data.totals.total_cost.toFixed(2)}`} />
            ) : null}
            <Stat label={t("sessionPlugins.usage.sessions", "会话数")} value={String(data.totals.sessions)} />
            <Stat label={t("sessionPlugins.usage.toolCalls", "工具调用")} value={formatTokens(data.totals.tool_calls)} />
          </div>
          {data.daily.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-medium text-muted-foreground">
                {t("sessionPlugins.usage.last7days", "近 7 日 Token")}
              </div>
              <div className="flex h-16 items-end gap-1">
                {data.daily.map((d) => (
                  <div key={d.day} className="flex flex-1 flex-col items-center gap-0.5" title={`${d.day}: ${formatTokens(d.input_tokens + d.output_tokens)}`}>
                    <div
                      className="w-full rounded-sm bg-primary/50"
                      style={{ height: `${Math.max(3, ((d.input_tokens + d.output_tokens) / maxDaily) * 52)}px` }}
                    />
                    <span className="text-[8px] text-muted-foreground/60">{d.day.slice(5)}</span>
                  </div>
                ))}
              </div>
              {/* v0.9.3 需求7：按日成本曲线（记账值或套餐计价；悬停明细）。 */}
              {showCost && (
                <div className="mt-2">
                  <div className="mb-1 text-[10px] font-medium text-muted-foreground">
                    {t("sessionPlugins.usage.last7daysCost", "近 7 日成本")}
                  </div>
                  <div className="flex h-12 items-end gap-1">
                    {data.daily.map((d) => (
                      <div
                        key={d.day}
                        className="flex flex-1 flex-col items-center gap-0.5"
                        title={`${d.day}: ¥${d.cost.toFixed(4)}`}
                      >
                        <div
                          className="w-full rounded-sm bg-amber-500/60 dark:bg-amber-400/50"
                          style={{ height: `${Math.max(d.cost > 0 ? 3 : 1, (d.cost / maxDailyCost) * 36)}px` }}
                        />
                        <span className="text-[8px] text-muted-foreground/60">{d.day.slice(5)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {data.top_sessions.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-medium text-muted-foreground">
                {t("sessionPlugins.usage.topSessions", "用量排行")}
              </div>
              <div className="space-y-0.5">
                {data.top_sessions.map((row) => {
                  const info = ctx.resolveSessionInfo(row.session_id);
                  const kindLabel = info?.kind === "task"
                    ? t("sessionPlugins.usage.kindTask", "任务")
                    : info?.kind === "node"
                      ? t("sessionPlugins.usage.kindNode", "子节点")
                      : info?.kind === "session"
                        ? t("sessionPlugins.usage.kindSession", "会话")
                        : t("sessionPlugins.usage.kindUnknown", "其他项目");
                  const kindCls = info?.kind === "task"
                    ? "bg-primary/15 text-primary"
                    : info?.kind === "node"
                      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      : info?.kind === "session"
                        ? "bg-muted text-muted-foreground"
                        : "bg-muted/60 text-muted-foreground/60";
                  return (
                    <div key={row.session_id} className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-accent/50">
                      <span className={cn("shrink-0 rounded px-1 text-[9px] leading-4", kindCls)}>{kindLabel}</span>
                      <span
                        className="min-w-0 flex-1 truncate text-foreground/80"
                        title={info ? `${info.title}（${row.session_id}）` : row.session_id}
                      >
                        {info?.title ?? row.session_id.slice(0, 14) + "…"}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{formatTokens(row.input_tokens + row.output_tokens)}</span>
                      {showCost && (
                        <span className="w-12 shrink-0 text-right tabular-nums text-foreground/70">¥{row.total_cost.toFixed(3)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          {loading ? t("sessionPlugins.usage.loading", "加载中…") : t("sessionPlugins.usage.empty", "暂无用量数据")}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/50 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

export const usagePanelPlugin: SessionPluginDescriptor = {
  id: "session.usage",
  displayNameKey: "sessionPlugins.usage.name",
  displayNameFallback: "用量成本面板",
  descriptionKey: "sessionPlugins.usage.description",
  descriptionFallback: "token/成本/会话排行与趋势",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["invoke:usage.query"],
  mounts: [
    {
      kind: "dock-panel",
      titleKey: "sessionPlugins.usage.panelTitle",
      titleFallback: "用量",
      Component: UsagePanelBody,
      defaultSlot: "right",
    },
  ],
};
