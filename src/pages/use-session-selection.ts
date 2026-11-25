/**
 * 会话选择/加载与发送链（v0.9.3 需求10 收官刀②，chat-page 拆解）：
 * 会话切换（缓存优先/流式截断/滚动记忆）、乐观会话列表、发送时的流注册
 * 与缓存播种、任务模式首条消息包装、session-resolved 观测、通知点击定位
 * 整体迁出。逻辑逐字搬迁，交互语义零变化。
 *
 * v0.9.8 需求24 续（用户裁决「任务会话的逻辑改成和普通会话一致」）：**打开任何会话
 * 都走 handleSelectSession**——普通会话、任务主会话、节点子代理的会话。记离开位置、
 * 收起预览、读消息、刷新用量、定位在这里只有一份；任务工作台经「保留任务上下文」
 * 标记复用它，节点会话的消息由 use-node-session-reload 补读。
 *
 * 职责边界：本钩子拥有 optimisticSessions 与 conductor 激活标记集合；
 * 会话消息 state（sessionMessages）留在页面（读写面横跨渲染区），经
 * setter/ref 注入。refreshSessionUsage 定义序在钩子之后，经 ref 运行时取用。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { devLog } from "@/lib/dev-log";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { streamStore } from "@/hooks/use-stream-store";
import {
  getCachedSessionMessages,
  setCachedSessionMessages,
} from "@/features/session-kernel/kernel/session-cache";
import { logTaskPhaseDebug } from "@/features/task-instance/task-phase-debug";
import { filterInvisibleUserMessages } from "./chat-page-utils";
import type { Message, Project, Session } from "@/types";
import type { TaskLaunchPhase } from "./chat-page-utils";

/**
 * 读一个会话的消息并显示（见 useSessionSelection 里的实现）。
 * 缓存里有、又不要求重读时**同步返回**——打开函数靠这一点在消息上屏的同一轮提交之前
 * 投出定位指令；多等一拍，定位指令就没人消费（v0.9.8 需求24 续实测：回来停不到原处）。
 */
export type ReloadSessionMessages = (sessionId: string, agentId: string | null, fresh?: boolean) => Message[] | Promise<Message[]>;

export interface SelectSessionOptions {
  /** 按完整视图打开——即使当前有搜索词、该会话有命中，也不落到命中处
   *（v0.9.8 需求23 补充轮「进入会话」：退出搜索并按平时的方式打开）。 */
  fullView?: boolean;
  /** 任务工作台里打开（任务主会话 / 节点会话）：保留任务上下文——不退出任务模式、
   * 不清任务选中态。其余与打开普通会话完全相同。 */
  keepTaskContext?: boolean;
  /** 节点子代理的会话：它的消息由 use-node-session-reload 从磁盘读最新的一份
   *（缓存往往是上次离开时的半截），这里不读；定位指令照常投递，消息到了才执行。 */
  node?: boolean;
}

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
  scrollMemory: RefObject<Map<string, number | "bottom">>;
  visitedSessions: RefObject<Set<string>>;
  scrollAction: RefObject<{ type: "bottom" } | { type: "restore"; top: number } | null>;
  /** 需求9 补充3：指令投递时同步武装滚动遮蔽（定位完成前内容不上屏）。 */
  armScroll: () => void;
  // 流式标记
  newSessionStreamIdsRef: RefObject<Set<string>>;
  // 任务态重置（切常规会话清任务选中）
  setTaskModeActive: (v: boolean) => void;
  setTaskLaunchOpen: (v: boolean) => void;
  setTaskLaunchReadOnly: (v: boolean) => void;
  taskLaunchOpenRef: RefObject<boolean>;
  taskLaunchPhaseRef: RefObject<TaskLaunchPhase>;
  /** 需求9 #4 补：任务首条 goal（mark_session 建实例即写标题用）。 */
  taskLaunchGoalRef: RefObject<string | null>;
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
  /** 读消息的实现由本钩子填（页面建 ref 是因为节点补读钩子在它之前挂载）。 */
  reloadSessionMessagesRef: RefObject<ReloadSessionMessages>;
  // v0.9.8 需求23：搜索态（见 use-search-lens）——有命中的会话打开时落到命中处；
  // 搜索态下离开会话不记滚动位置。
  isInSearchLens: (sessionId: string) => boolean;
  landsOnSearchHit: (sessionId: string) => boolean;
  jumpToSearchHit: (sessionId: string) => void;
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
    armScroll,
    newSessionStreamIdsRef,
    setTaskModeActive,
    setTaskLaunchOpen,
    setTaskLaunchReadOnly,
    taskLaunchOpenRef,
    taskLaunchPhaseRef,
    taskLaunchGoalRef,
    activeTaskInstanceIdRef,
    activeTaskRequirementFileRef,
    lastKnownStatusRef,
    setActiveTaskInstanceId,
    setActiveTaskRequirementFile,
    setTaskSelectedNodeId,
    setTaskNodeSessionAgentId,
    closeViewer,
    refreshSessionUsageRef,
    reloadSessionMessagesRef,
    isInSearchLens,
    landsOnSearchHit,
    jumpToSearchHit,
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
    // 需求9 #4 补：捕获纯 goal——mark_session 建实例即写标题（单步任务
    // agent 不调 update_steps，步骤上报链不触发）。
    taskLaunchGoalRef.current = message;
    return `/jishu-task dev ${message}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectSessionRef = useRef<(sessionId: string, options?: SelectSessionOptions) => void>(() => {});

  /**
   * 离开当前会话时记下它的滚动位置（下一次打开按这个位置恢复）。
   * v0.9.4 需求7 测试期修复八：滚动记忆语义化——离开时在底部（距底 100px 内，与
   * isAwayFromBottom 同口径）记 "bottom" 而非绝对像素：离开后回合继续追加内容
   *（后台回复/引号重发），回来按旧像素恢复会落在中间旧消息处（用户实测：底部离开
   * 回来定位到历史消息）。
   * v0.9.8 需求23：这个会话正以搜索态显示（只显示命中行）时，此刻的像素位置在完整
   * 列表里没有意义——不记，保留它进入搜索前的位置。
   */
  const noteLeavingSession = useCallback(() => {
    const leaving = selectedSessionRef.current;
    const el = messageAreaRef.current;
    if (!leaving || !el || isInSearchLens(leaving)) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 100;
    devLog("session", "切换会话（离开记录）", { from: leaving, atBottom });
    scrollMemory.current.set(leaving, atBottom ? "bottom" : el.scrollTop);
  }, [messageAreaRef, scrollMemory, selectedSessionRef, isInSearchLens]);

  /**
   * 读一个会话的消息并显示——普通会话、任务主会话、节点会话共用这一份实现。
   * - 缓存优先：流式结束后的缓存里带着交互卡等内容，回放比磁盘上的更完整；
   * - 没有缓存才从磁盘读。节点会话（fresh）例外：它的缓存往往是上次离开时的半截
   *（后台节点的事件不进本视图），先显示缓存避免闪空，随后读磁盘上的最新一份替换；
   * - 会话正在流式输出时，磁盘上已有本轮的用户消息——截掉它及其后，交给流式气泡渲染
   *（v0.8.0 需求7）；
   * - 磁盘读回来时用户可能已经切到别的会话：结果照常记进缓存，但不往屏幕上放。
   */
  reloadSessionMessagesRef.current = (sessionId: string, agentId: string | null, fresh = false): Message[] | Promise<Message[]> => {
    const show = (messages: Message[]) => {
      if (selectedSessionRef.current === sessionId) setSessionMessages(messages);
    };
    const cached = getCachedSessionMessages(sessionId);
    if (cached && !fresh) {
      show(cached);
      return cached;
    }
    if (cached) show(cached);
    return invokeCommand<Message[]>("get_session_messages", {
      agentId: agentId ?? activeId ?? "",
      sessionId,
      encodedName: projectId,
    })
      .then((messages) => {
        let visibleMessages = filterInvisibleUserMessages(messages);
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
        show(visibleMessages);
        return visibleMessages;
      })
      .catch(() => {
        if (!cached) show([]);
        return cached ?? [];
      });
  };

  /**
   * 打开会话——普通会话、任务主会话、节点会话都走这里（v0.9.8 需求24 续）。
   * 做的事只有这一份：清任务态（任务工作台里除外）→ 收起预览 → 记下离开位置 →
   * 改选中态（未读随之清，见 useUnreadClearedOnView）→ 读消息 → 刷新用量 → 定位。
   */
  const handleSelectSession = async (sessionId: string, options?: SelectSessionOptions) => {
    if (!options?.keepTaskContext) {
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
    }
    if (sessionId === selectedSessionRef.current || !projectId) return;

    // v0.8.0 需求4 补充：切换会话自动收起右侧预览——预览的文件属于上一会话
    // 上下文，跨会话保留易误导。同会话重复点击已被上方守卫拦截。
    closeViewer();

    noteLeavingSession();
    const isFirstVisit = !visitedSessions.current.has(sessionId);
    // v0.9.6 需求4 补充⑨「打开会话 = 已读」不在这里做：清未读跟着选中态走
    //（useUnreadClearedOnView，v0.9.8 需求24）。
    setSelectedSession(sessionId);
    selectedSessionRef.current = sessionId;

    // Live steer placeholders keep their per-session keys（渲染按
    // selectedSession 键取，切走不会串显）——不清空：清空会把后台会话
    // 仍排队的引导占位一并抹掉，切回时占位消失、直到插入成功才复现
    //（v0.9.3 需求10 测试期修复：用户实测「切走再回，引导不显示」）。

    // 读消息：有缓存用缓存（流式结束后缓存里带着交互卡等；流式中不重读 JSONL，
    // 否则已落盘的用户消息会和流式气泡各出现一次）。节点会话的消息由
    // use-node-session-reload 读最新的一份，这里不读。
    if (!options?.node) {
      // 缓存里有就同步拿到了；没有缓存才是等磁盘的那一个 Promise
      const loaded = reloadSessionMessagesRef.current(sessionId, null);
      if (loaded instanceof Promise) await loaded;
    }

    // 会话打开即拉取权威用量（含重启后的历史累计）。
    refreshSessionUsageRef.current?.(sessionId);

    if (isFirstVisit) visitedSessions.current.add(sessionId);
    if (!options?.fullView && landsOnSearchHit(sessionId)) {
      // v0.9.8 需求23：搜索态下打开有命中的会话——视图落到第一处命中，由消息视图
      // 当帧定位（搜索跳转信号）。这里不投「到底/恢复」：打开会话的滚动与搜索
      // 导航争同一个位置时，贴底跟随会把视图每帧拉回底部，命中留在屏幕外。
      // 与上面的 setSessionMessages 在同一批更新里——消息视图在消息就绪的那一帧定位。
      armScroll();
      jumpToSearchHit(sessionId);
    } else if (isFirstVisit) {
      armScroll();
      scrollAction.current = { type: "bottom" };
      visitedSessions.current.add(sessionId);
    } else {
      const saved = scrollMemory.current.get(sessionId);
      armScroll();
      scrollAction.current = saved === "bottom"
        ? { type: "bottom" }
        : saved !== undefined
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
    /** 离开当前会话时记滚动位置（任务工作台切到节点占位前也要记——那里不走打开函数）。 */
    noteLeavingSession,
    /** 读一个会话的消息并显示（节点会话补读用）。 */
    reloadSessionMessagesRef,
    prepareTaskLaunchMessage,
    handleMessageSent,
    handleSessionResolved,
  };
}
