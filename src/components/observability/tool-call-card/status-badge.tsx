import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ToolStatus } from "./types";
import { Clock, Loader2, Check, AlertTriangle, Ban } from "lucide-react";

const statusConfig: Record<ToolStatus, { icon: typeof Clock; color: string; labelKey: string; animate?: boolean }> = {
  pending: { icon: Clock, color: "var(--tool-pending)", labelKey: "sessions.toolStatusWaiting" },
  running: { icon: Loader2, color: "var(--tool-running)", labelKey: "sessions.toolStatusRunning", animate: true },
  success: { icon: Check, color: "var(--tool-success)", labelKey: "sessions.toolStatusDone" },
  error: { icon: AlertTriangle, color: "var(--tool-error)", labelKey: "sessions.toolStatusError" },
  aborted: { icon: Ban, color: "var(--tool-aborted)", labelKey: "sessions.toolStatusAborted" },
};

export const StatusBadge = memo(function StatusBadge({
  status,
  retried,
}: {
  status: ToolStatus;
  /** v0.9.8 需求9-①：曾失败、经重试成功的调用——success 徽标旁加「已重试」
   * 小标记（错误输出保留在卡内展开区，历史不删——审计价值）。 */
  retried?: boolean;
}) {
  const { t } = useTranslation();
  const config = statusConfig[status];
  const Icon = config.icon;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-background/70 px-1.5 py-0.5 text-[0.73em] font-semibold" style={{ color: config.color }}>
      <Icon
        className={cn("w-[1em] h-[1em]", config.animate ? "animate-spin" : "")}
      />
      {t(config.labelKey, config.labelKey.split(".").pop() ?? "")}
      {retried && (
        <span className="ml-0.5 rounded-full bg-muted px-1 py-px font-medium text-muted-foreground">
          {t("sessions.toolStatusRetried", "已重试")}
        </span>
      )}
    </span>
  );
});
