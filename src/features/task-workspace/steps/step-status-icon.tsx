/**
 * 步骤状态图标 + 颜色映射。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §4.3 状态映射表。
 *
 * 步骤栏（ProcessStepsPanel）与侧边栏节点列表（TaskSessionTree）共用此映射，
 * 确保同一节点状态在两处视觉一致。
 */
import { memo } from "react";
import {
  Circle,
  Loader2,
  Check,
  X,
  AlertCircle,
  RotateCw,
  Minus,
} from "lucide-react";
import type { NodeRunStatus } from "@/features/task-instance/graph/use-task-graph";

export interface StepStatusVisual {
  icon: React.ReactNode;
  colorClass: string;
  labelKey: string;
  defaultLabel: string;
}

const statusBadge =
  "inline-flex h-4 w-4 items-center justify-center rounded-full";

const StatusCheck = () => (
  <Check className="h-2.5 w-2.5" strokeWidth={3} />
);
const StatusX = () => <X className="h-2.5 w-2.5" strokeWidth={3} />;
const StatusAlert = () => (
  <AlertCircle className="h-2.5 w-2.5" strokeWidth={3} />
);
const StatusMinus = () => (
  <Minus className="h-2.5 w-2.5" strokeWidth={3} />
);
const StatusRotate = ({ animate }: { animate?: boolean }) => (
  <RotateCw
    className={`h-2.5 w-2.5 ${animate ? "animate-spin" : ""}`}
    strokeWidth={3}
  />
);

/**
 * 状态归一化：去掉后端可能残留的 JSON 引号（如 `"succeeded"`）并转小写，
 * 保证与下方 switch 的 snake_case 分支精确匹配。
 */
function normalizeStatus(
  status: NodeRunStatus | null | undefined,
): string | null | undefined {
  if (status == null) return undefined;
  const s = String(status).trim().toLowerCase().replace(/^"|"$/g, "");
  return s.length ? s : undefined;
}

/**
 * 按 NodeRunStatus 映射图标/颜色/文案。
 * 与设计 §4.3 表完全对齐。
 *
 * 视觉规则：
 * - 已完成/失败/待审批等终态：实心彩色圆底 + 白色图标，一眼可辨；
 * - 待执行：灰色空心圆；
 * - 执行中/重试中：主色旋转图标。
 */
export function getStepStatusVisual(
  status: NodeRunStatus | null | undefined,
): StepStatusVisual {
  switch (normalizeStatus(status)) {
    case "running":
      return {
        icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />,
        colorClass: "text-primary",
        labelKey: "task.step.running",
        defaultLabel: "执行中",
      };
    case "succeeded":
      return {
        icon: (
          <span className={`${statusBadge} bg-emerald-500 text-white`}>
            <StatusCheck />
          </span>
        ),
        colorClass: "text-emerald-500",
        labelKey: "task.step.succeeded",
        defaultLabel: "已完成",
      };
    case "failed":
      return {
        icon: (
          <span className={`${statusBadge} bg-red-500 text-white`}>
            <StatusX />
          </span>
        ),
        colorClass: "text-red-500",
        labelKey: "task.step.failed",
        defaultLabel: "失败",
      };
    case "awaiting_approval":
      return {
        icon: (
          <span className={`${statusBadge} bg-amber-500 text-white`}>
            <StatusAlert />
          </span>
        ),
        colorClass: "text-amber-500",
        labelKey: "task.step.awaitingApproval",
        defaultLabel: "待审批",
      };
    case "retry_wait":
    case "repairing":
      return {
        icon: (
          <span className={`${statusBadge} bg-orange-500 text-white`}>
            <StatusRotate animate />
          </span>
        ),
        colorClass: "text-orange-500",
        labelKey: "task.step.retrying",
        defaultLabel: "重试中",
      };
    case "skipped":
      return {
        icon: (
          <span className={`${statusBadge} bg-muted-foreground/50 text-white`}>
            <StatusMinus />
          </span>
        ),
        colorClass: "text-muted-foreground/40",
        labelKey: "task.step.skipped",
        defaultLabel: "已跳过",
      };
    case "ready":
    case "blocked":
    case "leased":
    case "cancelled":
    case "superseded":
    case null:
    case undefined:
    default:
      return {
        icon: <Circle className="h-3.5 w-3.5 text-muted-foreground" />,
        colorClass: "text-muted-foreground",
        labelKey: "task.step.pending",
        defaultLabel: "待执行",
      };
  }
}

/** Memo 版本的图标组件，供列表逐项渲染。 */
export const StepStatusIcon = memo(function StepStatusIcon({
  status,
}: {
  status: NodeRunStatus | null | undefined;
}) {
  const visual = getStepStatusVisual(status);
  return (
    <span className="inline-flex items-center justify-center">
      {visual.icon}
    </span>
  );
});
