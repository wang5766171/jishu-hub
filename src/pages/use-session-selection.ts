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
 * v0.9.8 评审修复轮 R2（用户裁决 5：打开软件进入会话 → 最底部；离开再回来 → 离开的
 * 位置；记忆只在本次运行期）：定位指令在**发起读取之前**挂好，打开函数不等读取结果。
 * 此前指令是等读取回来之后才投的——「显示消息」先一步提交，渲染抢在指令之前完成，
 * 指令落空，应用启动后每个会话的第一次打开空白约 0.8 秒、停在最开头。现在：
 * - 视图停在哪只有打开函数投的指令这一个决定方，指令带着会话归属；
 * - 读盘期间屏幕上不放上一个会话的消息（清空 + 遮蔽），空白不超过读取耗时；
 * - 读取回来之后的收尾（显示消息、刷新用量、搜索跳转）都先复核「用户还停在这个会话上」。
 *
 * 职责边界：本钩子拥有 optimisticSessions 与 conductor 激活标记集合；
 * 会话消息 state（sessionMessages）留在页面（读写面横跨渲染区），经
 * setter/ref 注入。refreshSessionUsage 定义序在钩子之后，经 ref 运行时取用。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { devLog } from "@/lib/dev-log";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "@/hooks/use-invoke";
import { streamStore } from "@/hooks/use-stream-store";
import {
  getCachedSessionMessages,
  setCachedSessionMessages,
} from "@/features/session-kernel/kernel/session-cache";
import { isNoSessionSelected } from "@/features/session-kernel/session-placeholder";
import { logTaskPhaseDebug } from "@/features/task-instance/task-phase-debug";
import { filterInvisibleUserMessages } from "./chat-page-utils";
import type { ScrollAction } from "./use-chat-scroll";
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
  // 滚动/访问记录（页面持有 ref；内存态——关闭软件即清，本次运行期内有效）
  messageAreaRef: RefObject<HTMLDivElement | null>;
  scrollMemory: RefObject<Map<string, number | "bottom">>;
  visitedSessions: RefObject<Set<string>>;
  /** 滚动指令：打开函数是唯一的写入方，滚动系统在消息就绪的那一帧消费。 */
  scrollAction: RefObject<ScrollAction | null>;
  /** 当前选中的会话（选中态变了 / 页面卸载时记下离开的会话的滚动位置）。 */
  selectedSession: string | null;
  /** 滚动系统最近一次量到的某个会话的位置（离开记录的样本）。 */
  lastScrollPositionOf: (sessionId: string) => "bottom" | number | undefined;
  /** 需求9 补充3：指令投递时同步武装滚动遮蔽（定位完成前内容不上屏）。
   *  返回「解除这一次武装」的函数——读到空、装载失败时没有可定位的内容，用它当场解除。 */
  armScroll: (sessionId: string) => () => void;
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
    selectedSession,
    lastScrollPositionOf,
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
   * v0.9.8 评审修复轮 R2：离开的是占位（新对话、节点待定）时不记——它们不是会话，
   * 记下的位置永远没人用，只会留下垃圾条目。
   * 二轮评审 R3（P1-1）：记录只有这一个写点，挂在选中态的变化上（下面的 useLayoutEffect）。
   * 修前只有「点别的会话」「切项目」两条路径记得调它；经「新对话」离开、切到管理页
   *（页面卸载）都不记，回来落在最底部或上一次的旧位置——裁决 5 的「离开再回来进入
   * 离开的位置」只覆盖了两种离开方式。
   * 二轮评审 R3（P2-3）：样本取滚动系统最近一次量到的值，不在离开那一刻现量；这个会话的
   * 定位指令还挂着没执行（读盘 / 节点补读期间就切走了）时不记——那时屏幕上是空的。
   * leaving：离开的那个会话。
   */
  const noteLeavingSession = useCallback((leaving: string | null) => {
    if (!leaving || isNoSessionSelected(leaving) || isInSearchLens(leaving)) return;
    if (scrollAction.current?.sessionId === leaving) return;
    // 这个会话本次运行里还没有过一次完整的显示（读盘 / 节点补读期间就切走了，样本没记过）：
    // 不拿「底部」顶替——那会盖掉它原有的记忆
    const position = lastScrollPositionOf(leaving);
    if (position === undefined) return;
    devLog("session", "离开会话（记下滚动位置）", { session: leaving, position });
    scrollMemory.current.set(leaving, position);
  }, [scrollAction, scrollMemory, isInSearchLens, lastScrollPositionOf]);

  // 选中态从某个会话变成别的（别的会话、新对话、节点占位、切项目后的空），或者页面卸载
  //（切到管理页）：那一刻记下离开的会话的位置。回调经 ref 取最新的，效果本身只在
  // 选中态变化时重跑——别的依赖变了不会被当成「离开了一次」。
  const noteLeavingRef = useRef(noteLeavingSession);
  noteLeavingRef.current = noteLeavingSession;
  useLayoutEffect(() => {
    const leaving = selectedSession;
    return () => noteLeavingRef.current(leaving);
  }, [selectedSession]);

  /** 当前这次遮蔽武装的解除函数（armScroll 的返回值）——读到空、装载失败时用它当场解除。 */
  const armReleaseRef = useRef<(() => void) | null>(null);
  /** 每个会话最新一次读取的序号：读回来时对不上，说明之后又读过一次（换了智能体重读、
   *  重新打开），这次的结果是旧的，不上屏、不进缓存。 */
  const readSeqRef = useRef(new Map<string, number>());
  /** 打开的序号：读盘回来时对不上，说明用户之后又打开过别的会话，这次打开的收尾不再做。 */
  const openSeqRef = useRef(0);

  /**
   * 把读到的消息放上屏。磁盘读回来时用户可能已经切到别的会话：结果照常记进缓存，但不往屏幕上放。
   * 这个会话还挂着没执行的定位指令时，遮蔽跟着消息走：
   * - 有内容：消息上屏的那一帧指令才执行，遮蔽与消息同一批武装（读盘超过了保险时长的话，
   *   遮蔽已经被保险解除过——定位完成前不上屏要靠这里重新武装），定位完成后由滚动系统解除；
   * - 没有内容（空会话、装载失败）：没有可定位的东西，当场解除遮蔽，不等保险。
   */
  const show = (sessionId: string, messages: Message[]) => {
    if (selectedSessionRef.current !== sessionId) return;
    if (scrollAction.current?.sessionId === sessionId) {
      if (messages.length > 0) {
        armReleaseRef.current = armScroll(sessionId);
      } else {
        armReleaseRef.current?.();
        armReleaseRef.current = null;
      }
    }
    setSessionMessages(messages);
  };

  /**
   * 读一个会话的消息并显示——普通会话、任务主会话、节点会话共用这一份实现。
   * - 缓存优先：流式结束后的缓存里带着交互卡等内容，回放比磁盘上的更完整；
   * - 没有缓存才从磁盘读。节点会话（fresh）例外：它的缓存往往是上次离开时的半截
   *（后台节点的事件不进本视图），先显示缓存避免闪空，随后读磁盘上的最新一份替换；
   * - 会话正在流式输出时，磁盘上已有本轮的用户消息——截掉它及其后，交给流式气泡渲染
   *（v0.8.0 需求7）；
   * - 同一个会话读过不止一次时只认最新那一次的结果（两次读可能乱序返回）。
   */
  reloadSessionMessagesRef.current = (sessionId: string, agentId: string | null, fresh = false): Message[] | Promise<Message[]> => {
    const cached = getCachedSessionMessages(sessionId);
    if (cached && !fresh) {
      show(sessionId, cached);
      return cached;
    }
    if (cached) show(sessionId, cached);
    const seq = (readSeqRef.current.get(sessionId) ?? 0) + 1;
    readSeqRef.current.set(sessionId, seq);
    const isLatestRead = () => readSeqRef.current.get(sessionId) === seq;
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
        // 之后又读过一次：这次的结果是旧的，不上屏、不覆盖缓存
        if (!isLatestRead()) return visibleMessages;
        setCachedSessionMessages(sessionId, visibleMessages);
        show(sessionId, visibleMessages);
        return visibleMessages;
      })
      .catch(() => {
        if (!isLatestRead()) return cached ?? [];
        if (!cached) show(sessionId, []);
        return cached ?? [];
      });
  };

  /**
   * 打开会话——普通会话、任务主会话、节点会话都走这里（v0.9.8 需求24 续）。
   * 做的事只有这一份：清任务态（任务工作台里除外）→ 收起预览 → 改选中态（离开位置
   * 随之记下、未读随之清，见 useLayoutEffect 与 useUnreadClearedOnView）→ 挂定位指令 → 读消息。
   *
   * 不等读取结果（v0.9.8 评审修复轮 R2）：定位指令在发起读取**之前**挂好。消费点本来就等
   *「消息非空」才执行——消息在缓存里，指令在消息上屏的同一轮提交里被消费；要走磁盘，
   * 读回来那一帧被消费。等读取回来再投，渲染会抢在指令之前提交，指令落空。
   */
  const handleSelectSession = (sessionId: string, options?: SelectSessionOptions) => {
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

    const isFirstVisit = !visitedSessions.current.has(sessionId);
    // v0.9.6 需求4 补充⑨「打开会话 = 已读」不在这里做：清未读跟着选中态走
    //（useUnreadClearedOnView，v0.9.8 需求24）。
    // 首次访问的登记不依赖读取完成——读盘慢、读到一半切走，它也已经访问过了。
    visitedSessions.current.add(sessionId);
    setSelectedSession(sessionId);
    selectedSessionRef.current = sessionId;

    // Live steer placeholders keep their per-session keys（渲染按
    // selectedSession 键取，切走不会串显）——不清空：清空会把后台会话
    // 仍排队的引导占位一并抹掉，切回时占位消失、直到插入成功才复现
    //（v0.9.3 需求10 测试期修复：用户实测「切走再回，引导不显示」）。

    // ── 定位：打开后视图停在哪只在这里决定 ──
    // 指令带着会话归属：读盘期间用户去了别处（新对话、切项目……这些切换不经这个函数），
    // 滚动系统发现选中的不是它，就把指令作废、解除遮蔽，不会按到后来显示的会话上。
    const landsOnHit = !options?.fullView && landsOnSearchHit(sessionId);
    armReleaseRef.current = armScroll(sessionId);
    if (landsOnHit) {
      // v0.9.8 需求23：搜索态下打开有命中的会话——视图落到第一处命中，由消息视图
      // 当帧定位（搜索跳转信号）。这里不投「到底/恢复」：打开会话的滚动与搜索
      // 导航争同一个位置时，贴底跟随会把视图每帧拉回底部，命中留在屏幕外。
      // 上一个会话还没执行的指令一并撤掉：消费点只认「消息非空」，不撤会按到这个会话的消息上。
      scrollAction.current = null;
    } else {
      const saved = scrollMemory.current.get(sessionId);
      scrollAction.current = isFirstVisit || saved === undefined || saved === "bottom"
        ? { type: "bottom", sessionId }
        : { type: "restore", top: saved, sessionId };
    }

    /** 读取的收尾：读完了、而且用户还停在这个会话上才做。 */
    const settle = () => {
      // 会话打开即拉取权威用量（含重启后的历史累计）。
      refreshSessionUsageRef.current?.(sessionId);
      // 搜索跳转的信号要和消息一起到：消息视图收到信号当场处理，消息还没就绪时发，它定位不到
      if (landsOnHit) jumpToSearchHit(sessionId);
    };

    // ── 读消息 ──
    // 有缓存用缓存（流式结束后缓存里带着交互卡等；流式中不重读 JSONL，
    // 否则已落盘的用户消息会和流式气泡各出现一次）。
    if (options?.node) {
      // 节点会话的消息由 use-node-session-reload 读最新的一份，这里不读；定位指令照常挂着，
      // 消息到了才执行。屏幕上同样先清空——上一个会话的消息不属于这里。
      setSessionMessages([]);
      settle();
      return;
    }
    const loaded = reloadSessionMessagesRef.current(sessionId, null);
    if (!(loaded instanceof Promise)) {
      settle();
      return;
    }
    // 等磁盘：屏幕上不放上一个会话的消息（消息区此刻已遮住），读回来直接落在最终位置。
    setSessionMessages([]);
    const seq = ++openSeqRef.current;
    void loaded.then(() => {
      // 读盘期间用户又打开过别的会话：这次打开的收尾不做（晚到的结果除了进缓存不留痕迹）
      if (openSeqRef.current !== seq || selectedSessionRef.current !== sessionId) return;
      settle();
    });
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
    /** 读一个会话的消息并显示（节点会话补读用）。 */
    reloadSessionMessagesRef,
    prepareTaskLaunchMessage,
    handleMessageSent,
    handleSessionResolved,
  };
}
