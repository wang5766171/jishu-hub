/**
 * TaskSidebar —— 任务模式下的右侧任务侧边栏组件（减法重构版）。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §3（会话页面 + 任务侧边栏）、§4 ProcessStepsPanel。
 *
 * 关键决策（用户明确要求）：
 * - 任务模式 = 普通会话页面（chat-page 原样复用 MessageView/ChatInput）+ 本侧边栏组件。
 * - 本组件 ONLY 渲染任务专属的「步骤面板 + 治理面 + 流程画布」，绝不复制会话区。
 * - 主会话区由 chat-page 自身渲染，selectedSession 指向任务的会话（需求/规划/节点）。
 *
 * 数据装配：
 * - useTaskGraph 由 chat-page 顶层无条件持有并传入（避免重复 hook）。
 * - useTaskInstance / useNodeSession 在本组件内持有（仅任务激活时挂载，故安全）。
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  taskErrorMessage,
  useTaskGraph,
  type RunProjection,
} from "@/features/task-instance/graph/use-task-graph";
import { useTaskInstance } from "@/features/task-instance/use-task-instance";
import { startTaskRun } from "@/features/task-instance/start-run";
import { useNodeSession } from "@/features/task-instance/use-node-session";
import { normalizeAgentId, type TaskLaunchInstanceSummary } from "@/features/task-instance/types";
import { ProcessStepsPanel } from "./steps/process-steps-panel";

// 流程页 lazy，避免膨胀初始 bundle
const FlowBoardOverlay = lazy(() =>
  import("./board/flow-board-overlay").then((m) => ({ default: m.FlowBoardOverlay })),
);

export interface TaskSidebarProps {
  taskId: string;
  projectPath: string;
  /** chat-page 的活跃任务实例（含 title / graph_id / active_run_id / 各阶段 session）。 */
  instance: TaskLaunchInstanceSummary;
  /** chat-page 顶层持有的 useTaskGraph 实例（单一数据源）。 */
  taskGraph: ReturnType<typeof useTaskGraph>;
  agents?: Array<{ id: string; display_name: string }>;
  agentsLoading?: boolean;
  /** 当前选中节点（chat-page 持有，用于步骤栏高亮 + 主区会话切换）。 */
  selectedNodeId?: string | null;
  /** 节点选择变化（步骤栏点击）→ 上浮 chat-page 以同步主区。 */
  onSelectNode?: (nodeId: string | null) => void;
  /** 选中节点的会话信息回填（供 chat-page 主区渲染该节点会话，含 agent_id）。
   *  v0.7.0 需求二-问题3：传完整 info 而非仅 session_id，以便节点会话消息加载
   *  用节点绑定的 agent_id（节点子代理可能是 claude-code/codex 等非 jishu-self）。 */
  onNodeSessionChange?: (info: { session_id: string | null; agent_id: string | null } | null) => void;
  /** 「隐藏步骤栏」（P4c）：收起整个侧边栏，由 chat-page 提供重开入口。 */
  onHide?: () => void;
}

export function TaskSidebar({
  taskId,
  projectPath,
  instance,
  taskGraph,
  agents,
  agentsLoading = false,
  selectedNodeId,
  onSelectNode,
  onNodeSessionChange,
  onHide,
}: TaskSidebarProps) {
  const { t } = useTranslation();
  const task = useTaskInstance({ projectRoot: projectPath, initialTaskId: taskId });

  // 进入时打开任务（仅加载实例，不影响 chat-page 主区）
  useEffect(() => {
    task.openTask(taskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // 执行阶段：加载图数据
  useEffect(() => {
    if (
      instance.current_phase === "execution" &&
      instance.graph_id &&
      instance.graph_id !== taskGraph.graph?.graph_id
    ) {
      taskGraph.loadGraph(instance.graph_id).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.current_phase, instance.graph_id]);

  // ── 执行阶段专用状态 ──
  const [boardOpen, setBoardOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // 节点会话查询（按需挂载当前选中节点）
  // P4f：必须用 displayedRunId（= activeRunId ?? lastRunId）兜底——已完成 run 重进时
  // activeRunId 已清空，仅 lastRunId 保留；否则 projection 为 null，fetchNodeSession
  // 直接 return，节点会话永远回填不上，点步骤会落到主任务会话。
  const projection = useMemo<RunProjection | null>(() => {
    const runId = taskGraph.displayedRunId ?? instance.active_run_id ?? null;
    if (!runId) return null;
    return {
      run_id: runId,
      graph_id: instance.graph_id ?? "",
      revision_id: taskGraph.activeRunRevisionId ?? taskGraph.revision?.revision_id ?? "",
      status: taskGraph.runStatus ?? "draft",
      run_seq: 0,
      node_runs: taskGraph.nodeRuns as unknown as RunProjection["node_runs"],
    };
  }, [
    instance.graph_id,
    instance.active_run_id,
    taskGraph.activeRunId,
    taskGraph.activeRunRevisionId,
    taskGraph.revision?.revision_id,
    taskGraph.runStatus,
    taskGraph.nodeRuns,
  ]);

  const nodeSession = useNodeSession({
    projection,
    onNodeSession: task.updateNodeSession,
  });

  // run id（activeRunId 优先；已完成 run 重进时为 lastRunId 经 displayedRunId 暴露）。
  // 提到首个 effect 之前声明，供下方节点会话查询 effect 使用。
  const runId = taskGraph.displayedRunId ?? instance.active_run_id ?? null;

  // 选中节点变化 → 同步 TaskInstance 内部 chatScope + 查询该节点会话。
  // selectedNodeId 是唯一受控源（可能来自侧边栏点击，也可能来自左侧任务树点击），
  // 这里统一回灌 task.selectNode，避免两处状态漂移。
  // P4f：依赖 runId——图/run 异步加载就绪（projection 从 null 变非空）后，
  // 若 selectedNodeId 未变，也要补查一次节点会话，否则刷新后点到已执行节点会落空。
  // Issue2：额外依赖选中节点的 attempt_count——节点开始执行 / 执行完成（会话就绪）时
  // 即使 selectedNodeId 不变也要重查，确保已完成节点也能稳定进入其会话。
  const selectedAttemptCount = selectedNodeId
    ? (taskGraph.nodeRuns[selectedNodeId]?.attempt_count ?? 0)
    : 0;
  // v0.7.0 需求二-问题3：额外监听选中节点的 status 与 session_id 变化——
  // 节点进入 running 态但 session_id 尚未由 Pi RPC SessionResolved 回填时，
  // 主区会卡在"未开始"占位。依赖 status/session_id 确保 session_id 回填后立即重查，
  // 让节点会话内容在运行阶段就显示，而非等到完成。
  const selectedNodeStatus = selectedNodeId
    ? (taskGraph.nodeRuns[selectedNodeId]?.status ?? null)
    : null;
  useEffect(() => {
    task.selectNode(selectedNodeId ?? null);
    if (selectedNodeId && runId) {
      nodeSession.fetchNodeSession(selectedNodeId).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId, runId, selectedAttemptCount, selectedNodeStatus]);

  // 选中节点的会话信息上浮 chat-page（主区渲染用）
  useEffect(() => {
    if (!selectedNodeId) {
      onNodeSessionChange?.(null);
      return;
    }
    const info = task.nodeSessionMap[selectedNodeId];
    onNodeSessionChange?.(info ? { session_id: info.session_id, agent_id: info.agent_id } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId, task.nodeSessionMap]);

  // run 状态变化回写 TaskInstance
  useEffect(() => {
    if (taskGraph.runStatus && runId) {
      task.syncRunStatus(runId, taskGraph.runStatus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskGraph.runStatus, runId]);

  // ── 步骤栏数据 ──
  const agentNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const agent of agents ?? []) {
      map[agent.id] = agent.display_name;
    }
    return map;
  }, [agents]);

  // ── 步骤栏回调 ──
  const handleSelectNode = useCallback(
    (nodeId: string | null) => {
      task.selectNode(nodeId);
      onSelectNode?.(nodeId);
    },
    [task, onSelectNode],
  );

  const handleLaunchRun = useCallback(async () => {
    const revisionId = taskGraph.revision?.revision_id;
    if (!instance.graph_id || !revisionId) return;
    setActionError(null);
    try {
      // T8-P1：与会话区「是否开始执行」共用同一启动入口，保证幂等键一致。
      const result = await startTaskRun({
        taskId: instance.task_id,
        projectRoot: projectPath,
        revisionId,
      });
      if (result?.run_id) {
        task.syncRunStatus(result.run_id, "running");
        await taskGraph.loadGraph(instance.graph_id);
      }
    } catch (err) {
      console.error("Failed to launch run:", err);
      setActionError(
        `${t("task.execution.error.launchFailed", "启动执行失败")}：${taskErrorMessage(err)}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.task_id, instance.graph_id, taskGraph.revision?.revision_id, taskGraph.loadGraph, projectPath, t]);

  const handleAssignAgent = useCallback(
    async (nodeId: string, agentId: string, roleId: string) => {
      if (runId) return;
      setActionError(null);
      try {
        await taskGraph.applyCommands([
          {
            op: "update_node",
            command_id: `assign-${nodeId}-${Date.now().toString(36)}`,
            node_id: nodeId,
            patch: {
              agent_assignment_constraint: {
                role_id: roleId,
                locked_agent_id: agentId,
                allowed_agent_ids: [],
                denied_agent_ids: [],
                required_capabilities: [],
              },
            },
          },
        ]);
      } catch (err) {
        console.error("Failed to assign agent:", err);
        setActionError(
          `${t("task.execution.error.assignAgentFailed", "指定智能体失败")}：${taskErrorMessage(err)}`,
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, taskGraph.applyCommands, t],
  );

  const isExecution = instance.current_phase === "execution";
  const activeRunId = runId;
  const inspectorSession = selectedNodeId
    ? task.nodeSessionMap[selectedNodeId] ?? null
    : null;

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col overflow-hidden border-l border-border/30 bg-background">
      {/* 操作类错误的可见反馈（启动 run / 指定 agent 失败）。 */}
      {actionError && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-1.5 text-[11px] text-red-600 dark:text-red-300">
          <span className="min-w-0 truncate">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="shrink-0 rounded px-1 hover:bg-red-500/15"
          >
            {t("common.dismiss", "知道了")}
          </button>
        </div>
      )}

      <ProcessStepsPanel
        title={instance.title}
        snapshot={taskGraph.snapshot}
        nodeRuns={taskGraph.nodeRuns}
        runStatus={taskGraph.runStatus}
        activeRunId={activeRunId}
        graphId={instance.graph_id ?? null}
        instanceActiveRunId={instance.active_run_id ?? null}
        selectedNodeId={selectedNodeId ?? null}
        agentNames={agentNames}
        onHideSidebar={onHide}
        onSelectNode={handleSelectNode}
        onStartRun={handleLaunchRun}
        onPauseRun={() => taskGraph.pauseRun().catch(console.error)}
        onResumeRun={() => taskGraph.resumeRun().catch(console.error)}
        onCancelRun={() => taskGraph.cancelRun().catch(console.error)}
        onOpenBoard={() => setBoardOpen(true)}
      />

      {/* 流程画布页覆盖层（T5） */}
      {boardOpen && isExecution && instance.graph_id && (
        <Suspense fallback={null}>
          <FlowBoardOverlay
            taskTitle={instance.title}
            graphId={instance.graph_id ?? null}
            runStarted={Boolean(activeRunId)}
            runStatus={taskGraph.runStatus}
            selectedNodeId={selectedNodeId}
            onSelectNode={handleSelectNode}
            onNodeDoubleClick={(nodeId) => {
              setBoardOpen(false);
              handleSelectNode(nodeId);
            }}
            onClose={() => setBoardOpen(false)}
            taskGraph={taskGraph}
            onStartRun={handleLaunchRun}
            agents={agents}
            agentsLoading={agentsLoading}
            defaultAgentId={normalizeAgentId(instance.planner_agent_id)}
            selectedNodeSession={inspectorSession}
            onAssignAgent={handleAssignAgent}
          />
        </Suspense>
      )}
    </div>
  );
}
