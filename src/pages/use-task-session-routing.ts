/**
 * 任务会话导流（v0.9.3 需求10 A5 簇②③，chat-page 拆解）：
 * 任务模式的状态机动作（新建任务对话/进入任务工作台/工作模式切换/退出）、
 * 任务节点会话选择与回填、任务面板上下文（流程全景插件的数据面）整体迁出。
 *
 * 职责边界：任务态 state 仍在 chat-page（读写面横跨发送链/流式管线/JSX），
 * 本钩子收拢**动作与派生**——所有"点哪里、切到哪个会话、面板给插件什么数据"
 * 的规则在这里；页面经 deps 注入 state/ref/邻接动作，消费返回的处理器与 ctx。
 */
import { useCallback, useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { AlertDialogOptions, ConfirmDialogOptions } from "@/components/ui/confirm-dialog";
import type { Message } from "@/types";
import type { ChatInputHandle } from "@/components/sessions/chat-input";
import type { GraphSnapshot } from "@/features/task-instance/graph/use-task-graph";
import type { TaskLaunchInstanceSummary, TaskPhase } from "@/features/task-instance/types";
import type {
  TaskPanelContext,
  TaskPanelNode,
  TaskNodeSession,
} from "@/features/session-kernel/plugins/types";
import { logTaskPhaseDebug } from "@/features/task-instance/task-phase-debug";
import { orderExecutableNodes, resolvePhaseSessionId } from "./chat-page-layout";
import type { TaskLaunchPhase } from "./chat-page-utils";

/** 任务图切片（面板 ctx 派生所需的最小面）。 */
export interface RoutingTaskGraphSlice {
  snapshot: GraphSnapshot | null;
  nodeRuns: Record<string, { status?: string }>;
  runStatus: string | null;
}

export interface TaskSessionRoutingDeps {
  // ── 任务态 state setter（页面持有） ──
  setTaskModeActive: (v: boolean) => void;
  setTaskLaunchOpen: (v: boolean) => void;
  setTaskLaunchReadOnly: (v: boolean) => void;
  setTaskLaunchPhase: (v: TaskLaunchPhase) => void;
  setActiveTaskInstanceId: (v: string | null) => void;
  setActiveTaskRequirementFile: (v: string | null) => void;
  setSelectedTaskSkillId: (v: string) => void;
  setTaskSelectedNodeId: (v: string | null) => void;
  setTaskNodeSessionAgentId: (v: string | null) => void;
  // ── 任务态 ref（mount-only 管线/轮询读实时值） ──
  taskLaunchOpenRef: RefObject<boolean>;
  taskLaunchPhaseRef: RefObject<TaskLaunchPhase>;
  activeTaskInstanceIdRef: RefObject<string | null>;
  activeTaskRequirementFileRef: RefObject<string | null>;
  lastKnownStatusRef: RefObject<string | null>;
  taskSelectedNodeIdRef: RefObject<string | null>;
  enteringTaskModeRef: RefObject<boolean>;
  // ── 读值 ──
  activeId: string | null;
  taskModeActive: boolean;
  /** 当前活跃任务实例（工作台短路判定与节点取消选择的阶段会话回退）。 */
  activeTaskLaunchInstance: TaskLaunchInstanceSummary | null;
  taskSelectedNodeId: string | null;
  /** 任务图切片（面板 ctx 派生）。 */
  taskGraph: RoutingTaskGraphSlice;
  /** 节点会话索引（面板 ctx 的 nodeSessions 派生）。 */
  nodeSessionMap: Record<string, { session_id: string | null; agent_id: string | null }>;
  // ── 邻接动作 ──
  closeSessionSidebar: () => void;
  setSelectedSession: (v: string | null) => void;
  selectedSessionRef: RefObject<string | null>;
  setSessionMessages: Dispatch<SetStateAction<Message[]>>;
  chatInputRef: RefObject<ChatInputHandle | null>;
  handleTaskCancelRun: () => void;
  setTaskBoardSignal: Dispatch<SetStateAction<number>>;
  // ── 工作模式切换的 agent 语境 ──
  /** 任务引擎 agent（useAgent 的 AgentStatus 子集，结构性依赖）。 */
  taskEngineAgent: { id: string; display_name: string } | null;
  taskModeAgentReady: boolean;
  setChatAgent: (id: string) => void;
  confirmDialog: (options: ConfirmDialogOptions) => Promise<boolean>;
  alertDialog: (options: AlertDialogOptions) => Promise<unknown>;
}

export function useTaskSessionRouting(deps: TaskSessionRoutingDeps) {
  const { t } = useTranslation();
  const {
    setTaskModeActive,
    setTaskLaunchOpen,
    setTaskLaunchReadOnly,
    setTaskLaunchPhase,
    setActiveTaskInstanceId,
    setActiveTaskRequirementFile,
    setSelectedTaskSkillId,
    setTaskSelectedNodeId,
    setTaskNodeSessionAgentId,
    taskLaunchOpenRef,
    taskLaunchPhaseRef,
    activeTaskInstanceIdRef,
    activeTaskRequirementFileRef,
    lastKnownStatusRef,
    taskSelectedNodeIdRef,
    enteringTaskModeRef,
    activeId,
    taskModeActive,
    activeTaskLaunchInstance,
    taskSelectedNodeId,
    taskGraph,
    nodeSessionMap,
    closeSessionSidebar,
    setSelectedSession,
    selectedSessionRef,
    setSessionMessages,
    chatInputRef,
    handleTaskCancelRun,
    setTaskBoardSignal,
    taskEngineAgent,
    taskModeAgentReady,
    setChatAgent,
    confirmDialog,
    alertDialog,
  } = deps;

  /** 新建任务对话：任务发起弹窗态（requirements 起）+ 新会话上下文。 */
  const handleOpenTaskConversation = useCallback(() => {
    setTaskModeActive(false);
    setTaskLaunchOpen(true);
    setTaskLaunchReadOnly(false);
    setTaskLaunchPhase("requirements");
    setActiveTaskInstanceId(null);
    setActiveTaskRequirementFile(null);
    taskLaunchOpenRef.current = true;
    taskLaunchPhaseRef.current = "requirements";
    activeTaskInstanceIdRef.current = null;
    activeTaskRequirementFileRef.current = null;
    lastKnownStatusRef.current = null;
    closeSessionSidebar();
    setSelectedSession("new");
    selectedSessionRef.current = "new";
    setSessionMessages([]);
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 工作模式切换（会话/任务）：agent 能力确认 + 任务态全量重置 + 新会话。 */
  const handleWorkModeChange = useCallback(async (value: string) => {
    const nextIsTask = value === "task";
    // 方式2：进入任务模式时若当前 agent 不支持任务模式（无 TASK_MODE 能力位），
    // 弹窗确认后自动切到内建引擎 agent（v0.7.4 需求3 M2：去 agentId 写死）。
    const engineId = taskEngineAgent?.id ?? "";
    const needEngineSwitch = engineId !== "" && activeId !== engineId;
    if (nextIsTask && needEngineSwitch) {
      if (!taskModeAgentReady) {
        await alertDialog({
          title: "无法进入任务模式",
          description: "任务模式需要先安装 Jishu Agent。请到环境检测页面完成安装后再发起任务。",
        });
        return;
      }
      const engineName = taskEngineAgent?.display_name ?? "Jishu Agent";
      const confirmed = await confirmDialog({
        title: `切换到 ${engineName}`,
        description: `任务模式由 ${engineName} 提供。将切换到 ${engineName} 并进入任务模式，是否继续？`,
        confirmText: "切换并继续",
        cancelText: "取消",
      });
      if (!confirmed) return;
      // 标记本次切换是为进入任务模式，阻止 activeId 变化时的清理 effect 重置任务模式
      enteringTaskModeRef.current = true;
    }
    setTaskModeActive(false);
    setTaskLaunchOpen(nextIsTask);
    setTaskLaunchReadOnly(false);
    setTaskLaunchPhase("requirements");
    setActiveTaskInstanceId(null);
    setActiveTaskRequirementFile(null);
    taskLaunchOpenRef.current = nextIsTask;
    taskLaunchPhaseRef.current = "requirements";
    activeTaskInstanceIdRef.current = null;
    activeTaskRequirementFileRef.current = null;
    lastKnownStatusRef.current = null;
    closeSessionSidebar();
    setSelectedSession("new");
    selectedSessionRef.current = "new";
    setSessionMessages([]);
    // v0.7.0：确认切换后主动切到引擎 agent（会话作用域；enteringTaskModeRef 已置，清理 effect 会跳过任务模式重置）
    if (nextIsTask && needEngineSwitch) {
      setChatAgent(engineId);
    }
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, taskModeAgentReady]);

  /** 进入任务工作台（会话页 + 任务侧边栏形态）：主区指向任务阶段会话。 */
  const openTaskPhaseWorkspace = useCallback((
    taskSession: TaskLaunchInstanceSummary,
    phase: TaskPhase,
    readOnly = false,
  ) => {
    // 短路：已是同一任务同一阶段（且非只读切换），避免重复清空 selectedNodeId 引起
    // 节点会话闪烁/竞态（v0.7.0 需求二-问题2：节点选中后再次点击变任务选中效果）。
    if (
      activeTaskInstanceIdRef.current === taskSession.task_id &&
      activeTaskLaunchInstance?.current_phase === taskSession.current_phase &&
      taskModeActive &&
      !readOnly
    ) {
      return;
    }
    logTaskPhaseDebug("workspace:open", {
      taskId: taskSession.task_id,
      phase,
      readOnly,
      status: taskSession.status,
      currentPhase: taskSession.current_phase,
      requirementSessionId: taskSession.requirement_session_id,
      planningSessionId: taskSession.planning_session_id,
      graphId: taskSession.graph_id,
    });
    setActiveTaskInstanceId(taskSession.task_id);
    setActiveTaskRequirementFile(taskSession.requirement_file ?? null);
    setSelectedTaskSkillId(taskSession.skill_id || "jishu-conductor-dev");
    activeTaskInstanceIdRef.current = taskSession.task_id;
    activeTaskRequirementFileRef.current = taskSession.requirement_file ?? null;
    lastKnownStatusRef.current = taskSession.status;
    setTaskModeActive(true);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    // 减法重构：不再进独立 TaskWorkspace 页面。直接把主会话区指向任务的阶段会话，
    // 复用 chat-page 既有 MessageView/ChatInput。
    // T8-P1：执行阶段不再置 null（此前导致会话区纯白、需求/规划内容全丢），
    // 而是沿用 conductor 会话，在其下方合流「流程执行」分隔线 + run 事件流（需求六）。
    const phaseSession = resolvePhaseSessionId(taskSession, phase);
    setSelectedSession(phaseSession ?? null);
    selectedSessionRef.current = phaseSession ?? null;
    setTaskSelectedNodeId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskLaunchInstance?.current_phase, taskModeActive]);

  /** 任务侧边栏节点选择 → 同步主区会话 + 步骤栏高亮。 */
  const handleTaskSelectNode = useCallback((nodeId: string | null) => {
    // v0.7.0 需求二：重复点击同一节点不触发任何逻辑（与左侧列表行为一致，
    // 只点一下选中，再点不清空内容）。nodeId 相同时直接 return。
    if (nodeId !== null && nodeId === taskSelectedNodeIdRef.current) {
      return;
    }
    setTaskSelectedNodeId(nodeId);
    if (!nodeId) {
      // 取消节点选择：清空节点会话 agent_id，主区恢复阶段会话
      setTaskNodeSessionAgentId(null);
      const sess = resolvePhaseSessionId(
        activeTaskLaunchInstance,
        activeTaskLaunchInstance?.current_phase,
      );
      setSelectedSession(sess);
      selectedSessionRef.current = sess;
    } else {
      // v0.7.0 需求二-问题3：选中节点立即切到 pending-node 占位，清空上一个节点的
      // 会话残留。session_id 回填后由 handleTaskNodeSessionChange 更新为真实节点会话。
      // 此前不立即清空，导致新节点 session_id 回填前主区仍显示上一个节点的会话内容。
      setTaskNodeSessionAgentId(null);
      setSelectedSession("pending-node");
      selectedSessionRef.current = "pending-node";
      setSessionMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskLaunchInstance]);

  /** 选中节点的会话信息回填 → 主区渲染该节点会话。 */
  const handleTaskNodeSessionChange = useCallback(
    (info: { session_id: string | null; agent_id: string | null } | null) => {
      if (info && info.session_id) {
        setSelectedSession(info.session_id);
        selectedSessionRef.current = info.session_id;
      } else if (info) {
        // 节点已运行但 session_id 未回填（attempt 存在但 Pi RPC SessionResolved 未到）
        setSelectedSession("pending-node");
        selectedSessionRef.current = "pending-node";
      }
      setTaskNodeSessionAgentId(info?.agent_id ?? null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // v0.9.2 需求2 M3：任务上下文（流程全景插件的数据面——内核组装，插件
  // 不直接触达 taskGraph store；流程执行能力与核心会话松耦合的落点）。
  // 节点序 = 拓扑执行序（chat-page-layout.orderExecutableNodes，A5 簇③随迁）。
  const taskPanelCtx = useMemo<TaskPanelContext | null>(() => {
    if (!activeTaskLaunchInstance) return null;
    const snapshot = taskGraph.snapshot;
    const nodeRuns = taskGraph.nodeRuns;
    if (!snapshot) {
      return {
        taskId: activeTaskLaunchInstance.task_id,
        title: activeTaskLaunchInstance.title,
        phase: activeTaskLaunchInstance.current_phase,
        runStatus: taskGraph.runStatus ?? null,
        completed: 0,
        total: 0,
        nodes: [],
        nodeSessions: [],
        selectedNodeId: taskSelectedNodeId,
        onSelectNode: handleTaskSelectNode,
        onOpenCanvas: () => setTaskBoardSignal((n) => n + 1),
        onCancelRun: handleTaskCancelRun,
      };
    }
    const nodes: TaskPanelNode[] = orderExecutableNodes(snapshot)
      .map((node) => {
        const run = nodeRuns[node.node_id];
        const status = run?.status ?? "blocked";
        return {
          nodeId: node.node_id,
          title: node.title,
          status,
          waitingFor:
            status === "blocked" ? t("sessionPlugins.flow.waiting", "等待中") : undefined,
        };
      });
    const completed = nodes.filter((node) =>
      ["succeeded", "skipped", "cancelled", "superseded", "failed"].includes(node.status),
    ).length;
    // v0.9.2 测试期：已执行节点的子会话索引（插件跨会话识别子节点产出物）。
    const nodeSessions: TaskNodeSession[] = nodes
      .map((node) => {
        const info = nodeSessionMap[node.nodeId];
        return {
          nodeId: node.nodeId,
          title: node.title,
          sessionId: info?.session_id ?? null,
          agentId: info?.agent_id ?? null,
        };
      })
      .filter((entry) => entry.sessionId != null);
    return {
      taskId: activeTaskLaunchInstance.task_id,
      title: activeTaskLaunchInstance.title,
      phase: activeTaskLaunchInstance.current_phase,
      runStatus: taskGraph.runStatus ?? null,
      completed,
      total: nodes.length,
      nodes,
      nodeSessions,
      selectedNodeId: taskSelectedNodeId,
      onSelectNode: handleTaskSelectNode,
      onOpenCanvas: () => setTaskBoardSignal((n) => n + 1),
      onCancelRun: handleTaskCancelRun,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskLaunchInstance, taskGraph.snapshot, taskGraph.nodeRuns, taskGraph.runStatus, taskSelectedNodeId, nodeSessionMap, handleTaskSelectNode, handleTaskCancelRun, t]);

  return {
    handleOpenTaskConversation,
    handleWorkModeChange,
    openTaskPhaseWorkspace,
    handleTaskSelectNode,
    handleTaskNodeSessionChange,
    taskPanelCtx,
  };
}
