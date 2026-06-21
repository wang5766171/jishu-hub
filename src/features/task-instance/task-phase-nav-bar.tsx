/**
 * TaskPhaseNavBar —— 三阶段导航条。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §7.1、§7.3。
 *           `任务数据结构与生命周期设计_20260622.md` §2.3 PhaseDisplayState。
 *
 * 三阶段（需求讨论 / 流程规划 / 任务执行）+ 标题 + 关闭按钮。
 * done 阶段可点击回溯（readOnly），active 高亮，pending 灰色不可点。
 */
import { ChevronLeft, X, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { PhaseDisplayStates, TaskPhase } from "./types";

interface TaskPhaseNavBarProps {
  title: string | null;
  phases: PhaseDisplayStates;
  activePhase: TaskPhase;
  runStatusLabel?: string | null;
  onPhaseChange: (phase: TaskPhase) => void;
  onClose?: () => void;
}

const PHASE_ORDER: TaskPhase[] = ["requirements", "planning", "execution"];

export function TaskPhaseNavBar({
  title,
  phases,
  activePhase,
  runStatusLabel,
  onPhaseChange,
  onClose,
}: TaskPhaseNavBarProps) {
  const { t } = useTranslation();

  const phaseLabel = (phase: TaskPhase): string => {
    switch (phase) {
      case "requirements":
        return t("task.phase.requirements", "需求讨论");
      case "planning":
        return t("task.phase.planning", "流程规划");
      case "execution":
        return t("task.phase.execution", "任务执行");
    }
  };

  const handleClick = (phase: TaskPhase) => {
    const state = phases[phase];
    if (state === "pending") return;
    onPhaseChange(phase);
  };

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <button
        type="button"
        onClick={onClose}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t("common.back", "返回")}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      <span className="truncate text-sm font-medium text-foreground">
        {title ?? t("task.untitled", "新任务")}
      </span>

      {runStatusLabel && (
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          {runStatusLabel}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        {PHASE_ORDER.map((phase, idx) => {
          const state = phases[phase];
          const isActive = phase === activePhase;
          return (
            <div key={phase} className="flex items-center">
              {idx > 0 && (
                <span
                  className={cn(
                    "mx-1 h-px w-4",
                    state === "pending" ? "bg-border" : "bg-primary/40",
                  )}
                />
              )}
              <button
                type="button"
                disabled={state === "pending"}
                onClick={() => handleClick(phase)}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                  isActive && "bg-primary/10 font-medium text-primary",
                  !isActive && state === "done" && "text-muted-foreground hover:bg-accent hover:text-foreground",
                  !isActive && state === "active" && "text-primary",
                  state === "pending" && "cursor-not-allowed text-muted-foreground/40",
                )}
              >
                {state === "done" && <Check className="h-3 w-3" />}
                {state === "active" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                )}
                {state === "pending" && (
                  <span className="h-1.5 w-1.5 rounded-full border border-muted-foreground/40" />
                )}
                {phaseLabel(phase)}
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onClose}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t("common.close", "关闭")}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
