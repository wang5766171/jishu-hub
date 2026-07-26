/**
 * PhaseExecutionView —— 任务执行阶段视图（三维模型）。
 *
 * 设计依据：`任务入口与容器架构设计_20260622.md` §4（三维模型）、§4.6.1（节点 hook 按需挂载）。
 *           `任务数据结构与生命周期设计_20260622.md` §3.3.1（三层模型）。
 *
 * 三个正交维度：
 *   1. 展现形式（canvas / split / chat）
 *   2. 会话范围（主任务会话 run 事件流 / 节点子代理会话）
 *   3. 主进程状态（RunProjection，画布节点状态实时反映，独立于会话切换）
 *
 * 关键约束（§4.6.1）：
 *   - 主任务会话（useRunEventStream）始终活跃，承载画布节点状态/主进程实时态
 *   - 节点子代理会话（useChatSession）只挂载当前选中节点
 *   - 切换 chatScope/节点纯前端视图行为，不打断后端执行
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, Square, X, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GraphEditor } from "@/features/task-instance/graph/graph-editor";
import { ExecutionGovernanceDrawer, type GovernanceTab } from "./execution-governance-drawer";
import { MessageView } from "@/components/sessions/message-view";
import { ChatInput } from "@/components/sessions/chat-input";
import { StreamingMessage } from "@/components/sessions/streaming-message";
import { useChatSession } from "@/features/chat-core/use-chat-session";
import { invokeCommand } from "@/hooks/use-invoke";
import { useRunEventStream } from "./use-run-event-stream";
import { useNodeSession } from "./use-node-session";
import { ExecutionViewSwitcher } from "./execution-view-switcher";
import { ExecutionChatScopeTabs } from "./execution-chat-scope-tabs";
import { cn } from "@/lib/utils";
import type { useTaskGraph, RunProjection, RunStatusValue } from "@/features/task-instance/graph/use-task-graph";
import { isTerminalRunStatus, taskErrorMessage } from "@/features/task-instance/graph/use-task-graph";
import type {
  ExecutionChatScope,
  ExecutionView,
  NodeSessionInfo,
  TaskInstance,
} from "./types";
import { normalizeAgentId } from "./types";

// 从 use-task-graph 推导返回类型（避免直接导出复杂的 hook 返回类型）。
type TaskGraphApi = ReturnType<typeof useTaskGraph>;

interface PhaseExecutionViewProps {
  instance: TaskInstance;
  projectPath: string;
  encodedProjectId?: string;
  taskGraph: TaskGraphApi;
  executionView: ExecutionView;
  chatScope: ExecutionChatScope;
  selectedNodeId: string | null;
  nodeSessions: Record<string, NodeSessionInfo>;
  /** 可选智能体列表（用于按节点指定执行 agent）。 */
  agents?: Array<{ id: string; display_name: string }>;
  /** agents 是否仍在加载。用于区分「加载中」与「加载失败/为空」——二者此前 UI 同形。 */
  agentsLoading?: boolean;
  onExecutionViewChange: (view: ExecutionView) => void;
  onChatScopeChange: (scope: ExecutionChatScope) => void;
  onSelectNode: (nodeId: string | null) => void;
  onNodeSessionUpdate: (nodeId: string, info: NodeSessionInfo) => void;
  onSyncRunStatus: (runId: string, status: string) => void;
  /**
   * 完成态只读（设计 §11）：run 已 completed 时整个执行视图不可编辑——
   * 节点会话不可发消息、画布不可增删改。由 container 从 task.readOnly 透传。
   */
  readOnly?: boolean;
}

export function PhaseExecutionView({
  instance,
  projectPath,
  encodedProjectId,
  taskGraph,
  executionView,
  chatScope,
  selectedNodeId,
  nodeSessions,
  agents,
  agentsLoading = false,
  onExecutionViewChange,
  onChatScopeChange,
  onSelectNode,
  onNodeSessionUpdate,
  onSyncRunStatus,
  readOnly = false,
}: PhaseExecutionViewProps) {
  const { t } = useTranslation();
  const runId = instance.active_run_id ?? taskGraph.displayedRunId ?? null;
  const runStarted = Boolean(runId || taskGraph.activeRunId);
  // T5：操作类错误的可见反馈。设计 §12 要求"run 启动失败 → 工作台提示"，
  // 此前所有错误只 console.error，对用户完全静默。
  // 用内联错误条而非 toast——全仓当前无 toast 基建，引入通知库属独立技术决策。
  const [actionError, setActionError] = useState<string | null>(null);

  // ── 执行治理面（S2）：审批队列 / 失败节点干预 / 产物 / 版本 ──
  // run 进 awaiting_human 或新审批到来时自动展开（仅边缘触发，用户关闭后不强制重开）。
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [governanceTab, setGovernanceTab] = useState<GovernanceTab>("approvals");
  const prevPendingRef = useRef(0);
  const prevAwaitingRef = useRef(false);
  const pendingApprovals = useMemo(
    () => taskGraph.approvals.filter((a) => !a.resolved),
    [taskGraph.approvals],
  );
  const isAwaitingHuman = taskGraph.runStatus === "awaiting_human";
  useEffect(() => {
    const newPending = pendingApprovals.length > prevPendingRef.current;
    const newAwaiting = isAwaitingHuman && !prevAwaitingRef.current;
    if (newPending || newAwaiting) {
      setGovernanceOpen(true);
      setGovernanceTab("approvals");
    }
    prevPendingRef.current = pendingApprovals.length;
    prevAwaitingRef.current = isAwaitingHuman;
  }, [pendingApprovals.length, isAwaitingHuman]);

  // 选中节点是否需要人工干预（NodeInspector 入口按钮显隐）。
  const selectedNodeRun = selectedNodeId ? taskGraph.nodeRuns[selectedNodeId] ?? null : null;
  const selectedNeedsIntervention = !!selectedNodeRun && [
    "failed",
    "awaiting_approval",
    "retry_wait",
    "repairing",
  ].includes(selectedNodeRun.status);

  // ── 手动启动执行（UI 驱动）：在最新 revision 上创建 run 并同步 TaskInstance ──
  const handleLaunchRun = async () => {
    const revisionId = taskGraph.revision?.revision_id;
    if (!instance.graph_id || !revisionId) return;
    setActionError(null);
    try {
      const result = await invokeCommand<{ status: string; run_id: string }>(
        "task_launch_start_run",
        {
          request: {
            task_id: instance.task_id,
            project_root: projectPath,
            revision_id: revisionId,
            idempotency_key: `ui-${instance.task_id}-${revisionId}`,
          },
        },
      );
      if (result?.run_id) {
        onSyncRunStatus(result.run_id, "running");
        await taskGraph.loadGraph(instance.graph_id);
      }
    } catch (err) {
      console.error("Failed to launch run:", err);
      setActionError(
        `${t("task.execution.error.launchFailed", "启动执行失败")}：${taskErrorMessage(err)}`,
      );
    }
  };

  // ── 按节点指定执行 agent：UpdateNode 设置 agent_assignment_constraint.locked_agent_id → 新 revision ──
  const handleAssignAgent = async (nodeId: string, agentId: string, roleId: string) => {
    if (runStarted) return;
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
  };

  // ── 维度3：主进程（run 事件流 + 投影）── 始终活跃 ──
  const runStream = useRunEventStream({ runId });

  // run 状态变化时回写 TaskInstance（联动 active_run_id / run_status）。
  useEffect(() => {
    if (runStream.runStatus && runId) {
      onSyncRunStatus(runId, runStream.runStatus);
    }
  }, [runStream.runStatus, runId, onSyncRunStatus]);

  // ── 节点会话查询（按需挂载当前选中节点）──
  // 构造 projection（从 taskGraph 的运行数据聚合）。
  // 注意：use-task-graph 的 nodeRuns 是 Record<string, NodeRun>，含 node_run_id/node_id/status/attempt_count，
  // 与 RunProjection.node_runs 的 NodeRunProjection 结构兼容（NodeRun.status 是 NodeRunStatus 枚举，兼容）。
  const projection = useMemo(() => {
    if (!runId) return null;
    return {
      run_id: runId,
      graph_id: instance.graph_id ?? "",
      revision_id: taskGraph.activeRunRevisionId ?? taskGraph.revision?.revision_id ?? "",
      status: taskGraph.runStatus ?? "draft",
      run_seq: 0,
      node_runs: taskGraph.nodeRuns as unknown as RunProjection["node_runs"],
    } as RunProjection;
  }, [runId, instance.graph_id, taskGraph.activeRunRevisionId, taskGraph.revision?.revision_id, taskGraph.runStatus, taskGraph.nodeRuns]);

  const nodeSession = useNodeSession({
    projection,
    onNodeSession: onNodeSessionUpdate,
  });

  // 选中节点变化 → 查询该节点会话（不打断执行）。
  useEffect(() => {
    if (selectedNodeId && chatScope.kind === "node") {
      nodeSession.fetchNodeSession(selectedNodeId).catch(console.error);
    }
  }, [selectedNodeId, chatScope.kind, nodeSession.fetchNodeSession]);

  // ── 维度2：会话范围（主任务 / 节点子代理）──
  const currentNodeSession =
    chatScope.kind === "node" ? nodeSessions[chatScope.nodeId] ?? null : null;
  const nodeSessionId = currentNodeSession?.session_id ?? null;

  // 节点子代理会话 hook（只挂载当前选中节点，按需）。
  const shouldUseNodeSession = chatScope.kind === "node" && nodeSessionId;
  const nodeChat = useChatSession({
    sessionId: shouldUseNodeSession ? nodeSessionId! : "__inactive__",
    projectPath,
    encodedProjectId,
    // 完成态下节点子代理会话也只读（不可 steer）。
    readOnly,
  });

  // ── 节点标题映射 ──
  const nodeTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const node of taskGraph.snapshot?.nodes ?? []) {
      map[node.node_id] = node.title;
    }
    return map;
  }, [taskGraph.snapshot?.nodes]);

  const showCanvas = executionView === "canvas" || executionView === "split";
  const showChatPanel = executionView === "split" || executionView === "chat";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* 顶部工具栏：运行状态 + 展现形式切换 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <RunStatusBadge status={taskGraph.runStatus} />
        <div className="flex items-center gap-1">
          {taskGraph.runStatus === "running" && (
            <button
              type="button"
              onClick={() => taskGraph.pauseRun().catch(console.error)}
              className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.pause", "暂停")}
            >
              <Pause className="h-3 w-3" />
            </button>
          )}
          {/* Q1（用户 2026-07-25 定）：awaiting_human 不给恢复按钮——该状态的推进方式是审批（B3.5），
              此处仅由徽章正确显示「等待审批」，避免用户误以为卡死。 */}
          {taskGraph.runStatus === "paused" && (
            <button
              type="button"
              onClick={() => taskGraph.resumeRun().catch(console.error)}
              className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.resume", "恢复")}
            >
              <Play className="h-3 w-3" />
            </button>
          )}
          {!taskGraph.activeRunId && !instance.active_run_id && instance.graph_id && (
            <button
              type="button"
              onClick={() => handleLaunchRun().catch(console.error)}
              className="flex h-6 items-center gap-1 rounded bg-primary/10 px-2 text-[11px] text-primary hover:bg-primary/20"
              title={t("task.execution.start", "开始执行")}
            >
              <Play className="h-3 w-3" />
              {t("task.execution.start", "开始执行")}
            </button>
          )}
          {taskGraph.activeRunId && !isTerminalRunStatus(taskGraph.runStatus) && (
            <button
              type="button"
              onClick={() => taskGraph.cancelRun().catch(console.error)}
              className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.cancel", "取消")}
            >
              <Square className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setGovernanceOpen((v) => !v)}
          className="relative flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("task.governance.open", "执行治理")}
          aria-label={t("task.governance.open", "执行治理")}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          {pendingApprovals.length > 0 && (
            <span className="grid h-3.5 min-w-3.5 place-items-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold leading-none text-white">
              {pendingApprovals.length}
            </span>
          )}
        </button>
        <div className="ml-auto">
          <ExecutionViewSwitcher value={executionView} onChange={onExecutionViewChange} />
        </div>
      </div>

      {/* T5：操作错误内联提示（设计 §12「run 启动失败 → 工作台提示」） */}
      {actionError && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400"
        >
          <span className="min-w-0 flex-1 break-words">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="shrink-0 rounded p-0.5 hover:bg-red-500/20"
            title={t("common.close", "关闭")}
            aria-label={t("common.close", "关闭")}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* 画布区（canvas/split 显示） */}
        {showCanvas && (
          <div
            className={cn(
              "flex min-h-0 flex-col",
              executionView === "split" ? "flex-1" : "flex-1",
            )}
          >
            <GraphEditor
              snapshot={taskGraph.snapshot}
              graphId={instance.graph_id}
              currentRevisionId={taskGraph.revision?.revision_id}
              selectedNodeId={selectedNodeId}
              onNodeSelect={(id) => {
                onSelectNode(id);
                if (id) {
                  // 点节点 → 自动切到分屏 + 该节点会话
                  onExecutionViewChange("split");
                }
              }}
              activeRunId={taskGraph.activeRunId}
              nodeRuns={taskGraph.nodeRuns}
              startRun={() => handleLaunchRun()}
              runStatus={taskGraph.runStatus}
              pauseRun={() => taskGraph.pauseRun()}
              resumeRun={() => taskGraph.resumeRun()}
              cancelRun={() => taskGraph.cancelRun()}
              applyCommands={taskGraph.applyCommands}
              canUndo={taskGraph.canUndo}
              canRedo={taskGraph.canRedo}
              undo={() => taskGraph.undo()}
              redo={() => taskGraph.redo()}
              readOnly={readOnly}
            />
          </div>
        )}

        {/* 对话面板（split/chat 显示） */}
        {showChatPanel && (
          <div
            className={cn(
              "flex min-h-0 flex-col border-l border-border",
              executionView === "chat" ? "flex-1" : "w-[420px]",
            )}
          >
            <ExecutionChatScopeTabs
              scope={chatScope}
              nodeSessions={nodeSessions}
              nodeTitles={nodeTitles}
              runActive={taskGraph.runStatus === "running"}
              onChange={onChatScopeChange}
            />
            <ExecutionChatPanel
              scope={chatScope}
              runMessages={runStream.projectedMessages}
              nodeChat={shouldUseNodeSession ? nodeChat : null}
              projectPath={projectPath}
              sessionId={nodeSessionId}
              readOnly={readOnly}
              placeholder={
                chatScope.kind === "run"
                  ? t("task.execution.mainPlaceholder", "查看执行进展…使用 @steer 干预")
                  : t("task.execution.nodePlaceholder", "输入消息…干预该节点 agent")
              }
            />
          </div>
        )}

        {/* 执行治理面（S2）：右浮层，工具栏「治理」按钮切换；awaiting_human/新审批自动展开 */}
        <ExecutionGovernanceDrawer
          open={governanceOpen}
          onClose={() => setGovernanceOpen(false)}
          tab={governanceTab}
          onTabChange={setGovernanceTab}
          approvals={taskGraph.approvals}
          artifacts={taskGraph.artifacts}
          revisions={taskGraph.revisions}
          currentRevisionId={taskGraph.revision?.revision_id ?? null}
          nodeRuns={taskGraph.nodeRuns}
          snapshot={taskGraph.snapshot}
          selectedNodeId={selectedNodeId}
          readOnly={readOnly}
          onResolveApproval={taskGraph.resolveApproval}
          onChooseRecovery={taskGraph.chooseRecovery}
        />
      </div>

      {/* InspectorPanel（选中节点时滑出，简化为底部固定区） */}
      {selectedNodeId && (
        <NodeInspector
          nodeId={selectedNodeId}
          nodeTitle={nodeTitles[selectedNodeId] ?? selectedNodeId}
          nodeSession={currentNodeSession}
          snapshot={taskGraph.snapshot}
          agents={agents ?? []}
          agentsLoading={agentsLoading}
          defaultAgentId={normalizeAgentId(instance.planner_agent_id)}
          disabled={runStarted}
          needsIntervention={selectedNeedsIntervention}
          onAssignAgent={handleAssignAgent}
          onOpenIntervention={() => {
            setGovernanceTab("intervention");
            setGovernanceOpen(true);
          }}
        />
      )}
    </div>
  );
}

/**
 * 运行状态徽章。
 *
 * ⚠️ status 值为后端 `RunStatus` 的 serde snake_case 形式（见 `use-task-graph.ts`
 * 的 `RunStatusValue`）。此前误用 PascalCase 比较，导致所有分支落 default、
 * 徽章恒显"待执行"。参数改用联合类型后，缺失分支可被 TS 发现。
 */
function RunStatusBadge({ status }: { status: RunStatusValue | null | undefined }) {
  const { t } = useTranslation();
  const label = (() => {
    switch (status) {
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
      case "validating":
        return t("task.run.validating", "校验中");
      case "ready":
        return t("task.run.ready", "就绪");
      case "draft":
      default:
        return t("task.run.draft", "待执行");
    }
  })();
  const color = (() => {
    switch (status) {
      case "running":
        return "bg-primary/15 text-primary";
      case "paused":
        return "bg-orange-500/15 text-orange-600";
      case "awaiting_human":
        return "bg-amber-500/15 text-amber-600";
      case "completed":
        return "bg-emerald-500/15 text-emerald-600";
      case "failed":
        return "bg-red-500/15 text-red-600";
      case "validating":
      case "ready":
        return "bg-sky-500/15 text-sky-600";
      case "cancelled":
      case "draft":
      default:
        return "bg-muted text-muted-foreground";
    }
  })();
  return (
    <span className={cn("rounded px-2 py-0.5 text-[10px] font-medium", color)}>{label}</span>
  );
}

/** 对话面板：根据 scope 渲染 run 事件流 或 节点会话。 */
function ExecutionChatPanel({
  scope,
  runMessages,
  nodeChat,
  projectPath,
  sessionId,
  readOnly,
  placeholder,
}: {
  scope: ExecutionChatScope;
  runMessages: ReturnType<typeof useRunEventStream>["projectedMessages"];
  nodeChat: ReturnType<typeof useChatSession> | null;
  projectPath: string;
  sessionId: string | null;
  readOnly: boolean;
  placeholder: string;
}) {
  // 主任务会话：渲染 run 事件流投影的消息（只读，干预用 @steer 单独入口）
  if (scope.kind === "run") {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[760px] flex-col gap-2 px-3 py-3">
            {runMessages.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                {placeholder}
              </div>
            ) : (
              <MessageView messages={runMessages} />
            )}
          </div>
        </div>
      </div>
    );
  }

  // 节点子代理会话：渲染该节点 agent 的真实会话消息
  if (!nodeChat || !sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        节点尚未产生会话…
      </div>
    );
  }
  const isStreaming = nodeChat.stream?.isStreaming ?? false;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-2 px-3 py-3">
          <MessageView messages={nodeChat.messages} />
          <StreamingMessage sessionId={sessionId} isComplete={!isStreaming} userMessage={null} />
        </div>
      </div>
      {/* 完成态只读：隐藏节点会话输入框（不可 steer），与 PhaseConversationShell 范式一致。 */}
      {!readOnly && (
        <div className="shrink-0 border-t border-border bg-background p-2">
          <ChatInput
            sessionId={sessionId}
            projectPath={projectPath}
            isSessionStreaming={isStreaming}
            placeholder={placeholder}
          />
        </div>
      )}
    </div>
  );
}

/** 节点详情 Inspector（简化版，展示节点标题、状态、agent）。 */
function NodeInspector({
  nodeId,
  nodeTitle,
  nodeSession,
  snapshot,
  agents,
  agentsLoading,
  defaultAgentId,
  disabled,
  needsIntervention,
  onAssignAgent,
  onOpenIntervention,
}: {
  nodeId: string;
  nodeTitle: string;
  nodeSession: NodeSessionInfo | null;
  snapshot: {
    nodes: Array<{
      node_id: string;
      title: string;
      description: string | null;
      role_requirement?: Record<string, unknown> | null;
      agent_assignment_constraint?: Record<string, unknown> | null;
    }>;
  } | null;
  agents: Array<{ id: string; display_name: string }>;
  agentsLoading: boolean;
  /** 未锁定节点的默认执行者（= TaskInstance.planner_agent_id，规范化后）。 */
  defaultAgentId: string;
  disabled: boolean;
  /** 选中节点 failed/awaiting_approval/retry_wait/repairing 时，显示「需干预」入口直达治理面板。 */
  needsIntervention: boolean;
  onAssignAgent: (nodeId: string, agentId: string, roleId: string) => Promise<void>;
  onOpenIntervention: () => void;
}) {
  const { t } = useTranslation();
  const node = snapshot?.nodes.find((n) => n.node_id === nodeId);
  const constraint = node?.agent_assignment_constraint;
  const roleRequirement = node?.role_requirement;
  const lockedAgentId = typeof constraint?.locked_agent_id === "string" ? constraint.locked_agent_id : "";
  const roleId = typeof roleRequirement?.role_id === "string" ? roleRequirement.role_id : nodeId;

  /** id → 展示名。用户可见处一律用 display_name，不得暴露内部代号（DEVELOP_READ §13.6）。 */
  const agentDisplayName = (id: string): string =>
    agents.find((agent) => agent.id === id)?.display_name ?? id;

  // D3：未锁定节点的默认执行者显示为默认 agent 名，而非「自动选择」。
  // 引擎侧的同一语义由 resolve_agent_assignment 的显式回退保证（设计 §6.2）。
  const defaultOptionLabel = agentsLoading
    ? t("task.execution.agentsLoading", "加载智能体…")
    : t("task.execution.defaultAgent", "{{name}}（默认）", {
        name: agentDisplayName(defaultAgentId),
      });

  return (
    <div className="h-32 shrink-0 border-t border-border bg-background px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-xs font-medium text-foreground">{nodeTitle}</div>
        {needsIntervention && (
          <button
            type="button"
            onClick={onOpenIntervention}
            className="flex h-6 shrink-0 items-center gap-1 rounded bg-amber-500/15 px-2 text-[10px] font-medium text-amber-700 hover:bg-amber-500/25 dark:text-amber-300"
            title={t("task.governance.needsIntervention", "需干预")}
          >
            <ShieldCheck className="h-3 w-3" />
            {t("task.governance.needsIntervention", "需干预")}
          </button>
        )}
        <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{t("task.execution.executorAgent", "执行智能体")}</span>
          <select
            value={lockedAgentId}
            disabled={disabled || agents.length === 0}
            onChange={(event) => {
              const value = event.target.value;
              if (value) onAssignAgent(nodeId, value, roleId).catch(console.error);
            }}
            className="h-6 rounded border border-border bg-background px-2 text-[11px] text-foreground disabled:opacity-60"
          >
            <option value="">{defaultOptionLabel}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.display_name}</option>
            ))}
          </select>
        </label>
      </div>
      {/* 项③：加载中与加载失败此前 UI 完全同形（都只是置灰 select），补可辨识提示。 */}
      {agents.length === 0 && (
        <div className="mt-1 text-[10px] text-muted-foreground">
          {agentsLoading
            ? t("task.execution.agentsLoading", "加载智能体…")
            : t("task.execution.agentsUnavailable", "智能体列表不可用，请检查智能体配置")}
        </div>
      )}
      {node?.description && (
        <div className="mt-1 text-[11px] text-muted-foreground">{node.description}</div>
      )}
      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
        {nodeSession && (
          <>
            <span>
              {t("task.execution.nodeStatus", "状态")}：
              {t(`task.nodeStatus.${nodeSession.status}`, nodeSession.status)}
            </span>
            {/* A7：此前直出 nodeSession.agent_id（界面显示 jishu-self 这类内部代号）。 */}
            {nodeSession.agent_id && (
              <span>
                {t("task.execution.executorAgent", "执行智能体")}：
                {agentDisplayName(nodeSession.agent_id)}
              </span>
            )}
            <span>{t("task.execution.attempt", "尝试")}：{nodeSession.attempt_number}</span>
          </>
        )}
      </div>
    </div>
  );
}
