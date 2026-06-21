/**
 * ExecutionViewSwitcher —— 执行阶段展现形式切换器（canvas / split / chat）。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §4.2、§4.5。
 * 与会话范围（chatScope）正交，只控制视觉布局。
 */
import { LayoutGrid, Columns2, MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ExecutionView } from "./types";

interface ExecutionViewSwitcherProps {
  value: ExecutionView;
  onChange: (view: ExecutionView) => void;
}

export function ExecutionViewSwitcher({ value, onChange }: ExecutionViewSwitcherProps) {
  const { t } = useTranslation();
  const options: Array<{ value: ExecutionView; icon: typeof LayoutGrid; label: string }> = [
    { value: "canvas", icon: LayoutGrid, label: t("task.execution.canvas", "画布") },
    { value: "split", icon: Columns2, label: t("task.execution.split", "分屏") },
    { value: "chat", icon: MessageSquare, label: t("task.execution.chat", "对话") },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.label}
            className={cn(
              "flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="h-3 w-3" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
