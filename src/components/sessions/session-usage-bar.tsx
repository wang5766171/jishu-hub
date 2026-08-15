import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, ArrowUpFromLine, Coins } from "lucide-react";
import { useSessionUsage } from "@/lib/session-usage";
import { cn } from "@/lib/utils";

/**
 * 会话用量状态栏（v0.7.3 需求2-A4/A10）：输入区上方的紧凑一行，
 * 展示本会话累计 输入/输出 token、成本 与 最近剩余上下文。
 * 数据来自 turn_complete 事件的 usage（本次运行期间累计，见 session-usage.ts）。
 */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export const SessionUsageBar = memo(function SessionUsageBar({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const { t } = useTranslation();
  const usage = useSessionUsage(sessionId);
  if (!sessionId || !usage) return null;
  const hasTokens = usage.inputTokens > 0 || usage.outputTokens > 0;
  const hasCost = usage.totalCost > 0;
  if (!hasTokens && !hasCost && usage.contextRemaining == null) return null;

  return (
    <div
      className="mx-auto flex w-full max-w-[var(--message-content-max-width)] flex-wrap items-center gap-x-3 gap-y-0.5 px-4 pb-1 pt-1 text-[11px] leading-none tabular-nums text-muted-foreground/70"
      aria-label={t("sessions.usageAriaLabel")}
    >
      {hasTokens && (
        <span className="inline-flex items-center gap-1" title={t("sessions.usageTokensIn")}>
          <ArrowUpFromLine className="h-3 w-3" />
          {formatTokens(usage.inputTokens)}
        </span>
      )}
      {hasTokens && (
        <span className="inline-flex items-center gap-1" title={t("sessions.usageTokensOut")}>
          <ArrowDownToLine className="h-3 w-3" />
          {formatTokens(usage.outputTokens)}
        </span>
      )}
      {hasCost && (
        <span className="inline-flex items-center gap-1" title={t("sessions.usageCost")}>
          <Coins className="h-3 w-3" />
          {`$${usage.totalCost.toFixed(3)}`}
        </span>
      )}
      {usage.contextRemaining != null && (
        <span
          className={cn(
            "inline-flex items-center gap-1",
            usage.contextRemaining < 10_000 && "text-amber-500",
          )}
          title={t("sessions.usageContextRemaining")}
        >
          {t("sessions.usageContextRemaining")}
          {formatTokens(usage.contextRemaining)}
        </span>
      )}
    </div>
  );
});
