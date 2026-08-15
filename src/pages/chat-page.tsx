import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useDeferredValue } from "react";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import {
  streamStore,
  useSessionStream,
} from "@/hooks/use-stream-store";
import { MessageView, type MessageSearchNavigation, type MessageSearchStatus } from "@/components/sessions/message-view";
import { RenameSessionDialog } from "@/components/sessions/rename-session-dialog";
import { RenameTaskSessionDialog } from "@/components/sessions/rename-task-session-dialog";
import { ChatInput, type StagedGuideApi } from "@/components/sessions/chat-input";
import { StreamingMessage } from "@/components/sessions/streaming-message";
import { clearImageCache } from "@/components/sessions/inline-image";
// 会话二级树（T3）：侧边栏任务会话区
import { TaskSessionTree } from "@/features/task-workspace/sidebar/task-session-tree";
// 任务模式右侧栏（减法重构：仅渲染任务步骤面板 + 治理面 + 画布，主会话区复用 chat-page）。
import { TaskSidebar } from "@/features/task-workspace/task-sidebar";
// 任务图数据：chat-page 顶层无条件持有（无 graph 时无副作用），主区 run 流与侧边栏共享。
import { useTaskGraph, taskErrorMessage } from "@/features/task-instance/graph/use-task-graph";
// T8-P1 三段合流：执行段的「流程执行」分隔线 + 会话区「是否开始执行」确认卡。
import { PhaseDivider } from "@/components/sessions/conversation-content";
import { ExecutionStartPrompt } from "@/features/task-workspace/execution-start-prompt";
import { countExecutableSteps } from "@/features/task-workspace/steps/compute-step-order";
import { startTaskRun } from "@/features/task-instance/start-run";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { MessageSquare, Search, X, Pencil, RotateCw, FolderOpen, SquarePen, ClipboardList, PanelLeftClose, PanelLeftOpen, PanelRightOpen, ArrowRight, ChevronUp, ArrowLeftRight, ChevronDown, ChevronRight, PictureInPicture2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { searchSessions } from "@/lib/session-search";
import { openFloatingSession } from "@/lib/floating-window";
import {
  buildInteractionInsertions,
  commitAssistantWithInteractions,
  type InteractionInsertion,
} from "@/lib/deferred-user-message";
import {
  formatInteractionReply,
  formatInteractionResponseValue,
  interactionRequestFromEvent,
} from "@/lib/conversation-interaction";
import { AgentLogo, AgentSwitcher, useAgent } from "@/agents";
import { logTaskPhaseDebug } from "@/features/task-instance/task-phase-debug";
import { resolvePhaseSessionId, shouldRenderGlobalChatInput } from "./chat-page-layout";
import { getSessionDraft, setSessionDraft } from "@/lib/input-history";
import { recordSessionUsage } from "@/lib/session-usage";
import { ContextRing } from "@/components/sessions/context-ring";
import {
  buildAssistantContentFromStreamState,
  extractRealSessionId,
  formatRelativeTime,
  PHASE_LAUNCH_RANK,
  stripTaskLaunchInstructionFromMessages,
  TerminalIcon,
  uniqueSessionsById,
  type PendingChatApproval,
  type PendingChatInteraction,
  type TaskLaunchPhase,
} from "./chat-page-utils";
import { type TaskPhase, type TaskLaunchInstanceSummary } from "@/features/task-instance/types";
import type {
  AgentEventPayload,
  ConversationInteractionSubmission,
  InteractionResponseDto,
  Message,
  Project,
  ProjectMeta,
  ProjectSettings,
  Session,
  SessionSearchResult,
} from "@/types";


export function ChatPage({
  currentProject,
  currentProjectMeta,
  onRefresh,
  sessionNames,
  refetchNames,
  onSwitchProject,
  onProjectSessionsLoadingChange,
  navigateToSession,
}: {
  currentProject: Project | null;
  currentProjectMeta?: ProjectMeta;
  onRefresh: () => Promise<number>;
  sessionNames: Record<string, string> | null;
  refetchNames: (silent?: boolean) => Promise<Record<string, string>>;
  onSwitchProject: () => void;
  onProjectSessionsLoadingChange?: (loading: boolean) => void;
  navigateToSession?: string | null;
}) {
  const { t } = useTranslation();
  // v0.7.0 需求一：会话作用域状态（chatAgentId 替代全局 activeId）。
  const { agents, chatAgentId, chatAgent, chatCapabilities: capabilities, setChatAgent, healthLoading } = useAgent();
  // 兼容别名：active / activeId 在本文件大量使用，统一指向会话作用域。
  const activeId = chatAgentId;
  const active = chatAgent;
  const projectId = currentProject?.encoded_name ?? null;
  const projectPathForSettings = currentProject?.path ?? null;
  const supportsModelPicker = active?.config_surface.kind === "model_store"
    ? (active.config_surface.supports_picker ?? false)
    : false;
  const projectSettingsSurface = active?.project_settings_surface;
  const supportsAccessModeSwitch = projectSettingsSurface?.kind === "supported"
    && projectSettingsSurface.scopes.includes("local")
    && projectSettingsSurface.access_modes.length > 0;

  // Mid-turn steer (inject guidance without stopping output) is possible for
  // transports with a native steer channel: Pi-RPC (`steer` command, real
  // mid-turn injection + `steer_injected` event) and Codex app-server
  // (`turn/steer`). ACP (claude-code / acp_preferred) has NO mid-turn steer —
  // its `steer_chat` just queues a follow-up prompt for the next turn and
  // never emits `steer_injected`, so the steer UI path (optimistic bubble +
  // turn_complete commit) never fires and the guide is lost. For ACP, guide
  // must fall back to stop+send (handled by chat-input.tsx's default path),
  // which matches ACP's actual "steer = new prompt" semantics.
  const supportsSteer = active?.transport === "pi_rpc" || active?.transport === "codex_app_server";
  // Fresh mirror for the mount-only agent-event listener (whose useEffect deps
  // are [], so it closes over a stale `supportsSteer`). Updated every render.
  const supportsSteerRef = useRef(supportsSteer);
  supportsSteerRef.current = supportsSteer;

  // selectedSession: null or real backend UUID — never fake IDs
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  // 输入历史/草稿作用域（A6）：草稿按 项目+会话 维度，历史按项目维度。
  const draftSessionKey = projectId ? `${projectId}:${selectedSession ?? "new"}` : null;
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const [renameOpen, setRenameOpen] = useState(false);
  // 正在重命名的任务会话；为 null 时弹窗关闭。用对象引用区分"重命名哪个任务会话"。
  const [renameTaskTarget, setRenameTaskTarget] = useState<TaskLaunchInstanceSummary | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [messageSearchStatus, setMessageSearchStatus] = useState<MessageSearchStatus>({ current: 0, total: 0 });
  const [messageSearchNavigation, setMessageSearchNavigation] = useState<MessageSearchNavigation | null>(null);
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const [optimisticSessions, setOptimisticSessions] = useState<Session[]>([]);
  // 三阶段任务容器（TaskPhaseContainer）状态。唯一任务界面。
  const [taskModeActive, setTaskModeActive] = useState(false);
  // 任务模式下选中的节点（步骤栏高亮 + 主区切换为该节点会话）。null = 未选节点。
  const [taskSelectedNodeId, setTaskSelectedNodeId] = useState<string | null>(null);
  // v0.7.0 需求二-问题3：选中节点会话绑定的 agent_id（节点子代理可能是非 jishu-self，
  // 加载节点会话消息需用此 agent_id 而非主会话的 activeId）。
  const [taskNodeSessionAgentId, setTaskNodeSessionAgentId] = useState<string | null>(null);
  // 任务侧边栏显隐（执行阶段的「显示/隐藏步骤栏」切换，P4c）。需求/规划阶段不显示侧边栏（P4a）。
  const [taskSidebarHidden, setTaskSidebarHidden] = useState(false);
  const [taskLaunchOpen, setTaskLaunchOpen] = useState(false);
  const [taskLaunchReadOnly, setTaskLaunchReadOnly] = useState(false);
  const [taskLaunchPhase, setTaskLaunchPhase] = useState<TaskLaunchPhase>("requirements");
  const [activeTaskInstanceId, setActiveTaskInstanceId] = useState<string | null>(null);
  const [activeTaskRequirementFile, setActiveTaskRequirementFile] = useState<string | null>(null);
  const [selectedTaskSkillId, setSelectedTaskSkillId] = useState("jishu-conductor-dev");
  const [taskLaunchSessions, setTaskLaunchSessions] = useState<TaskLaunchInstanceSummary[]>([]);
  // 记录上次已知 status，用于检测变化。
  const lastKnownStatusRef = useRef<string | null>(null);
  const [regularSessionsOpen, setRegularSessionsOpen] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState<PendingChatApproval[]>([]);
  const [pendingInteractions, setPendingInteractions] = useState<PendingChatInteraction[]>([]);
  const [approvalResolving, setApprovalResolving] = useState(false);

  // Quick model picker for Pi-backed model stores. The adapter declares
  // this surface; the page does not inspect the agent id.
  const [modelOptions, setModelOptions] = useState<{ provider: string; model: string }[]>([]);
  const [activeModel, setActiveModel] = useState<{ provider: string; model: string } | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLSpanElement>(null);
  const refreshModelPicker = useCallback(async () => {
    if (!supportsModelPicker) {
      setModelOptions([]);
      setActiveModel(null);
      return;
    }
    try {
      const [config, act] = await Promise.all([
        invokeCommand<{ providers?: Record<string, { models?: { id: string }[] }> }>(
          "get_models_config",
          { agentId: activeId ?? "" },
        ),
        invokeCommand<{ provider: string; model: string } | null>("get_active", { agentId: activeId ?? "" }),
      ]);
      const opts: { provider: string; model: string }[] = [];
      for (const [provider, value] of Object.entries(config?.providers ?? {})) {
        for (const m of value.models ?? []) {
          if (typeof m.id === "string") {
            opts.push({ provider, model: m.id });
          }
        }
      }
      setModelOptions(opts);
      setActiveModel(act);
    } catch (e) {
      console.warn("Model picker refresh failed:", e);
    }
  }, [supportsModelPicker]);
  useEffect(() => {
    void refreshModelPicker();
  }, [refreshModelPicker]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (modelMenuRef.current?.contains(event.target as Node)) return;
      setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const messageAreaRef = useRef<HTMLDivElement>(null);
  const [isUserMessageAbove, setIsUserMessageAbove] = useState(false);
  const isAwayFromBottomRef = useRef(false);
  const activeIdRef = useRef<string | null>(activeId);
  const taskLaunchOpenRef = useRef(taskLaunchOpen);
  const taskLaunchPhaseRef = useRef<TaskLaunchPhase>(taskLaunchPhase);
  // 阶段标签自动跟随：跟踪上次 current_phase（数据源为 refreshTaskLaunchSessions 的 3s
  // 轮询）。follow effect 据此前进检测；守卫 taskLaunchPhase===prev 同时防跨任务误跟随
  // 与打断手动回看。
  const prevCurrentPhaseRef = useRef<string | null>(null);
  const activeTaskInstanceIdRef = useRef<string | null>(activeTaskInstanceId);
  // v0.7.0：记录当前选中的节点 id，用于短路重复点击（同一节点再点不触发任何逻辑）。
  const taskSelectedNodeIdRef = useRef<string | null>(taskSelectedNodeId);
  taskSelectedNodeIdRef.current = taskSelectedNodeId;
  // v0.7.0：记录上次轮询到的 instance active_run_id，检测 conductor 重试创建新 run。
  const lastInstanceRunIdRef = useRef<string | null>(null);
  // 进入任务模式需切到 Jishu Agent 时置 true：阻止 activeId 变化触发的清理 effect 重置任务模式状态
  const enteringTaskModeRef = useRef(false);
  const activeTaskRequirementFileRef = useRef<string | null>(activeTaskRequirementFile);
  const selectedTaskSkillIdRef = useRef(selectedTaskSkillId);
  // 减法重构：节点选择不再需要跨页面桥接 ref —— TaskSidebar 与任务树同处 chat-page，
  // 统一由 taskSelectedNodeId 这一个受控状态驱动（树高亮 / 侧边栏高亮 / 主区会话）。
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // Fresh project path for the agent-event listener (whose useEffect deps are
  // [], so it closes over a stale `currentProject`). Updated every render.
  const projectPathRef = useRef<string | null>(currentProject?.path ?? null);
  projectPathRef.current = currentProject?.path ?? null;
  const projectIdRef = useRef<string | null>(currentProject?.encoded_name ?? null);
  projectIdRef.current = currentProject?.encoded_name ?? null;
  // Imperative handle into ChatInput's staging area — used by Route 2 to
  // auto-send staged guides at turn_complete.
  const stagedApiRef = useRef<StagedGuideApi | null>(null);
  const selectedSessionRef = useRef<string | null>(null);
  const visitedSessions = useRef(new Set<string>());
  const scrollMemory = useRef(new Map<string, number>());
  const scrollAction = useRef<{ type: "bottom" } | { type: "restore", top: number } | null>(null);
  const sessionMessagesRef = useRef(sessionMessages);
  sessionMessagesRef.current = sessionMessages;
  const newSessionStreamIdsRef = useRef<Set<string>>(new Set());
  // Records when a follow-up streaming state was (re)created for a session at
  // turn_complete — keyed by session id → start timestamp (ms). Covers two cases
  // that both start an empty "thinking" state for a PENDING reply after a turn
  // ends: (1) a manually-guided steer committed as a follow-up (followUpExpected),
  // and (2) Route 2 auto-sending staged guides. Used to detect and ignore a
  // spurious turn_complete that the ACP/agent process emits right after it is
  // (re)launched — before the real reply has begun. Without this guard that
  // early turn_complete drops the freshly-created "thinking" state, leaving a
  // blank gap until the reply's first token arrives.
  const pendingReplyStartedAtRef = useRef<Map<string, number>>(new Map());
  const refetchSessionsRef = useRef<((silent?: boolean) => Promise<Session[]>) | null>(null);
  // Holds the latest handleSelectSession so the navigateToSession effect always
  // invokes the freshest closure (current projectId/selectedSession) instead of
  // a stale one captured when navigateToSession last changed. (K-MED-7)
  const handleSelectSessionRef = useRef<(sessionId: string) => void>(() => {});
  /**
   * Per-session messages cache. Keyed by canonical session id (the id we
   * started the stream with) AND by resolvedId once known. While a session is
   * streaming, we never re-fetch from JSONL on session switch — we use the
   * cached snapshot to avoid duplicating the user message that has already
   * been written to JSONL by the CLI but is also being rendered live by
   * `<StreamingMessage>` from the pending state.
   */
  const sessionMessagesCacheRef = useRef<Map<string, Message[]>>(new Map());
  // Steered user messages queued while the agent is mid-turn. They are NOT
  // inserted into sessionMessages immediately — doing so while the first
  // turn's assistant reply is still streaming (not yet committed to
  // sessionMessages) would place them ABOVE that reply. Instead they are
  // surfaced when the steer continuation's turn completes, slotted between
  // the first reply and the steer response (matching Pi's JSONL order).
  const pendingSteerMessagesRef = useRef<Map<string, string[]>>(new Map());
  // Live display of steered user messages for the current session. Rendered
  // AFTER the streaming bubble (a steer is inserted mid-output, so it must
  // appear below the in-progress assistant reply). Each entry is removed when
  // its turn completes and the steer is committed into sessionMessages at its
  // correct position (between the prior reply and the steer's response).
  const [pendingSteerDisplay, setPendingSteerDisplay] = useState<Message[]>([]);
  // Subscribe to streaming state for the currently-selected session. Drives
  // whether the streaming bubble is rendered and whether the input is in Stop mode.
  const currentStream = useSessionStream(selectedSession);
  // 任务图数据：无条件持有（无 graph 时无副作用）。任务模式主区（run 流）与右侧 TaskSidebar 共享。
  const taskGraph = useTaskGraph();
  // v0.7.0：ref 镜像，供轮询回调（非 React 闭包）读 taskGraph 而不进入依赖数组。
  const taskGraphRef = useRef(taskGraph);
  taskGraphRef.current = taskGraph;

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    taskLaunchOpenRef.current = taskLaunchOpen;
  }, [taskLaunchOpen]);

  useEffect(() => {
    taskLaunchPhaseRef.current = taskLaunchPhase;
  }, [taskLaunchPhase]);

  useEffect(() => {
    activeTaskInstanceIdRef.current = activeTaskInstanceId;
  }, [activeTaskInstanceId]);

  useEffect(() => {
    activeTaskRequirementFileRef.current = activeTaskRequirementFile;
  }, [activeTaskRequirementFile]);

  useEffect(() => {
    selectedTaskSkillIdRef.current = selectedTaskSkillId;
  }, [selectedTaskSkillId]);

  // Single hook for current project's sessions
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const { data: sessions, loading: sessionsLoading, setData: setSessions, refetch: refetchSessions } = useInvoke<Session[]>(
    projectId && activeId ? "list_sessions" : "",
    projectId && activeId ? { agentId: activeId, encodedName: projectId } : undefined,
    activeId + "_" + listRefreshKey,
  );
  // Ref mirror for use inside the mount-only stream listener closure.
  const sessionsRef = useRef<Session[] | null>(null);
  sessionsRef.current = sessions ?? null;
  // 节点子代理会话 id 集合（常规会话列表过滤用，与 taskLaunchSessions 同节奏刷新）。
  const [nodeSessionIds, setNodeSessionIds] = useState<string[]>([]);
  const refreshTaskLaunchSessions = useCallback(async () => {
    if (!projectPathForSettings) {
      setTaskLaunchSessions([]);
      setNodeSessionIds([]);
      return;
    }
    try {
      const [items, nodeIds] = await Promise.all([
        invokeCommand<TaskLaunchInstanceSummary[]>(
          "task_launch_list_sessions",
          { projectRoot: projectPathForSettings },
        ),
        // 节点子代理会话 id（全局；orchestrator feature 关时命令不注册，降级为空）。
        invokeCommand<string[]>("orchestrator_list_node_session_ids").catch(
          () => [] as string[],
        ),
      ]);
      setTaskLaunchSessions(items);
      setNodeSessionIds(nodeIds);

      // v0.7.0：检测当前任务的 active_run_id 变化（conductor 重试创建新 run）。
      // 只在轮询回调里、且 run id 真正变化时 loadGraph，不会死循环。
      // 注意：通过 ref 读 taskGraph，避免把它放进依赖数组（它是每次渲染的新对象，
      // 会导致 useCallback 重建 → useEffect 重跑 → 死循环 → 界面一直加载中）。
      const tg = taskGraphRef.current;
      const activeInst = items.find((it) => it.task_id === activeTaskInstanceIdRef.current);
      const newRunId = activeInst?.active_run_id ?? null;
      if (
        newRunId
        && newRunId !== lastInstanceRunIdRef.current
        && activeInst?.graph_id
        && tg && tg.displayedRunId !== newRunId
      ) {
        lastInstanceRunIdRef.current = newRunId;
        tg.loadGraph(activeInst.graph_id).catch(console.error);
      }
    } catch (error) {
      console.warn("Failed to load task launch sessions:", error);
    }
  }, [projectPathForSettings]);

  useEffect(() => {
    refreshTaskLaunchSessions().catch(console.error);
  }, [refreshTaskLaunchSessions]);

  useEffect(() => {
    if (!projectPathForSettings) return;
    const timer = window.setInterval(() => {
      refreshTaskLaunchSessions().catch(console.error);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [projectPathForSettings, refreshTaskLaunchSessions]);

  useEffect(() => {
    refetchSessionsRef.current = refetchSessions;
  }, [refetchSessions]);

  useEffect(() => {
    // Clear sessions when switching agents to avoid showing stale data from previous agent
    setSessions(null);
  }, [activeId, setSessions]);

  useEffect(() => {
    onProjectSessionsLoadingChange?.(Boolean(projectId && sessionsLoading));
  }, [projectId, sessionsLoading, onProjectSessionsLoadingChange]);

  useEffect(() => {
    return () => onProjectSessionsLoadingChange?.(false);
  }, [onProjectSessionsLoadingChange]);

  const searchResults = useMemo<SessionSearchResult[]>(() => {
    if (!sessions || !deferredSearchQuery.trim()) return [];
    return searchSessions(sessions, deferredSearchQuery);
  }, [sessions, deferredSearchQuery]);
  const taskLaunchSessionIds = useMemo(
    () => new Set(
      [
        ...taskLaunchSessions.flatMap((item) => [
          item.requirement_session_id,
          item.planning_session_id,
        ]),
        ...nodeSessionIds,
      ].filter((value): value is string => Boolean(value)),
    ),
    [taskLaunchSessions, nodeSessionIds],
  );
  const regularSessions = useMemo(
    () => (sessions ?? []).filter((session) => !taskLaunchSessionIds.has(session.id)),
    [sessions, taskLaunchSessionIds],
  );

  // Build display session list with optimistic sessions prepended
  let displaySessions = regularSessions;
  if (deferredSearchQuery.trim() && sessions) {
    displaySessions = uniqueSessionsById(
      searchResults
        .map((r: SessionSearchResult) => sessions.find(s => s.id === r.sessionId))
        .filter((session): session is Session => {
          if (!session) return false;
          return !taskLaunchSessionIds.has(session.id);
        }),
    );
  } else if (!deferredSearchQuery.trim()) {
    displaySessions = uniqueSessionsById([...optimisticSessions, ...displaySessions]);
  }
  const displayTaskLaunchSessions = taskLaunchSessions.filter((taskSession) => {
    const query = deferredSearchQuery.trim().toLocaleLowerCase();
    if (!query) return true;
    return `${taskSession.title}\n${taskSession.skill_id}\n${taskSession.status}`
      .toLocaleLowerCase()
      .includes(query);
  });

  const hasSearchQuery = searchQuery.trim().length > 0;
  const showMessageSearchControls = hasSearchQuery && !!selectedSession && selectedSession !== "new";
  const showStartComposer = !!projectId && (!selectedSession || selectedSession === "new");
  const activeTaskLaunchInstance = useMemo(
    () => activeTaskInstanceId
      ? taskLaunchSessions.find((item) => item.task_id === activeTaskInstanceId) ?? null
      : null,
    [activeTaskInstanceId, taskLaunchSessions],
  );
  /** 按 task_id 反查完整的任务实例（侧边栏树只持有结构子集）。 */
  const findTaskInstance = useCallback(
    (taskId: string): TaskLaunchInstanceSummary | null =>
      taskLaunchSessions.find((item) => item.task_id === taskId) ?? null,
    [taskLaunchSessions],
  );
  // T7：taskLaunchPhaseStates（三阶段 tab 的 done/active/pending 派生）随 TaskPhaseNavBar 一并退役。
  const [accessRefreshKey, setAccessRefreshKey] = useState(0);
  const { data: projectSettings } = useInvoke<ProjectSettings>(
    supportsAccessModeSwitch && projectPathForSettings && activeId ? "load_project_settings_local" : "",
    supportsAccessModeSwitch && projectPathForSettings && activeId ? { agentId: activeId, projectPath: projectPathForSettings } : undefined,
    accessRefreshKey,
  );
  const messageSearchTotal = showMessageSearchControls ? messageSearchStatus.total : 0;
  const messageSearchLabel = messageSearchTotal > 0
    ? `${messageSearchStatus.current}/${messageSearchTotal}`
    : "0/0";

  const requestMessageSearchNavigation = useCallback((direction: 1 | -1) => {
    setMessageSearchNavigation((prev) => ({
      direction,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, []);

  const handleMessageSearchStatusChange = useCallback((status: MessageSearchStatus) => {
    setMessageSearchStatus((prev) => (
      prev.current === status.current && prev.total === status.total ? prev : status
    ));
  }, []);

  // Auto-clear optimistic sessions once real session appears in backend list
  useEffect(() => {
    if (sessions && optimisticSessions.length > 0) {
      setOptimisticSessions(prev => prev.filter(opt => !sessions.some(s => s.id === opt.id)));
    }
  }, [sessions]);

  useEffect(() => {
    if (!showMessageSearchControls) {
      setMessageSearchStatus({ current: 0, total: 0 });
    }
  }, [showMessageSearchControls]);

  // Clear session state when project changes
  useEffect(() => {
    setSelectedSession(null);
    selectedSessionRef.current = null;
    setSessionMessages([]);
    setOptimisticSessions([]);
    setTaskModeActive(false);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    sessionMessagesCacheRef.current.clear();
    newSessionStreamIdsRef.current.clear();
    clearImageCache();
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !activeId) return;
    // 若本次 agent 切换是为进入任务模式（自动切到 Jishu Agent），保留任务模式状态，仅刷新会话列表
    if (enteringTaskModeRef.current) {
      enteringTaskModeRef.current = false;
      setListRefreshKey(Date.now());
      refetchNames(true).catch(console.error);
      return;
    }
    setSelectedSession(null);
    selectedSessionRef.current = null;
    setSessionMessages([]);
    setOptimisticSessions([]);
    setTaskModeActive(false);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    sessionMessagesCacheRef.current.clear();
    newSessionStreamIdsRef.current.clear();
    setListRefreshKey(Date.now());
    refetchNames(true).catch(console.error);
  }, [activeId, projectId, refetchNames]);

  // Navigate to a specific session (triggered by floating window restore)
  useEffect(() => {
    if (navigateToSession) {
      handleSelectSessionRef.current(navigateToSession);
    }
  }, [navigateToSession]);

  const handleRefresh = async () => {
    const newKey = await onRefresh();
    setListRefreshKey(newKey);
    setAccessRefreshKey(Date.now());
  };

  const accessModeOptions = useMemo(() => {
    if (projectSettingsSurface?.kind !== "supported") return [];
    const labels: Record<string, string> = {
      default: t("sessions.accessDefault"),
      bypassPermissions: t("sessions.accessBypass"),
      plan: t("sessions.accessPlan"),
    };
    return projectSettingsSurface.access_modes.map((value) => ({
      value,
      label: labels[value] ?? value,
    }));
  }, [projectSettingsSurface, t]);

  const accessModeValue = projectSettings?.permissions?.defaultMode || "default";
  const accessModeLabel = accessModeOptions.find((option) => option.value === accessModeValue)?.label ?? t("sessions.accessDefault");
  // ── 斜杠命令面板（A2）：GUI 本地命令注册表，不透传给 agent ──────────────
  const hasSelectedSession = Boolean(selectedSession && selectedSession !== "new");
  const slashCommands = useMemo(
    () => [
      { name: "new", label: t("sessions.slashNew"), available: Boolean(projectId) },
      { name: "task", label: t("sessions.slashTask"), available: Boolean(projectId) },
      { name: "rename", label: t("sessions.slashRename"), available: hasSelectedSession },
      { name: "terminal", label: t("sessions.slashTerminal"), available: hasSelectedSession },
      { name: "float", label: t("sessions.slashFloat"), available: hasSelectedSession },
    ],
    [hasSelectedSession, projectId, t],
  );
  const handleSlashCommand = useCallback(
    (name: string) => {
      switch (name) {
        case "new":
          handleNewSession();
          break;
        case "task":
          handleOpenTaskConversation();
          break;
        case "rename":
          setRenameOpen(true);
          break;
        case "terminal":
          if (selectedSession) void handleResumeSession(selectedSession);
          break;
        case "float":
          if (selectedSession) handleFloatSession(selectedSession);
          break;
      }
    },
    [selectedSession],
  );

  const workModeOptions = useMemo(() => [
    { value: "chat", label: t("sessions.workMode.chat") },
    { value: "task", label: t("sessions.workMode.task") },
  ], [t]);
  const jishuAgent = useMemo(
    () => agents.find((agent) => agent.id === "jishu-self") ?? null,
    [agents],
  );
  const taskModeAgentReady = Boolean(jishuAgent?.health.installed);
  const taskModeCanSend = taskModeAgentReady && activeId === "jishu-self";
  // 应用内确认/提示弹窗（替代系统原生 confirm/message，样式与应用统一）
  const { confirm: confirmDialog, alert: alertDialog, dialogNode: confirmDialogNode } = useConfirmDialog();

  const handleAccessModeChange = useCallback(async (value: string) => {
    if (!supportsAccessModeSwitch || !projectPathForSettings) return;
    const nextSettings: ProjectSettings = {
      permissions: {
        defaultMode: value === "default" ? null : value,
        allow: projectSettings?.permissions?.allow ?? null,
        deny: projectSettings?.permissions?.deny ?? null,
      },
      hooks: projectSettings?.hooks ?? null,
      env: projectSettings?.env ?? null,
      model: projectSettings?.model ?? null,
    };
    await invokeCommand("save_project_settings_local", { agentId: activeId ?? "", projectPath: projectPathForSettings, settings: nextSettings });
    setAccessRefreshKey(Date.now());
  }, [activeId, projectPathForSettings, projectSettings, supportsAccessModeSwitch]);

  useEffect(() => {
    if (!taskLaunchOpen || agents.length === 0) return;
    if (!taskModeAgentReady) {
      void alertDialog({
        title: "无法进入任务模式",
        description: "任务模式需要先安装 Jishu Agent。请到环境检测页面完成安装后再发起任务。",
      });
      return;
    }
    if (activeId !== "jishu-self") {
      // v0.7.0：会话作用域切换（任务模式属于会话场景）。
      // 标记本次切换是为进入任务模式，阻止上面的清理 effect 重置任务模式状态
      enteringTaskModeRef.current = true;
      setChatAgent("jishu-self");
    }
  }, [activeId, agents.length, setChatAgent, taskLaunchOpen, taskModeAgentReady]);

  const handleWorkModeChange = useCallback(async (value: string) => {
    const nextIsTask = value === "task";
    // 方式2：进入任务模式时若当前不是 Jishu Agent，弹窗确认后自动切换（仅 Jishu Agent 支持任务模式）。
    if (nextIsTask && activeId !== "jishu-self") {
      if (!taskModeAgentReady) {
        await alertDialog({
          title: "无法进入任务模式",
          description: "任务模式需要先安装 Jishu Agent。请到环境检测页面完成安装后再发起任务。",
        });
        return;
      }
      const confirmed = await confirmDialog({
        title: "切换到 Jishu Agent",
        description: "任务模式由 Jishu Agent 提供。将切换到 Jishu Agent 并进入任务模式，是否继续？",
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
    setSelectedSession("new");
    selectedSessionRef.current = "new";
    setSessionMessages([]);
    setPendingSteerDisplay([]);
    // v0.7.0：确认切换后主动切到 Jishu Agent（会话作用域；enteringTaskModeRef 已置，清理 effect 会跳过任务模式重置）
    if (nextIsTask && activeId !== "jishu-self") {
      setChatAgent("jishu-self");
    }
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  }, [activeId, taskModeAgentReady, setChatAgent]);

  // 记录哪些 session 已经注入过 launch instruction（只在每个阶段的首条消息注入一次，
  // 后续消息复用 agent 进程上下文，不重复下达阶段指令，避免 agent 误以为每轮都是新阶段开始）。
  const injectedLaunchSessionsRef = useRef<Set<string>>(new Set());

  const prepareTaskLaunchMessage = useCallback((message: string) => {
    if (!taskLaunchOpen) return message;
    // 判断当前 session 是否已经激活过 conductor。
    // selectedSession 为 null 或 "new" 时是首条消息，需要激活 conductor；
    // 已有 session id 时，检查是否在已激活集合里。
    const currentSession = selectedSessionRef.current;
    const isFirstMessage = !currentSession || currentSession === "new";
    const alreadyInjected = currentSession
      ? injectedLaunchSessionsRef.current.has(currentSession)
      : false;
    if (!isFirstMessage && alreadyInjected) {
      // 后续消息：conductor 已接管，原样透传（agent 进程已有上下文）。
      return message;
    }
    // 标记当前 session 已激活（pending id 和后续 real id 都标记）。
    if (currentSession && currentSession !== "new") {
      injectedLaunchSessionsRef.current.add(currentSession);
    }
    // 首条消息：以 /jishu-task 命令激活 conductor 扩展，由其驱动 discuss→plan→execute。
    // domain 默认 dev（Batch 4 增加 research 后可由 UI 选择）。
    return `/jishu-task dev ${message}`;
  }, [taskLaunchOpen]);

  useLayoutEffect(() => {
    if (!scrollAction.current || !messageAreaRef.current) return;
    const action = scrollAction.current;
    scrollAction.current = null;
    if (action.type === "bottom") {
      messageAreaRef.current.scrollTop = messageAreaRef.current.scrollHeight;
    } else {
      messageAreaRef.current.scrollTop = action.top;
    }
  }, [sessionMessages]);

  // Track whether user has scrolled away from the bottom
  useEffect(() => {
    const el = messageAreaRef.current;
    if (!el) return;
    const onScroll = () => {
      const awayFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight > 100;
      isAwayFromBottomRef.current = awayFromBottom;
      setIsAwayFromBottom(awayFromBottom);
      const containerTop = el.getBoundingClientRect().top;
      const hasUserMessageAbove = Array.from(
        el.querySelectorAll<HTMLElement>('[data-user-message="true"]'),
      ).some((message) => message.getBoundingClientRect().top < containerTop - 1);
      setIsUserMessageAbove(hasUserMessageAbove);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [selectedSession, sessionMessages]);

  const handleScrollToPreviousUserMessage = useCallback(() => {
    const el = messageAreaRef.current;
    if (!el) return;
    const containerTop = el.getBoundingClientRect().top;
    const previousMessages = Array.from(
      el.querySelectorAll<HTMLElement>('[data-user-message="true"]'),
    ).filter((message) => message.getBoundingClientRect().top < containerTop - 1);
    const target = previousMessages[previousMessages.length - 1];
    if (!target) return;
    const top = el.scrollTop + target.getBoundingClientRect().top - containerTop;
    el.scrollTo({ top, behavior: "smooth" });
  }, []);

  const handleScrollToBottom = useCallback(() => {
    if (messageAreaRef.current) {
      messageAreaRef.current.scrollTo({ top: messageAreaRef.current.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const handleSelectSession = async (sessionId: string) => {
    setTaskModeActive(false);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    if (sessionId === selectedSession || !projectId) return;

    if (selectedSession && messageAreaRef.current) {
      scrollMemory.current.set(selectedSession, messageAreaRef.current.scrollTop);
    }
    const isFirstVisit = !visitedSessions.current.has(sessionId);
    setSelectedSession(sessionId);
    selectedSessionRef.current = sessionId;
    // Live steer placeholders belong to the previous session; drop them so
    // they don't render under a different conversation. Any still-pending
    // steer is committed into its own session's cache at turn_complete.
    setPendingSteerDisplay([]);

    // While a session is streaming we keep its message snapshot in
    // `sessionMessagesCacheRef` and *do not* reload from JSONL — otherwise the
    // user message that the CLI has already flushed to disk would appear twice
    // (once from the JSONL, once from the live `<StreamingMessage>` bubble).
    // Also trust the cache after streaming ends (turn_complete populates it
    // with committed messages including interaction blocks), to avoid losing
    // interaction cards when the user navigates between sessions.
    const cached = sessionMessagesCacheRef.current.get(sessionId);
    if (cached) {
      setSessionMessages(cached);
    } else {
      try {
        const messages = await invokeCommand<Message[]>("get_session_messages", {
          agentId: activeId ?? "",
          sessionId,
          encodedName: projectId,
        });
        const visibleMessages = stripTaskLaunchInstructionFromMessages(messages);
        sessionMessagesCacheRef.current.set(sessionId, visibleMessages);
        setSessionMessages(visibleMessages);
      } catch {
        setSessionMessages([]);
      }
    }

    if (isFirstVisit) {
      scrollAction.current = { type: "bottom" };
      visitedSessions.current.add(sessionId);
    } else {
      const saved = scrollMemory.current.get(sessionId);
      scrollAction.current = saved !== undefined
        ? { type: "restore", top: saved }
        : { type: "bottom" };
    }
  };
  handleSelectSessionRef.current = handleSelectSession;

  // Listen for cross-page session open requests
  useEffect(() => {
    const onStorage = () => {
      try {
        const raw = localStorage.getItem("jishu:open-session");
        if (!raw) return;
        localStorage.removeItem("jishu:open-session");
        const { sessionId } = JSON.parse(raw) as { sessionId: string };
        if (sessionId && handleSelectSessionRef.current) {
          handleSelectSessionRef.current(sessionId);
        }
      } catch (e) {
        console.error("Failed to handle open-session event", e);
      }
    };
    window.addEventListener("storage", onStorage);
    // Also poll on mount (storage event only fires on OTHER windows)
    onStorage();
    const interval = setInterval(onStorage, 500);
    return () => {
      window.removeEventListener("storage", onStorage);
      clearInterval(interval);
    };
  }, []);

  // T8-P1 修正：任务模式下所有 selectedSession 变更（进入任务、切换阶段、切换节点会话）
  // 都要加载对应会话消息。openTaskPhaseWorkspace / handleTaskSelectNode 直接 setSelectedSession，
  // 不走 handleSelectSession，因此需要此自动加载兜底，否则主区只显示执行段而看不到需求/规划内容。
  useEffect(() => {
    if (!taskModeActive || !selectedSession || selectedSession === "new" || !projectId) return;
    if (streamStore.hasState(selectedSession)) return;

    const cached = sessionMessagesCacheRef.current.get(selectedSession);
    // 节点会话可能在离开期间继续跑（后台节点的事件不进本视图），缓存往往是上次进入时的
    // 半截快照。因此进入节点会话时先渲染缓存避免闪空，再重读一次取最新基线；此后的增量
    // 由 agent-event 流式接续——与常规会话「进入读一次 + 事件流」完全同一套机制。
    const isNodeSession = !!taskSelectedNodeId;
    if (cached) {
      setSessionMessages(cached);
      if (!isNodeSession) return;
    }

    let cancelled = false;
    // v0.7.0 需求二-问题3：节点会话用节点 attempt 绑定的 agent_id 加载消息
    // （节点子代理可能是 claude-code/codex 等非 jishu-self，消息存在各自 session 存储）。
    const nodeAgentId = isNodeSession ? (taskNodeSessionAgentId ?? activeId ?? "") : (activeId ?? "");
    invokeCommand<Message[]>("get_session_messages", {
      agentId: nodeAgentId,
      sessionId: selectedSession,
      encodedName: projectId,
    })
      .then((messages) => {
        if (cancelled) return;
        const visibleMessages = stripTaskLaunchInstructionFromMessages(messages);
        sessionMessagesCacheRef.current.set(selectedSession, visibleMessages);
        setSessionMessages(visibleMessages);
      })
      .catch(() => {
        if (!cancelled && !cached) setSessionMessages([]);
      });

    return () => {
      cancelled = true;
    };
  }, [taskModeActive, selectedSession, projectId, taskSelectedNodeId, taskNodeSessionAgentId, activeId]);

  const handleNewSession = async () => {
    if (!projectId) return;

    setTaskModeActive(false);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    activeTaskInstanceIdRef.current = null;
    activeTaskRequirementFileRef.current = null;
    lastKnownStatusRef.current = null;
    setActiveTaskInstanceId(null);
    setActiveTaskRequirementFile(null);
    setSelectedSession("new");
    selectedSessionRef.current = "new";
    setSessionMessages([]);
    setPendingSteerDisplay([]);

    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  };

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
    setSelectedSession("new");
    selectedSessionRef.current = "new";
    setSessionMessages([]);
    setPendingSteerDisplay([]);
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  }, []);

  const handleResumeSession = async (sessionId: string) => {
    setLoadingSessionId(sessionId);
    try {
      const existing = await invokeCommand<{ pid: number; project_path: string; started_at: string } | null>(
        "find_session_terminal", { sessionId }
      );
      if (existing) {
        try { await invokeCommand<boolean>("focus_session_terminal", { sessionId }); } catch {}
        setLoadingSessionId(null);
        return;
      }
      const session = sessions?.find(s => s.id === sessionId);
      const cwd = session?.project_path || currentProject?.path;
      if (!cwd) return;
      const pid = await invokeCommand<number>("open_in_terminal", {
        agentId: activeId ?? "",
        projectPath: cwd,
        resumeSessionId: sessionId,
      });
      await invokeCommand("register_terminal_session", {
        sessionId, pid, projectPath: cwd,
        agentId: activeId ?? "",
      });
    } catch (err) {
      console.error("Failed to resume session:", err);
    } finally {
      setLoadingSessionId(null);
    }
  };

  const handleRefreshMessages = useCallback(async () => {
    if (selectedSession && projectId) {
      // Refuse to reload from JSONL while this session has a live streaming
      // state. Pi writes the user message and each assistant segment to JSONL
      // as they're produced, so a mid-turn reload overlaps the live
      // StreamingMessage bubble (duplicate rows) AND overwrites the
      // turn-snapshot cache that turn_complete appends to — causing
      // turn_complete to re-append the in-progress turn. The header button is
      // disabled while streaming; this guard also covers the session-list
      // context-menu entry that calls the same handler.
      if (streamStore.hasState(selectedSession)) return;
      try {
        const msgs = await invokeCommand<Message[]>("get_session_messages", {
          agentId: activeId ?? "",
          sessionId: selectedSession,
          encodedName: projectId,
        });
        const visibleMessages = stripTaskLaunchInstructionFromMessages(msgs);
        sessionMessagesCacheRef.current.set(selectedSession, visibleMessages);
        setSessionMessages(visibleMessages);
      } catch (e) {
        console.error(e);
      }
    }
  }, [selectedSession, projectId]);

  const handleFloatSession = useCallback((sessionId: string) => {
    const name = sessionNames?.[sessionId]
      || sessions?.find(s => s.id === sessionId)?.display_name
      || sessionId.slice(0, 8);
    openFloatingSession(sessionId, name, activeId || "", currentProject?.encoded_name || "", active?.display_name);
  }, [sessionNames, sessions, activeId, active, currentProject]);

  const applyTaskLaunchInstanceSnapshot = useCallback((record: TaskLaunchInstanceSummary) => {
    const isCurrentTask = !activeTaskInstanceIdRef.current
      || activeTaskInstanceIdRef.current === record.task_id;

    logTaskPhaseDebug("snapshot:received", {
      taskId: record.task_id,
      isCurrentTask,
      status: record.status,
      currentPhase: record.current_phase,
    });

    if (isCurrentTask) {
      activeTaskInstanceIdRef.current = record.task_id;
      activeTaskRequirementFileRef.current = record.requirement_file ?? null;
      setActiveTaskInstanceId(record.task_id);
      setActiveTaskRequirementFile(record.requirement_file ?? null);
      lastKnownStatusRef.current = record.status;
    }

    setTaskLaunchSessions((current) => {
      const rest = current.filter((item) => item.task_id !== record.task_id);
      return [record, ...rest];
    });
  }, []);

  const handleMessageSent = useCallback((sid: string, msg: string) => {
    // For new sessions, register a stream entry here. For existing sessions,
    // chat-input.tsx already called streamStore.start() before invoking
    // send_message, so we skip to avoid resetting accumulated chunks.
    if (!streamStore.hasState(sid)) {
      streamStore.start(sid, msg);
    }

    const isNewSessionSend = !selectedSession || selectedSession === "new";
    if (isNewSessionSend) {
      newSessionStreamIdsRef.current.add(sid);
      // Task-mode sessions are tracked by the task instance list, not the
      // regular optimistic sessions list. Adding them here would make a
      // duplicate "new session" entry appear in the regular sidebar until the
      // real session id resolves and the task filter catches up. Skip the
      // optimistic entry for task mode; the task sidebar already shows it.
      if (!taskLaunchOpenRef.current) {
        const newOptSession: Session = {
          id: sid,
          path: currentProject?.path || "",
          messages: [],
          display_name: t("sessions.newChat") || "新对话",
          started_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
        };
        setOptimisticSessions(prev => [newOptSession, ...prev]);
      }
      setSelectedSession(sid);
      selectedSessionRef.current = sid;
      // Seed the cache for this brand-new session with whatever the user is
      // currently looking at (an empty list for a fresh session).
      sessionMessagesCacheRef.current.set(sid, []);
      setSessionMessages([]);
    } else {
      // Existing session: snapshot the currently displayed messages so we can
      // append the assistant turn on completion without re-reading JSONL.
      sessionMessagesCacheRef.current.set(sid, sessionMessagesRef.current);
    }

    requestAnimationFrame(() => {
      if (messageAreaRef.current) {
        messageAreaRef.current.scrollTop = messageAreaRef.current.scrollHeight;
      }
    });
  }, [selectedSession, currentProject?.path, t]);

  // conductor 驱动的任务发现：首条消息激活 conductor 后，conductor 异步创建 TaskInstance（写入 requirement_session_id）。
  // 轮询任务列表按 requirement_session_id 匹配到该任务后，打开三阶段工作台（此处不标记 launch 会话，避免重复建任务；标记由流式 chunk 处理按需触发，见 task_launch_mark_session 内联调用）。
  // 用 projectPathRef.current（非 state）+ deps=[]，使其引用稳定，可在 mount-only 的
  // stream listener 闭包内安全调用而不捕获陈旧的 projectPath。
  const discoverConductorTask = useCallback(async (sessionId: string) => {
    const projectRoot = projectPathRef.current;
    if (!projectRoot || !sessionId) return;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const items = await invokeCommand<TaskLaunchInstanceSummary[]>(
          "task_launch_list_sessions",
          { projectRoot },
        );
        const found = items.find((item) => item.requirement_session_id === sessionId);
        if (found) {
          logTaskPhaseDebug("conductor-task:discovered", {
            taskId: found.task_id,
            sessionId,
            currentPhase: found.current_phase,
          });
          // 仅关联任务实例（供 follow effect 监听 current_phase），不切换 UI：需求/规划讨论
          // 继续留在 taskLaunch 界面，由 follow effect 在阶段推进时按阶段切标签/工作台
          // （openTaskPhaseWorkspace，execution 分支自行设置 taskContainer*）。此处若
          // setTaskModeActive(true) 会把需求讨论强行拽入 TaskPhaseContainer，触发 useChatSession
          // 加载 requirement session 失败（Pi session not found）+ TaskPhaseContainer 重复挂载
          // （分隔线两次、卡"思考中"）。
          setActiveTaskInstanceId(found.task_id);
          activeTaskInstanceIdRef.current = found.task_id;
          setSelectedTaskSkillId(found.skill_id || "jishu-conductor-dev");
          selectedTaskSkillIdRef.current = found.skill_id || "jishu-conductor-dev";
          lastKnownStatusRef.current = found.status;
          setTaskLaunchSessions(items);
          return;
        }
      } catch (error) {
        console.warn("discoverConductorTask poll failed:", error);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    logTaskPhaseDebug("conductor-task:not-found", { sessionId });
  }, []);

  const handleSessionResolved = useCallback((_pendingSessionId: string, realSessionId: string) => {
    if (!taskLaunchOpenRef.current) {
      logTaskPhaseDebug("session-resolved:ignored", {
        sessionId: realSessionId,
        taskLaunchOpen: taskLaunchOpenRef.current,
      });
      return;
    }
    // realSessionId 来自 send_message 的同步返回值，新 session 时仍为 pending（Pi 真 id 由
    // session_resolved 流式事件异步送达）。任务关联改在 stream listener 收到 session_resolved
    // 时用真 id 触发 discoverConductorTask，不在此用 pending 触发（必 not-found）。
    logTaskPhaseDebug("session-resolved", {
      taskId: activeTaskInstanceIdRef.current,
      sessionId: realSessionId,
      phase: taskLaunchPhaseRef.current,
    });
  }, []);

  // T7：openTaskChatPhase（需求/规划走旧 chat 路径）已随三阶段形态退役——
  // 所有阶段统一由 openTaskPhaseWorkspace 进入「会话页 + 任务侧边栏」形态。

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
    // T4 合流：所有阶段统一进入任务模式（会话页 + TaskSidebar），不再区分 chat-phase 与 execution-phase 两条路径。
    setActiveTaskInstanceId(taskSession.task_id);
    setActiveTaskRequirementFile(taskSession.requirement_file ?? null);
    setSelectedTaskSkillId(taskSession.skill_id || "jishu-conductor-dev");
    activeTaskInstanceIdRef.current = taskSession.task_id;
    activeTaskRequirementFileRef.current = taskSession.requirement_file ?? null;
    selectedTaskSkillIdRef.current = taskSession.skill_id || "jishu-conductor-dev";
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
    setPendingSteerDisplay([]);
  }, []);
  // 任务侧边栏节点选择 → 同步主区会话 + 步骤栏高亮
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
  }, [activeTaskLaunchInstance]);

  // 选中节点的会话信息回填 → 主区渲染该节点会话（复用 chat-page 的 MessageView/ChatInput）
  // v0.7.0 需求二-问题3：接收完整 info（含 agent_id），节点会话消息加载用节点绑定的 agent。
  // 节点已运行但 session_id 尚未回填时，用 pending 标记占位，避免主区显示主流程会话。
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
    [],
  );

  // 退出任务模式时清理图数据，避免残留 run 状态。
  // 注意：不依赖 taskGraph（每次渲染是新对象，会导致死循环），通过 ref 调用。
  useEffect(() => {
    if (!taskModeActive) {
      taskGraphRef.current.clearGraph();
      setTaskSidebarHidden(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskModeActive]);

  // 任务模式 + 执行阶段 + 未选节点 = 三段合流视图：
  // conductor 会话（需求 + 规划）→「流程执行」分隔线 →（未启动：确认卡 / 已启动：run 事件流）。
  // T8-P1：这里**不再**替换主区，只是在会话流末尾追加执行段，输入框保持可用。
  const taskExecutionMode =
    taskModeActive && !taskSelectedNodeId && activeTaskLaunchInstance?.current_phase === "execution";
  // 已完成 / 已存在但终态的 run 重进时，restoreLatestRun 把 activeRunId 置 null、只保留
  // displayedRunId（= activeRunId ?? lastRunId）。必须用 displayedRunId 兜底，否则：
  // - 重进已完成任务 → 回退成「是否开始执行」卡，且分隔线下的执行内容被挡住不显示；
  // - live 跑完那一刻 pollRunProjection 清 activeRunId，也会闪回开始卡。
  const taskRunStarted = Boolean(taskGraph.displayedRunId ?? activeTaskLaunchInstance?.active_run_id);
  const taskStepCount = countExecutableSteps(taskGraph.snapshot);

  // 活跃任务的真节点标题（与右侧步骤栏同源，来自 taskGraph.snapshot），
  // 透传给左侧任务树覆盖 use-task-node-sessions 用 revision 取的占位标题（"A"/"B"）。
  const activeTaskNodeTitles = useMemo(() => {
    const map: Record<string, string> = {};
    if (taskModeActive) {
      for (const n of taskGraph.snapshot?.nodes ?? []) {
        map[n.node_id] = n.title;
      }
    }
    return map;
  }, [taskModeActive, taskGraph.snapshot]);

  // 选中一个还没跑过的步骤时，主区给出明确占位——否则会继续显示上一个会话，
  // 用户以为点击没生效（需求：「点击右侧每一行都能看到每一条的执行情况」）。
  // v0.7.0 需求二-问题3：改按 node run 状态判定。只有完全不存在或状态为
  // blocked/ready 才算"未开始"；一旦状态进入 leased/running（即使 session_id 暂为 null），
  // 让出主区给节点会话渲染（显示流式占位而非"未开始"），避免节点内容延迟到完成才显示。
  const selectedNodeRun = taskSelectedNodeId ? taskGraph.nodeRuns[taskSelectedNodeId] : undefined;
  const taskSelectedNodeNotStarted =
    taskModeActive &&
    !!taskSelectedNodeId &&
    (!selectedNodeRun ||
     selectedNodeRun.attempt_count <= 0 ||
     selectedNodeRun.status === "blocked" ||
     selectedNodeRun.status === "ready");
  // v0.7.0 需求二-问题3：节点已进入 leased/running 但 session_id 尚未由 Pi RPC
  // SessionResolved 回填（selectedSession 为 "pending-node" 占位）。此时主区显示
  // "正在建立会话"占位，而非主流程会话内容，避免节点会话和主流程混在一起。
  const taskSelectedNodeStarting = selectedSession === "pending-node";

  // T8-P10：节点会话的流式输出与常规会话**同一套机制**——
  // `agent-event` → `streamStore` → `useSessionStream` → `StreamingMessage`。
  // 先前 orchestrator 的节点子代理只把事件推进 runtime_bridge 的 channel emitter
  // （供执行引擎消费），从不到达 webview，所以前端无从流式；P9 曾用轮询重读 JSONL 兜底，
  // 那是「另一套机制」，已废弃。现在由 Tauri 层向 orchestrator 注入 NodeEventSink
  // （见 lib.rs setup / runtime_bridge），节点事件与聊天事件走同一条 `agent-event` 通道，
  // 前端无需任何节点专用刷新逻辑。

  // 「是否开始执行」确认卡：用户点「先调整流程」后按任务维度收起，切任务自动复位。
  const [execPromptDismissedTaskId, setExecPromptDismissedTaskId] = useState<string | null>(null);
  const [execStarting, setExecStarting] = useState(false);
  const [execStartError, setExecStartError] = useState<string | null>(null);
  const showExecutionStartPrompt =
    taskExecutionMode &&
    !taskRunStarted &&
    execPromptDismissedTaskId !== (activeTaskLaunchInstance?.task_id ?? null);

  // T8-P9：进入流程执行阶段时把主会话拉到底部。
  // 执行段（「流程执行」分隔线 + 确认卡 / run 事件流）是**追加在 conductor 会话末尾**的，
  // 而进入任务时滚动位置停在需求/规划中间，「开始执行」按钮直接落在视口之外，用户以为没有。
  // 按 taskId × 执行段形态（未启动确认卡 / 已启动 run 流）各定位一次，之后不再打扰手动浏览。
  const execAutoScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!taskExecutionMode) return;
    const taskId = activeTaskLaunchInstance?.task_id;
    if (!taskId) return;
    const key = `${taskId}:${taskRunStarted ? "run" : "prompt"}`;
    if (execAutoScrolledRef.current === key) return;
    // conductor 会话消息还没加载完就滚没有意义（scrollHeight 尚未成形），等内容到位再来。
    if (sessionMessages.length === 0 && !taskRunStarted) return;
    execAutoScrolledRef.current = key;
    // 双 rAF：等执行段完成布局后再定位，否则测到的 scrollHeight 偏小、滚不到真正底部。
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = messageAreaRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [
    taskExecutionMode,
    activeTaskLaunchInstance?.task_id,
    taskRunStarted,
    sessionMessages.length,
    showExecutionStartPrompt,
  ]);

  // 执行中 run 事件流增长时贴底跟随；用户上翻查看历史时不抢滚动。
  useEffect(() => {
    if (!taskExecutionMode || !taskRunStarted) return;
    if (isAwayFromBottomRef.current) return;
    const raf = requestAnimationFrame(() => {
      const el = messageAreaRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [taskExecutionMode, taskRunStarted, taskGraph.projectedMessages.length]);

  const handleStartExecutionFromChat = useCallback(async () => {
    const instance = activeTaskLaunchInstance;
    const revisionId = taskGraph.revision?.revision_id;
    const projectRoot = currentProject?.path;
    if (!instance || !revisionId || !projectRoot) return;
    setExecStarting(true);
    setExecStartError(null);
    try {
      const result = await startTaskRun({
        taskId: instance.task_id,
        projectRoot,
        revisionId,
      });
      if (result?.run_id && instance.graph_id) {
        await taskGraph.loadGraph(instance.graph_id);
      }
    } catch (err) {
      console.error("Failed to start run from chat:", err);
      setExecStartError(
        `${t("task.execution.error.launchFailed", "启动执行失败")}：${taskErrorMessage(err)}`,
      );
    } finally {
      setExecStarting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskLaunchInstance, taskGraph.revision?.revision_id, taskGraph.loadGraph, currentProject?.path, t]);

  // taskLaunch 阶段标签自动跟随：refreshTaskLaunchSessions 的 3s 轮询持续刷新
  // taskLaunchSessions，activeTaskLaunchInstance.current_phase 会自动跟上后端。此 effect
  // 监听其前进：仅当用户仍停在上一阶段（taskLaunchPhaseRef===prev，未手动挪开）才跟随切 tab
  // ——requirements→planning 切规划会话，planning→execution 切执行工作台（与手动点 tab 同走
  // openTaskPhaseWorkspace，行为一致）。不依赖 turn_complete 或 session-id 匹配，数据源即
  // 既有轮询；守卫 taskLaunchPhase===prev 兼防跨任务误跟随与打断手动回看（M3）。
  const taskLaunchCurrentPhase = activeTaskLaunchInstance?.current_phase ?? null;
  useEffect(() => {
    const prev = prevCurrentPhaseRef.current;
    const next = taskLaunchCurrentPhase;
    const advanced = !!next && !!prev && PHASE_LAUNCH_RANK[next] > PHASE_LAUNCH_RANK[prev];
    if (advanced) {
      // 结论性诊断：每次检测到 current_phase 前进都记录守卫值。无此日志=轮询没拿到新
      // phase（后端）；userOnPrev:false=用户已手动挪开（守卫拦截，符合预期）；true 才跟随。
      const userOnPrev = taskLaunchPhaseRef.current === prev;
      const launchOpen = taskLaunchOpenRef.current;
      logTaskPhaseDebug("launch-follow:detected", {
        taskId: activeTaskLaunchInstance?.task_id,
        prev,
        next,
        userOnPrev,
        launchOpen,
      });
      if (userOnPrev && launchOpen && activeTaskLaunchInstance) {
        const targetPhase: TaskPhase = (
          next === "execution" || next === "graph" ? "execution" : next) as TaskPhase;
        logTaskPhaseDebug("launch-follow:advance", {
          taskId: activeTaskLaunchInstance.task_id,
          prev,
          next,
          targetPhase,
        });
        openTaskPhaseWorkspace(activeTaskLaunchInstance, targetPhase);
      }
    }
    prevCurrentPhaseRef.current = next;
  }, [taskLaunchCurrentPhase, activeTaskLaunchInstance, openTaskPhaseWorkspace]);

  // taskLaunch 切标签时的阶段锚点定位：discuss/plan 同一 conductor 会话，切标签需滚到
  // 对应 PhaseDivider（data-phase），而非总会话顶部。仅在 taskLaunchPhase 变化时定位，
  // 不打扰用户在当前标签内的浏览。TaskPhaseContainer 路径由 PhaseConversationShell 自身处理。
  // ⚠️ prevLaunchPhaseRef 只在定位成功后更新——流式期间或消息未加载时不标记完成，
  // 等 isStreaming 变 false 或 sessionMessages.length 变化后自动重试。
  const prevLaunchPhaseRef = useRef<TaskLaunchPhase | null>(null);
  useEffect(() => {
    if (!taskLaunchOpen || taskModeActive) return;
    if (!selectedSession || selectedSession === "new") return;
    if (prevLaunchPhaseRef.current === taskLaunchPhase) return;
    if (currentStream?.isStreaming) return; // 流式中不抢滚动，等结束后重试
    const anchor = taskLaunchPhase === "requirements" ? "discuss" : "plan";
    const container = messageAreaRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-phase="${anchor}"]`);
    if (el) {
      el.scrollIntoView({ block: "start" });
      prevLaunchPhaseRef.current = taskLaunchPhase;
    } else if (anchor === "discuss") {
      // discuss 锚点对应会话顶部；divider 尚未产生则滚顶（总是成功）。
      container.scrollTop = 0;
      prevLaunchPhaseRef.current = taskLaunchPhase;
    } else if (sessionMessages.length > 0) {
      // PhaseDivider 是流式瞬态块，不持久化——消息已加载但元素不存在 → 滚到底部（规划内容在末尾）。
      container.scrollTop = container.scrollHeight;
      prevLaunchPhaseRef.current = taskLaunchPhase;
    }
    // sessionMessages.length === 0 且元素未找到 → 消息尚在加载，等下次 dep 变化重试。
  }, [taskLaunchOpen, taskModeActive, taskLaunchPhase, selectedSession, currentStream?.isStreaming, sessionMessages.length]);

  const handleTaskLaunchBeforeSend = useCallback(async (_message: string) => {
    // conductor 驱动的任务模式：首条消息由 prepareTaskLaunchMessage 包装为 /jishu-task 命令激活 conductor，
    // 无需前端拦截或技能安装检查（conductor 扩展随 Hub 启动自动部署）。消息正常发送。
    return false;
  }, []);

  // Stream listener (mount-only). Each chunk is routed into the per-session
  // store entry via streamStore.push, regardless of which session is currently
  // selected — that's what makes parallel streaming work.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    listen<AgentEventPayload>("agent-event", (event) => {
      const payload = event.payload;
      const chunks = Array.isArray(payload) ? payload : [payload];

      for (const chunk of chunks) {
        // Ignore chunks for agents we're not currently using — UNLESS the chunk
        // belongs to the session we're currently viewing. Execution-phase node
        // sub-agent sessions run under a different agent_id than the active
        // (conductor) agent, but when the user opens a node session we must
        // stream its output live instead of waiting for a manual refresh (T8-P8).
        if (
          chunk.agent_id !== activeIdRef.current &&
          chunk.session_id !== selectedSessionRef.current
        ) {
          continue;
        }

        const cid = chunk.session_id;

        if (chunk.data.kind === "approval_request") {
          const approval: PendingChatApproval = {
            sessionId: cid,
            requestId: chunk.data.request_id,
            approvalKind: chunk.data.approval_kind,
            payload: chunk.data.payload,
          };
          setPendingApprovals((current) => {
            const exists = current.some(
              (item) =>
                item.sessionId === approval.sessionId
                && item.requestId === approval.requestId,
            );
            return exists ? current : [...current, approval];
          });
        }

        if (chunk.data.kind === "interaction_request") {
          const request = interactionRequestFromEvent(chunk.data);
          setPendingInteractions((current) => {
            const next: PendingChatInteraction = {
              agentId: chunk.agent_id,
              sessionId: cid,
              request,
            };
            const exists = current.some(
              (item) =>
                item.agentId === next.agentId
                && item.sessionId === next.sessionId
                && item.request.requestId === next.request.requestId,
            );
            return exists ? current : [...current, next];
          });
        }

        // Detect resolved session id and register it as an alias before pushing
        // (so subsequent chunks under the real id route to the same entry).
        const realId = extractRealSessionId(chunk.data);
        if (realId && realId !== cid) {
          streamStore.alias(cid, realId);
          // 新任务讨论关联：用 Pi 真实 session id（= conductor 写入任务的 requirement_session_id）
          // 触发 discover。ChatInput 的 onSessionResolved 拿的是 send_message 同步返回值（新 session
          // 仍为 pending），匹配不到 conductor 写的真 id；只有此处 session_resolved 事件携带真 id。
          if (taskLaunchOpenRef.current && !activeTaskInstanceIdRef.current) {
            logTaskPhaseDebug("launch-link:resolve", {
              pendingId: cid,
              realId,
              phase: taskLaunchPhaseRef.current,
            });
            discoverConductorTask(realId).catch((e) =>
              console.warn("discoverConductorTask failed:", e),
            );
          }
          // R2: 仅当已关联真任务（activeTaskInstanceId 非空）时才 mark。为空说明
          // Conductor 建的真任务尚未被 discoverConductorTask 发现，此时 mark 会让后端
          // mark_task_stage_session 的 unwrap_or_else 生成 uuid 占位任务（title="新任务"、
          // 无图），导致会话列表出现两条数据。跳过 mark，交由 discoverConductorTask 按
          // requirement_session_id 关联真任务；会话 id 由 Conductor 扩展 conductor_sync_phase
          // 权威写入，不依赖此处 mark。
          if (taskLaunchOpenRef.current && activeTaskInstanceIdRef.current) {
            const projectRoot = projectPathRef.current;
            if (projectRoot) {
              invokeCommand<TaskLaunchInstanceSummary>("task_launch_mark_session", {
                projectRoot,
                taskId: activeTaskInstanceIdRef.current,
                sessionId: realId,
                skillId: selectedTaskSkillIdRef.current,
                phase: taskLaunchPhaseRef.current,
                title: null,
              })
                .then((record) => {
                  applyTaskLaunchInstanceSnapshot(record);
                })
                .catch((error) => console.warn("Failed to mark task launch session:", error));
            }
          }

          // Promote the optimistic session id to the real one in the UI.
          setOptimisticSessions(prev => uniqueSessionsById(prev.map(s => s.id === cid ? { ...s, id: realId } : s)));
          if (newSessionStreamIdsRef.current.has(cid)) {
            newSessionStreamIdsRef.current.add(realId);
          }
          // Move messages cache entry from pending id to real id (and keep
          // both keys pointing at the same array for safety).
          const cached = sessionMessagesCacheRef.current.get(cid);
          if (cached) sessionMessagesCacheRef.current.set(realId, cached);
          // Migrate queued steer messages too. A user can guide (steer) while
          // a tool-bearing turn is running — often BEFORE the session id
          // resolves — so the steer is queued under the pending id. Without
          // this migration, turn_complete (which looks up by the resolved id
          // once known) would miss the queue, leaving the live "已引导"
          // placeholder stuck even though Pi already processed the steer
          // (visible only after a JSONL refresh).
          const queuedSteers = pendingSteerMessagesRef.current.get(cid);
          if (queuedSteers) {
            pendingSteerMessagesRef.current.set(realId, queuedSteers);
            pendingSteerMessagesRef.current.delete(cid);
          }
          // Migrate launch-injection marker: if the pending id was already
          // injected with launch instruction, the real id is too (same session).
          if (injectedLaunchSessionsRef.current.has(cid)) {
            injectedLaunchSessionsRef.current.add(realId);
          } else if (taskLaunchOpenRef.current) {
            // 兜底：任务模式下首条消息发送时 selectedSession 往往还是 null/"new"，
            // prepareTaskLaunchMessage 不会把 pending id 加入 set（786 行的 if 不满足），
            // 导致上面的迁移找不到 pending id、real id 永不入 set。此后用户在任务会话里
            // 发的任何消息都会被误判为首条、重新包装成 /jishu-task 命令——而 Conductor
            // 命令 handler 见 phase !== "idle" 直接 return，Pi 不启动任何 run，界面卡死
            // 在"思考中"。任务模式 session resolve 时无条件把 real id 标记为已激活，确保
            // 后续消息原样透传给已激活的 Conductor。
            injectedLaunchSessionsRef.current.add(realId);
          }
          setPendingInteractions((current) =>
            current.map((item) =>
              item.agentId === chunk.agent_id && item.sessionId === cid
                ? { ...item, sessionId: realId }
                : item,
            ),
          );
          if (selectedSessionRef.current === cid) {
            setSelectedSession(realId);
            selectedSessionRef.current = realId;
            visitedSessions.current.add(realId);
          }
        }

        // Phase dividers and interaction requests may legitimately arrive after
        // a prior run's stream state was dropped; lifecycle-only events may not
        // create an empty continuation stream.
        if (!streamStore.pushTracked(cid, chunk)) {
          continue;
        }

        if (chunk.data.kind === "turn_complete") {
          // Build final assistant/user messages from the accumulated state.
          const state = streamStore.getState(cid);
          const finalKey = state?.resolvedId ?? cid;
          // A4/A10：记录本回合用量（字段可缺省；后续 UI 按有数据项展示）
          if (chunk.data.usage) {
            recordSessionUsage(finalKey, chunk.data.usage as {
              input_tokens?: number | null;
              output_tokens?: number | null;
              total_cost?: number | null;
              context_remaining?: number | null;
              context_window_total?: number | null;
            });
          }
          // Spurious-completion guard: when a follow-up streaming state was just
          // created at the end of a turn (a manually-guided steer committed as a
          // follow-up, or Route 2 auto-sending staged guides), the (re)launched
          // ACP/agent process can emit early turn_complete events (Complete,
          // Error, …) before its real reply has begun — carrying no assistant
          // text. Processing them would drop the freshly-created "thinking"
          // state, leaving a blank gap until the real reply's first token.
          // Detect them (follow-up started recently + no text produced) and skip:
          // keep the state so the pending reply fills it naturally. The marker
          // is retained across skips so consecutive spurious completions are all
          // ignored; it is cleared only when a genuine completion (with text) is
          // processed below, or expires after the window.
          const pendingReplyStartedAt = pendingReplyStartedAtRef.current.get(finalKey)
            ?? pendingReplyStartedAtRef.current.get(cid);
          // state must exist (an aborted turn whose state was already dropped by
          // handleAbort is null here and must NOT be skipped — its queued steers
          // still need committing). content/tools may hold ACP startup noise so
          // only text/thinking gate this.
          const hasNoReplyText = Boolean(state)
            && !(state!.text.length || state!.thinking.length);
          if (
            pendingReplyStartedAt !== undefined
            && Date.now() - pendingReplyStartedAt < 2000
            && hasNoReplyText
          ) {
            continue;
          }
          const isNewSessionStream =
            newSessionStreamIdsRef.current.has(cid)
            || newSessionStreamIdsRef.current.has(finalKey);
          // For transports without mid-turn steer (ACP), a queued guide that
          // couldn't be injected is sent as a real new message. Set in the
          // no-tool branch below; the actual streamStore.start + send_message
          // runs after this turn's drop(cid), so the new stream isn't cleared.
          let guideToSendAfterDrop: string | null = null;
          const newMessages: Message[] = [];
          if (state?.pendingUserMessage) {
            newMessages.push({
              role: "user",
              content: [{ type: "text", text: state.pendingUserMessage }],
              timestamp: Date.now(),
            });
          }
          // Build the assistant content blocks for this turn. When Pi
          // delivers a steer mid-turn (at a tool-call gap) it folds the
          // steer's reply into the SAME turn — so a single turn_complete can
          // hold [reply1a, steer, reply1b] worth of content, accumulated in
          // arrival order. `steerSplits` records the content-array index at
          // each injection point; we split there and interleave the queued
          // steers so the live order matches the JSONL Pi persists.
          const steerQueueKey = pendingSteerMessagesRef.current.has(finalKey)
            ? finalKey
            : cid;
          const queuedSteers = pendingSteerMessagesRef.current.get(steerQueueKey) ?? [];
          // ── Build interactionInsertions with REAL indices ───────────────────
          // The snapshot `item.index` (content.length at interaction_request time)
          // goes stale once the agent emits more content after the request.
          // Instead, after we've built the final assistantContent, re-scan it to
          // find each answered interaction's tool_use block and use its REAL index.
          // Sanitize + sort: each split marks the start of a new segment.
          const steerSplits = Array.from(new Set(state?.steerSplits ?? []))
            .filter((idx) => idx > 0 && idx < (state?.content.length ?? 0))
            .sort((a, b) => a - b);

          // True when a committed steer will be answered in a FOLLOW-UP turn
          // (a leftover not delivered mid-turn, or the appended steer in a
          // no-tool turn). Drives the pre-created "thinking" state below.
          let followUpExpected = false;

          const assistantContent = buildAssistantContentFromStreamState(state);
          // An aborted turn (e.g. the user hit Stop on Claude Code's ACP
          // transport, which emits TurnComplete(Aborted)) must still embed any
          // pending, UNANSWERED interaction — otherwise the question vanishes
          // the moment the stream state is dropped. On normal completion there
          // are no pending interactions, so includePending only affects aborts.
          const isAbortedTurn = chunk.data.reason === "Aborted";
          const interactionInsertions = buildInteractionInsertions({
            assistantContent,
            interactionSplits: state?.interactionSplits ?? [],
            includePending: isAbortedTurn,
          });

          // Remove the first `count` steers from the session queue. Reads the
          // CURRENT ref (not the `queuedSteers` snapshot) so successive calls
          // within the same turn_complete — mid-turn steers then a leftover —
          // compose correctly instead of re-slicing the original array.
          const consumeSteerFromQueue = (count: number) => {
            if (count <= 0) return;
            const current = pendingSteerMessagesRef.current.get(steerQueueKey) ?? [];
            const remaining = current.slice(count);
            if (remaining.length > 0) {
              pendingSteerMessagesRef.current.set(steerQueueKey, remaining);
            } else {
              pendingSteerMessagesRef.current.delete(steerQueueKey);
            }
          };
          // Drop the oldest `count` live placeholders (FIFO matches the queue
          // shift) — but ONLY when this session is the one currently viewed.
          // Live placeholders are session-specific (cleared on switch), so a
          // background session committing its queued steer must not touch the
          // viewed session's display array.
          const dropLivePlaceholders = (count: number) => {
            if (count <= 0) return;
            const viewing = selectedSessionRef.current;
            if (viewing === cid || viewing === finalKey) {
              setPendingSteerDisplay((prev) => prev.slice(count));
            }
          };
          if (interactionInsertions.length > 0) {
            const midSteerCount = Math.min(steerSplits.length, queuedSteers.length);
            const committed = commitAssistantWithInteractions({
              assistantContent,
              interactionInsertions,
              steerInsertions: steerSplits.slice(0, midSteerCount).map((index, i) => ({
                index,
                text: queuedSteers[i],
              })),
              error: state?.error,
            });
            newMessages.push(...committed.messages);
            consumeSteerFromQueue(midSteerCount);
            dropLivePlaceholders(midSteerCount);

            const leftover = pendingSteerMessagesRef.current.get(steerQueueKey);
            if (leftover && leftover.length > 0) {
              newMessages.push({
                role: "user",
                content: [{ type: "text", text: leftover[0] }],
                timestamp: Date.now(),
              });
              followUpExpected = true;
              consumeSteerFromQueue(1);
              dropLivePlaceholders(1);
            }
          } else if (steerSplits.length > 0 && queuedSteers.length > 0) {
            // TOOL-BEARING turn with mid-turn steers: split the accumulated
            // content at each injection point and interleave the steers
            // between segments — yielding [reply1a, steer, reply1b] instead of
            // [reply1a+reply1b, steer], matching the JSONL order.
            const midCount = Math.min(steerSplits.length, queuedSteers.length);
            let prevIdx = 0;
            for (let i = 0; i < midCount; i++) {
              const seg = assistantContent.slice(prevIdx, steerSplits[i]);
              if (seg.length > 0) {
                newMessages.push({ role: "assistant", content: seg, timestamp: Date.now() });
              }
              newMessages.push({
                role: "user",
                content: [{ type: "text", text: queuedSteers[i] }],
                timestamp: Date.now(),
              });
              prevIdx = steerSplits[i];
            }
            // Tail segment (after the final mid-turn steer); errors attach here.
            const tail = assistantContent.slice(prevIdx);
            if (state?.error) tail.push({ type: "text", text: state.error });
            if (tail.length > 0) {
              newMessages.push({ role: "assistant", content: tail, timestamp: Date.now() });
            }
            consumeSteerFromQueue(midCount);
            dropLivePlaceholders(midCount);

            // Pi delivers steers one-at-a-time; any queue entry left after the
            // mid-turn steers was queued too late to be folded in and will be
            // processed as a follow-up turn. Commit it now (appended after the
            // tail) so it lands BEFORE its response, which arrives in the next
            // turn_complete — mirroring the no-tool FIFO behavior below.
            const leftover = pendingSteerMessagesRef.current.get(steerQueueKey);
            if (leftover && leftover.length > 0) {
              newMessages.push({
                role: "user",
                content: [{ type: "text", text: leftover[0] }],
                timestamp: Date.now(),
              });
              followUpExpected = true;
              consumeSteerFromQueue(1);
              dropLivePlaceholders(1);
            }
          } else {
            // No mid-turn steer injection: commit the turn as a single
            // assistant message, then append one queued steer FIFO. With Pi's
            // default one-at-a-time steering the steer is answered in a
            // separate follow-up turn, so appending it here lands it between
            // this reply and the next — [reply, steer, steerResponse].
            if (state?.error) {
              assistantContent.push({ type: "text", text: state.error });
            }
            if (assistantContent.length > 0) {
              newMessages.push({ role: "assistant", content: assistantContent, timestamp: Date.now() });
            }
            if (queuedSteers.length > 0) {
              if (supportsSteerRef.current) {
                // Pi-RPC: the queued steer is answered in a follow-up turn.
                // Commit it as a user message now; the response arrives in the
                // next turn_complete. followUpExpected pre-creates a "thinking"
                // state so the gap isn't blank.
                newMessages.push({
                  role: "user",
                  content: [{ type: "text", text: queuedSteers[0] }],
                  timestamp: Date.now(),
                });
                followUpExpected = true;
                consumeSteerFromQueue(1);
                dropLivePlaceholders(1);
              } else {
                // No mid-turn steer (ACP/claude-code): the queued guide was
                // never injected, so no follow-up reply will come. Send it as a
                // real new message (mirrors Route 2) so the agent actually
                // processes it. Do NOT commit it as a user message here —
                // send_message's own turn_complete will commit guide+reply
                // naturally (committing now would duplicate it). The actual
                // streamStore.start + send_message runs AFTER the drop below
                // (same as Route 2) — otherwise this turn's drop(cid) would
                // clear the freshly-started stream.
                const guideText = queuedSteers[0];
                consumeSteerFromQueue(1);
                dropLivePlaceholders(1);
                guideToSendAfterDrop = guideText;
              }
            }
          }

          // Resolve the base messages from the cache (preferring real id).
          const baseMessages =
            sessionMessagesCacheRef.current.get(finalKey)
            ?? sessionMessagesCacheRef.current.get(cid)
            ?? [];
          const updated = [...baseMessages, ...newMessages];
          sessionMessagesCacheRef.current.set(finalKey, updated);
          if (cid !== finalKey) sessionMessagesCacheRef.current.set(cid, updated);

          // Persist interaction blocks to JSONL (best-effort). The session's
          // `path` field is the JSONL file location for existing sessions; new
          // sessions may only have the project directory, in which case we skip
          // the write (the interaction data is still in the cache, and the
          // session loader filters interaction tool_use blocks on reload).
          if (interactionInsertions.length > 0) {
            const sessionList = sessionsRef.current;
            const sessionPath = sessionList?.find(s => s.id === finalKey)?.path
              ?? sessionList?.find(s => s.id === cid)?.path
              ?? "";
            invokeCommand("persist_interaction_blocks", {
              agentId: activeIdRef.current ?? "",
              sessionPath,
              sessionId: finalKey,
              encodedName: projectIdRef.current,
              interactions: interactionInsertions.map(ins => ({
                index: ins.index,
                request_id: ins.requestId ?? null,
                prompt: ins.prompt,
                options: ins.options,
                answer: ins.answer,
                selected_options: ins.selectedOptions ?? [],
                origin: ins.origin ?? null,
              })),
            }).catch((err: unknown) => {
              console.warn("Failed to persist interaction blocks:", err);
            });
          }

          // Persist the in-progress assistant text/thinking of an ABORTED turn
          // so it survives a refresh. Claude Code's transcript is owned by the
          // external `claude` CLI, which writes at message-completion
          // boundaries and ABANDONS an interrupted message — so the JSONL a
          // refresh reads would otherwise lack the partial the user already
          // saw (opencode/jishu no-op their adapter: they persist their own
          // store incrementally). Best-effort + idempotent: the backend strips
          // anything Claude already durably wrote, so the racing onAbort path
          // re-calling this is a safe no-op.
          if (isAbortedTurn && (state?.text || state?.thinking)) {
            const sessionList = sessionsRef.current;
            const partialSessionPath = sessionList?.find(s => s.id === finalKey)?.path
              ?? sessionList?.find(s => s.id === cid)?.path
              ?? "";
            invokeCommand("persist_partial_assistant", {
              agentId: activeIdRef.current ?? "",
              sessionPath: partialSessionPath,
              sessionId: finalKey,
              encodedName: projectIdRef.current,
              text: state?.text ?? "",
              thinking: state?.thinking ?? "",
            }).catch((err: unknown) => {
              console.warn("Failed to persist partial assistant after abort:", err);
            });
          }

          // If the user is currently viewing this session, reflect the update
          // immediately. Otherwise the cache will be used the next time they
          // switch back to this session (without a JSONL reload).
          const viewed = selectedSessionRef.current;
          const shouldKeepFollowingOutput = !isAwayFromBottomRef.current;
          if (viewed === cid || viewed === finalKey) {
            setSessionMessages(updated);
          }

          // Convert the streaming bubble into the formal MessageView row in a
          // single paint. drop() schedules the normal external-store update;
          // forcing a synchronous flush here can remove the live row before
          // React commits its formal Markdown replacement.
          streamStore.drop(cid);
          if ((viewed === cid || viewed === finalKey) && shouldKeepFollowingOutput) {
            // The live turn and its committed Markdown use different DOM
            // subtrees. Wait for both the stream-store notification and the
            // Markdown layout before fixing the viewport at the output end.
            // If the user scrolled up, preserve their reading position.
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const currentViewed = selectedSessionRef.current;
                if (currentViewed !== cid && currentViewed !== finalKey) return;
                const scrollEl = messageAreaRef.current;
                if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
              });
            });
          }
          // This was a genuine completion (had text, or the follow-up window
          // elapsed) — clear the spurious-completion marker so it does not
          // suppress a later legitimate turn_complete for this session.
          pendingReplyStartedAtRef.current.delete(finalKey);
          pendingReplyStartedAtRef.current.delete(cid);

          if (followUpExpected) {
            // A committed steer will be answered in a FOLLOW-UP turn (a
            // leftover not delivered mid-turn in a tool turn, or the appended
            // steer in a no-tool turn). Pre-create an empty streaming state so
            // the "thinking" indicator shows immediately and PERSISTS until the
            // agent actually responds — otherwise there's a blank gap until the
            // response's first chunk re-activates the state via the
            // content-chunk guard above. Mid-turn steers are folded into the
            // committed segments above, so they do NOT trigger this. Use the
            // resolved key + re-alias cid so response chunks route correctly
            // after the drop cleared the alias map.
            //
            // No timeout: the response turn is guaranteed (Pi delivers the
            // queued steer one-at-a-time), so the state is always resolved —
            // either content arrives (fills it; the indicator is naturally
            // replaced by the reply) or the response turn's turn_complete
            // fires (drops the state, covering empty or error responses). An
            // arbitrary cutoff would kill the indicator before a slow model's
            // first token, exactly the bug we're fixing.
            streamStore.start(finalKey, null);
            if (cid !== finalKey) streamStore.alias(finalKey, cid);
            pendingReplyStartedAtRef.current.set(finalKey, Date.now());
          }

          // ACP (no mid-turn steer): a queued guide that couldn't be injected
          // is sent as a real new message now that this turn's drop has settled.
          // Mirrors Route 2 — start the stream + record the spurious-completion
          // marker + fire send_message in an async IIFE so the reply fills the
          // "thinking" state naturally.
          if (guideToSendAfterDrop !== null) {
            const guideText = guideToSendAfterDrop;
            // Start the reply stream WITHOUT pendingUserMessage: send_message
            // already delivered the guide to the backend (it's in the JSONL),
            // so the reply's turn_complete must NOT re-commit it as a user
            // message (that would duplicate it). We commit the guide into the
            // cache ourselves here, exactly once.
            streamStore.start(finalKey, null);
            if (cid !== finalKey) streamStore.alias(finalKey, cid);
            pendingReplyStartedAtRef.current.set(finalKey, Date.now());
            const guideBase =
              sessionMessagesCacheRef.current.get(finalKey)
              ?? sessionMessagesCacheRef.current.get(cid)
              ?? [];
            const guideUpdated = [...guideBase, {
              role: "user" as const,
              content: [{ type: "text" as const, text: guideText }],
              timestamp: Date.now(),
            }];
            sessionMessagesCacheRef.current.set(finalKey, guideUpdated);
            if (cid !== finalKey) sessionMessagesCacheRef.current.set(cid, guideUpdated);
            if (selectedSessionRef.current === cid || selectedSessionRef.current === finalKey) {
              setSessionMessages(guideUpdated);
            }
            const guideProjectPath = projectPathRef.current;
            void (async () => {
              try {
                await invokeCommand("send_message", {
                  agentId: activeIdRef.current ?? "",
                  projectPath: guideProjectPath,
                  sessionId: finalKey,
                  message: guideText,
                });
              } catch (err) {
                console.error("Failed to send queued guide:", err);
                streamStore.drop(finalKey);
              }
            })();
          }

          // Route 2 (orthogonal to manual guide): when the turn ends, auto-send
          // any messages the user staged but did NOT manually guide — merged
          // into a single new turn. claimAll(finalKey) synchronously marks them
          // sent for THIS session, so a manual click racing this moment (or a
          // re-click) is blocked by the shared claimed-id set — each staged
          // guide is delivered exactly once. Gated on !followUpExpected so it
          // never competes with a manual steer's follow-up turn (that turn fires
          // its own turn_complete, which re-evaluates).
          //
          // Targets the session whose turn just completed (finalKey), NOT the
          // currently-viewed session. Staging state is partitioned by session
          // (stagedMessagesBySession), so a background session's turn_complete
          // claims only its own staged guides — never another conversation's.
          // This fixes the case where the user staged a guide in session A,
          // switched to B, and A's completion (while viewing B) must still send
          // A's staged guide. Claiming is gated only on stagedApiRef existing
          // (the ChatInput must be mounted) and !followUpExpected; the viewed
          // session is irrelevant.
          if (!followUpExpected && stagedApiRef.current) {
            const claimed = stagedApiRef.current.claimAll(finalKey);
            if (claimed.length > 0) {
              const merged = claimed.map((m) => m.content).join("\n\n");
              // Start WITHOUT pendingUserMessage: send_message delivers the
              // message to the backend (JSONL), so the reply's turn_complete
              // must NOT re-commit it (would duplicate). Commit it into the
              // cache ourselves here, exactly once.
              streamStore.start(finalKey, null);
              if (cid !== finalKey) streamStore.alias(finalKey, cid);
              pendingReplyStartedAtRef.current.set(finalKey, Date.now());
              const autoBase =
                sessionMessagesCacheRef.current.get(finalKey)
                ?? sessionMessagesCacheRef.current.get(cid)
                ?? [];
              const autoUpdated = [...autoBase, {
                role: "user" as const,
                content: [{ type: "text" as const, text: merged }],
                timestamp: Date.now(),
              }];
              sessionMessagesCacheRef.current.set(finalKey, autoUpdated);
              if (cid !== finalKey) sessionMessagesCacheRef.current.set(cid, autoUpdated);
              if (selectedSessionRef.current === cid || selectedSessionRef.current === finalKey) {
                setSessionMessages(autoUpdated);
              }
              const projectPath = projectPathRef.current;
              const restore = stagedApiRef.current.restore.bind(stagedApiRef.current);
              void (async () => {
                try {
                  await invokeCommand("send_message", {
                    agentId: activeIdRef.current ?? "",
                    projectPath,
                    sessionId: finalKey,
                    message: merged,
                  });
                } catch (err) {
                  console.error("Auto-send of staged guides failed:", err);
                  streamStore.drop(finalKey);
                  restore(finalKey, claimed);
                }
              })();
            }
          }

          if (isNewSessionStream) {
            newSessionStreamIdsRef.current.delete(cid);
            newSessionStreamIdsRef.current.delete(finalKey);
            refetchSessionsRef.current?.(true).catch(console.error);
          }

        }
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlistenFn = fn;
      }
    });
    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive display name for the current session
  const displayName = selectedSession
    ? (sessionNames?.[selectedSession] || sessions?.find(s => s.id === selectedSession)?.display_name || optimisticSessions.find(s => s.id === selectedSession)?.display_name || selectedSession.slice(0, 8))
    : "";
  // 选中节点会话时，主区头部显示节点标题（任务名），而非节点会话的裸 display_name（"1"/"2"）。
  const nodeHeaderTitle =
    taskModeActive && taskSelectedNodeId
      ? taskGraph.snapshot?.nodes.find((n) => n.node_id === taskSelectedNodeId)?.title ?? displayName
      : displayName;
  const activeApproval = pendingApprovals[0] ?? null;
  // v0.7.0 需求二：节点会话的 interaction 来自节点子代理（agent_id 可能是非 activeId
  // 的 claude-code/codex 等）。匹配只按 sessionId（已唯一标识会话），不限制 agentId，
  // 否则节点执行阶段的 agent 问答无法显示和提交。
  const activeInteraction = pendingInteractions.find(
    (item) => item.sessionId === selectedSession,
  ) ?? null;
  const handleInteractionSubmit = useCallback(async (
    submission: ConversationInteractionSubmission,
  ) => {
    // v0.7.0 需求二：节点会话 interaction 匹配只按 sessionId + requestId（不限制 agentId）。
    const interaction = pendingInteractions.find(
      (item) =>
        item.sessionId === selectedSession
        && item.request.requestId === submission.requestId,
    );
    if (!interaction) return;

    const matchesInteraction = (item: PendingChatInteraction) =>
      item.agentId === interaction.agentId
      && item.sessionId === interaction.sessionId
      && item.request.requestId === submission.requestId;
    const value = formatInteractionResponseValue(interaction.request, submission);
    const checkpoint = streamStore.recordInteractionResponseWithCheckpoint(
      interaction.sessionId,
      submission.requestId,
      value,
      submission.selectedOptionIds,
    );
    const restorePending = () =>
      setPendingInteractions((current) =>
        current.some(matchesInteraction) ? current : [...current, interaction],
      );

    // Hide the panel immediately; restored below on failure.
    setPendingInteractions((current) => current.filter((item) => !matchesInteraction(item)));

    // Hand the answer to the backend along with the interaction's origin. The
    // backend takes the AUTHORITATIVE delivery decision from the process's
    // actual transport (design R6 — never assume mid-turn from the event hint).
    let result: InteractionResponseDto | null = null;
    try {
      result = await invokeCommand<InteractionResponseDto>("respond_chat_interaction", {
        sessionId: interaction.sessionId,
        requestId: submission.requestId,
        value,
        interaction: {
          request_id: submission.requestId,
          prompt: interaction.request.prompt,
          options: interaction.request.options.map((option) => ({
            option_id: option.optionId,
            label: option.label,
            description: option.description ?? null,
          })),
          answer: value,
          selected_options: submission.selectedOptionIds,
          origin: interaction.request.origin ?? null,
        },
        origin: interaction.request.origin,
      });
    } catch (error) {
      streamStore.rollbackInteractionResponse(checkpoint);
      restorePending();
      throw error;
    }

    const delivery = result?.delivery ?? "follow_up";

    if (delivery === "mid_turn") {
      // The answer was recorded before IPC so a TurnComplete released by the
      // extension_ui_response cannot commit an unanswered interaction.
      return;
    }

    // Follow-up: this transport cannot answer mid-turn as a business question.
    // Remove the inline placeholder (no phantom gap) and deliver the answer as
    // a new user message — the design's safety net for transports without
    // mid-turn reachability (CLI, capability-absent downgrade, opencode).
    streamStore.removeInteractionSplit(interaction.sessionId, submission.requestId);
    const replyText = formatInteractionReply(interaction.request, submission).trim();
    if (!replyText) return;

    // Mirror the standard send path: register a new turn's stream, snapshot the
    // session cache, then dispatch send_message. The prior turn is persisted to
    // the session JSONL and re-rendered from history on completion.
    streamStore.start(interaction.sessionId, replyText);
    handleMessageSent(interaction.sessionId, replyText);
    try {
      await invokeCommand("send_message", {
        agentId: activeIdRef.current ?? "",
        projectPath: projectPathRef.current ?? "",
        sessionId: interaction.sessionId,
        message: replyText,
      });
    } catch (sendError) {
      console.error("Failed to send interaction follow-up message:", sendError);
      streamStore.end(interaction.sessionId);
      restorePending();
    }
  }, [
    handleMessageSent,
    pendingInteractions,
    selectedSession,
  ]);
  const resolveActiveApproval = useCallback(async (approved: boolean) => {
    if (!activeApproval || approvalResolving) return;
    setApprovalResolving(true);
    try {
      await invokeCommand("resolve_chat_permission", {
        sessionId: activeApproval.sessionId,
        requestId: activeApproval.requestId,
        approved,
      });
      setPendingApprovals((current) =>
        current.filter(
          (item) =>
            item.sessionId !== activeApproval.sessionId
            || item.requestId !== activeApproval.requestId,
        ),
      );
    } catch (error) {
      console.error("Failed to resolve ACP permission request:", error);
    } finally {
      setApprovalResolving(false);
    }
  }, [activeApproval, approvalResolving]);
  const projectDisplayName = currentProjectMeta?.custom_name || currentProject?.name || t("sessions.noProject");
  const projectPath = currentProject?.path ?? "";
  const activeModelLabel = activeModel
    ? `${activeModel.provider}/${activeModel.model}`
    : (t("sessions.activeModel") || "Pick model");
  // 模型选择器+水位圆环（v0.7.3 需求2 收尾）：移至发送按钮左侧同一行（trailingControls）。
  const modelTrailingControls = (
    supportsModelPicker ? (
        <span ref={modelMenuRef} className="relative inline-flex shrink-0 min-w-0 items-center gap-1.5">
          {/* 水位圆环贴模型按钮左侧；整体渲染于发送按钮同一行（trailingControls） */}
          <ContextRing sessionId={selectedSession && selectedSession !== "new" ? selectedSession : null} />
          {modelOptions.length === 0 ? (
            <span className="truncate text-amber-400">
              {t("sessions.modelNotConfigured") || "No models — open 管理-配置"}
            </span>
          ) : (
            <>
              <button
                type="button"
                aria-label={t("sessions.activeModel") || "Active model"}
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                title={activeModelLabel}
                onClick={() => setModelMenuOpen((open) => !open)}
                className={cn(
                  "inline-flex h-7 max-w-[11rem] items-center gap-1.5 rounded-md text-xs font-mono text-muted-foreground transition-fast hover:bg-accent/30 hover:text-foreground",
                  modelMenuOpen && "bg-accent/30 text-foreground",
                )}
              >
                <span className="min-w-0 truncate">{activeModelLabel}</span>
                <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", modelMenuOpen && "rotate-180")} />
              </button>
              {modelMenuOpen && (
                <div className="absolute bottom-full right-0 mb-1 z-50 max-h-64 w-48 overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-lg">
                  {modelOptions.map((o) => {
                    const value = `${o.provider}/${o.model}`;
                    const selected = activeModel?.provider === o.provider && activeModel?.model === o.model;
                    return (
                      <button
                        key={value}
                        type="button"
                        title={value}
                        onClick={async () => {
                          const next = { provider: o.provider, model: o.model };
                          setActiveModel(next);
                          setModelMenuOpen(false);
                          try {
                            await invokeCommand("set_active", { agentId: activeId ?? "", active: next });
                          } catch (err) {
                            console.warn("set_active failed:", err);
                          }
                        }}
                        className={cn(
                          "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs font-mono transition-fast hover:bg-accent/60",
                          selected ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        <span className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          selected ? "bg-primary" : "bg-transparent",
                        )} />
                        <span className="min-w-0 flex-1 truncate">{value}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </span>
      ) : null
  );

  const startComposerFooter = currentProject ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/40 bg-muted/45 px-4 py-2.5 text-xs text-muted-foreground">
      {projectPath && (
        <span className="inline-flex min-w-0 items-center gap-1">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--icon-folder)]" />
          <span className="min-w-0 max-w-[45%] truncate text-left font-mono text-[0.92em]" title={`${t("sessions.projectPath")}: ${projectPath}`}>
            {projectPath}
          </span>
          {/* 单个左右堆叠箭头图标：进入项目管理页（切换项目） */}
          <button
            type="button"
            onClick={onSwitchProject}
            title={t("sessions.switchProject")}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-fast hover:bg-accent/45 hover:text-foreground"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
      {!supportsModelPicker && (
        <ContextRing sessionId={selectedSession && selectedSession !== "new" ? selectedSession : null} />
      )}
      {/* v0.7.0 需求一：原静态智能体展示位改为可切换（AgentSwitcher 受控）。
          新会话可切换（切换 = 新建会话）；任务态只有 jishu agent 可用，保持静态展示。 */}
      {taskLaunchOpen ? (
        <span className="inline-flex min-w-0 items-center gap-1.5" title={active?.display_name ?? ""}>
          {active ? <AgentLogo agentId={active.id} size={14} /> : null}
          <span className="truncate">{active?.display_name ?? t("sessions.currentAgent")}</span>
        </span>
      ) : (
        <AgentSwitcher value={activeId} onChange={setChatAgent} dropUp>
          {active && (
            <span className="truncate">{active.display_name}</span>
          )}
        </AgentSwitcher>
      )}
    </div>
  ) : null;

  return (
    <div className="flex h-full">
      {/* Left sidebar */}
      <div
        className={cn(
          "chat-sidebar flex flex-col shrink-0",
          sidebarCollapsed ? "w-14" : "w-60"
        )}
      >
        {/* Expanded sidebar */}
        <div className={cn("flex flex-col", sidebarCollapsed && "hidden")} style={{ background: "var(--color-layer-1)" }}>
          {/* Project card */}
          {/* v0.7.3 需求2：项目切换移至输入区 footer（目录旁左右箭头），左上角仅展示项目名 */}
          <div className="flex items-center gap-2 px-3 h-10 border-b border-border/20">
            <FolderOpen className={cn("h-5 w-5 shrink-0 ml-1", currentProject ? "text-[var(--icon-folder)]" : "text-muted-foreground/40")} />
            <span className={cn("truncate text-sm font-semibold flex-1 min-w-0 leading-none pt-[1px]", currentProject ? "text-foreground" : "text-muted-foreground")} title={currentProject ? projectDisplayName : undefined}>
              {currentProject ? projectDisplayName : t("sessions.noProject")}
            </span>
          </div>
          {/* Actions */}
          <div className="flex items-center gap-1.5 px-3 h-11 pt-2 pb-1">
            <button
              onClick={projectId ? handleNewSession : undefined}
              title={projectId ? t("sessions.newSession") : t("sessions.selectProject")}
              className={cn(
                "flex-1 flex items-center gap-2.5 h-8 pl-2 pr-2 rounded-lg transition-fast text-sm text-foreground",
                projectId ? "hover:bg-accent" : "opacity-40 cursor-not-allowed"
              )}
            >
              <SquarePen className="h-3.5 w-3.5 shrink-0 text-[var(--icon-action)]" />
              <span className="truncate leading-none pt-[1px]">{t("sessions.startNewChat")}</span>
            </button>
            <button
              onClick={handleRefresh}
              title={t("sessions.refresh")}
              className="shrink-0 h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent/50 transition-fast text-muted-foreground hover:text-foreground"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="shrink-0 h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent/50 transition-fast text-muted-foreground hover:text-foreground"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="px-3 pb-2">
            <button
              onClick={projectId ? () => handleOpenTaskConversation() : undefined}
              title={projectId ? t("tasks.startTask") : t("sessions.selectProject")}
              className={cn(
                "flex h-8 w-full items-center gap-2.5 rounded-lg pl-2 pr-2 text-sm text-foreground transition-fast",
                projectId ? taskLaunchOpen ? "bg-primary/10 font-medium" : "hover:bg-accent" : "opacity-40 cursor-not-allowed"
              )}
            >
              <ClipboardList className="h-3.5 w-3.5 shrink-0 text-[var(--icon-action)]" />
              <span className="truncate leading-none pt-[1px]">{t("tasks.startTask")}</span>
            </button>
          </div>
          {/* Search */}
          <div className="px-3 h-10 pb-2">
            <div className="relative h-8">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--icon-search)]" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("sessions.searchAll")}
                className="h-full pl-8 pr-7 !text-sm !leading-none shadow-none rounded-lg border-border/40 truncate"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(""); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-fast"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              {showMessageSearchControls && (
                <div className="absolute left-[calc(100%+0.42rem)] top-1/2 z-30 flex h-[2.55rem] -translate-y-1/2 overflow-hidden rounded-[12px] border border-border/50 bg-background/95 shadow-[0_0.45rem_1.25rem_rgba(0,0,0,0.16)] backdrop-blur">
                  <span className="flex min-w-[2.85rem] items-center justify-center px-[0.65rem] text-[0.7rem] font-medium tabular-nums text-muted-foreground leading-none">
                    {messageSearchLabel}
                  </span>
                  <div className="flex h-full w-[1.55rem] flex-col border-l border-border/40">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={messageSearchTotal === 0}
                      onClick={() => requestMessageSearchNavigation(-1)}
                      title={t("sessions.previousMatch")}
                      className="h-1/2 w-full rounded-none px-0 hover:bg-accent/70 disabled:opacity-30"
                    >
                      <ChevronUp className="size-[0.85rem]" strokeWidth={3} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={messageSearchTotal === 0}
                      onClick={() => requestMessageSearchNavigation(1)}
                      title={t("sessions.nextMatch")}
                      className="h-1/2 w-full rounded-none border-t border-border/30 px-0 hover:bg-accent/70 disabled:opacity-30"
                    >
                      <ChevronDown className="size-[0.85rem]" strokeWidth={3} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Collapsed sidebar header */}
        <div className={cn("flex flex-col", !sidebarCollapsed && "hidden")} style={{ background: "var(--color-layer-1)" }}>
          {/* Row 1: Project icon */}
          <div className="flex items-center justify-center h-10 border-b border-border/20" title={currentProject?.name ?? t("sessions.noProject")}>
            <FolderOpen className={cn("h-4 w-4", currentProject ? "text-[var(--icon-folder)]" : "text-muted-foreground/40")} />
          </div>
          {/* Row 2: Expand button */}
          <div className="flex items-center justify-center h-11 pt-2 pb-1">
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent/50 transition-fast text-muted-foreground hover:text-foreground"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </div>
          {/* Row 3: New chat */}
          <div className="flex items-center justify-center h-10 pb-2">
            <button
              onClick={projectId ? handleNewSession : undefined}
              title={projectId ? t("sessions.newSession") : t("sessions.selectProject")}
              className={cn(
                "h-8 w-8 flex items-center justify-center rounded-lg transition-fast",
                projectId ? "hover:bg-accent" : "opacity-40 cursor-not-allowed"
              )}
            >
              <SquarePen className="h-4 w-4 text-[var(--icon-action)]" />
            </button>
          </div>
          <div className="flex items-center justify-center h-10 pb-2">
            <button
              onClick={projectId ? () => handleOpenTaskConversation() : undefined}
              title={projectId ? t("tasks.startTask") : t("sessions.selectProject")}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition-fast",
                projectId ? taskLaunchOpen ? "bg-primary/10" : "hover:bg-accent" : "opacity-40 cursor-not-allowed"
              )}
            >
              <ClipboardList className="h-4 w-4 text-[var(--icon-action)]" />
            </button>
          </div>
        </div>

        {/* Session list: expanded */}
        <div className={cn("flex-1 overflow-y-auto", sidebarCollapsed && "hidden")}>
          <button
            type="button"
            onClick={() => setRegularSessionsOpen((open) => !open)}
            className="flex h-8 w-full items-center gap-2 border-y border-border/20 bg-[var(--color-layer-1)] px-3 text-[11px] font-medium text-muted-foreground"
          >
            <span className="pl-2">{t("sessions.regularConversations")}</span>
            <span className="tabular-nums">({displaySessions.length})</span>
            <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground">
              {regularSessionsOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </span>
          </button>
          {regularSessionsOpen && displaySessions.map((session) => {
            const isActive = session.id === selectedSession;
            const name = sessionNames?.[session.id] || session.display_name || session.id.slice(0, 8);
            const timeStr = session.last_active
              ? formatRelativeTime(session.last_active, t)
              : session.started_at
                ? formatRelativeTime(session.started_at, t)
                : null;
            const searchHit = searchResults.find((r: SessionSearchResult) => r.sessionId === session.id);
            return (
              <ContextMenu key={session.id}>
                <ContextMenuTrigger asChild>
                  <button
                    onClick={() => handleSelectSession(session.id)}
                    className={cn(
                      "flex flex-col w-full items-start pl-5 pr-2 py-2 text-xs transition-fast border-b border-border/10",
                      isActive
                        ? "bg-primary/10 text-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                    )}
                  >
                    <div className="flex items-center gap-3 w-full">
                      <MessageSquare className="h-3 w-3 shrink-0 text-[var(--icon-message)]" />
                      <span className="truncate flex-1 text-left min-w-0 leading-none pt-[1px]">{name}</span>
                      {searchHit ? (
                        <span className="shrink-0 rounded-full bg-primary/20 text-primary px-1.5 py-0.5 text-[9px] font-medium leading-none">
                          {searchHit.matchCount}
                        </span>
                      ) : timeStr ? (
                        <span className={cn(
                          "text-[0.65em] shrink-0 tabular-nums",
                          isActive ? "text-accent-foreground/40" : "text-muted-foreground/40"
                        )}>{timeStr}</span>
                      ) : null}
                    </div>
                    {searchHit && searchHit.previewText && (
                      <div className="mt-1.5 pl-6 w-full text-left">
                        <p className="text-[10px] text-muted-foreground/70 line-clamp-2 leading-tight break-all">
                          {searchHit.previewText}
                        </p>
                      </div>
                    )}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => handleFloatSession(session.id)}>
                    <PictureInPicture2 className="h-3.5 w-3.5 mr-2" />
                    {t("sessions.float", "悬浮窗口")}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleResumeSession(session.id)}>
                    <TerminalIcon className="h-3.5 w-3.5 mr-2" />
                    {t("sessions.openTerminal")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => { handleSelectSession(session.id); setRenameOpen(true); }}>
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    {t("sessions.rename")}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleRefreshMessages()}>
                    <RotateCw className="h-3.5 w-3.5 mr-2" />
                    {t("sessions.refresh")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          <TaskSessionTree
            tasks={displayTaskLaunchSessions}
            activeTaskId={activeTaskInstanceId}
            activeNodeId={activeTaskInstanceId ? taskSelectedNodeId : null}
            titleByNodeId={activeTaskNodeTitles}
            onSelectTask={(task) => {
              // 树的 TaskSessionTreeTask 是 TaskLaunchInstanceSummary 的结构子集，
              // 回传时按 task_id 反查完整实例（openTaskPhaseWorkspace 需要 project_root 等字段）。
              const instance = findTaskInstance(task.task_id);
              if (!instance) return;
              const phase: TaskPhase =
                instance.current_phase === "planning"
                  ? "planning"
                  : instance.current_phase === "execution" || instance.current_phase === "graph"
                    ? "execution"
                    : "requirements";
              openTaskPhaseWorkspace(instance, phase);
            }}
            onSelectNode={(task, node) => {
              const instance = findTaskInstance(task.task_id);
              if (!instance) return;
              // 若目标任务尚未激活，先进任务执行 workspace（会重置 selectedNodeId），
              // 随后指定目标节点，TaskSidebar 收到受控 prop 后自行拉取节点会话并高亮。
              // 若任务已激活（含再次点击当前节点），直接切节点，不再调 openTaskPhaseWorkspace，
              // 避免重复清空 selectedNodeId 引起节点会话→任务主会话的闪烁/竞态
              //（v0.7.0 需求二-问题2：节点选中后再次点击变任务选中效果）。
              if (activeTaskInstanceIdRef.current !== task.task_id || !taskModeActive) {
                openTaskPhaseWorkspace(instance, "execution");
              }
              // v0.7.0 需求二-问题3：统一走 handleTaskSelectNode，立即切 pending-node
              // 占位，避免新节点 session_id 回填前主区显示上一个节点的会话。
              handleTaskSelectNode(node.node_id);
            }}
            onRenameTask={(task) => setRenameTaskTarget(findTaskInstance(task.task_id))}
            onDeleteTask={async (task) => {
              if (!projectPathForSettings) return;
              const confirmed = await confirmDialog({
                title: t("tasks.deleteTask"),
                description: t("tasks.deleteTaskConfirm", { title: task.title }),
                variant: "destructive",
              });
              if (!confirmed) return;
              if (task.graph_id) {
                await invokeCommand("orchestrator_delete_graph", { graphId: task.graph_id });
              }
              await invokeCommand("task_launch_delete_task", {
                projectRoot: projectPathForSettings,
                taskId: task.task_id,
              });
              setTaskLaunchSessions((current) => current.filter((item) => item.task_id !== task.task_id));
            }}
          />
        </div>

        {/* Collapsed: empty body */}
        <div className={cn("flex-1", !sidebarCollapsed && "hidden")} />
      </div>

      {/* Right: Chat area */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {/* 新建任务对话（TaskInstance 尚未创建）的顶栏：标题 + 关闭。
            减法重构：TaskHeaderBar 已随 TaskWorkspace 退役，这里用内联顶栏保留关闭能力，
            不引入独立组件；任务激活后主区沿用 chat-page 常规会话头。 */}
        {projectId && taskLaunchOpen && !taskModeActive ? (
          <div
            className="flex items-center justify-between px-5 h-[44px] border-b border-border/30"
            style={{ background: "var(--color-layer-1)" }}
          >
            <span className="font-medium text-sm truncate">
              {activeTaskLaunchInstance?.title ?? t("tasks.startTask", "新任务")}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                logTaskPhaseDebug("launch-nav:close", {
                  taskId: activeTaskInstanceIdRef.current,
                  activePhase: taskLaunchPhaseRef.current,
                  status: activeTaskLaunchInstance?.status ?? null,
                });
                setTaskLaunchOpen(false);
                setTaskLaunchReadOnly(false);
                taskLaunchOpenRef.current = false;
                setActiveTaskInstanceId(null);
                setActiveTaskRequirementFile(null);
                activeTaskInstanceIdRef.current = null;
                activeTaskRequirementFileRef.current = null;
                lastKnownStatusRef.current = null;
              }}
              title={t("common.close", "关闭")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
        {!projectId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center">
              <MessageSquare className="h-7 w-7 text-[var(--icon-message)]" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm">{t("sessions.noProject")}</span>
              <button
                onClick={onSwitchProject}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-primary hover:bg-primary/10 transition-fast font-medium"
              >
                <span className="leading-none pt-[1px]">{t("sessions.switchProject")}</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : showStartComposer ? (
          // Start-composer view: the heading + centered ChatInput are rendered
          // in the unified ChatInput block below (kept in ONE React element
          // position across start-composer and active-session views so the
          // ChatInput instance — and its stagedMessagesBySession state — is
          // preserved across session switches). This branch collapses the
          // message area so the unified block can take flex-1 and center.
          <div className="hidden" />
        ) : (
          <>
            {!taskLaunchOpen ? (
              <>
            {/* Session header */}
            {selectedSession && selectedSession !== "new" ? (
              <div className="flex items-center justify-between px-5 h-[44px] border-b border-border/30" style={{ background: "var(--color-layer-1)" }}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-sm truncate">{nodeHeaderTitle}</span>
                  <span className="text-[11px] text-muted-foreground/50 font-mono shrink-0">{selectedSession.slice(0, 8)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleFloatSession(selectedSession)}
                    title={t("sessions.float", "悬浮窗口")}
                  >
                    <PictureInPicture2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleRefreshMessages}
                    disabled={Boolean(currentStream)}
                    title={currentStream ? t("sessions.refreshDisabledWhileStreaming") : t("sessions.refresh")}
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleResumeSession(selectedSession)}
                    disabled={loadingSessionId === selectedSession}
                    title={t("sessions.openTerminal")}
                  >
                    <TerminalIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-xs" onClick={() => setRenameOpen(true)} title={t("sessions.rename")}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="px-5 h-[44px] flex items-center border-b border-border/30" style={{ background: "var(--color-layer-1)" }}>
                <span className="font-medium text-sm text-muted-foreground">{t("sessions.newChat")}</span>
              </div>
            )}
              </>
            ) : null}
              {/* Messages */}
              <div className="relative flex-1 min-h-0">
                <div ref={messageAreaRef} className="h-full overflow-y-auto">
                {taskSelectedNodeNotStarted ? (
                  // 选中的步骤还没执行过——直接说明，而不是把上一段会话继续摆在这里。
                  <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-8 text-center text-[12px] text-muted-foreground">
                    {t("task.execution.nodeNotStarted")}
                  </div>
                ) : taskSelectedNodeStarting ? (
                  // v0.7.0 需求二-问题3：节点正在执行但会话尚未建立（session_id 待 Pi RPC 回填）。
                  // 显示占位而非主流程会话，避免节点会话和主流程混在一起。
                  <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 py-8 text-center text-[12px] text-muted-foreground">
                    {t("task.execution.nodeStarting")}
                  </div>
                ) : selectedSession && selectedSession !== "new" ? (
                  <MessageView
                    messages={sessionMessages}
                    searchQuery={searchQuery}
                    searchNavigation={messageSearchNavigation}
                    onSearchStatusChange={handleMessageSearchStatusChange}
                    flat
                    scrollContainerRef={messageAreaRef}
                  />
                ) : null}
                {/* T8-P1 三段合流（需求六）：执行阶段不是独立页面，而是在上方 conductor 会话
                    （需求 + 规划）末尾接一条「流程执行」分隔线，再往下追加执行内容——
                    未启动时是「是否开始执行」确认卡，已启动后是 run 事件流。 */}
                {taskExecutionMode ? (
                  <>
                    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4">
                      <PhaseDivider phase="execute" title={t("task.phase.execution", "流程执行")} />
                    </div>
                    {taskRunStarted ? (
                      <MessageView messages={taskGraph.projectedMessages} flat />
                    ) : showExecutionStartPrompt ? (
                      <ExecutionStartPrompt
                        stepCount={taskStepCount}
                        canStart={Boolean(taskGraph.revision?.revision_id)}
                        starting={execStarting}
                        error={execStartError}
                        onStart={handleStartExecutionFromChat}
                        onDismiss={() =>
                          setExecPromptDismissedTaskId(activeTaskLaunchInstance?.task_id ?? null)
                        }
                      />
                    ) : (
                      <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 pb-2 text-[12px] text-muted-foreground">
                        {t(
                          "task.execution.awaitingStart",
                          "流程尚未开始。可继续在下方对话中调整流程，或在右侧步骤栏点击「开始执行」。",
                        )}
                      </div>
                    )}
                  </>
                ) : null}
                {/* Only show StreamingMessage while the stream is active.
                    Once isStreaming flips to false the turn is complete and the
                    committed messages are already rendered by MessageView above —
                    keeping the streaming preview would duplicate interaction cards
                    and other content. */}
                {currentStream?.isStreaming && selectedSession && selectedSession !== "new" && !taskSelectedNodeNotStarted && (
                  <StreamingMessage
                    key={selectedSession}
                    sessionId={selectedSession}
                    isComplete={false}
                    scrollContainerRef={messageAreaRef}
                  />
                )}
              {/* Live placeholders for guided (steer) messages that have NOT
                  yet been injected. Shown the instant the user clicks "guide",
                  positioned AFTER the streaming bubble so they sit at the guide
                  position (below the in-progress reply). Once Pi delivers a
                  steer at a tool-call gap (steer_injected marker) it is rendered
                  INLINE inside <StreamingMessage> (via steerTexts) at its real
                  split position, so we drop it from this bottom block to avoid
                  showing it twice — `steerTexts.length` guides have moved
                  inline. The remaining (not-yet-injected) guides stay here until
                  the turn completes, at which point turn_complete commits them
                  into sessionMessages and drops them from this list. */}
                {(() => {
                if (!selectedSession || selectedSession === "new") return null;
                const steerInjectedCount = currentStream?.steerTexts?.length ?? 0;
                const visible = pendingSteerDisplay.slice(steerInjectedCount);
                if (visible.length === 0) return null;
                return (
                  <div className="mx-auto w-full max-w-[var(--message-content-max-width)] space-y-2 px-4 py-1">
                    {visible.map((msg, i) => {
                      const text = msg.content.find((c) => c.type === "text")?.text ?? "";
                      return (
                        <div
                          key={`pending-steer-${steerInjectedCount + i}`}
                          className="w-full flex justify-end"
                          data-user-message="true"
                        >
                          <div className="max-w-[88%] min-w-0 flex flex-col items-end">
                            <div className="flex items-center gap-2 mb-0.5 text-[11px]">
                              <span className="font-medium text-muted-foreground">{t("sessions.user")}</span>
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-500">
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                {t("sessions.steered")}
                              </span>
                            </div>
                            <div
                              className="rounded-xl px-3 py-2 bg-[var(--message-user-bg)] text-[var(--message-user-fg)] whitespace-pre-wrap break-all overflow-hidden min-w-0 max-w-full"
                              style={{ fontSize: "var(--font-size-prose)" }}
                            >
                              {text}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
                </div>
                {isUserMessageAbove ? (
                  <button
                    onClick={handleScrollToPreviousUserMessage}
                    className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border/40 bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-all hover:bg-accent hover:text-foreground hover:border-border/60 hover:shadow-md opacity-60 hover:opacity-100"
                    title={t("sessions.scrollToPreviousUserMessage")}
                  >
                    <ChevronUp className="h-4 w-4" strokeWidth={2.5} />
                  </button>
                ) : null}
              </div>
          </>
        )}
        {/* Unified ChatInput — rendered in ONE React element position across
            the start-composer view and the active-session view. Keeping the
            component instance stable (same parent, same child slot, no key)
            preserves its stagedMessagesBySession state across session switches;
            previously two separate <ChatInput> instances in mutually-exclusive
            branches unmounted/remounted on switch, losing staged guides.
            Layout adapts via conditional
            sibling elements + className — ChatInput itself never moves. */}
        {/* T8-P1：执行阶段**不再**隐藏输入——用户需要能在会话区让主进程调整流程（需求六）。
            仅当任务模式下确实没有可发送目标时才隐藏：没有 conductor 会话，或选中的步骤
            还没跑过（此时发消息会落到上一段会话，属于误发）。 */}
        {shouldRenderGlobalChatInput({
          projectId,
          taskModeActive: taskModeActive && (!selectedSession || taskSelectedNodeNotStarted),
        }) && (
          <div className={showStartComposer
            ? "flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10"
            : "relative shrink-0"
          }>
            {showStartComposer ? (
              <h1 className="mb-14 w-full max-w-[var(--message-content-max-width)] text-center text-[2rem] font-medium leading-tight tracking-normal text-foreground">
                {taskLaunchOpen
                  ? t("tasks.createPrompt", { project: projectDisplayName })
                  : t("sessions.startPrompt", { project: projectDisplayName })}
              </h1>
            ) : isAwayFromBottom ? (
              <button
                onClick={handleScrollToBottom}
                className="absolute -top-10 left-1/2 -translate-x-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border/40 bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-all hover:bg-accent hover:text-foreground hover:border-border/60 hover:shadow-md opacity-60 hover:opacity-100"
                title={t("sessions.scrollToBottom", "滚动到底部")}
              >
                <ChevronDown className="h-4 w-4" strokeWidth={2.5} />
              </button>
            ) : null}
            <ChatInput
              ref={chatInputRef}
              sessionId={selectedSession === "new" ? null : selectedSession}
              projectPath={currentProject?.path ?? null}
              agentId={activeId}
              stagedApiRef={stagedApiRef}
              onMessageSent={handleMessageSent}
              onSessionResolved={handleSessionResolved}
              onBeforeSend={handleTaskLaunchBeforeSend}
              prepareMessageForAgent={prepareTaskLaunchMessage}
              allowFiles={capabilities ? (capabilities.has("FILE_INPUT") || capabilities.has("IMAGE_INPUT")) : true}
              agentDisplayName={active?.display_name}
              disabled={taskLaunchOpen && (!taskModeCanSend || taskLaunchReadOnly)}
              initialDraft={getSessionDraft(draftSessionKey)}
              historyScope={projectId}
              onDraftChange={(v) => setSessionDraft(draftSessionKey, v)}
              slashCommands={slashCommands}
              trailingControls={modelTrailingControls}
              onSlashCommand={handleSlashCommand}
              containerClassName={showStartComposer ? "mx-auto w-full max-w-[var(--message-content-max-width)] px-0 pb-0 pt-0" : undefined}
              panelClassName={showStartComposer ? "rounded-[22px] border-border/70 bg-card/98 shadow-[0_18px_48px_rgba(0,0,0,0.10)]" : undefined}
              contextFooter={startComposerFooter}
              workModeLabel={t("sessions.workMode.label")}
              workModeOptions={workModeOptions}
              workModeValue={taskLaunchOpen ? "task" : "chat"}
              onWorkModeChange={handleWorkModeChange}
              accessModeLabel={accessModeLabel}
              accessModeTitle={supportsAccessModeSwitch ? t("sessions.accessMode") : t("sessions.accessModeReadOnly")}
              accessModeReadOnly={!supportsAccessModeSwitch}
              accessModeOptions={accessModeOptions}
              accessModeValue={accessModeValue}
              onAccessModeChange={handleAccessModeChange}
              interactionRequest={activeInteraction?.request}
              onInteractionSubmit={handleInteractionSubmit}
              onAbort={async () => {
                if (selectedSession) {
                  const state = streamStore.getState(selectedSession);
                  const finalKey = state?.resolvedId ?? selectedSession;
                  if (state) {
                    const newMessages: Message[] = [];
                    if (state.pendingUserMessage) {
                      newMessages.push({
                        role: "user",
                        content: [{ type: "text", text: state.pendingUserMessage }],
                        timestamp: Date.now(),
                      });
                    }
                    const assistantContent = buildAssistantContentFromStreamState(state);
                    const interactionInsertions = buildInteractionInsertions({
                      assistantContent,
                      interactionSplits: state.interactionSplits,
                      includePending: true,
                    });
                    const committed = commitAssistantWithInteractions({
                      assistantContent,
                      interactionInsertions,
                      error: state.error,
                    });
                    newMessages.push(...committed.messages);

                    if (newMessages.length > 0) {
                      const baseMessages =
                        sessionMessagesCacheRef.current.get(finalKey)
                        ?? sessionMessagesCacheRef.current.get(selectedSession)
                        ?? [];
                      const updated = [...baseMessages, ...newMessages];
                      sessionMessagesCacheRef.current.set(finalKey, updated);
                      if (selectedSession !== finalKey) {
                        sessionMessagesCacheRef.current.set(selectedSession, updated);
                      }
                      setSessionMessages(updated);
                    }

                    if (interactionInsertions.length > 0) {
                      const sessionList = sessionsRef.current;
                      const sessionPath = sessionList?.find(s => s.id === finalKey)?.path
                        ?? sessionList?.find(s => s.id === selectedSession)?.path
                        ?? "";
                      invokeCommand("persist_interaction_blocks", {
                        agentId: activeId ?? "",
                        sessionPath,
                        sessionId: finalKey,
                        encodedName: projectId,
                        interactions: interactionInsertions.map((ins: InteractionInsertion) => ({
                          index: ins.index,
                          request_id: ins.requestId ?? null,
                          prompt: ins.prompt,
                          options: ins.options,
                          answer: ins.answer,
                          selected_options: ins.selectedOptions ?? [],
                          origin: ins.origin ?? null,
                        })),
                      }).catch((err: unknown) => {
                        console.warn("Failed to persist interaction blocks after abort:", err);
                      });
                    }

                    // Persist the in-progress assistant text/thinking of this
                    // aborted turn so it survives a refresh (twin of the call
                    // in the turn_complete(Aborted) handler). Idempotent on the
                    // backend, so the two racing paths never double-write.
                    if (state.text || state.thinking) {
                      const sessionList = sessionsRef.current;
                      const partialSessionPath = sessionList?.find(s => s.id === finalKey)?.path
                        ?? sessionList?.find(s => s.id === selectedSession)?.path
                        ?? "";
                      invokeCommand("persist_partial_assistant", {
                        agentId: activeId ?? "",
                        sessionPath: partialSessionPath,
                        sessionId: finalKey,
                        encodedName: projectId,
                        text: state.text,
                        thinking: state.thinking,
                      }).catch((err: unknown) => {
                        console.warn("Failed to persist partial assistant after abort:", err);
                      });
                    }
                  }

                  setPendingInteractions((current) =>
                    current.filter((item) => item.sessionId !== selectedSession),
                  );
                  if (
                    !state
                    && !sessionMessagesCacheRef.current.has(selectedSession)
                  ) {
                    // A null `state` here means the abort-originated
                    // turn_complete (e.g. Claude Code's ACP cancel, which races
                    // this callback) already committed the turn's content from
                    // the stream state and dropped it — so the cache (and thus
                    // sessionMessages) is already authoritative and complete.
                    // Re-fetching from the backend would clobber that with JSONL
                    // that lags the live stream for a cancelled turn, visibly
                    // rolling back already-shown content (Claude-Code-specific).
                    // The aborted-turn turn_complete commit (which now uses
                    // includePending, covering pending interactions) is the
                    // source of truth, so we only fall back to the backend when
                    // we genuinely have nothing cached for this session.
                    try {
                      const msgs = await invokeCommand<Message[]>("get_session_messages", {
                        agentId: activeId ?? "",
                        sessionId: selectedSession,
                        encodedName: projectId,
                      });
                      const visibleMessages = stripTaskLaunchInstructionFromMessages(msgs);
                      sessionMessagesCacheRef.current.set(selectedSession, visibleMessages);
                      setSessionMessages(visibleMessages);
                    } catch (e) {
                      console.error("Failed to refresh messages after abort", e);
                    }
                  }
                }
              }}
              onGuideStaged={async (content: string) => {
                if (!selectedSession || selectedSession === "new") return;
                // Pi-RPC delivers the guide as a real mid-turn injection
                // (steer_chat + steer_injected event). ACP (claude-code) has no
                // mid-turn steer — steer_chat just queues a follow-up prompt and
                // never injects — so skip it; the guide still queues below and
                // becomes a real message when the user stops or the reply
                // completes (Route 2 / turn_complete commit).
                if (supportsSteer) {
                  await invokeCommand("steer_chat", {
                    sessionId: selectedSession,
                    message: content,
                  });
                }
                // Queue for commit at turn_complete AND show live now.
                // Rendered after the streaming bubble (see pendingSteerDisplay
                // below) so it sits below the in-progress reply; committed into
                // sessionMessages between that reply and the guide's response
                // when the turn completes (or sent by Route 2 if it wasn't a
                // real mid-turn injection).
                const key = selectedSession;
                const existing = pendingSteerMessagesRef.current.get(key) ?? [];
                pendingSteerMessagesRef.current.set(key, [...existing, content]);
                setPendingSteerDisplay((prev) => [
                  ...prev,
                  {
                    role: "user",
                    content: [{ type: "text", text: content }],
                    timestamp: Date.now(),
                  },
                ]);
              }}
            />
          </div>
        )}
      </div>

      {/* 任务模式：右侧任务侧边栏。减法重构——唯一区别于普通会话页的组件；
          主会话区（上方 MessageView/ChatInput）原样复用 chat-page，不做任何复制。
          P4a：仅执行阶段显示；P4c：可被「隐藏步骤栏」收起。 */}
      {taskModeActive && activeTaskLaunchInstance?.current_phase === "execution" && !taskSidebarHidden ? (
        <TaskSidebar
          taskId={activeTaskLaunchInstance.task_id}
          projectPath={currentProject?.path ?? ""}
          instance={activeTaskLaunchInstance}
          taskGraph={taskGraph}
          agents={agents.map((agent) => ({ id: agent.id, display_name: agent.display_name }))}
          agentsLoading={healthLoading && agents.length === 0}
          selectedNodeId={taskSelectedNodeId}
          onSelectNode={handleTaskSelectNode}
          onNodeSessionChange={handleTaskNodeSessionChange}
          onHide={() => setTaskSidebarHidden(true)}
        />
      ) : null}

      {/* P4c + T8-P8：侧边栏被隐藏后，渲染停靠在布局里的 40px 折叠栏
          （展开按钮 + 进度点阵），而非浮层按钮——浮层易被输入区遮挡、易误认为缺失。 */}
      {taskModeActive && activeTaskLaunchInstance?.current_phase === "execution" && taskSidebarHidden ? (
        <div className="flex h-full w-10 shrink-0 flex-col items-center gap-2 border-l border-border/30 bg-background py-2">
          <button
            type="button"
            onClick={() => setTaskSidebarHidden(false)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("task.steps.show", "显示步骤栏")}
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
          {/* 进度点阵：折叠态仍可见各节点状态（goal 节点排除）。 */}
          <div className="mt-1 flex flex-1 flex-col items-center gap-1 overflow-hidden">
            {(taskGraph.snapshot?.nodes ?? [])
              .filter((n) => n.node_kind !== "goal")
              .map((n) => {
                const status = taskGraph.nodeRuns[n.node_id]?.status;
                const dot =
                  status === "succeeded" || status === "skipped"
                    ? "bg-emerald-500"
                    : status === "failed"
                      ? "bg-red-500"
                      : status === "running"
                        ? "bg-primary animate-pulse"
                        : "bg-muted-foreground/30";
                return (
                  <span
                    key={n.node_id}
                    className={`h-1.5 w-1.5 rounded-full ${dot}`}
                    title={n.title}
                  />
                );
              })}
          </div>
        </div>
      ) : null}

      <RenameSessionDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        sessionId={selectedSession ?? ""}
        currentName={displayName}
        onRenamed={refetchNames}
      />
      <RenameTaskSessionDialog
        open={renameTaskTarget !== null}
        onOpenChange={(open) => { if (!open) setRenameTaskTarget(null); }}
        currentName={renameTaskTarget?.title ?? ""}
        onSubmit={async (name) => {
          if (!renameTaskTarget || !projectPathForSettings) return;
          try {
            const updated = await invokeCommand<TaskLaunchInstanceSummary>("task_launch_rename_task", {
              projectRoot: projectPathForSettings,
              taskId: renameTaskTarget.task_id,
              title: name,
            });
            setTaskLaunchSessions((current) => current.map((item) => item.task_id === updated.task_id ? updated : item));
          } catch (error) {
            void alertDialog({ title: "重命名失败", description: `重命名失败：${String(error)}` });
          }
        }}
      />
      {confirmDialogNode}
      <Dialog
        open={Boolean(activeApproval)}
        onOpenChange={(open) => {
          if (!open && activeApproval && !approvalResolving) {
            void resolveActiveApproval(false);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("sessions.permissionTitle")}</DialogTitle>
            <DialogDescription>
              {t("sessions.permissionDescription", {
                kind: activeApproval?.approvalKind ?? "other",
              })}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-72 overflow-auto rounded-md border border-border/60 bg-muted/50 p-3 text-xs whitespace-pre-wrap break-all">
            {JSON.stringify(activeApproval?.payload ?? {}, null, 2)}
          </pre>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={approvalResolving}
              onClick={() => void resolveActiveApproval(false)}
            >
              {t("sessions.permissionReject")}
            </Button>
            <Button
              disabled={approvalResolving}
              onClick={() => void resolveActiveApproval(true)}
            >
              {approvalResolving
                ? t("sessions.permissionResolving")
                : t("sessions.permissionApprove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

