/**
 * 会话选择/加载与发送链（v0.9.3 需求10 收官刀②，chat-page 拆解）：
 * 会话切换（缓存优先/流式截断/滚动记忆）、乐观会话列表、发送时的流注册
 * 与缓存播种、任务模式首条消息包装、session-resolved 观测、通知点击定位
 * 整体迁出。逻辑逐字搬迁，交互语义零变化。
 *
 * 职责边界：本钩子拥有 optimisticSessions 与 conductor 激活标记集合；
 * 会话消息 state（sessionMessages）留在页面（读写面横跨渲染区），经
 * setter/ref 注入。refreshSessionUsage 定义序在钩子之后，经 ref 运行时取用。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { streamStore } from "@/hooks/use-stream-store";
import {
  getCachedSessionMessages,
  setCachedSessionMessages,
} from "@/features/session-kernel/kernel/session-cache";
import { logTaskPhaseDebug } from "@/features/task-instance/task-phase-debug";
import { stripTaskLaunchInstructionFromMessages } from "./chat-page-utils";
import type { Message, Project, Session } from "@/types";
import type { TaskLaunchPhase } from "./chat-page-utils";

export interface SessionSelectionDeps {
  projectId: string | null;
  activeId: string | null;
  currentProject: Project | null;
  sessions: Session[] | null;
  // 会话消息 state（页面持有）
  setSessionMessages: (messages: Message[]) => void;
  sessionMessagesRef: RefObject<Message[]>;
  setSelectedSession: (id: string | null) => void;
  selectedSessionRef: RefObject<string | null>;
  // 滚动/访问记录（页面持有 ref）
  messageAreaRef: RefObject<HTMLDivElement | null>;
  scrollMemory: RefObject<Map<string, number>>;
  visitedSessions: RefObject<Set<string>>;
  scrollAction: RefObject<{ type: "bottom" } | { type: "restore"; top: number } | null>;
  // 流式标记
  newSessionStreamIdsRef: RefObject<Set<string>>;
  // 任务态重置（切常规会话清任务选中）
  setTaskModeActive: (v: boolean) => void;
  setTaskLaunchOpen: (v: boolean) => void;
  setTaskLaunchReadOnly: (v: boolean) => void;
  taskLaunchOpenRef: RefObject<boolean>;
  taskLaunchPhaseRef: RefObject<TaskLaunchPhase>;
  activeTaskInstanceIdRef: RefObject<string | null>;
  activeTaskRequirementFileRef: RefObject<string | null>;
  lastKnownStatusRef: RefObject<string | null>;
  setActiveTaskInstanceId: (v: string | null) => void;
  setActiveTaskRequirementFile: (v: string | null) => void;
  setTaskSelectedNodeId: (v: string | null) => void;
  setTaskNodeSessionAgentId: (v: string | null) => void;
  // 邻接动作
  closeViewer: () => void;
  refreshSessionUsageRef: RefObject<(sessionId: string) => void>;
}

export function useSessionSelection(deps: SessionSelectionDeps) {
  const { t } = useTranslation();
  const {
    projectId,
    activeId,
    currentProject,
    sessions,
    setSessionMessages,
    sessionMessagesRef,
    setSelectedSession,
    selectedSessionRef,
    messageAreaRef,
    scrollMemory,
    visitedSessions,
    scrollAction,
    newSessionStreamIdsRef,
    setTaskModeActive,
    setTaskLaunchOpen,
    setTaskLaunchReadOnly,
    taskLaunchOpenRef,
    taskLaunchPhaseRef,
    activeTaskInstanceIdRef,
    activeTaskRequirementFileRef,
    lastKnownStatusRef,
    setActiveTaskInstanceId,
    setActiveTaskRequirementFile,
    setTaskSelectedNodeId,
    setTaskNodeSessionAgentId,
    closeViewer,
    refreshSessionUsageRef,
  } = deps;

  const [optimisticSessions, setOptimisticSessions] = useState<Session[]>([]);

  // Auto-clear optimistic sessions once real session appears in backend list
  useEffect(() => {
    if (sessions && optimisticSessions.length > 0) {
      setOptimisticSessions(prev => prev.filter(opt => !sessions.some(s => s.id === opt.id)));
    }
  }, [sessions]);

  // 记录哪些 session 已经注入过 launch instruction（只在每个阶段的首条消息注入一次，
  // 后续消息复用 agent 进程上下文，不重复下达阶段指令，避免 agent 误以为每轮都是新阶段开始）。
  const injectedLaunchSessionsRef = useRef<Set<string>>(new Set());

  const prepareTaskLaunchMessage = useCallback((message: string) => {
    if (!taskLaunchOpenRef.current) return message;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectSessionRef = useRef<(sessionId: string) => void>(() => {});

  const handleSelectSession = async (sessionId: string) => {
    setTaskModeActive(false);
    setTaskLaunchOpen(false);
    setTaskLaunchReadOnly(false);
    taskLaunchOpenRef.current = false;
    // v0.9.2 测试期修复：切常规会话时清除任务选中态——此前 activeTaskInstanceId
    // 残留，任务树行持续高亮（用户实测：任务会话选过后点常规会话，列表里任务
    // 行仍是选中态）。节点选择态一并复位，避免回任务时残留节点会话上下文。
    activeTaskInstanceIdRef.current = null;
    activeTaskRequirementFileRef.current = null;
    lastKnownStatusRef.current = null;
    setActiveTaskInstanceId(null);
    setActiveTaskRequirementFile(null);
    setTaskSelectedNodeId(null);
    setTaskNodeSessionAgentId(null);
    if (sessionId === selectedSessionRef.current || !projectId) return;

    // v0.8.0 需求4 补充：切换会话自动收起右侧预览——预览的文件属于上一会话
    // 上下文，跨会话保留易误导。同会话重复点击已被上方守卫拦截。
    closeViewer();

    if (selectedSessionRef.current && messageAreaRef.current) {
      scrollMemory.current.set(selectedSessionRef.current, messageAreaRef.current.scrollTop);
    }
    const isFirstVisit = !visitedSessions.current.has(sessionId);
    setSelectedSession(sessionId);
    selectedSessionRef.current = sessionId;
    // Live steer placeholders keep their per-session keys（渲染按
    // selectedSession 键取，切走不会串显）——不清空：清空会把后台会话
    // 仍排队的引导占位一并抹掉，切回时占位消失、直到插入成功才复现
    //（v0.9.3 需求10 测试期修复：用户实测「切走再回，引导不显示」）。

    // While a session is streaming we keep its message snapshot in
    // `kernel/session-cache` and *do not* reload from JSONL — otherwise the
    // user message that the CLI has already flushed to disk would appear twice
    // (once from the JSONL, once from the live `<StreamingMessage>` bubble).
    // Also trust the cache after streaming ends (turn_complete populates it
    // with committed messages including interaction blocks), to avoid losing
    // interaction cards when the user navigates between sessions.
    const cached = getCachedSessionMessages(sessionId);
    if (cached) {
      setSessionMessages(cached);
    } else {
      try {
        const messages = await invokeCommand<Message[]>("get_session_messages", {
          agentId: activeId ?? "",
          sessionId,
          encodedName: projectId,
        });
        let visibleMessages = stripTaskLaunchInstructionFromMessages(messages);
        // v0.8.0 需求7：缓存缺失但该会话正在流式输出（本应用生命周期内首次
        // 打开的后台流式会话）——CLI 已把当前回合的用户消息落盘，直接渲染会
        // 与流式气泡的 pendingUserMessage 各出现一次。从最后一条与回合
        // prompt 相同的 user 消息处截断：其后是本回合的 steer 与增量回复，
        // 均由流式气泡负责渲染。文本精确匹配，不匹配（CLI 改写 prompt 等）
        // 时退回原样渲染。
        const pending = streamStore.getState(sessionId)?.pendingUserMessage ?? null;
        if (streamStore.isStreaming(sessionId) && pending != null) {
          for (let i = visibleMessages.length - 1; i >= 0; i--) {
            const m = visibleMessages[i];
            if (m.role !== "user") continue;
            const text = m.content.find((c) => c.type === "text")?.text ?? null;
            if (text === pending) {
              visibleMessages = visibleMessages.slice(0, i);
              break;
            }
          }
        }
        setCachedSessionMessages(sessionId, visibleMessages);
        setSessionMessages(visibleMessages);
      } catch {
        setSessionMessages([]);
      }
    }

    // 会话打开即拉取权威用量（含重启后的历史累计）。
    refreshSessionUsageRef.current?.(sessionId);

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

  // v0.9.3 测试期（通知点击跳回收尾）：deep-link 转发的 desktop-notify-click
  //（点击系统通知 → jishu-hub://session/<id> → single-instance/冷启动 → Rust
  // 聚焦 + 广播）→ 经 ref 调最新 handleSelectSession 定位会话。监听挂在
  // chat-page 而非插件的 lastCtx 间接层——冷启动（应用未运行时点通知中心）
  // 与未发过通知的场景同样可靠。
  useEffect(() => {
    const unlistenPromise = listen<{ sessionId?: string | null }>("desktop-notify-click", (event) => {
      const sid = event.payload?.sessionId;
      if (sid) handleSelectSessionRef.current(sid);
    });
    return () => {
      void unlistenPromise.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMessageSent = useCallback((sid: string, msg: string, toolIds?: string[]) => {
    // For new sessions, register a stream entry here. For existing sessions,
    // chat-input.tsx already called streamStore.start() before invoking
    // send_message, so we skip to avoid resetting accumulated chunks.
    if (!streamStore.hasState(sid)) {
      streamStore.start(sid, msg, toolIds ?? []);
    }

    const isNewSessionSend = !selectedSessionRef.current || selectedSessionRef.current === "new";
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
      setCachedSessionMessages(sid, []);
      setSessionMessages([]);
    } else {
      // Existing session: snapshot the currently displayed messages so we can
      // append the assistant turn on completion without re-reading JSONL.
      setCachedSessionMessages(sid, sessionMessagesRef.current);
    }

    requestAnimationFrame(() => {
      if (messageAreaRef.current) {
        messageAreaRef.current.scrollTop = messageAreaRef.current.scrollHeight;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.path]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    /** conductor 激活标记集合（事件管线的 launch instruction 注入也消费）。 */
    injectedLaunchSessionsRef,
    optimisticSessions,
    setOptimisticSessions,
    handleSelectSession,
    handleSelectSessionRef,
    prepareTaskLaunchMessage,
    handleMessageSent,
    handleSessionResolved,
  };
}
