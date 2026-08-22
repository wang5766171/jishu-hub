import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, ArrowUpFromLine, Coins, Loader2, Minimize2 } from "lucide-react";
import { useSessionUsage } from "@/lib/session-usage";
import { useInvoke } from "@/hooks/use-invoke";
import { cn } from "@/lib/utils";

/**
 * 上下文水位圆环（v0.7.3 需求2）：模型选择器旁的常驻水位指示，点击弹出详情。
 * 数据源为 session-usage store（turn_complete usage）；总量或剩余缺失
 * （codex / 未对话的新会话）时不渲染。颜色分级与 TUI footer 一致：
 * ≤70% 灰、>70% 琥珀、>90% 红。
 *
 * v0.7.4 需求1 A3：compact prop 提供时（capability CONTEXT_COMPACT 门控，
 * 由调用方决定），弹层内渲染「立即压缩」按钮与「自动压缩」开关。
 */

export interface ContextRingCompactControls {
  onCompact: () => void;
  compacting: boolean;
  /** Hub 偏好；null = 跟随 agent 默认（未配置） */
  autoCompaction: boolean | null;
  onAutoCompactionChange: (enabled: boolean) => void;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export const ContextRing = memo(function ContextRing({
  sessionId,
  agentId,
  compact,
}: {
  sessionId: string | null;
  /** v0.8.0 需求9 收尾：用于回填时重读全局压缩阈值配置。 */
  agentId?: string | null;
  compact?: ContextRingCompactControls;
}) {
  const { t } = useTranslation();
  const usage = useSessionUsage(sessionId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // v0.8.0 需求9 收尾：压缩触发点 = 窗口 × 阈值%（用户口径：90% 即用到
  // 900k 时压缩）。随用量回填实时重读全局阈值（refreshKey = usage.updatedAt，
  // 每轮 turn_complete 变化）——配置改动下一轮回填即生效，不缓存创建时的值。
  const { data: agentConfig } = useInvoke<Record<string, unknown>>(
    agentId && sessionId ? "load_config" : "",
    agentId && sessionId ? { agentId } : undefined,
    usage?.updatedAt,
  );
  const thresholdPercent = (() => {
    const raw = (agentConfig?.compaction as { thresholdPercent?: unknown } | undefined)?.thresholdPercent;
    const pct = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 90;
    return Math.min(99, Math.max(1, pct));
  })();
  const compactionTriggerTokens =
    usage?.contextWindowTotal && usage.contextWindowTotal > 0
      ? Math.floor((usage.contextWindowTotal * thresholdPercent) / 100)
      : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!sessionId || !usage) return null;
  if (usage.contextRemaining == null || !usage.contextWindowTotal) return null;

  const pct = Math.min(
    100,
    Math.max(0, Math.round((1 - usage.contextRemaining / usage.contextWindowTotal) * 100)),
  );
  const tone =
    pct > 90 ? "text-red-400" : pct > 70 ? "text-amber-500" : "text-muted-foreground";
  const title = t("sessions.usageContextUsed", { percent: String(pct) });

  const R = 6;
  const C = 2 * Math.PI * R;

  return (
    <span ref={rootRef} className="relative inline-flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        className={cn(
          "inline-flex h-6 w-6 items-center justify-center rounded-full transition-fast hover:bg-accent/45",
          tone,
        )}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 -rotate-90">
          {/* 底环 */}
          <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.22" />
          {/* 进度弧：dashoffset 随水位增长 */}
          <circle
            cx="8"
            cy="8"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct / 100)}
          />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-[calc(100%+0.45rem)] right-0 z-[90] w-56 rounded-xl border border-border bg-popover p-2.5 text-xs shadow-xl">
          <div className={cn("font-medium leading-tight", tone)}>{title}</div>
          <div className="mt-1 text-muted-foreground tabular-nums">
            {/* v0.8.0 需求9 收尾：分子改为已用量（used/total 惯例），
                原先分子放剩余量与直觉相反。 */}
            {t("sessions.usageWatermarkDetail", {
              used: formatTokens(
                (usage.contextWindowTotal ?? 0) - (usage.contextRemaining ?? 0),
              ),
              total: formatTokens(usage.contextWindowTotal),
            })}
          </div>
          {(usage.inputTokens > 0 || usage.outputTokens > 0 || usage.totalCost > 0) && (
            <div className="mt-1.5 space-y-0.5 border-t border-border/40 pt-1.5 tabular-nums text-muted-foreground">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1">
                  <ArrowUpFromLine className="h-3 w-3" />
                  {t("sessions.usageTokensIn")}
                </span>
                <span>{formatTokens(usage.inputTokens)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1">
                  <ArrowDownToLine className="h-3 w-3" />
                  {t("sessions.usageTokensOut")}
                </span>
                <span>{formatTokens(usage.outputTokens)}</span>
              </div>
              {usage.totalCost > 0 && (
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1">
                    <Coins className="h-3 w-3" />
                    {t("sessions.usageCost")}
                  </span>
                  <span>{`$${usage.totalCost.toFixed(3)}`}</span>
                </div>
              )}
            </div>
          )}
          {compact && (
            <div className="mt-1.5 space-y-1.5 border-t border-border/40 pt-1.5">
              <button
                type="button"
                disabled={compact.compacting}
                onClick={compact.onCompact}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] transition-fast hover:bg-accent/40 disabled:opacity-60"
              >
                {compact.compacting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Minimize2 className="h-3 w-3" />
                )}
                {compact.compacting
                  ? t("sessions.compactRunning")
                  : t("sessions.compactNow")}
              </button>
              <label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
                <span>{t("sessions.autoCompaction")}</span>
                <input
                  type="checkbox"
                  className="h-3 w-3"
                  checked={compact.autoCompaction ?? true}
                  onChange={(e) => compact.onAutoCompactionChange(e.target.checked)}
                />
              </label>
              {compactionTriggerTokens !== null && (
                <p className="text-[10px] leading-tight text-muted-foreground/70 tabular-nums">
                  {t("sessions.usageCompactionBudget", {
                    tokens: formatTokens(compactionTriggerTokens),
                    percent: String(thresholdPercent),
                  })}
                </p>
              )}
              <p className="text-[10px] leading-tight text-muted-foreground/60">
                {t("sessions.compactHint")}
              </p>
            </div>
          )}
          <div className="mt-1.5 border-t border-border/40 pt-1.5 text-[10px] leading-tight text-muted-foreground/60">
            {t("sessions.usageRuntimeNote")}
          </div>
        </div>
      )}
    </span>
  );
});
