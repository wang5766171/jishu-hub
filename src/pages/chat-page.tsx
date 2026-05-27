import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useDeferredValue } from "react";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { streamStore } from "@/hooks/use-stream-store";
import { MessageView, type MessageSearchNavigation, type MessageSearchStatus } from "@/components/sessions/message-view";
import { RenameSessionDialog } from "@/components/sessions/rename-session-dialog";
import { ChatInput } from "@/components/sessions/chat-input";
import { StreamingMessage } from "@/components/sessions/streaming-message";
import { StatusBar as ObservabilityStatusBar } from "@/components/observability";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageSquare, Search, X, Pencil, RotateCw, FolderOpen, SquarePen, PanelLeftClose, PanelLeftOpen, ArrowRight, ChevronUp, ChevronDown,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { searchSessions } from "@/lib/session-search";
import { useAgent } from "@/agents";
import type { Session, Project, Message, ContentBlock, AgentStreamChunk, SessionSearchResult } from "@/types";

function TerminalIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="3" width="20" height="18" rx="3" />
      <polyline points="7 10 10 13 7 16" />
      <line x1="13" y1="16" x2="17" y2="16" />
    </svg>
  );
}

function formatRelativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
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

export function ChatPage({
  currentProject,
  onRefresh,
  sessionNames,
  refetchNames,
  onSwitchProject,
}: {
  currentProject: Project | null;
  onRefresh: () => Promise<number>;
  sessionNames: Record<string, string> | null;
  refetchNames: (silent?: boolean) => Promise<Record<string, string>>;
  onSwitchProject: () => void;
}) {
  const { t } = useTranslation();
  const { activeId, active, capabilities } = useAgent();
  const projectId = currentProject?.encoded_name ?? null;

  // selectedSession: null or real backend UUID — never fake IDs
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const [renameOpen, setRenameOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [messageSearchStatus, setMessageSearchStatus] = useState<MessageSearchStatus>({ current: 0, total: 0 });
  const [messageSearchNavigation, setMessageSearchNavigation] = useState<MessageSearchNavigation | null>(null);
  const [optimisticSessions, setOptimisticSessions] = useState<Session[]>([]);

  const messageAreaRef = useRef<HTMLDivElement>(null);
  const streamChunksRef = useRef<AgentStreamChunk[]>([]);
  const pendingUserMsgRef = useRef<string | null>(null);
  const resolvedSessionIdRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(activeId);
  const streamingAgentRef = useRef<string | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const selectedSessionRef = useRef<string | null>(null);
  const visitedSessions = useRef(new Set<string>());
  const scrollMemory = useRef(new Map<string, number>());
  const scrollAction = useRef<{ type: "bottom" } | { type: "restore", top: number } | null>(null);
  // Buffer for early chunks arriving before handleMessageSent sets streamingSessionRef
  const earlyChunksRef = useRef<AgentStreamChunk[]>([]);

  const showChatArea = !!selectedSession;
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
  const { data: sessions } = useInvoke<Session[]>(
    projectId ? "list_sessions" : "",
    projectId ? { encodedName: projectId } : undefined,
    listRefreshKey,
  );

  const searchResults = useMemo<SessionSearchResult[]>(() => {
    if (!sessions || !deferredSearchQuery.trim()) return [];
    return searchSessions(sessions, deferredSearchQuery);
  }, [sessions, deferredSearchQuery]);

  // Build display session list with optimistic sessions prepended
  let displaySessions = sessions ?? [];
  if (deferredSearchQuery.trim() && sessions) {
    displaySessions = searchResults.map((r: SessionSearchResult) => sessions.find(s => s.id === r.sessionId)!).filter(Boolean) as Session[];
  } else if (!deferredSearchQuery.trim()) {
    displaySessions = [...optimisticSessions, ...displaySessions];
  }

  const hasSearchQuery = searchQuery.trim().length > 0;
  const showMessageSearchControls = hasSearchQuery && !!selectedSession && selectedSession !== "new";
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
    streamChunksRef.current = [];
    earlyChunksRef.current = [];
    setPendingUserMessage(null);
    pendingUserMsgRef.current = null;
    resolvedSessionIdRef.current = null;
  }, [projectId]);

  const handleRefresh = async () => {
    const newKey = await onRefresh();
    setListRefreshKey(newKey);
  };

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

  const handleSelectSession = async (sessionId: string) => {
    if (sessionId === selectedSession || !projectId) return;

    if (selectedSession && messageAreaRef.current) {
      scrollMemory.current.set(selectedSession, messageAreaRef.current.scrollTop);
    }
    const isFirstVisit = !visitedSessions.current.has(sessionId);
    setSelectedSession(sessionId);
    selectedSessionRef.current = sessionId;

    try {
      const messages = await invokeCommand<Message[]>("get_session_messages", {
        sessionId,
        encodedName: projectId,
      });
      setSessionMessages(messages);
    } catch {
      setSessionMessages([]);
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

  const handleNewSession = async () => {
    if (!projectId) return;

    setSelectedSession("new");
    selectedSessionRef.current = "new";
    setSessionMessages([]);
    streamStore.setSession(null);
    setPendingUserMessage(null);
    pendingUserMsgRef.current = null;
    resolvedSessionIdRef.current = null;

    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  };

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
      });
    } catch (err) {
      console.error("Failed to resume session:", err);
    } finally {
      setLoadingSessionId(null);
    }
  };

  const handleRefreshMessages = useCallback(async () => {
    if (selectedSession && projectId) {
      try {
        const msgs = await invokeCommand<Message[]>("get_session_messages", {
          sessionId: selectedSession,
          encodedName: projectId,
        });
        setSessionMessages(msgs);
      } catch (e) {
        console.error(e);
      }
    }
  }, [selectedSession, projectId]);

  const handleMessageSent = useCallback((sid: string, msg: string) => {
    streamChunksRef.current = [];
    streamStore.setSession(sid);

    if (!selectedSession || selectedSession === "new") {
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
    }

    setPendingUserMessage(msg);
    pendingUserMsgRef.current = msg;
    resolvedSessionIdRef.current = null;
    streamingAgentRef.current = activeIdRef.current;

    // Replay early chunks that arrived before this callback ran
    const early = earlyChunksRef.current.filter(c => c.session_id === sid);
    for (const chunk of early) {
      streamStore.push(chunk);
      streamChunksRef.current.push(chunk);
      const realId = extractRealSessionId(chunk.data);
      if (realId && realId !== sid) {
        resolvedSessionIdRef.current = realId;
        setOptimisticSessions(prev => prev.map(s => s.id === sid ? { ...s, id: realId } : s));
        setSelectedSession(realId);
        selectedSessionRef.current = realId;
        visitedSessions.current.add(realId);
      }
    }
    earlyChunksRef.current = [];

    requestAnimationFrame(() => {
      if (messageAreaRef.current) {
        messageAreaRef.current.scrollTop = messageAreaRef.current.scrollHeight;
      }
    });
  }, [selectedSession, currentProject?.path, t]);

  // Stream listener (mount-only, exact match on streaming session)
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    listen<AgentStreamChunk[] | AgentStreamChunk>("agent-event", (event) => {
      const payload = event.payload;
      const chunks = Array.isArray(payload) ? payload : [payload];
      const currentStreaming = streamStore.getSessionId();

      for (const chunk of chunks) {
        if (streamingAgentRef.current && chunk.agent_id !== streamingAgentRef.current) continue;
        if (!currentStreaming && chunk.agent_id !== activeIdRef.current) continue;

        // Buffer early chunks that arrive before handleMessageSent sets the ref
        if (!currentStreaming) {
          earlyChunksRef.current.push(chunk);
          continue;
        }

        // Exact match only — prevents cross-session contamination
        if (chunk.session_id !== currentStreaming) continue;

        // Use streamStore for O(1) push instead of O(N²) useState spread
        streamStore.push(chunk);
        streamChunksRef.current.push(chunk);

        // Extract real session_id from system init or result events
        const realId = extractRealSessionId(chunk.data);
        if (realId && realId !== currentStreaming && realId !== resolvedSessionIdRef.current) {
          resolvedSessionIdRef.current = realId;
          setOptimisticSessions(prev => prev.map(s => s.id === currentStreaming ? { ...s, id: realId } : s));
          setSelectedSession(realId);
          selectedSessionRef.current = realId;
          visitedSessions.current.add(realId);
        }

        if (chunk.data.kind === "turn_complete") {
          // Reconstruct text and tool_use from all accumulated chunks
          let text = "";
          let thinking = "";
          const tools: Array<{ type: "tool_use"; id: string; name: string; input: unknown }> = [];
          for (const c of streamChunksRef.current) {
            if (c.data.kind === "text_delta") {
              text += c.data.delta;
            } else if (c.data.kind === "thinking") {
              thinking += c.data.delta;
            } else if (c.data.kind === "tool_use_start") {
              tools.push({ type: "tool_use", id: c.data.call_id, name: c.data.tool, input: c.data.input });
            } else if (c.data.kind === "message") {
              for (const block of c.data.content) {
                if (block.type === "tool_use") {
                  tools.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
                } else if (block.type === "text") {
                  text += block.text;
                } else if (block.type === "thinking") {
                  thinking += block.thinking;
                }
              }
            }
          }

          // Build final messages
          const newMessages: Message[] = [];
          if (pendingUserMsgRef.current) {
            newMessages.push({ role: "user", content: [{ type: "text", text: pendingUserMsgRef.current }], timestamp: Date.now() });
          }
          const assistantContent: ContentBlock[] = [];
          if (thinking) assistantContent.push({ type: "thinking", thinking });
          assistantContent.push(...tools);
          if (text) assistantContent.push({ type: "text", text });
          if (assistantContent.length > 0) {
            newMessages.push({ role: "assistant", content: assistantContent, timestamp: Date.now() });
          }

          setSessionMessages((prev) => {
            if (selectedSessionRef.current === (resolvedSessionIdRef.current || currentStreaming)) {
              return [...prev, ...newMessages];
            }
            return prev;
          });

          // Clear streaming state
          streamStore.setSession(null);
          streamingAgentRef.current = null;
          streamChunksRef.current = [];
          setPendingUserMessage(null);
          pendingUserMsgRef.current = null;

          // Refresh session list directly
          setListRefreshKey(prev => prev + 1);

          requestAnimationFrame(() => {
            if (messageAreaRef.current) {
              messageAreaRef.current.scrollTop = messageAreaRef.current.scrollHeight;
            }
            // Refocus input after assistant finishes responding
            chatInputRef.current?.focus();
          });

          setTimeout(() => { refetchNames(true); }, 2000);
        }
      }
    }).then((fn) => {
      if (cancelled) {
        fn(); // Already unmounted — unregister immediately
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
              <span className="truncate text-sm font-semibold text-foreground flex-1 min-w-0 leading-none pt-[1px]" title={currentProject.name}>{currentProject.name}</span>
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
              <span className="truncate leading-none pt-[1px]">发起新对话</span>
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
        </div>

        {/* Session list: expanded */}
        <div className={cn("flex-1 overflow-y-auto", sidebarCollapsed && "hidden")}>
          {displaySessions.map((session) => {
            const isActive = session.id === selectedSession;
            const name = sessionNames?.[session.id] || session.display_name || session.id.slice(0, 8);
            const timeStr = session.last_active
              ? formatRelativeTime(session.last_active)
              : session.started_at
                ? formatRelativeTime(session.started_at)
                : null;
            const searchHit = searchResults.find((r: SessionSearchResult) => r.sessionId === session.id);
            return (
              <button
                key={session.id}
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
            );
          })}
        </div>

        {/* Collapsed: empty body */}
        <div className={cn("flex-1", !sidebarCollapsed && "hidden")} />
      </div>

      {/* Right: Chat area */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {!showChatArea ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center">
              <MessageSquare className="h-7 w-7 text-[var(--icon-message)]" />
            </div>
            {projectId ? (
              <p className="text-sm">{t("sessions.selectSession")}</p>
            ) : (
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
            )}
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
                    onClick={handleRefreshMessages}
                    title={t("sessions.refresh")}
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
            <div ref={messageAreaRef} className="flex-1 min-h-0 overflow-y-auto" style={{ overflowAnchor: "none" }}>
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
              {streamStore.getSessionId() && 
                (streamStore.getSessionId() === selectedSession || resolvedSessionIdRef.current === selectedSession) && 
                selectedSession && selectedSession !== "new" && (
                <StreamingMessage
                  key={streamStore.getSessionId()!}
                  isComplete={false}
                  userMessage={pendingUserMessage ?? undefined}
                  scrollContainerRef={messageAreaRef}
                />
              )}
            </div>
          </>
        )}
        {/* Chat input */}
        {projectId && (
          <ChatInput
            ref={chatInputRef}
            sessionId={selectedSession === "new" ? null : selectedSession}
            projectPath={currentProject?.path ?? null}
            disabled={streamStore.getSessionId() !== null}
            onMessageSent={handleMessageSent}
            allowFiles={capabilities ? (capabilities.has("FILE_INPUT") || capabilities.has("IMAGE_INPUT")) : true}
          />
        )}
      </div>

      <RenameSessionDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        sessionId={selectedSession ?? ""}
        currentName={displayName}
        onRenamed={refetchNames}
      />
    </div>
  );
}
