import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useDeferredValue, lazy, Suspense } from "react";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import {
  streamStore,
  useSessionStream,
  type SessionStreamState,
} from "@/hooks/use-stream-store";
import { MessageView, type MessageSearchNavigation, type MessageSearchStatus } from "@/components/sessions/message-view";
import { RenameSessionDialog } from "@/components/sessions/rename-session-dialog";
import { RenameTaskSessionDialog } from "@/components/sessions/rename-task-session-dialog";
import { ChatInput, type StagedGuideApi } from "@/components/sessions/chat-input";
import { StreamingMessage } from "@/components/sessions/streaming-message";
import { clearImageCache } from "@/components/sessions/inline-image";
import { StatusBar as ObservabilityStatusBar } from "@/components/observability";
// 三阶段任务容器：动态加载，不膨胀 chat-page 初始 bundle。
// 设计依据：任务入口与容器架构设计_20260622.md §2.1、§2.4。
const TaskPhaseContainer = lazy(() =>
  import("@/features/task-instance/task-phase-container").then((m) => ({ default: m.default })),
);
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
import {
  HardDrive, MessageSquare, Search, X, Pencil, RotateCw, FolderOpen, SquarePen, ClipboardList, PanelLeftClose, PanelLeftOpen, ArrowRight, ChevronUp, ChevronDown, ChevronRight, PictureInPicture2,
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
import { AgentLogo, useAgent } from "@/agents";
import { logTaskPhaseDebug } from "@/features/task-instance/task-phase-debug";
import { TaskPhaseNavBar } from "@/features/task-instance/task-phase-nav-bar";
import { shouldRenderGlobalChatInput } from "./chat-page-layout";
import {
  deriveAllPhaseStates,
  taskInstanceFromRaw,
  type PhaseDisplayStates,
  type TaskPhase,
} from "@/features/task-instance/types";
import type {
  AgentEventPayload,
  ContentBlock,
  ConversationInteractionRequest,
  ConversationInteractionSubmission,
  InteractionResponseDto,
  Message,
  Project,
  ProjectMeta,
  ProjectSettings,
  Session,
  SessionSearchResult,
} from "@/types";

function TerminalIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="3" width="20" height="18" rx="3" />
      <polyline points="7 10 10 13 7 16" />
      <line x1="13" y1="16" x2="17" y2="16" />
    </svg>
  );
}

function buildAssistantContentFromStreamState(state: SessionStreamState | null | undefined): ContentBlock[] {
  if (!state) return [];
  if (state.content.length > 0) return [...state.content];

  const assistantContent: ContentBlock[] = [];
  if (state.thinking) assistantContent.push({ type: "thinking", thinking: state.thinking });
  state.tools.forEach((tool, idx) => {
    const id = tool.id || `stream-${idx}-${tool.name}`;
    assistantContent.push({
      type: "tool_use",
      id,
      name: tool.name,
      input: tool.input,
    });
    if (tool.output !== undefined) {
      assistantContent.push({
        type: "tool_result",
        tool_use_id: id,
        content: tool.output,
      });
    }
  });
  if (state.text) assistantContent.push({ type: "text", text: state.text });
  return assistantContent;
}

function formatRelativeTime(
  date: Date | string,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t("time.justNow");
  if (diffMin < 60) return t("time.minutesAgo", { count: String(diffMin) });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("time.hoursAgo", { count: String(diffHr) });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return t("time.daysAgo", { count: String(diffDay) });
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function uniqueSessionsById(items: Session[]): Session[] {
  const seen = new Set<string>();
  const unique: Session[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function extractRealSessionId(data: unknown): string | null {
  const obj = data as Record<string, unknown> | null;
  if (!obj) return null;
  if (obj.kind === "session_resolved") {
    const normalizedSid = obj.session_id;
    if (typeof normalizedSid === "string" && normalizedSid.length >= 8) {
      return normalizedSid;
    }
  }
  const sid = obj.session_id;
  if (typeof sid === "string" && !sid.startsWith("pending-") && !sid.startsWith("new_session_") && sid.length >= 8) {
    return sid;
  }
  return null;
}

interface PendingChatApproval {
  sessionId: string;
  requestId: string;
  approvalKind: string;
  payload: unknown;
}

interface PendingChatInteraction {
  agentId: string;
  sessionId: string;
  request: ConversationInteractionRequest;
}

type TaskLaunchPhase = "requirements" | "planning";

// 三阶段顺序（graph 视同 execution 级），用于「阶段标签自动跟随」判定 current_phase
// 是否前进。conductor 在 turn 内调 conductor_sync_phase 推进 current_phase。
const PHASE_LAUNCH_RANK: Record<string, number> = {
  requirements: 0,
  planning: 1,
  execution: 2,
  graph: 2,
};

interface TaskLaunchInstanceSummary {
  task_id: string;
  project_root: string;
  title: string;
  skill_id: string;
  planner_agent_id?: string;
  status: string;
  current_phase: string;
  requirement_file?: string | null;
  requirement_session_id?: string | null;
  planning_session_id?: string | null;
  graph_id?: string | null;
  active_run_id?: string | null;
  last_run_id?: string | null;
  run_status?: string | null;
  created_at: number;
  updated_at: number;
}

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
  const { agents, activeId, active, capabilities, setActive, healthLoading } = useAgent();
  const projectId = currentProject?.encoded_name ?? null;
  const projectPathForSettings = currentProject?.path ?? null;
  const supportsModelPicker = active?.config_surface.kind === "model_store"
    ? (active.config_surface.supports_picker ?? false)
    : false;
  const projectSettingsSurface = active?.project_settings_surface;
  const supportsAccessModeSwitch = projectSettingsSurface?.kind === "supported"
    && projectSettingsSurface.scopes.includes("local")
    && projectSettingsSurface.access_modes.length > 0;

  // Mid-turn steer (inject guidance without stopping output) is only possible
  // for agents running a persistent Pi-RPC connection: that runtime delivers
  // the steer as a real mid-turn injection and emits a `steer_injected` event
  // so the UI can interleave the guide at its real position. ACP (claude-code
  // / acp_preferred) has NO mid-turn steer — its `steer_chat` just queues a
  // follow-up prompt for the next turn and never emits `steer_injected`, so
  // the steer UI path (optimistic bubble + turn_complete commit) never fires
  // and the guide is lost. For ACP, guide must fall back to stop+send
  // (handled by chat-input.tsx's default path), which matches ACP's actual
  // "steer = new prompt" semantics.
  const supportsSteer = active?.transport === "pi_rpc";
  // Fresh mirror for the mount-only agent-event listener (whose useEffect deps
  // are [], so it closes over a stale `supportsSteer`). Updated every render.
  const supportsSteerRef = useRef(supportsSteer);
  supportsSteerRef.current = supportsSteer;

  // selectedSession: null or real backend UUID — never fake IDs
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
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
  const [taskContainerTaskId, setTaskContainerTaskId] = useState<string | null>(null);
  const [taskContainerPhase, setTaskContainerPhase] = useState<TaskPhase>("requirements");
  const [taskContainerReadOnly, setTaskContainerReadOnly] = useState(false);
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
  const [taskSessionsOpen, setTaskSessionsOpen] = useState(true);
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
        ),
        invokeCommand<{ provider: string; model: string } | null>("get_active"),
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
  // 进入任务模式需切到 Jishu Agent 时置 true：阻止 activeId 变化触发的清理 effect 重置任务模式状态
  const enteringTaskModeRef = useRef(false);
  const activeTaskRequirementFileRef = useRef<string | null>(activeTaskRequirementFile);
  const selectedTaskSkillIdRef = useRef(selectedTaskSkillId);
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

  const fileToolCount = useMemo(() => {
    return sessionMessages.reduce((count, msg) => (
      count + msg.content.filter((block) => {
        if (block.type !== "tool_use") return false;
        const name = block.name.toLowerCase();
        return name.includes("read") || name.includes("edit") || name.includes("write");
      }).length
    ), 0);
  }, [sessionMessages]);

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
    projectId ? "list_sessions" : "",
    projectId ? { encodedName: projectId } : undefined,
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
  const taskLaunchPhaseStates = useMemo<PhaseDisplayStates>(() => {
    if (!activeTaskLaunchInstance) {
      return {
        requirements: taskLaunchPhase === "requirements" ? "active" : "done",
        planning: taskLaunchPhase === "planning" ? "active" : "pending",
        execution: "pending",
      };
    }
    return deriveAllPhaseStates(taskInstanceFromRaw({
      ...activeTaskLaunchInstance,
      planner_agent_id: activeTaskLaunchInstance.planner_agent_id ?? "jishu_agent",
    }));
  }, [activeTaskLaunchInstance, taskLaunchPhase]);
  const [accessRefreshKey, setAccessRefreshKey] = useState(0);
  const { data: projectSettings } = useInvoke<ProjectSettings>(
    supportsAccessModeSwitch && projectPathForSettings ? "load_project_settings_local" : "",
    supportsAccessModeSwitch && projectPathForSettings ? { projectPath: projectPathForSettings } : undefined,
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
    setTaskContainerReadOnly(false);
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
    setTaskContainerReadOnly(false);
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
    await invokeCommand("save_project_settings_local", { projectPath: projectPathForSettings, settings: nextSettings });
    setAccessRefreshKey(Date.now());
  }, [projectPathForSettings, projectSettings, supportsAccessModeSwitch]);

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
      // 标记本次切换是为进入任务模式，阻止上面的清理 effect 重置任务模式状态
      enteringTaskModeRef.current = true;
      setActive("jishu-self").catch((error) => {
        console.warn("Failed to switch to Jishu Agent for task mode:", error);
        enteringTaskModeRef.current = false;
      });
    }
  }, [activeId, agents.length, setActive, taskLaunchOpen, taskModeAgentReady]);

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
    setTaskContainerReadOnly(false);
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
    // 确认切换后主动切到 Jishu Agent（enteringTaskModeRef 已置，清理 effect 会跳过任务模式重置）
    if (nextIsTask && activeId !== "jishu-self") {
      setActive("jishu-self").catch((error) => {
        console.warn("Failed to switch to Jishu Agent for task mode:", error);
        enteringTaskModeRef.current = false;
      });
    }
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  }, [activeId, taskModeAgentReady, setActive]);

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
    setTaskContainerReadOnly(false);
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

  const handleNewSession = async () => {
    if (!projectId) return;

    setTaskModeActive(false);
    setTaskContainerReadOnly(false);
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
    setTaskContainerReadOnly(false);
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
        projectPath: cwd,
        resumeSessionId: sessionId,
      });
      await invokeCommand("register_terminal_session", {
        sessionId, pid, projectPath: cwd,
        agentId: activeId,
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

  const openTaskChatPhase = useCallback(async (
    taskSession: TaskLaunchInstanceSummary,
    phase: Exclude<TaskPhase, "execution">,
    readOnly = false,
  ) => {
    const sessionId = phase === "planning"
      ? taskSession.planning_session_id
      : taskSession.requirement_session_id;
    logTaskPhaseDebug("chat-phase:open", {
      taskId: taskSession.task_id,
      phase,
      readOnly,
      sessionId,
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
    selectedTaskSkillIdRef.current = taskSession.skill_id || "jishu-conductor-dev";
    lastKnownStatusRef.current = taskSession.status;
    setTaskModeActive(false);
    setTaskContainerReadOnly(false);
    setTaskLaunchOpen(true);
    setTaskLaunchReadOnly(readOnly);
    setTaskLaunchPhase(phase);
    taskLaunchOpenRef.current = true;
    taskLaunchPhaseRef.current = phase;
    setPendingSteerDisplay([]);

    if (!sessionId || !projectId) {
      setSelectedSession("new");
      selectedSessionRef.current = "new";
      setSessionMessages([]);
      return;
    }

    const currentSelectedSession = selectedSessionRef.current;
    if (currentSelectedSession && messageAreaRef.current) {
      scrollMemory.current.set(currentSelectedSession, messageAreaRef.current.scrollTop);
    }
    const isFirstVisit = !visitedSessions.current.has(sessionId);
    setSelectedSession(sessionId);
    selectedSessionRef.current = sessionId;

    const cached = sessionMessagesCacheRef.current.get(sessionId);
    if (cached) {
      setSessionMessages(cached);
    } else {
      try {
        const messages = await invokeCommand<Message[]>("get_session_messages", {
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
  }, [projectId]);

  const openTaskPhaseWorkspace = useCallback(async (
    taskSession: TaskLaunchInstanceSummary,
    phase: TaskPhase,
    readOnly = false,
  ) => {
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
    if (phase !== "execution") {
      await openTaskChatPhase(taskSession, phase, readOnly);
      return;
    }

    setActiveTaskInstanceId(taskSession.task_id);
    setActiveTaskRequirementFile(taskSession.requirement_file ?? null);
    setSelectedTaskSkillId(taskSession.skill_id || "jishu-conductor-dev");
    activeTaskInstanceIdRef.current = taskSession.task_id;
    activeTaskRequirementFileRef.current = taskSession.requirement_file ?? null;
    selectedTaskSkillIdRef.current = taskSession.skill_id || "jishu-conductor-dev";
    lastKnownStatusRef.current = taskSession.status;
    setTaskModeActive(true);
    setTaskContainerTaskId(taskSession.task_id);
    setTaskContainerPhase(phase);
    setTaskContainerReadOnly(readOnly);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    setSelectedSession(null);
    selectedSessionRef.current = null;
    setPendingSteerDisplay([]);
  }, [openTaskChatPhase]);
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
        // Ignore chunks for agents we're not currently using.
        if (chunk.agent_id !== activeIdRef.current) {
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
  const activeApproval = pendingApprovals[0] ?? null;
  const activeInteraction = pendingInteractions.find(
    (item) =>
      item.agentId === activeId
      && item.sessionId === selectedSession,
  ) ?? null;
  const handleInteractionSubmit = useCallback(async (
    submission: ConversationInteractionSubmission,
  ) => {
    const interaction = pendingInteractions.find(
      (item) =>
        item.agentId === activeId
        && item.sessionId === selectedSession
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
  const startComposerFooter = currentProject ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/40 bg-muted/45 px-4 py-2.5 text-xs text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--icon-folder)]" />
        <span className="truncate font-medium text-foreground" title={projectDisplayName}>{projectDisplayName}</span>
      </span>
      {supportsModelPicker ? (
        <span ref={modelMenuRef} className="relative inline-flex min-w-0 items-center gap-1.5">
          <HardDrive className="h-3.5 w-3.5 shrink-0 text-[var(--icon-config)]" />
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
                  "inline-flex h-8 min-w-[8.5rem] max-w-[11rem] items-center justify-between gap-1.5 rounded-full border border-border/50 bg-background/80 px-2.5 text-xs font-mono text-muted-foreground transition-fast hover:bg-accent/45 hover:text-foreground",
                  modelMenuOpen && "border-primary/45 bg-primary/8 text-foreground shadow-sm",
                )}
              >
                <span className="min-w-0 truncate">{activeModelLabel}</span>
                <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", modelMenuOpen && "rotate-180")} />
              </button>
              {modelMenuOpen && (
                <div className="absolute left-5 top-[calc(100%+0.45rem)] z-[80] max-h-64 w-48 origin-top-left overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl">
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
                            await invokeCommand("set_active", { active: next });
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
      ) : null}
      <span className="inline-flex min-w-0 items-center gap-1.5" title={active?.display_name ?? ""}>
        {active ? <AgentLogo agentId={active.id} size={14} /> : null}
        <span className="truncate">{active?.display_name ?? t("sessions.currentAgent")}</span>
      </span>
      {projectPath && (
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[0.92em]" title={`${t("sessions.projectPath")}: ${projectPath}`}>
          {projectPath}
        </span>
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
          {currentProject ? (
            <div className="flex items-center gap-2 px-3 h-10 border-b border-border/20">
              <FolderOpen className="h-5 w-5 shrink-0 ml-1 text-[var(--icon-folder)]" />
              <span className="truncate text-sm font-semibold text-foreground flex-1 min-w-0 leading-none pt-[1px]" title={projectDisplayName}>{projectDisplayName}</span>
              <button
                onClick={onSwitchProject}
                className="shrink-0 px-1.5 h-6 flex items-center gap-0.5 rounded-md text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-fast"
                title={t("sessions.switchProject")}
              >
                <span className="leading-none pt-[1px]">{t("sessions.switchProject")}</span>
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 h-10 border-b border-border/20">
              <FolderOpen className="h-5 w-5 shrink-0 ml-1 text-muted-foreground/40" />
              <span className="text-sm font-semibold text-muted-foreground leading-none pt-[1px] flex-1">{t("sessions.noProject")}</span>
              <button
                onClick={onSwitchProject}
                className="shrink-0 px-1.5 h-6 flex items-center gap-0.5 rounded-md text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-fast"
              >
                <span className="leading-none pt-[1px]">{t("sessions.switchProject")}</span>
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          )}
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
          <div className="flex items-center justify-center h-10 border-b border-border/20">
            <button
              onClick={onSwitchProject}
              className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent/50 transition-fast"
              title={currentProject?.name ?? t("sessions.noProject")}
            >
              <FolderOpen className="h-4 w-4 text-[var(--icon-folder)]" />
            </button>
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
            className="flex h-8 w-full items-center gap-2 border-y border-border/20 bg-[var(--color-layer-1)] px-4 text-[11px] font-medium text-muted-foreground"
          >
            {regularSessionsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <span>{t("sessions.regularConversations")}</span>
            <span className="ml-auto tabular-nums">{displaySessions.length}</span>
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
          <button
            type="button"
            onClick={() => setTaskSessionsOpen((open) => !open)}
            className="flex h-8 w-full items-center gap-2 border-y border-border/20 bg-[var(--color-layer-1)] px-4 text-[11px] font-medium text-muted-foreground"
          >
            {taskSessionsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <span>{t("sessions.taskConversations")}</span>
            <span className="ml-auto tabular-nums">{displayTaskLaunchSessions.length}</span>
          </button>
          {taskSessionsOpen && displayTaskLaunchSessions.map((taskSession) => {
            const phase = taskSession.current_phase === "planning" ? "planning" : "requirements";
            const isActive = activeTaskInstanceId === taskSession.task_id && (taskLaunchOpen || taskModeActive);
            return (
              <ContextMenu key={taskSession.task_id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={async () => {
                      if (taskSession.graph_id && (taskSession.current_phase === "graph" || taskSession.current_phase === "execution")) {
                        // 执行阶段：打开三阶段容器（TaskPhaseContainer），落在执行阶段视图
                        openTaskPhaseWorkspace(taskSession, "execution");
                        return;
                      }
                      openTaskPhaseWorkspace(taskSession, phase as TaskPhase);
                    }}
                    className={cn(
                      "flex w-full flex-col items-start border-b border-border/10 py-2 pl-5 pr-2 text-xs transition-fast",
                      isActive
                        ? "bg-primary/10 text-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                    )}
                  >
                    <div className="flex w-full items-center gap-3">
                      <MessageSquare className="h-3 w-3 shrink-0 text-[var(--icon-message)]" />
                      <span className="min-w-0 flex-1 truncate text-left leading-none">
                        {taskSession.title}
                      </span>
                      <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                        {taskSession.current_phase === "graph" ? "流程" : phase === "planning" ? "规划" : "需求"}
                      </span>
                    </div>
                    <div className="mt-1.5 flex w-full items-center gap-2 pl-6 text-[10px] text-muted-foreground/70">
                      <span className="truncate">Skill: {taskSession.skill_id}</span>
                    </div>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onClick={() => setRenameTaskTarget(taskSession)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    {t("sessions.rename")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={async () => {
                      if (!projectPathForSettings) return;
                      const confirmed = await confirmDialog({
                        title: t("tasks.deleteTask"),
                        description: t("tasks.deleteTaskConfirm", { title: taskSession.title }),
                        variant: "destructive",
                      });
                      if (!confirmed) return;
                      if (taskSession.graph_id) {
                        await invokeCommand("orchestrator_delete_graph", { graphId: taskSession.graph_id });
                      }
                      await invokeCommand("task_launch_delete_task", {
                        projectRoot: projectPathForSettings,
                        taskId: taskSession.task_id,
                      });
                      setTaskLaunchSessions((current) => current.filter((item) => item.task_id !== taskSession.task_id));
                    }}
                  >
                    <X className="h-3.5 w-3.5 mr-2" />
                    {t("tasks.deleteTask")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>

        {/* Collapsed: empty body */}
        <div className={cn("flex-1", !sidebarCollapsed && "hidden")} />
      </div>

      {/* Right: Chat area */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {projectId && taskLaunchOpen && !taskModeActive ? (
          <TaskPhaseNavBar
            title={activeTaskLaunchInstance?.title ?? t("tasks.startTask", "新任务")}
            phases={taskLaunchPhaseStates}
            activePhase={taskLaunchPhase}
            onPhaseChange={(phase) => {
              if (!activeTaskLaunchInstance) return;
              const state = taskLaunchPhaseStates[phase];
              logTaskPhaseDebug("launch-nav:phase-click", {
                taskId: activeTaskLaunchInstance.task_id,
                requestedPhase: phase,
                state,
                activePhase: taskLaunchPhase,
                status: activeTaskLaunchInstance.status,
                currentPhase: activeTaskLaunchInstance.current_phase,
              });
              if (state === "active") return;
              openTaskPhaseWorkspace(activeTaskLaunchInstance, phase, state === "done");
            }}
            onClose={() => {
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
          />
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
        ) : taskModeActive ? (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {t("common.loading", "加载中…")}
              </div>
            }
          >
            <TaskPhaseContainer
              key={`${taskContainerTaskId ?? "new"}:${taskContainerPhase}:${taskContainerReadOnly ? "ro" : "rw"}`}
              projectPath={currentProject?.path ?? ""}
              encodedProjectId={currentProject?.encoded_name}
              initialTaskId={taskContainerTaskId}
              initialPhase={taskContainerPhase}
              initialReadOnly={taskContainerReadOnly}
              agents={agents.map((agent) => ({ id: agent.id, display_name: agent.display_name }))}
              agentsLoading={healthLoading && agents.length === 0}
              onSidebarUpdate={() => refreshTaskLaunchSessions().catch(console.error)}
              onClose={() => {
                setTaskModeActive(false);
                setTaskContainerTaskId(null);
                setTaskContainerPhase("requirements");
                setTaskContainerReadOnly(false);
                refreshTaskLaunchSessions().catch(console.error);
              }}
            />
          </Suspense>
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
            <ObservabilityStatusBar
              model={active?.display_name}
              turns={sessionMessages.length}
              fileCount={fileToolCount}
            />
            {/* Session header */}
            {selectedSession && selectedSession !== "new" ? (
              <div className="flex items-center justify-between px-5 h-[44px] border-b border-border/30" style={{ background: "var(--color-layer-1)" }}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-sm truncate">{displayName}</span>
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
                {selectedSession && selectedSession !== "new" && (
                  <MessageView
                    messages={sessionMessages}
                    searchQuery={searchQuery}
                    searchNavigation={messageSearchNavigation}
                    onSearchStatusChange={handleMessageSearchStatusChange}
                    flat
                    scrollContainerRef={messageAreaRef}
                  />
                )}
                {/* Only show StreamingMessage while the stream is active.
                    Once isStreaming flips to false the turn is complete and the
                    committed messages are already rendered by MessageView above —
                    keeping the streaming preview would duplicate interaction cards
                    and other content. */}
                {currentStream?.isStreaming && selectedSession && selectedSession !== "new" && (
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
        {shouldRenderGlobalChatInput({ projectId, taskModeActive }) && (
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
              stagedApiRef={stagedApiRef}
              onMessageSent={handleMessageSent}
              onSessionResolved={handleSessionResolved}
              onBeforeSend={handleTaskLaunchBeforeSend}
              prepareMessageForAgent={prepareTaskLaunchMessage}
              allowFiles={capabilities ? (capabilities.has("FILE_INPUT") || capabilities.has("IMAGE_INPUT")) : true}
              agentDisplayName={active?.display_name}
              disabled={taskLaunchOpen && (!taskModeCanSend || taskLaunchReadOnly)}
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

function stripTaskLaunchInstructionFromMessages(messages: Message[]): Message[] {
  return messages
    // 过滤 Conductor before_agent_start 注入消息（skill 方法论全文，display:false 但 Pi 仍写 JSONL）
    .filter((message) => {
      if (message.role !== "user") return true;
      const firstText = message.content.find((b) => b.type === "text");
      if (!firstText || firstText.type !== "text") return true;
      // Conductor 注入消息以 [JISHU-TASK: 开头
      if (firstText.text.trimStart().startsWith("[JISHU-TASK:")) return false;
      return true;
    })
    .map((message) => ({
      ...message,
      content: message.content.map((block) => {
        if (block.type !== "text") return block;
        return {
          ...block,
          text: stripTaskLaunchInstruction(block.text),
        };
      }),
    }));
}

function stripTaskLaunchInstruction(text: string): string {
  const launch = stripTaggedInstruction(
    text,
    "<jishu-task-launch-instruction>",
    "</jishu-task-launch-instruction>",
  );
  const planning = stripTaggedInstruction(
    launch,
    "<jishu-task-planning-stage>",
    "</jishu-task-planning-stage>",
  );
  return planning;
}

function stripTaggedInstruction(text: string, startTag: string, endTag: string): string {
  const start = text.indexOf(startTag);
  const end = text.indexOf(endTag);
  if (start < 0 || end < start) return text;
  const afterInstruction = text.slice(end + endTag.length);
  const chineseMarker = "用户消息：";
  const asciiMarker = "用户消息:";
  const chineseIndex = afterInstruction.indexOf(chineseMarker);
  if (chineseIndex >= 0) {
    return afterInstruction.slice(chineseIndex + chineseMarker.length).trimStart();
  }
  const asciiIndex = afterInstruction.indexOf(asciiMarker);
  if (asciiIndex >= 0) {
    return afterInstruction.slice(asciiIndex + asciiMarker.length).trimStart();
  }
  return afterInstruction.trimStart();
}
