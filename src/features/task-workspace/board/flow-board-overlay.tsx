/**
 * FlowBoardOverlay —— 独立流程画布页（全屏覆盖层）。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §5。
 *
 * 形态：fixed inset-0 z-50，非路由（避免动 router 与常规会话状态）。
 *
 * 双模式（§5.2）：
 * - edit：运行前，可增删改节点/边、undo/redo、AI 提案
 * - board：运行后，只读看板（保留选中/缩放/定位/进节点会话）
 *
 * 入口：ProcessStepsPanel 顶部「流程编排 / 流程看板」按钮
 * 返回：顶栏 ← / × / Esc
 */
import { Suspense, lazy, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, X, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isTerminalRunStatus } from "@/features/task-instance/graph/use-task-graph";
import type { RunStatusValue, useTaskGraph } from "@/features/task-instance/graph/use-task-graph";
import type { NodeSessionInfo } from "@/features/task-instance/types";
import { NodeInspector } from "./node-inspector";

const GraphEditor = lazy(() =>
  import("@/features/task-instance/graph/graph-editor").then((m) => ({ default: m.GraphEditor })),
);

type TaskGraphApi = ReturnType<typeof useTaskGraph>;

export interface FlowBoardOverlayProps {
  /** 任务标题 */
  taskTitle: string;
  /** graph_id */
  graphId: string | null;
  /** run 是否已开始（决定 edit/board 模式） */
  runStarted: boolean;
  /** run 状态 */
  runStatus?: RunStatusValue | null;
  /** 当前选中节点 */
  selectedNodeId?: string | null;
  /** 选中节点变化 */
  onSelectNode?: (nodeId: string | null) => void;
  /** 双击节点 → 关闭覆盖层 + 进节点会话 */
  onNodeDoubleClick?: (nodeId: string) => void;
  /** 关闭覆盖层 */
  onClose: () => void;
  /** GraphEditor 所需的 taskGraph API */
  taskGraph: TaskGraphApi;
  /** 启动 run（走 task_launch_start_run，由 TaskSidebar 提供）。 */
  onStartRun?: () => Promise<void>;

  // ── NodeInspector（T7 自旧执行页面迁入）──
  /** 可选执行智能体列表。 */
  agents?: Array<{ id: string; display_name: string }>;
  agentsLoading?: boolean;
  /** 未锁定节点的默认执行者（规范化后的 planner_agent_id）。 */
  defaultAgentId?: string;
  /** 选中节点的会话信息（状态/执行者/尝试次数展示）。 */
  selectedNodeSession?: NodeSessionInfo | null;
  /** 指定执行智能体。 */
  onAssignAgent?: (nodeId: string, agentId: string, roleId: string) => Promise<void>;
}

export function FlowBoardOverlay({
  taskTitle,
  graphId,
  runStarted,
  runStatus,
  selectedNodeId,
  onSelectNode,
  onNodeDoubleClick,
  onClose,
  taskGraph,
  onStartRun,
  agents,
  agentsLoading = false,
  defaultAgentId = "",
  selectedNodeSession = null,
  onAssignAgent,
}: FlowBoardOverlayProps) {
  const { t } = useTranslation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Esc 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const mode: "edit" | "board" = runStarted ? "board" : "edit";
  const modeLabel = mode === "edit"
    ? t("task.flow.modeEdit", "流程编排")
    : t("task.flow.modeBoard", "流程看板");
  const readOnly = mode === "board" || isTerminalRunStatus(runStatus);

  // 节点点击：单击选中，双击进会话
  const lastClickTime = useRef(0);
  const lastClickNode = useRef<string | null>(null);

  const handleNodeSelect = (nodeId: string | null) => {
    if (!nodeId) {
      onSelectNode?.(null);
      return;
    }
    const now = Date.now();
    const isDoubleClick =
      lastClickNode.current === nodeId && now - lastClickTime.current < 350;
    lastClickTime.current = now;
    lastClickNode.current = nodeId;

    if (isDoubleClick) {
      onNodeDoubleClick?.(nodeId);
      return;
    }
    // 单击：延迟选中（等双击窗口过期），避免单击立刻选中然后双击触发
    // 实际上选中是幂等的，直接选中即可
    onSelectNode?.(nodeId);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* ── 顶栏 ── */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
        <Button
          ref={closeButtonRef}
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="gap-1.5 text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="text-xs">{t("common.back", "返回")}</span>
        </Button>

        <div className="h-4 w-px bg-border" />

        <Workflow className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">{taskTitle}</span>
        <span className="text-xs text-muted-foreground">·</span>
        <span className="text-xs text-muted-foreground">{modeLabel}</span>

        {/* 运行状态 */}
        {runStatus && (
          <>
            <div className="ml-2 h-1.5 w-1.5 rounded-full bg-primary/60" />
            <span className="text-xs text-muted-foreground">{runStatus}</span>
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* 视图适配由 GraphEditor 内置的 ReactFlow Controls 提供，此处不再重复入口。 */}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── 画布区 ── */}
      <div className="relative flex min-h-0 flex-1">
        {graphId ? (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {t("common.loading", "加载中…")}
              </div>
            }
          >
            <div className="flex h-full w-full flex-col">
              <GraphEditor
                snapshot={taskGraph.snapshot}
                graphId={graphId}
                currentRevisionId={taskGraph.revision?.revision_id}
                selectedNodeId={selectedNodeId}
                onNodeSelect={handleNodeSelect}
                activeRunId={taskGraph.activeRunId}
                nodeRuns={taskGraph.nodeRuns}
                startRun={onStartRun}
                runStatus={taskGraph.runStatus}
                pauseRun={taskGraph.pauseRun}
                resumeRun={taskGraph.resumeRun}
                cancelRun={taskGraph.cancelRun}
                applyCommands={taskGraph.applyCommands}
                validateCommands={taskGraph.validateCommands}
                getDiff={taskGraph.getDiff}
                lastDiff={taskGraph.lastDiff}
                canUndo={taskGraph.canUndo}
                canRedo={taskGraph.canRedo}
                undo={taskGraph.undo}
                redo={taskGraph.redo}
                generateProposal={taskGraph.generateProposal}
                planning={taskGraph.planning}
                applyDraftToRun={taskGraph.applyDraftToRun}
                canApplyDraftToRun={taskGraph.canApplyDraftToRun}
                readOnly={readOnly}
              />
              {/* 节点详情 + 指定执行智能体（T7 自旧执行页面迁入）。 */}
              {selectedNodeId && onAssignAgent && (
                <NodeInspector
                  nodeId={selectedNodeId}
                  nodeTitle={
                    taskGraph.snapshot?.nodes.find((n) => n.node_id === selectedNodeId)?.title ??
                    selectedNodeId
                  }
                  nodeSession={selectedNodeSession}
                  snapshot={taskGraph.snapshot}
                  agents={agents ?? []}
                  agentsLoading={agentsLoading}
                  defaultAgentId={defaultAgentId}
                  disabled={runStarted}
                  onAssignAgent={onAssignAgent}
                />
              )}
            </div>
          </Suspense>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Workflow className="h-8 w-8 opacity-50" />
            <p className="text-xs">{t("task.flow.noGraph", "尚未生成流程图")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
