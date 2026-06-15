import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useDeferredValue } from "react";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { streamStore, useSessionStream } from "@/hooks/use-stream-store";
import { MessageView, type MessageSearchNavigation, type MessageSearchStatus } from "@/components/sessions/message-view";
import { RenameSessionDialog } from "@/components/sessions/rename-session-dialog";
import { ChatInput, type StagedGuideApi } from "@/components/sessions/chat-input";
import { StreamingMessage } from "@/components/sessions/streaming-message";
import { clearImageCache } from "@/components/sessions/inline-image";
import { StatusBar as ObservabilityStatusBar } from "@/components/observability";
import { TasksPage } from "@/pages/tasks-page";
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
import { cn } from "@/lib/utils";
import { searchSessions } from "@/lib/session-search";
import { openFloatingSession } from "@/lib/floating-window";
import { interactionRequestFromEvent } from "@/lib/conversation-interaction";
import { AgentLogo, useAgent } from "@/agents";
import type {
  AgentStreamChunk,
  ContentBlock,
  ConversationInteractionRequest,
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

interface TaskConversationSummary {
  graph_id: string;
  title: string;
  original_goal: string;
  project_root: string;
  owner_agent_id: string;
  run_id: string | null;
  phase: string;
  current_node_id: string | null;
  current_node_title: string | null;
  completed_nodes: number;
  total_nodes: number;
  pending_interaction_count: number;
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
  const { activeId, active, capabilities } = useAgent();
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
  // for agents running a persistent ACP / Pi-RPC connection, which populate
  // ChatProcess.acp. CLI/embedded agents have no acp handle, so steer_chat
  // would fail with "No active ACP session found" — for them guide must fall
  // back to stop+send (handled by chat-input.tsx's default path).
  const supportsSteer =
    active?.transport === "pi_rpc" || active?.transport === "acp_preferred";

  // selectedSession: null or real backend UUID — never fake IDs
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const [renameOpen, setRenameOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [messageSearchStatus, setMessageSearchStatus] = useState<MessageSearchStatus>({ current: 0, total: 0 });
  const [messageSearchNavigation, setMessageSearchNavigation] = useState<MessageSearchNavigation | null>(null);
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const [optimisticSessions, setOptimisticSessions] = useState<Session[]>([]);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [selectedTaskGraphId, setSelectedTaskGraphId] = useState<string | null>(null);
  const [regularSessionsOpen, setRegularSessionsOpen] = useState(true);
  const [taskSessionsOpen, setTaskSessionsOpen] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState<PendingChatApproval[]>([]);
  const [pendingInteractions, setPendingInteractions] = useState<PendingChatInteraction[]>([]);
  const [approvalResolving, setApprovalResolving] = useState(false);

  // Quick model picker for Pi-backed model stores. The adapter declares
  // this surface; the page does not inspect the agent id.
  const [modelOptions, setModelOptions] = useState<{ provider: string; model: string }[]>([]);
  const [activeModel, setActiveModel] = useState<{ provider: string; model: string } | null>(null);
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

  const messageAreaRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(activeId);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // Fresh project path for the agent-event listener (whose useEffect deps are
  // [], so it closes over a stale `currentProject`). Updated every render.
  const projectPathRef = useRef<string | null>(currentProject?.path ?? null);
  projectPathRef.current = currentProject?.path ?? null;
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

  // Single hook for current project's sessions
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const { data: sessions, loading: sessionsLoading, setData: setSessions, refetch: refetchSessions } = useInvoke<Session[]>(
    projectId ? "list_sessions" : "",
    projectId ? { encodedName: projectId } : undefined,
    activeId + "_" + listRefreshKey,
  );
  const {
    data: taskConversations,
    refetch: refetchTaskConversations,
  } = useInvoke<TaskConversationSummary[]>(
    projectPathForSettings ? "orchestrator_list_task_conversations" : "",
    projectPathForSettings ? { projectRoot: projectPathForSettings } : undefined,
    projectPathForSettings ?? "",
  );

  useEffect(() => {
    if (!projectPathForSettings) return;
    const timer = window.setInterval(() => {
      refetchTaskConversations(true).catch(console.error);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [projectPathForSettings, refetchTaskConversations]);

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

  // Build display session list with optimistic sessions prepended
  let displaySessions = sessions ?? [];
  if (deferredSearchQuery.trim() && sessions) {
    displaySessions = uniqueSessionsById(searchResults.map((r: SessionSearchResult) => sessions.find(s => s.id === r.sessionId)!).filter(Boolean) as Session[]);
  } else if (!deferredSearchQuery.trim()) {
    displaySessions = uniqueSessionsById([...optimisticSessions, ...displaySessions]);
  }
  const displayTaskConversations = (taskConversations ?? []).filter((task) => {
    const query = deferredSearchQuery.trim().toLocaleLowerCase();
    if (!query) return true;
    return `${task.title}\n${task.original_goal}\n${task.current_node_title ?? ""}`
      .toLocaleLowerCase()
      .includes(query);
  });

  const hasSearchQuery = searchQuery.trim().length > 0;
  const showMessageSearchControls = hasSearchQuery && !!selectedSession && selectedSession !== "new";
  const showStartComposer = !!projectId && (!selectedSession || selectedSession === "new");
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
    setTaskPanelOpen(false);
    setSelectedTaskGraphId(null);
    sessionMessagesCacheRef.current.clear();
    newSessionStreamIdsRef.current.clear();
    clearImageCache();
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !activeId) return;
    setSelectedSession(null);
    selectedSessionRef.current = null;
    setSessionMessages([]);
    setOptimisticSessions([]);
    setTaskPanelOpen(false);
    setSelectedTaskGraphId(null);
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
      setIsAwayFromBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 100);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [selectedSession]);

  const handleScrollToBottom = useCallback(() => {
    if (messageAreaRef.current) {
      messageAreaRef.current.scrollTo({ top: messageAreaRef.current.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const handleSelectSession = async (sessionId: string) => {
    setTaskPanelOpen(false);
    setSelectedTaskGraphId(null);
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
    const cached = sessionMessagesCacheRef.current.get(sessionId);
    const isStreaming = streamStore.isStreaming(sessionId);
    if (cached && (isStreaming || streamStore.hasState(sessionId))) {
      setSessionMessages(cached);
    } else {
      try {
        const messages = await invokeCommand<Message[]>("get_session_messages", {
          sessionId,
          encodedName: projectId,
        });
        sessionMessagesCacheRef.current.set(sessionId, messages);
        setSessionMessages(messages);
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

  // Listen for cross-page session open requests (from TasksPage)
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

    setTaskPanelOpen(false);
    setSelectedTaskGraphId(null);
    setSelectedSession("new");
    selectedSessionRef.current = "new";
    setSessionMessages([]);
    setPendingSteerDisplay([]);

    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  };

  const handleOpenTaskConversation = useCallback((graphId: string | null) => {
    setSelectedTaskGraphId(graphId);
    setTaskPanelOpen(true);
    setSelectedSession(null);
    selectedSessionRef.current = null;
    setPendingSteerDisplay([]);
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
        sessionMessagesCacheRef.current.set(selectedSession, msgs);
        setSessionMessages(msgs);
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
      const newOptSession: Session = {
        id: sid,
        path: currentProject?.path || "",
        messages: [],
        display_name: t("sessions.newChat") || "新对话",
        started_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
      };
      setOptimisticSessions(prev => [newOptSession, ...prev]);
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

  // Stream listener (mount-only). Each chunk is routed into the per-session
  // store entry via streamStore.push, regardless of which session is currently
  // selected — that's what makes parallel streaming work.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    listen<AgentStreamChunk[] | AgentStreamChunk>("agent-event", (event) => {
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

        // Only push into the store if it knows about this session — otherwise
        // we'd accidentally create state for a session we never started. The
        // one exception is a steer/follow_up continuation: Pi finishes the
        // current turn (which drops the streaming state at turn_complete
        // below), then starts a NEW turn for the queued steer/follow_up. That
        // new turn's content chunks arrive AFTER the drop, so without this
        // re-activation they'd be silently discarded and the agent's response
        // to the steer would be invisible until a manual refresh. Re-start an
        // empty state (pendingUserMessage=null — a continuation, not a new
        // prompt) so the continuation's text/tool events accumulate and its
        // turn_complete builds a second assistant message appended after the
        // first. Non-content chunks (session_resolved/approval/interaction)
        // still skip — they must not create streaming state on their own.
        if (!streamStore.hasState(cid)) {
          if (
            chunk.data.kind === "text_delta"
            || chunk.data.kind === "thinking"
            || chunk.data.kind === "tool_use_start"
            || chunk.data.kind === "tool_use_result"
            || chunk.data.kind === "message"
          ) {
            streamStore.start(cid, null);
          } else {
            continue;
          }
        }

        // Detect resolved session id and register it as an alias before pushing
        // (so subsequent chunks under the real id route to the same entry).
        const realId = extractRealSessionId(chunk.data);
        if (realId && realId !== cid) {
          streamStore.alias(cid, realId);

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

        streamStore.push(cid, chunk);

        if (chunk.data.kind === "turn_complete") {
          // Build final assistant/user messages from the accumulated state.
          const state = streamStore.getState(cid);
          const finalKey = state?.resolvedId ?? cid;
          const isNewSessionStream =
            newSessionStreamIdsRef.current.has(cid)
            || newSessionStreamIdsRef.current.has(finalKey);
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
          // Sanitize + sort: each split marks the start of a new segment.
          const steerSplits = Array.from(new Set(state?.steerSplits ?? []))
            .filter((idx) => idx > 0 && idx < (state?.content.length ?? 0))
            .sort((a, b) => a - b);

          // True when a committed steer will be answered in a FOLLOW-UP turn
          // (a leftover not delivered mid-turn, or the appended steer in a
          // no-tool turn). Drives the pre-created "thinking" state below.
          let followUpExpected = false;

          const assistantContent: ContentBlock[] = [];
          if (state?.content.length) {
            assistantContent.push(...state.content);
          } else {
            if (state?.thinking) assistantContent.push({ type: "thinking", thinking: state.thinking });
            state?.tools.forEach((tool, idx) => {
              assistantContent.push({
                type: "tool_use",
                id: tool.id || `stream-${idx}-${tool.name}`,
                name: tool.name,
                input: tool.input,
              });
              if (tool.output !== undefined) {
                assistantContent.push({
                  type: "tool_result",
                  tool_use_id: tool.id || `stream-${idx}-${tool.name}`,
                  content: tool.output,
                });
              }
            });
            if (state?.text) assistantContent.push({ type: "text", text: state.text });
          }

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

          if (steerSplits.length > 0 && queuedSteers.length > 0) {
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
              newMessages.push({
                role: "user",
                content: [{ type: "text", text: queuedSteers[0] }],
                timestamp: Date.now(),
              });
              followUpExpected = true;
              consumeSteerFromQueue(1);
              dropLivePlaceholders(1);
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

          // If the user is currently viewing this session, reflect the update
          // immediately. Otherwise the cache will be used the next time they
          // switch back to this session (without a JSONL reload).
          const viewed = selectedSessionRef.current;
          const scrollEl = messageAreaRef.current;
          const shouldStickToBottom = Boolean(
            scrollEl
            && (viewed === cid || viewed === finalKey)
            && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120
          );
          if (viewed === cid || viewed === finalKey) {
            setSessionMessages(updated);
          }

          // Convert the streaming bubble into the formal MessageView row in a
          // single paint. Keeping the completed stream around briefly causes
          // the same reply to be rendered twice, then removed, which looks
          // like a vertical jump at the end of a turn.
          streamStore.drop(cid);
          streamStore.flushNow();

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
          }

          // Route 2 (orthogonal to manual guide): when the turn ends, auto-send
          // any messages the user staged but did NOT manually guide — merged
          // into a single new turn. claimAll() synchronously marks them sent,
          // so a manual click racing this moment (or a re-click) is blocked by
          // the shared claimed-id set — each staged guide is delivered exactly
          // once. Gated on !followUpExpected so it never competes with a manual
          // steer's follow-up turn (that turn fires its own turn_complete, which
          // re-evaluates). Only for the viewed session, since staged messages
          // belong to it.
          if (
            !followUpExpected
            && stagedApiRef.current
            && (viewed === cid || viewed === finalKey)
          ) {
            const claimed = stagedApiRef.current.claimAll();
            if (claimed.length > 0) {
              const merged = claimed.map((m) => m.content).join("\n\n");
              streamStore.start(finalKey, merged);
              if (cid !== finalKey) streamStore.alias(finalKey, cid);
              try {
                await invokeCommand("send_message", {
                  projectPath: projectPathRef.current,
                  sessionId: finalKey,
                  message: merged,
                });
              } catch (err) {
                console.error("Auto-send of staged guides failed:", err);
                streamStore.drop(finalKey);
                stagedApiRef.current.restore(claimed);
              }
            }
          }

          if (isNewSessionStream) {
            newSessionStreamIdsRef.current.delete(cid);
            newSessionStreamIdsRef.current.delete(finalKey);
            refetchSessionsRef.current?.(true).catch(console.error);
          }

          requestAnimationFrame(() => {
            if (shouldStickToBottom && messageAreaRef.current) {
              messageAreaRef.current.scrollTop = messageAreaRef.current.scrollHeight;
            }
            chatInputRef.current?.focus();
          });
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
  const handleInteractionSubmitted = useCallback((requestId: string) => {
    setPendingInteractions((current) =>
      current.filter(
        (item) =>
          item.agentId !== activeId
          || item.sessionId !== selectedSession
          || item.request.requestId !== requestId,
      ),
    );
  }, [activeId, selectedSession]);
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
  const startComposerFooter = currentProject ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/40 bg-muted/45 px-4 py-2.5 text-xs text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--icon-folder)]" />
        <span className="truncate font-medium text-foreground" title={projectDisplayName}>{projectDisplayName}</span>
      </span>
      {supportsModelPicker ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <HardDrive className="h-3.5 w-3.5 shrink-0 text-[var(--icon-config)]" />
          {modelOptions.length === 0 ? (
            <span className="truncate text-amber-400">
              {t("sessions.modelNotConfigured") || "No models — open 管理-配置"}
            </span>
          ) : (
            <select
              aria-label={t("sessions.activeModel") || "Active model"}
              className="h-6 rounded-md border border-input bg-transparent px-2 text-xs font-mono max-w-[260px] truncate"
              value={
                activeModel
                  ? `${activeModel.provider}/${activeModel.model}`
                  : ""
              }
              onChange={async (e) => {
                const value = e.target.value;
                if (!value) return;
                const [provider, ...rest] = value.split("/");
                const model = rest.join("/");
                const next = { provider, model };
                setActiveModel(next);
                try {
                  await invokeCommand("set_active", { active: next });
                } catch (err) {
                  console.warn("set_active failed:", err);
                }
              }}
            >
              {!activeModel && <option value="">— pick model —</option>}
              {modelOptions.map((o) => (
                <option
                  key={`${o.provider}/${o.model}`}
                  value={`${o.provider}/${o.model}`}
                >
                  {o.provider}/{o.model}
                </option>
              ))}
            </select>
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
              onClick={projectId ? () => handleOpenTaskConversation(null) : undefined}
              title={projectId ? t("tasks.startTask") : t("sessions.selectProject")}
              className={cn(
                "flex h-8 w-full items-center gap-2.5 rounded-lg pl-2 pr-2 text-sm text-foreground transition-fast",
                projectId ? taskPanelOpen ? "bg-primary/10 font-medium" : "hover:bg-accent" : "opacity-40 cursor-not-allowed"
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
              onClick={projectId ? () => handleOpenTaskConversation(null) : undefined}
              title={projectId ? t("tasks.startTask") : t("sessions.selectProject")}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition-fast",
                projectId ? taskPanelOpen ? "bg-primary/10" : "hover:bg-accent" : "opacity-40 cursor-not-allowed"
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
            const isActive = session.id === selectedSession && !taskPanelOpen;
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
            <span className="ml-auto tabular-nums">{displayTaskConversations.length}</span>
          </button>
          {taskSessionsOpen && displayTaskConversations.map((task) => {
            const isActive = taskPanelOpen && task.graph_id === selectedTaskGraphId;
            return (
              <button
                key={task.graph_id}
                type="button"
                onClick={() => handleOpenTaskConversation(task.graph_id)}
                className={cn(
                  "flex w-full flex-col items-start border-b border-border/10 py-2 pl-5 pr-2 text-xs transition-fast",
                  isActive
                    ? "bg-primary/10 text-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                )}
              >
                <div className="flex w-full items-center gap-3">
                  <ClipboardList className="h-3 w-3 shrink-0 text-[var(--icon-action)]" />
                  <span className="min-w-0 flex-1 truncate text-left leading-none">
                    {task.title}
                  </span>
                  {task.pending_interaction_count > 0 ? (
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-600">
                      {task.pending_interaction_count}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[0.65em] tabular-nums text-muted-foreground/40">
                      {formatRelativeTime(new Date(task.updated_at), t)}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex w-full items-center gap-2 pl-6 text-[10px] text-muted-foreground/70">
                  <span>{t(`tasks.conversation.phases.${task.phase}`)}</span>
                  {task.current_node_title && (
                    <>
                      <span>·</span>
                      <span className="min-w-0 truncate">{task.current_node_title}</span>
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Collapsed: empty body */}
        <div className={cn("flex-1", !sidebarCollapsed && "hidden")} />
      </div>

      {/* Right: Chat area */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
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
        ) : taskPanelOpen ? (
          <TasksPage
            initialProjectPath={currentProject?.path ?? null}
            initialGraphId={selectedTaskGraphId}
            onClose={() => {
              setTaskPanelOpen(false);
              setSelectedTaskGraphId(null);
              refetchTaskConversations(true).catch(console.error);
            }}
          />
        ) : showStartComposer ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
            <div className="flex w-full max-w-[var(--message-content-max-width)] min-w-0 flex-col items-center">
              <h1 className="mb-14 max-w-full text-center text-[2rem] font-medium leading-tight tracking-normal text-foreground">
                {t("sessions.startPrompt", { project: projectDisplayName })}
              </h1>
              <ChatInput
                ref={chatInputRef}
                sessionId={null}
                projectPath={currentProject?.path ?? null}
                onMessageSent={handleMessageSent}
                allowFiles={capabilities ? (capabilities.has("FILE_INPUT") || capabilities.has("IMAGE_INPUT")) : true}
                agentDisplayName={active?.display_name}
                containerClassName="max-w-full px-0 pb-0 pt-0"
                panelClassName="rounded-[22px] border-border/70 bg-card/98 shadow-[0_18px_48px_rgba(0,0,0,0.10)]"
                contextFooter={startComposerFooter}
                accessModeLabel={accessModeLabel}
                accessModeTitle={supportsAccessModeSwitch ? t("sessions.accessMode") : t("sessions.accessModeReadOnly")}
                accessModeReadOnly={!supportsAccessModeSwitch}
                accessModeOptions={accessModeOptions}
                accessModeValue={accessModeValue}
                onAccessModeChange={handleAccessModeChange}
              />
            </div>
          </div>
        ) : (
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
            {/* Messages */}
            <div ref={messageAreaRef} className="flex-1 min-h-0 overflow-y-auto">
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
              {currentStream && selectedSession && selectedSession !== "new" && (
                <StreamingMessage
                  key={selectedSession}
                  sessionId={selectedSession}
                  isComplete={!currentStream.isStreaming}
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
                        <div key={`pending-steer-${steerInjectedCount + i}`} className="w-full flex justify-end">
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
          </>
        )}
        {/* Chat input area with scroll-to-bottom overlay */}
        {projectId && !showStartComposer && !taskPanelOpen && (
          <div className="relative">
            {isAwayFromBottom && (
              <button
                onClick={handleScrollToBottom}
                className="absolute -top-10 left-1/2 -translate-x-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border/40 bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-all hover:bg-accent hover:text-foreground hover:border-border/60 hover:shadow-md opacity-60 hover:opacity-100"
                title={t("sessions.scrollToBottom", "滚动到底部")}
              >
                <ChevronDown className="h-4 w-4" strokeWidth={2.5} />
              </button>
            )}
            <ChatInput
              ref={chatInputRef}
              sessionId={selectedSession === "new" ? null : selectedSession}
              projectPath={currentProject?.path ?? null}
              stagedApiRef={stagedApiRef}
              onMessageSent={handleMessageSent}
              allowFiles={capabilities ? (capabilities.has("FILE_INPUT") || capabilities.has("IMAGE_INPUT")) : true}
              agentDisplayName={active?.display_name}
              contextFooter={startComposerFooter}
              accessModeLabel={accessModeLabel}
              accessModeTitle={supportsAccessModeSwitch ? t("sessions.accessMode") : t("sessions.accessModeReadOnly")}
              accessModeReadOnly={!supportsAccessModeSwitch}
              accessModeOptions={accessModeOptions}
              accessModeValue={accessModeValue}
              onAccessModeChange={handleAccessModeChange}
              interactionRequest={activeInteraction?.request}
              onInteractionSubmitted={handleInteractionSubmitted}
              onGuideStaged={
                supportsSteer
                  ? async (content: string) => {
                      if (!selectedSession || selectedSession === "new") return;
                      await invokeCommand("steer_chat", {
                        sessionId: selectedSession,
                        message: content,
                      });
                      // Queue for commit at turn_complete AND show live now.
                      // Rendered after the streaming bubble (see
                      // pendingSteerDisplay below) so it sits below the
                      // in-progress reply; committed into sessionMessages
                      // between that reply and the steer's response when the
                      // turn completes.
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
                    }
                  : undefined
              }
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
