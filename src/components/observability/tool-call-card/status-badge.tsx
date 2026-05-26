import { memo } from "react";
import { cn } from "@/lib/utils";
import type { ToolStatus } from "./types";
import { Clock, Loader2, Check, AlertTriangle, Ban } from "lucide-react";

const statusConfig: Record<ToolStatus, { icon: typeof Clock; color: string; label: string; animate?: boolean }> = {
  pending: { icon: Clock, color: "var(--tool-pending)", label: "Waiting" },
  running: { icon: Loader2, color: "var(--tool-running)", label: "Running", animate: true },
  success: { icon: Check, color: "var(--tool-success)", label: "Done" },
  error: { icon: AlertTriangle, color: "var(--tool-error)", label: "Error" },
  aborted: { icon: Ban, color: "var(--tool-aborted)", label: "Aborted" },
};

export const StatusBadge = memo(function StatusBadge({ status }: { status: ToolStatus }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  return (
    <span className="inline-flex items-center gap-1 text-[0.73em] font-medium" style={{ color: config.color }}>
      <Icon
        className={cn("w-[1em] h-[1em]", config.animate ? "animate-spin" : "")}
      />
      {config.label}
    </span>
  );
});
