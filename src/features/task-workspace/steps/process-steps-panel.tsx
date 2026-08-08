/**
 * 流程步骤栏（ProcessStepsPanel）。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §4（布局 / 步骤序 / 状态映射 / 显隐规则）。
 *
 * 职责：
 * - 顶部：任务标题 / 运行状态 / 进度 n/m / 「流程编排」按钮（T5 前禁用）/ 折叠
 * - 中部：步骤列表（拓扑序，状态图标 + 标题 + agent）
 * - 底部：运行控制（开始 / 暂停 / 恢复 / 取消）
 * - 折叠态：40px 竖条 + 进度点阵
 *
 * 性能：步骤列表逐项 memo；整体用 layoutSignature 做 memo key，避免每秒轮询全栏重渲染。
 */
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Workflow, PanelRightClose, Play, Pause, Square, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  GraphSnapshot,
  NodeRun,
  NodeRunStatus,
  RunStatusValue,
} from "@/features/task-instance/graph/use-task-graph";
import { isTerminalRunStatus } from "@/features/task-instance/graph/use-task-graph";
import { computeStepOrder } from "./compute-step-order";
import { StepItem } from "./step-item";

// ── Props ──

export interface ProcessStepsPanelProps {
  /** 任务标题。 */
  title: string | null;
  /** 流程图快照（含节点 + 边）。null 时步骤栏不渲染。 */
  snapshot: GraphSnapshot | null;
  /** 节点运行状态 Map（来自 taskGraph.nodeRuns）。 */
  nodeRuns: Record<string, NodeRun>;
  /** 当前 run 状态。 */
  runStatus: RunStatusValue | null;
  /** 活跃 run id（用于判断是否可开始执行）。 */
  activeRunId: string | null;
  /** graph_id（判断是否有流程图）。 */
  graphId: string | null;
  /** 任务实例的 active_run_id（与 activeRunId 配合判断可否开始执行）。 */
  instanceActiveRunId: string | null;
  /** 当前选中的节点 id（高亮；null 表示主任务/run 事件流）。 */
  selectedNodeId: string | null;
  /** agent id → display_name 映射（步骤栏右侧 agent 标签）。 */
  agentNames: Record<string, string>;
  /** 画布布局坐标（可选，用于步骤排序的视觉一致性）。 */
  layoutPositions?: Record<string, { x: number; y: number }> | null;
  /** 「隐藏步骤栏」（P4c）：收起整个侧边栏，由外层提供重开入口。 */
  onHideSidebar?: () => void;

  // ── 回调 ──
  /** 选中节点；传 null 表示切回主任务/run 事件流。 */
  onSelectNode: (nodeId: string | null) => void;
  onStartRun: () => void;
  onPauseRun: () => void;
  onResumeRun: () => void;
  onCancelRun: () => void;
  /** 「流程编排」按钮（T5 接入，T2 阶段禁用并提示）。 */
  onOpenBoard?: () => void;
}

// ── 进度计算 ──

function computeProgress(
  orderedIds: string[],
  nodeRuns: Record<string, NodeRun>,
): { done: number; total: number } {
  let done = 0;
  for (const id of orderedIds) {
    const status = nodeRuns[id]?.status;
    if (status === "succeeded" || status === "skipped") done++;
  }
  return { done, total: orderedIds.length };
}

// ── 主组件 ──

export const ProcessStepsPanel = memo(function ProcessStepsPanel({
  title,
  snapshot,
  nodeRuns,
  runStatus,
  activeRunId,
  graphId,
  instanceActiveRunId,
  selectedNodeId,
  agentNames,
  layoutPositions,
  onHideSidebar,
  onSelectNode,
  onStartRun,
  onPauseRun,
  onResumeRun,
  onCancelRun,
  onOpenBoard,
}: ProcessStepsPanelProps) {
  const { t } = useTranslation();

  // 步骤排序（layoutSignature 变化才重算）
  const layoutSignature = useMemo(() => {
    if (!snapshot) return "";
    const nodePart = snapshot.nodes.map((n) => n.node_id).join("|");
    const edgePart = snapshot.edges
      .map((e) => `${e.source_node_id}->${e.target_node_id}`)
      .join("|");
    return `${nodePart}#${edgePart}`;
  }, [snapshot]);

  const orderedIds = useMemo(
    () => computeStepOrder(snapshot, layoutPositions),
    // 只依赖 signature，不依赖 snapshot 引用（snapshot 引用每次轮询都变，但拓扑没变）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutSignature, layoutPositions],
  );

  // P4d：整体任务节点（node_kind === "goal"）不是流程步骤，排除出步骤列表；
  // 主任务会话入口由上方独立的「主任务」按钮承担。
  const stepNodeIds = useMemo(
    () =>
      orderedIds.filter(
        (id) => snapshot?.nodes.find((n) => n.node_id === id)?.node_kind !== "goal",
      ),
    [orderedIds, snapshot],
  );

  const progress = useMemo(
    () => computeProgress(stepNodeIds, nodeRuns),
    [stepNodeIds, nodeRuns],
  );

  // 显隐规则 §4.4：无 graph_id 不渲染
  if (!graphId) return null;

  // 运行状态标签
  const statusLabel = (() => {
    switch (runStatus) {
      case "running":
        return t("task.run.running", "执行中");
      case "paused":
        return t("task.run.paused", "已暂停");
      case "awaiting_human":
        return t("task.run.awaitingHuman", "等待审批");
      case "completed":
        return t("task.run.completed", "已完成");
      case "failed":
        return t("task.run.failed", "失败");
      case "cancelled":
        return t("task.run.cancelled", "已取消");
      default:
        return t("task.run.draft", "待执行");
    }
  })();

  const statusColor = (() => {
    switch (runStatus) {
      case "running":
        return "text-primary";
      case "paused":
        return "text-orange-500";
      case "awaiting_human":
        return "text-amber-500";
      case "completed":
        return "text-emerald-500";
      case "failed":
        return "text-red-500";
      default:
        return "text-muted-foreground";
    }
  })();

  const canStartRun = !activeRunId && !instanceActiveRunId && !!graphId;
  const canCancel = activeRunId && !isTerminalRunStatus(runStatus);

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-l border-border bg-background">
      {/* ── 顶部：标题 + 状态 + 进度 + 编排 + 折叠 ── */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {title ?? t("task.untitled", "未命名任务")}
          </span>
          <button
            type="button"
            onClick={() => onHideSidebar?.()}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("task.steps.hide", "隐藏步骤栏")}
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className={cn("flex items-center gap-1 text-[11px]", statusColor)}>
            {/* 状态圆点 */}
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                statusColor.replace("text-", "bg-"),
                runStatus === "running" && "animate-pulse",
              )}
            />
            {statusLabel}
          </span>
          {progress.total > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {progress.done}/{progress.total}
            </span>
          )}
          {/* 「流程编排 / 流程看板」按钮（T5 启用） */}
          <button
            type="button"
            disabled={!graphId}
            onClick={onOpenBoard}
            className={cn(
              "ml-auto flex h-5 items-center gap-1 rounded px-1.5 text-[10px] transition-fast",
              graphId
                ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                : "cursor-not-allowed text-muted-foreground/30",
            )}
            title={
              !graphId
                ? t("task.board.noGraph", "尚未生成流程图")
                : activeRunId || instanceActiveRunId
                  ? t("task.flow.modeBoard", "流程看板")
                  : t("task.flow.modeEdit", "流程编排")
            }
          >
            <Workflow className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* ── 中部：步骤列表 ── */}
      <div className="flex-1 overflow-y-auto">
        {stepNodeIds.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
            {t("task.steps.empty", "暂无流程节点")}
          </div>
        ) : (
          <>
            {/* 主任务 / run 事件流入口 */}
            <button
              type="button"
              onClick={() => onSelectNode(null)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs transition-fast",
                selectedNodeId === null
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate">{t("task.steps.mainTask", "主任务")}</span>
            </button>
            {stepNodeIds.map((nodeId, i) => {
            const run = nodeRuns[nodeId];
            const node = snapshot?.nodes.find((n) => n.node_id === nodeId);
            const status: NodeRunStatus | null | undefined = run?.status;
            // agent 标签：优先从 nodeRuns 的 agent 信息取，或从 snapshot 的 assignment
            const agentId = (run as unknown as { agent_id?: string } | undefined)?.agent_id ?? null;
            const agentLabel = agentId ? agentNames[agentId] ?? agentId : null;
            return (
              <StepItem
                key={nodeId}
                index={i + 1}
                nodeId={nodeId}
                title={node?.title ?? nodeId}
                status={status}
                agentLabel={agentLabel}
                isSelected={selectedNodeId === nodeId}
                onSelect={(id) => onSelectNode(id)}
              />
            );
          })}
          </>
        )}
      </div>

      {/* ── 底部：运行控制 + 治理入口 ── */}
      <div className="shrink-0 border-t border-border px-3 py-2">
        <div className="flex items-center gap-1">
          {/* 开始执行 */}
          {canStartRun && (
            <button
              type="button"
              onClick={onStartRun}
              className="flex h-6 items-center gap-1 rounded bg-primary/10 px-2 text-[11px] text-primary hover:bg-primary/20"
            >
              <Play className="h-3 w-3" />
              {t("task.execution.start", "开始执行")}
            </button>
          )}
          {/* 暂停 */}
          {runStatus === "running" && (
            <button
              type="button"
              onClick={onPauseRun}
              className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.pause", "暂停")}
            >
              <Pause className="h-3 w-3" />
            </button>
          )}
          {/* 恢复 */}
          {runStatus === "paused" && (
            <button
              type="button"
              onClick={onResumeRun}
              className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.resume", "恢复")}
            >
              <Play className="h-3 w-3" />
            </button>
          )}
          {/* 取消 */}
          {canCancel && (
            <button
              type="button"
              onClick={onCancelRun}
              className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.cancel", "取消")}
            >
              <Square className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
