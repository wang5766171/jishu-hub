/**
 * use-task-execution-stage —— 任务执行段（v0.9.7 需求2 补充：chat-page
 * 简化簇C，自 §12 预案迁移，零逻辑变更纯移动）。
 *
 * 职责（原文件 1797-2105 区域 + 1295-1372 画布/节点动作）：
 * ① 方案卡（TaskPlanCard）数据与确认启动（handleConfirmPlan——未勾选节点
 *   remove_node 后以新 revision 启动 run；全选直启）；
 * ② 执行工作台从聊天启动（handleStartExecutionFromChat——启动前强制刷新
 *   graph 拿最新 draft revision）；
 * ③ 子任务卡/汇总卡数据（taskFlowNodes——节点状态 + 执行者权威回退 +
 *   当前动作摘要）与 nodeAgentIds 状态签名刷新；
 * ④ 失败节点人工干预（重试/跳过）与画布节点执行者指派；
 * ⑤ 执行段滚动（进入拉底 + run 流增长贴底跟随）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { startTaskRun } from "@/features/task-instance/start-run";
import { taskErrorMessage } from "@/features/task-instance/graph/use-task-graph";
import type { UseTaskGraphReturn as TaskGraphApi, GraphSnapshot } from "@/features/task-instance/graph/use-task-graph";
import { orderExecutableNodes } from "./chat-page-layout";
import type { ConfirmDialogOptions } from "@/components/ui/confirm-dialog";
import type { AgentStatus } from "@/agents/types";
import type { FlowNodeStatus, PlanNodeInfo } from "@/features/task-workspace/task-flow-cards";
import type { TaskLaunchInstanceSummary } from "@/features/task-instance/types";

interface NodeSessionSummary {
  node_id: string;
  agent_id: string | null;
}

// 方案卡数据（graph snapshot 可执行节点 + 锁定执行者/角色前提）。
function planNodesOf(snapshot: GraphSnapshot | null): PlanNodeInfo[] {
  if (!snapshot) return [];
  return orderExecutableNodes(snapshot)
    .map((node) => {
      const constraint = node.agent_assignment_constraint as { locked_agent_id?: unknown } | null | undefined;
      const locked =
        constraint && typeof constraint.locked_agent_id === "string" && constraint.locked_agent_id
          ? constraint.locked_agent_id
          : null;
      const roleRequirement = node.role_requirement as { role_id?: unknown } | null | undefined;
      const roleId =
        roleRequirement && typeof roleRequirement.role_id === "string" && roleRequirement.role_id
          ? roleRequirement.role_id
          : node.node_id;
      return {
        nodeId: node.node_id,
        title: node.title,
        responsibility: typeof node.description === "string" ? node.description : "",
        acceptance:
          node.metadata && typeof node.metadata.acceptance === "string" ? node.metadata.acceptance : null,
        agentId: locked,
        roleId,
      };
    });
}

export interface TaskExecutionStageApi {
  execStarting: boolean;
  execStartError: string | null;
  taskPlanNodes: PlanNodeInfo[];
  taskFlowNodes: FlowNodeStatus[];
  nodeActionBusy: string | null;
  showExecutionStartPrompt: boolean;
  handleConfirmPlan: (selectedIds: string[]) => Promise<void>;
  handleStartExecutionFromChat: () => Promise<void>;
  handlePlanAssignAgent: (nodeId: string, agentId: string | null) => Promise<void>;
  handleRetryNode: (nodeId: string) => Promise<void>;
  handleSkipNode: (nodeId: string) => Promise<void>;
  setExecPromptDismissedTaskId: (id: string | null) => void;
}

export function useTaskExecutionStage({
  taskExecutionMode,
  taskRunStarted,
  activeTaskLaunchInstance,
  taskGraph,
  taskGraphRef,
  boardRunId,
  projectPath,
  agents,
  confirmDialog,
  isAwayFromBottomRef,
  messageAreaRef,
  sessionMessagesLength,
}: {
  taskExecutionMode: boolean;
  taskRunStarted: boolean;
  activeTaskLaunchInstance: TaskLaunchInstanceSummary | null;
  taskGraph: TaskGraphApi;
  taskGraphRef: { current: TaskGraphApi };
  boardRunId: string | null;
  projectPath: string | null;
  agents: AgentStatus[];
  confirmDialog: (opts: ConfirmDialogOptions) => Promise<boolean>;
  isAwayFromBottomRef: RefObject<boolean>;
  messageAreaRef: RefObject<HTMLDivElement | null>;
  sessionMessagesLength: number;
}): TaskExecutionStageApi {
  const { t } = useTranslation();
  void confirmDialog; // 画布取消确认保留在页面（cancelRun 经路由钩子消费）

  const [execPromptDismissedTaskId, setExecPromptDismissedTaskId] = useState<string | null>(null);
  const [execStarting, setExecStarting] = useState(false);
  const [execStartError, setExecStartError] = useState<string | null>(null);
  const showExecutionStartPrompt =
    taskExecutionMode &&
    !taskRunStarted &&
    execPromptDismissedTaskId !== (activeTaskLaunchInstance?.task_id ?? null);

  // ── 执行段滚动（进入拉底 + run 流增长贴底） ──
  const execAutoScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!taskExecutionMode) return;
    const taskId = activeTaskLaunchInstance?.task_id;
    if (!taskId) return;
    const key = `${taskId}:${taskRunStarted ? "run" : "prompt"}`;
    if (execAutoScrolledRef.current === key) return;
    if (sessionMessagesLength === 0 && !taskRunStarted) return;
    execAutoScrolledRef.current = key;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = messageAreaRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskExecutionMode, activeTaskLaunchInstance?.task_id, taskRunStarted, sessionMessagesLength, showExecutionStartPrompt]);

  useEffect(() => {
    if (!taskExecutionMode || !taskRunStarted) return;
    if (isAwayFromBottomRef.current) return;
    const raf = requestAnimationFrame(() => {
      const el = messageAreaRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskExecutionMode, taskRunStarted, taskGraph.projectedMessages.length]);

  // ── 方案卡数据 + 行内指派 ──
  const taskPlanNodes = useMemo(() => planNodesOf(taskGraph.snapshot), [taskGraph.snapshot]);

  const handlePlanAssignAgent = useCallback(
    async (nodeId: string, agentId: string | null) => {
      if (taskGraph.activeRunId) return;
      const roleId = taskPlanNodes.find((n) => n.nodeId === nodeId)?.roleId ?? nodeId;
      try {
        await taskGraph.applyCommands([
          {
            op: "update_node",
            command_id: `plan-assign-${nodeId}-${Date.now().toString(36)}`,
            node_id: nodeId,
            patch: {
              agent_assignment_constraint: agentId
                ? {
                    role_id: roleId,
                    locked_agent_id: agentId,
                    allowed_agent_ids: [],
                    denied_agent_ids: [],
                    required_capabilities: [],
                  }
                : null,
            },
          },
        ]);
      } catch (err) {
        console.error("Failed to assign agent:", err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskGraph, taskPlanNodes],
  );

  // ── 节点执行者权威回填（状态签名驱动） ──
  const [nodeAgentIds, setNodeAgentIds] = useState<Map<string, string>>(() => new Map());
  const nodeRunStatusSignature = useMemo(
    () =>
      Object.entries(taskGraph.nodeRuns)
        .map(([id, run]) => `${id}:${run.status}:${run.attempt_count}`)
        .sort()
        .join("|"),
    [taskGraph.nodeRuns],
  );
  useEffect(() => {
    if (!boardRunId) {
      setNodeAgentIds(new Map());
      return;
    }
    let cancelled = false;
    invokeCommand<NodeSessionSummary[]>("orchestrator_list_node_sessions", { runId: boardRunId })
      .then((sessions) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const s of sessions) {
          if (s.agent_id) map.set(s.node_id, s.agent_id);
        }
        setNodeAgentIds(map);
      })
      .catch((e) => console.warn("list_node_sessions failed:", e));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRunId, nodeRunStatusSignature]);

  // ── 子任务卡/汇总卡数据 ──
  const taskFlowNodes = useMemo<FlowNodeStatus[]>(() => {
    const snapshot = taskGraph.snapshot;
    const nodeRuns = taskGraph.nodeRuns;
    if (!snapshot) return [];
    const runIdToNodeId = new Map<string, string>();
    for (const [nodeId, run] of Object.entries(nodeRuns)) {
      runIdToNodeId.set(run.node_run_id ?? "", nodeId);
    }
    const agentByNode = new Map<string, string>();
    const lastActionByNode = new Map<string, string>();
    for (const event of taskGraph.events) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const nodeId =
        typeof payload.node_id === "string" && payload.node_id
          ? payload.node_id
          : typeof payload.node_run_id === "string"
            ? runIdToNodeId.get(payload.node_run_id)
            : undefined;
      if (!nodeId) continue;
      if (event.event_type === "attempt_started") {
        const assignment = payload.agent_assignment as { agent_id?: string } | undefined;
        if (assignment?.agent_id) agentByNode.set(nodeId, assignment.agent_id);
      } else if (event.event_type === "attempt_progressed") {
        if (payload.public === false) continue;
        const message = typeof payload.message === "string" ? payload.message : "";
        // 纯标点/空白消息不作为动作摘要。
        if (message.trim() && !/^[\s。．.，,、;；!！?？·\-—~～*#]*$/.test(message)) {
          lastActionByNode.set(nodeId, message.trim());
        }
      }
    }
    return orderExecutableNodes(snapshot)
      .map((node) => {
        const status = nodeRuns[node.node_id]?.status ?? "blocked";
        const agentId = nodeAgentIds.get(node.node_id) ?? agentByNode.get(node.node_id) ?? null;
        const agent = agentId ? agents.find((a) => a.id === agentId) : null;
        return {
          nodeId: node.node_id,
          title: node.title,
          status,
          agentName: agent?.display_name ?? agentId,
          lastAction: lastActionByNode.get(node.node_id) ?? null,
          clickable: !["blocked", "ready"].includes(status),
          startedAt: nodeRuns[node.node_id]?.started_at ?? null,
          finishedAt: nodeRuns[node.node_id]?.finished_at ?? null,
          acceptance:
            node.metadata && typeof node.metadata.acceptance === "string" ? node.metadata.acceptance : null,
          error: nodeRuns[node.node_id]?.error ?? null,
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskGraph.snapshot, taskGraph.nodeRuns, taskGraph.events, agents, nodeAgentIds]);

  // ── 方案卡确认启动 / 从聊天启动 ──
  const handleConfirmPlan = useCallback(
    async (selectedIds: string[]) => {
      const instance = activeTaskLaunchInstance;
      const graphId = instance?.graph_id;
      const revisionId = taskGraph.revision?.revision_id;
      if (!instance || !graphId || !revisionId || !projectPath) return;
      const removed = taskPlanNodes.filter((node) => !selectedIds.includes(node.nodeId)).map((n) => n.nodeId);
      setExecStarting(true);
      setExecStartError(null);
      try {
        let effectiveRevisionId = revisionId;
        if (removed.length > 0) {
          const diff = await taskGraph.applyCommands(
            removed.map((nodeId) => ({
              op: "remove_node",
              command_id: `plan-exclude-${nodeId}-${Date.now().toString(36)}`,
              node_id: nodeId,
            })),
          );
          if (diff?.to_revision_id) effectiveRevisionId = diff.to_revision_id;
        }
        const result = await startTaskRun({ taskId: instance.task_id, projectRoot: projectPath, revisionId: effectiveRevisionId });
        if (result?.run_id) {
          await taskGraph.loadGraph(graphId);
        }
      } catch (err) {
        console.error("Failed to confirm plan:", err);
        setExecStartError(`${t("task.execution.error.launchFailed", "启动执行失败")}：${taskErrorMessage(err)}`);
      } finally {
        setExecStarting(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTaskLaunchInstance, taskPlanNodes, taskGraph, projectPath, t],
  );

  const handleStartExecutionFromChat = useCallback(async () => {
    const instance = activeTaskLaunchInstance;
    if (!instance || !projectPath) return;
    setExecStarting(true);
    setExecStartError(null);
    try {
      // 启动前强制刷新 graph 拿最新 draft revision（修订后旧 revision 竞态）。
      if (instance.graph_id) {
        await taskGraphRef.current.loadGraph(instance.graph_id).catch(console.error);
      }
      const revisionId = taskGraphRef.current.revision?.revision_id;
      if (!revisionId) return;
      const result = await startTaskRun({ taskId: instance.task_id, projectRoot: projectPath, revisionId });
      if (result?.run_id && instance.graph_id) {
        await taskGraph.loadGraph(instance.graph_id);
      }
    } catch (err) {
      console.error("Failed to start run from chat:", err);
      setExecStartError(`${t("task.execution.error.launchFailed", "启动执行失败")}：${taskErrorMessage(err)}`);
    } finally {
      setExecStarting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskLaunchInstance, projectPath, t]);

  // ── 失败节点人工干预 ──
  const [nodeActionBusy, setNodeActionBusy] = useState<string | null>(null);
  const handleFailedNodeAction = useCallback(
    (command: "orchestrator_retry_node" | "orchestrator_skip_node") => async (nodeId: string) => {
      const graphId = activeTaskLaunchInstance?.graph_id;
      const runId = taskGraph.displayedRunId ?? activeTaskLaunchInstance?.active_run_id ?? null;
      if (!graphId || !runId) return;
      setNodeActionBusy(nodeId);
      try {
        await invokeCommand(command, { runId, nodeId });
        await taskGraphRef.current.loadGraph(graphId);
      } catch (err) {
        console.error(`${command} failed:`, err);
      } finally {
        setNodeActionBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTaskLaunchInstance, taskGraph.displayedRunId],
  );
  const handleRetryNode = useMemo(() => handleFailedNodeAction("orchestrator_retry_node"), [handleFailedNodeAction]);
  const handleSkipNode = useMemo(() => handleFailedNodeAction("orchestrator_skip_node"), [handleFailedNodeAction]);

  return {
    execStarting,
    execStartError,
    taskPlanNodes,
    taskFlowNodes,
    nodeActionBusy,
    showExecutionStartPrompt,
    handleConfirmPlan,
    handleStartExecutionFromChat,
    handlePlanAssignAgent,
    handleRetryNode,
    handleSkipNode,
    setExecPromptDismissedTaskId,
  };
}
