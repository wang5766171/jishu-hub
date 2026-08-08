/**
 * 步骤栏单个步骤项。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §4.1 布局、§4.3 状态映射。
 *
 * 性能：React.memo + props 全为原始值（string/boolean/number），
 * 轮询更新 nodeRuns 时只有状态变化的步骤项会重渲染。
 */
import { memo } from "react";
import { cn } from "@/lib/utils";
import { StepStatusIcon } from "./step-status-icon";
import type { NodeRunStatus } from "@/features/task-instance/graph/use-task-graph";

export interface StepItemProps {
  /** 步骤序号（1-based）。 */
  index: number;
  nodeId: string;
  title: string;
  status: NodeRunStatus | null | undefined;
  /** 节点的 agent 名称（用于步骤栏右侧显示）。 */
  agentLabel: string | null;
  /** 是否为当前选中节点（高亮底色）。 */
  isSelected: boolean;
  onSelect: (nodeId: string) => void;
}

export const StepItem = memo(function StepItem({
  index,
  nodeId,
  title,
  status,
  agentLabel,
  isSelected,
  onSelect,
}: StepItemProps) {
  const isRunning = status === "running";
  return (
    <button
      type="button"
      onClick={() => onSelect(nodeId)}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-fast",
        isSelected
          ? "bg-primary/10 font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
      )}
    >
      {/* 序号 + 状态图标 */}
      <span className="flex w-6 shrink-0 items-center justify-center">
        <StepStatusIcon status={status} />
      </span>
      <span className="w-4 shrink-0 text-right text-[10px] text-muted-foreground/60">{index}</span>
      {/* 标题 */}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {/* agent 标签 */}
      {agentLabel && (
        <span className="shrink-0 text-[10px] text-muted-foreground/60">{agentLabel}</span>
      )}
      {/* running 时的旋转标记（额外的视觉锚点，agent 标签右侧） */}
      {isRunning && (
        <span className="shrink-0 text-primary">
          {/* 旋转点，纯 CSS */}
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        </span>
      )}
    </button>
  );
});
