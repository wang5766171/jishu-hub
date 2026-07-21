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
import { useEffect, useMemo } from "react";
import { Play, Pause, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GraphEditor } from "@/features/task-workbench/graph-editor";
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
import type { useTaskGraph, RunProjection } from "@/features/task-workbench/use-task-graph";
import type {
  ExecutionChatScope,
  ExecutionView,
  NodeSessionInfo,
  TaskInstance,
} from "./types";

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
  onExecutionViewChange: (view: ExecutionView) => void;
  onChatScopeChange: (scope: ExecutionChatScope) => void;
  onSelectNode: (nodeId: string | null) => void;
  onNodeSessionUpdate: (nodeId: string, info: NodeSessionInfo) => void;
  onSyncRunStatus: (runId: string, status: string) => void;
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
  onExecutionViewChange,
  onChatScopeChange,
  onSelectNode,
  onNodeSessionUpdate,
  onSyncRunStatus,
}: PhaseExecutionViewProps) {
  const { t } = useTranslation();
  const runId = instance.active_run_id ?? taskGraph.displayedRunId ?? null;
  const runStarted = Boolean(runId || taskGraph.activeRunId);

  // ── 手动启动执行（UI 驱动）：在最新 revision 上创建 run 并同步 TaskInstance ──
  const handleLaunchRun = async () => {
    const revisionId = taskGraph.revision?.revision_id;
    if (!instance.graph_id || !revisionId) return;
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
    }
  };

  // ── 按节点指定执行 agent：UpdateNode 设置 agent_assignment_constraint.locked_agent_id → 新 revision ──
  const handleAssignAgent = async (nodeId: string, agentId: string, roleId: string) => {
    if (runStarted) return;
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
      status: taskGraph.runStatus ?? "Draft",
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
    readOnly: false,
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
          {taskGraph.runStatus === "Running" && (
            <button
              type="button"
              onClick={() => taskGraph.pauseRun().catch(console.error)}
              className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.pause", "暂停")}
            >
              <Pause className="h-3 w-3" />
            </button>
          )}
          {taskGraph.runStatus === "Paused" && (
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
          {taskGraph.activeRunId && taskGraph.runStatus !== "Completed" && (
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
        <div className="ml-auto">
          <ExecutionViewSwitcher value={executionView} onChange={onExecutionViewChange} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
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
              runActive={taskGraph.runStatus === "Running"}
              onChange={onChatScopeChange}
            />
            <ExecutionChatPanel
              scope={chatScope}
              runMessages={runStream.projectedMessages}
              nodeChat={shouldUseNodeSession ? nodeChat : null}
              projectPath={projectPath}
              sessionId={nodeSessionId}
              placeholder={
                chatScope.kind === "run"
                  ? t("task.execution.mainPlaceholder", "查看执行进展…使用 @steer 干预")
                  : t("task.execution.nodePlaceholder", "输入消息…干预该节点 agent")
              }
            />
          </div>
        )}
      </div>

      {/* InspectorPanel（选中节点时滑出，简化为底部固定区） */}
      {selectedNodeId && (
        <NodeInspector
          nodeId={selectedNodeId}
          nodeTitle={nodeTitles[selectedNodeId] ?? selectedNodeId}
          nodeSession={currentNodeSession}
          snapshot={taskGraph.snapshot}
          agents={agents ?? []}
          disabled={runStarted}
          onAssignAgent={handleAssignAgent}
        />
      )}
    </div>
  );
}

/** 运行状态徽章。 */
function RunStatusBadge({ status }: { status: string | null | undefined }) {
  const { t } = useTranslation();
  const label = (() => {
    switch (status) {
      case "Running":
        return t("task.run.running", "执行中");
      case "Paused":
        return t("task.run.paused", "已暂停");
      case "Completed":
        return t("task.run.completed", "已完成");
      case "Failed":
        return t("task.run.failed", "失败");
      case "Cancelled":
        return t("task.run.cancelled", "已取消");
      default:
        return t("task.run.draft", "待执行");
    }
  })();
  const color = (() => {
    switch (status) {
      case "Running":
        return "bg-primary/15 text-primary";
      case "Paused":
        return "bg-orange-500/15 text-orange-600";
      case "Completed":
        return "bg-emerald-500/15 text-emerald-600";
      case "Failed":
        return "bg-red-500/15 text-red-600";
      case "Cancelled":
        return "bg-muted text-muted-foreground";
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
  placeholder,
}: {
  scope: ExecutionChatScope;
  runMessages: ReturnType<typeof useRunEventStream>["projectedMessages"];
  nodeChat: ReturnType<typeof useChatSession> | null;
  projectPath: string;
  sessionId: string | null;
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
      <div className="shrink-0 border-t border-border bg-background p-2">
        <ChatInput
          sessionId={sessionId}
          projectPath={projectPath}
          isSessionStreaming={isStreaming}
          placeholder={placeholder}
        />
      </div>
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
  disabled,
  onAssignAgent,
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
  disabled: boolean;
  onAssignAgent: (nodeId: string, agentId: string, roleId: string) => Promise<void>;
}) {
  const node = snapshot?.nodes.find((n) => n.node_id === nodeId);
  const constraint = node?.agent_assignment_constraint;
  const roleRequirement = node?.role_requirement;
  const lockedAgentId = typeof constraint?.locked_agent_id === "string" ? constraint.locked_agent_id : "";
  const roleId = typeof roleRequirement?.role_id === "string" ? roleRequirement.role_id : nodeId;
  return (
    <div className="h-32 shrink-0 border-t border-border bg-background px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-xs font-medium text-foreground">{nodeTitle}</div>
        <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>执行智能体</span>
          <select
            value={lockedAgentId}
            disabled={disabled || agents.length === 0}
            onChange={(event) => {
              const value = event.target.value;
              if (value) onAssignAgent(nodeId, value, roleId).catch(console.error);
            }}
            className="h-6 rounded border border-border bg-background px-2 text-[11px] text-foreground disabled:opacity-60"
          >
            <option value="">自动选择</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.display_name}</option>
            ))}
          </select>
        </label>
      </div>
      {node?.description && (
        <div className="mt-1 text-[11px] text-muted-foreground">{node.description}</div>
      )}
      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
        {nodeSession && (
          <>
            <span>状态：{nodeSession.status}</span>
            {nodeSession.agent_id && <span>agent：{nodeSession.agent_id}</span>}
            <span>attempt：{nodeSession.attempt_number}</span>
          </>
        )}
      </div>
    </div>
  );
}
