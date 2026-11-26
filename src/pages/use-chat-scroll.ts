/**
 * use-chat-scroll —— 会话滚动系统（v0.9.7 需求2 补充：chat-page 简化簇A，
 * 自 chat-page.tsx §12 预案迁移，零逻辑变更纯移动）。
 *
 * 职责（原文件 839-996 区域 + 相关 refs/state）：
 * ① scrollAction 指令消费（bottom / restore）——useLayoutEffect 挂消息到达；
 * ② 贴底跟随（rAF × 10s 逐帧，覆盖 markdown/图片后置撑高；用户上翻即解除；
 *   需求9 补充3：自 200ms 轮询收紧——粗步进会露出「停中部再拉底」的滚动）；
 * ③ restore clamp 扩窗重试（渲染窗口化配套：目标在窗口外 → expandSignal）；
 * ④ 滚动事件 rAF 节流 + 离底判定 + 活动轮次计算（turn-rail 高亮数据源）；
 * ⑤ 横杠导航跳转（handleJumpToTurn，窗口外目标双 rAF 扩窗重试）；
 * ⑥ 需求9 补充3：滚动武装遮蔽（armScroll——指令投递到定位完成之间
 *   visibility:hidden，切换的首个可见帧即最终位置，消除多帧滚动闪）。
 *
 * 隐式执行序警示（fix22 教训，迁移时保留原序）：scrollAction 消费 →
 * 消息加载 → 节点会话轮询回填。本 hook 只拥有滚动域；指令的「写入方」
 * （use-session-selection——打开任何会话都走它，v0.9.8 需求24 续）仍经 scrollAction ref
 * 外部投递，
 * 投递时应同步调 armScroll()（遮蔽启动）。
 *
 * v0.9.8 需求23：搜索态（搜索词非空）下不启动贴底跟随——消息列表只显示命中行、
 * 由搜索导航定位，跟随会每帧把视图拉回列表底部。
 *
 * v0.9.8 评审修复轮 R2（O-1～O-4）：「打开后视图停在哪」只有打开函数投的指令这一个
 * 决定方，指令带着它投给的那个会话、在发起读取**之前**就挂好；本 hook 是唯一的消费方，
 * 消费点等消息非空才执行。由此立下三条：
 * - 指令和遮蔽都属于投给它们的那个会话：选中态已经换了别的（新对话、节点占位、
 *   切项目——这些切换不经打开函数），两样都作废，不留给后来的会话。
 * - 「离开底部」标记只有 syncAwayFromBottom 一个写点，程序性定位（到底 / 恢复）之后
 *   当场更新——它是别处判断「用户在不在底部」的依据。
 * - 遮蔽的解除权跟着武装走：一次武装的解除只对那一次有效，上一个会话的放回循环
 *   不会解除新会话的遮蔽。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildTurnSummaries } from "@/components/sessions/turn-rail";
import { isNoSessionSelected } from "@/features/session-kernel/session-placeholder";
import { devLog } from "@/lib/dev-log";
import type { Message } from "@/types";
import type { SearchLensInput } from "./use-search-lens";

/** 恢复滚动位置时，内容还没撑到目标高度的话最多等多久（逐帧重试的时间上限）。 */
const RESTORE_RETRY_MS = 3000;
/** 遮蔽保险：武装之后这么久还没有等到明确的解除点（读取一直不回来、没有谁负责定位），
 * 就不再遮着——内容上屏，退回没有遮蔽时的行为。 */
const ARM_INSURANCE_MS = 800;

/**
 * 滚动指令——「打开后视图停在哪」只由它决定。写入方只有打开函数
 *（use-session-selection），本 hook 在消息就绪的那一帧消费，消费后置 null。
 * sessionId：指令投给的那个会话——消息非空、且正显示的就是它，才执行。
 */
export type ScrollAction =
  | { type: "bottom"; sessionId: string }
  | { type: "restore"; top: number; sessionId: string };

export interface ChatScrollHandle {
  /** 滚动指令（外部写入：bottom / restore；本 hook 消费后置 null）。 */
  scrollAction: RefObject<ScrollAction | null>;
  /** 需求9 补充3：武装滚动遮蔽（写入方投递指令时调用——定位完成前内容
   *  visibility:hidden，消费/超时后恢复；消除「顶部→中部→底部」多帧闪）。
   *  sessionId：这次遮蔽属于哪个会话的打开——选中态离开它，遮蔽就不该再留。
   *  返回「解除这一次武装」的函数：只对这一次有效（期间又被重新武装过则什么都不做）。 */
  armScroll: (sessionId: string) => () => void;
  /** 解除滚动遮蔽（定位由别处完成的打开路径——搜索跳转——定位后调用）。 */
  disarmScroll: () => void;
  /** 停止贴底跟随（进入搜索态时调用）。 */
  stopBottomFollow: () => void;
  /** 离底判定 ref（事件管线/任务 run 增长贴底判定共用，非 React 闭包读）。 */
  isAwayFromBottomRef: RefObject<boolean>;
  /** 离底 state（JSX 消费：滚动到底按钮显隐）。 */
  isAwayFromBottom: boolean;
  /** 活动轮次（turn-rail 高亮）。 */
  activeTurnIndex: number;
  /** 轮次摘要（横杠导航轨数据源）。 */
  turnSummaries: ReturnType<typeof buildTurnSummaries>;
  /** 横杠导航跳转（顶对齐视口顶；窗口外目标扩窗重试）。 */
  handleJumpToTurn: (index: number) => void;
  /** 渲染窗口化扩窗信号（MessageView expandSignal 消费）。 */
  messageExpandSignal: number;
  /** 滚到底按钮动作。 */
  handleScrollToBottom: () => void;
  /** 这个会话最近一次量到的滚动位置（在底部 = "bottom"，否则是像素值）；没量过 = undefined。
   *  离开会话时的位置记录从这里取样本（见 use-session-selection 的 noteLeavingSession）。 */
  lastScrollPositionOf: (sessionId: string) => "bottom" | number | undefined;
  /** 会话没了：它的位置样本一并清掉。 */
  forgetScrollPosition: (sessionId: string) => void;
}

export function useChatScroll({
  messageAreaRef,
  sessionMessages,
  selectedSession,
  searchLensInputRef,
}: {
  messageAreaRef: RefObject<HTMLDivElement | null>;
  sessionMessages: Message[];
  selectedSession: string | null;
  /** 搜索态输入（见 use-search-lens）。渲染期间由页面写入；本 hook 只在消费指令时读搜索词。 */
  searchLensInputRef: RefObject<SearchLensInput>;
}): ChatScrollHandle {
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const [activeTurnIndex, setActiveTurnIndex] = useState(0);
  const [messageExpandSignal, setMessageExpandSignal] = useState(0);
  const isAwayFromBottomRef = useRef(false);
  // v0.9.4 需求7 修复八 / v0.9.6 需求11：贴底跟随（用户主动到底或 bottom 指令
  // 置 true；上翻解除）。v0.9.7 需求9 补充3：跟随步进自 200ms interval 收紧为
  // rAF 逐帧——大回合 markdown/分帧渲染持续撑高期间，粗步进会露出「停在中部
  // 再拉底」的可见滚动（CDP 采样：+72ms h=2942 停中部 → +253ms 才拉底）。
  const bottomFollowRef = useRef(false);
  const bottomFollowTimerRef = useRef<number | null>(null);
  // 需求9 补充3 回归修复：触摸上滑解除跟随的方向判定基准（上一触点 Y）。
  const lastTouchYRef = useRef<number | null>(null);
  const scrollAction = useRef<ScrollAction | null>(null);
  // 二轮评审 R3（P1-1 / P2-3）：每个会话最近一次量到的位置，按会话记。离开记录取这里的值——
  // 离开那一刻不能现量：切到别的会话时 DOM 已经是下一个会话的，页面卸载时消息区早已摘掉。
  // 这个会话的定位指令还挂着没执行（读盘 / 节点补读期间）时不记：那时屏幕上是空的，不是它的位置。
  const lastPositionRef = useRef(new Map<string, "bottom" | number>());
  // v0.9.8 需求24 续：恢复位置的等待期间（首帧内容没撑到目标高度、逐帧再试）靠这三样判断「停手」。
  // - 用户动过：按滚轮 / 触摸 / 拖滚动条判断（与贴底跟随同一口径），另加横杠跳转与滚到底按钮，
  //   **不按位置变化判断**——
  //   视口上方的内容撑高时，浏览器的滚动锚定自己就会挪动滚动位置，那不是用户操作
  //  （实测带任务图的任务回来时因此放弃放回，停在半路）。
  // - 换了会话 / 来了新内容（消息数组变了）：不再把上一个会话的位置按到新内容上。
  // - 来了新的定位指令：以新的为准。
  const userScrollAtRef = useRef(0);
  const lastMessagesRef = useRef<Message[]>(sessionMessages);
  const restoreGenRef = useRef(0);
  /** 恢复位置还在等待（首帧被压低、逐帧再试）——这期间视图在半路上，不算在底部。 */
  const restorePendingRef = useRef(false);
  /**
   * 「离开底部」标记的唯一写点。它是别处判断「用户在不在底部」的依据（任务执行段的自动滚动、
   * 流式输出的贴底）：恢复位置还在等待期间恒为真，其余按此刻的实际位置算。
   */
  const syncAwayFromBottom = useCallback((el: HTMLElement) => {
    isAwayFromBottomRef.current = restorePendingRef.current || el.scrollHeight - el.scrollTop - el.clientHeight > 100;
  }, []);

  // ── 需求9 补充3：滚动武装遮蔽 ──
  // 指令投递（armScroll）到定位完成（消费 layoutEffect）之间，消息区
  // visibility:hidden——定位过程（空→部分高度 clamp→全高）的中间帧全部
  // 不上屏，首个可见帧即最终位置（直出，无滚动无闪）。直改 DOM（不经
  // React state）：arm 与消费都在渲染临界区，state 提交反而引入额外帧。
  const scrollArmedRef = useRef(false);
  /** 这次遮蔽属于哪个会话的打开。 */
  const armOwnerRef = useRef<string | null>(null);
  /** 武装的代号：每武装一次加一，解除函数靠它认「还是不是我这同一次武装」。 */
  const armGenRef = useRef(0);
  const armScrollTimerRef = useRef<number | null>(null);
  const disarmScroll = useCallback(() => {
    scrollArmedRef.current = false;
    armOwnerRef.current = null;
    if (armScrollTimerRef.current !== null) {
      window.clearTimeout(armScrollTimerRef.current);
      armScrollTimerRef.current = null;
    }
    if (messageAreaRef.current) messageAreaRef.current.style.visibility = "";
  }, [messageAreaRef]);
  /** 保险重新计时。放回循环还在等（合法的等待最长 RESTORE_RETRY_MS，比保险时长长）时逐次续期。 */
  const renewArmInsurance = useCallback(() => {
    if (armScrollTimerRef.current !== null) window.clearTimeout(armScrollTimerRef.current);
    armScrollTimerRef.current = window.setTimeout(() => {
      armScrollTimerRef.current = null;
      if (scrollArmedRef.current) disarmScroll();
    }, ARM_INSURANCE_MS);
  }, [disarmScroll]);
  /** 解除某一次武装：只对那一次有效——期间被重新武装过（又打开了一个会话），解除权已经不在它手上。 */
  const releaseArm = useCallback((gen: number) => {
    if (gen !== 0 && gen === armGenRef.current && scrollArmedRef.current) disarmScroll();
  }, [disarmScroll]);
  const armScroll = useCallback((sessionId: string) => {
    const gen = ++armGenRef.current;
    armOwnerRef.current = sessionId;
    scrollArmedRef.current = true;
    if (messageAreaRef.current) messageAreaRef.current.style.visibility = "hidden";
    renewArmInsurance();
    return () => releaseArm(gen);
  }, [messageAreaRef, renewArmInsurance, releaseArm]);

  /** 停止贴底跟随：正在跑的跟随帧作废，之后内容变高不再把视图拉回底部。 */
  const stopBottomFollow = useCallback(() => {
    bottomFollowRef.current = false;
    if (bottomFollowTimerRef.current !== null) {
      cancelAnimationFrame(bottomFollowTimerRef.current);
      bottomFollowTimerRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    // 恢复位置的等待循环靠它认「换了会话 / 来了新内容」——没有新指令时也要更新，所以放在最前面
    lastMessagesRef.current = sessionMessages;
    const el = messageAreaRef.current;
    // 指令与遮蔽都属于投给它们的那个会话（见 ScrollAction）。读盘期间用户去了别处——新对话、
    // 节点占位、切项目、切智能体——这些切换不经打开函数，没人替上一条指令收尾：选中态已经不是
    // 那个会话，指令作废、遮蔽解除，不留给后来显示的会话。
    if (scrollAction.current && scrollAction.current.sessionId !== selectedSession) scrollAction.current = null;
    if (scrollArmedRef.current && armOwnerRef.current !== selectedSession) disarmScroll();
    if (!scrollAction.current || !el) return;
    // v0.9.2 测试期修复：消息未加载时消费滚动指令 → scrollHeight=0 → 定位到
    // 顶部而非底部。等待 sessionMessages 非空后再执行（restore 同理）。
    if (sessionMessages.length === 0) return;
    const action = scrollAction.current;
    scrollAction.current = null;
    // 恢复位置的等待循环靠下面的代号认「来了新的定位指令」
    const generation = ++restoreGenRef.current;
    restorePendingRef.current = false;
    // 遮蔽解除时机（需求9 补充3 二轮）：**延到定位动作落定后**——bottom 在
    // rAF 首轮跟随拉底之后（内容分帧撑高的半成品高度帧不上屏）；restore
    // clamp 扩窗在双 rAF 重设之后；常规 restore 消费帧即解除。实测：消费即
    // 解除会在「半高 clamp → 全高 → rAF 拉底」间露出 1-2 帧中部位置闪。
    // 解除的是「此刻这一次武装」：之后循环收尾时只解除它，不动后来的武装。
    const armedGen = scrollArmedRef.current ? armGenRef.current : 0;
    const disarmIfArmed = () => releaseArm(armedGen);
    // v0.9.8 需求23：搜索态下不启动贴底跟随（列表由搜索导航定位）——照常滚到底，只是不跟随。
    bottomFollowRef.current = action.type === "bottom" && !searchLensInputRef.current.query.trim();
    devLog("session", "scrollAction 消费", { type: action.type, top: action.type === "restore" ? action.top : undefined });
    if (action.type === "bottom") {
      el.scrollTop = el.scrollHeight;
      // 「离开底部」标记当场更新。它可能还是上一个会话留下的「真」（用户是往上翻着离开的）：
      // 不更新，下面贴底循环的第一帧就按它自停，连遮蔽都不解除；而消费点这一次赋值只落在当前
      // 渲染出来的高度上，内容继续撑高就没人跟了——从一个往上翻着的会话切过来，新会话停在顶部。
      syncAwayFromBottom(el);
      if (!bottomFollowRef.current) {
        disarmIfArmed();
        return;
      }
      // v0.9.6 需求11：贴底跟随由消费点直接启动——原独立 effect 挂在
      // [selectedSession] 上，而消息异步晚于 selectedSession 到达：轮询
      // effect 执行时 bottomFollowRef 尚为 false 直接 return「死亡」。
      // rAF × 10s：覆盖一切撑高来源；用户上翻即刻解除。
      if (bottomFollowTimerRef.current !== null) {
        cancelAnimationFrame(bottomFollowTimerRef.current);
      }
      const t0 = Date.now();
      let disarmed = false;
      const follow = () => {
        if (!bottomFollowRef.current || isAwayFromBottomRef.current || Date.now() - t0 > 10_000) {
          bottomFollowTimerRef.current = null;
          return;
        }
        const el = messageAreaRef.current;
        if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
          el.scrollTop = el.scrollHeight;
        }
        // 首轮拉底完成后解除遮蔽（先滚到当帧高度、再上屏）。
        if (!disarmed) { disarmed = true; disarmIfArmed(); }
        bottomFollowTimerRef.current = requestAnimationFrame(follow);
      };
      bottomFollowTimerRef.current = requestAnimationFrame(follow);
    } else {
      el.scrollTop = action.top;
      // v0.9.4 性能优化配套（渲染窗口化）：restore 的绝对像素基于全量渲染
      // 时代的高度，窗口化后 scrollHeight 偏小会被 clamp 到底——检测到
      // clamp 即 bump expandSignal 扩全窗，下一帧重设原位置。
      const maxTop = el.scrollHeight - el.clientHeight;
      // v0.9.8 需求24 续：「离开底部」标记当场更新（见 syncAwayFromBottom）。它是别处判断
      //「用户在不在底部」的依据（任务执行段的自动滚动）；原来只靠滚动事件更新、慢两三帧，
      // 程序性恢复位置之后的那几帧里触发的「滚到底」会把刚恢复的位置盖掉。
      // 恢复还没放到位（被压低、要逐帧等内容长出来）期间保持为真：视图在半路上，不算在底部——
      // 实测带任务图的任务回来时，视图先被压到当前内容的底部，任务图加载完触发的「进入执行段
      // 拉到底」就把它拽走了。
      restorePendingRef.current = action.top > maxTop;
      syncAwayFromBottom(el);
      // v0.9.8 需求24 续：被压低就不分大小。首帧内容还没撑到最终高度时，恢复的位置会被
      // 浏览器悄悄压低十几个像素，之后内容长出来也不动（实测切走再回来差 14 像素）。
      // 压低超过 50 像素的多半是目标在渲染窗口之外——额外扩全窗一次。
      if (action.top > maxTop + 50) setMessageExpandSignal((n) => n + 1);
      if (action.top > maxTop) {
        // 等布局稳定再放回原位；内容还在长就逐帧再试，最多 RESTORE_RETRY_MS。用户已经动过就停手。
        // 按时间算而不是按帧数：带任务图的任务，内容要等任务图加载完才长出来（约 0.8 秒），
        // 按帧数只试约半秒就放弃了，恢复的位置永远放不回去。
        const giveUpAt = performance.now() + RESTORE_RETRY_MS;
        const startedAt = performance.now();
        const messagesAtStart = sessionMessages;
        const place = () => {
          const el2 = messageAreaRef.current;
          if (!el2) return;
          if (generation !== restoreGenRef.current || scrollAction.current !== null) {
            // 来了新的定位指令（新会话已经消费，或者指令已投、消息还没到）：这里的一切归它管。
            // 「恢复未到位」的标记、遮蔽都不动——否则会把新会话的等待保护清掉、把它的遮蔽提前解除。
            return;
          }
          // 换了会话或来了新内容（没有新的定位指令）/ 用户滚轮 / 触摸 / 拖了滚动条 / 点了跳转：
          // 不再把视图挪到原位；标记按此刻的实际位置算
          if (lastMessagesRef.current !== messagesAtStart || userScrollAtRef.current > startedAt) {
            restorePendingRef.current = false;
            syncAwayFromBottom(el2);
            disarmIfArmed();
            return;
          }
          // 还在等：遮蔽的保险跟着续期（等待时长比保险时长长，不续期会先露出半路位置再跳回）
          if (scrollArmedRef.current) renewArmInsurance();
          const top = Math.min(action.top, el2.scrollHeight - el2.clientHeight);
          el2.scrollTop = top;
          if (top < action.top - 1 && performance.now() < giveUpAt) {
            // 还没放到位：继续等
            syncAwayFromBottom(el2);
            requestAnimationFrame(place);
          } else {
            // 放到位了，或等不到：按实际位置算
            restorePendingRef.current = false;
            syncAwayFromBottom(el2);
            disarmIfArmed();
          }
        };
        requestAnimationFrame(() => requestAnimationFrame(place));
      } else {
        disarmIfArmed();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionMessages, selectedSession]);

  // 卸载清理贴底跟随 rAF 与武装遮蔽定时器（防泄漏/防残留隐藏）。
  useEffect(
    () => () => {
      if (bottomFollowTimerRef.current !== null) {
        cancelAnimationFrame(bottomFollowTimerRef.current);
      }
      if (armScrollTimerRef.current !== null) {
        window.clearTimeout(armScrollTimerRef.current);
      }
    },
    [],
  );

  // 轮次摘要（每轮用户问题 + agent 前几句回答）——横杠导航轨的数据源。
  const turnSummaries = useMemo(() => buildTurnSummaries(sessionMessages), [sessionMessages]);

  // 滚动事件（rAF 节流）：离底判定 + 活动轮次计算（全消息 DOM 遍历是滚动
  // 卡顿主因之一，节流后每帧至多一次）。
  // 需求9 补充3 回归修复（2026-11-11 用户实测「往上滚又弹回来」）：贴底
  // 跟随自 200ms interval 收紧为 rAF 逐帧后，与 scroll 事件的 rAF 回调**同
  // 帧竞争**——用户向上滚 <100px 时离底判定尚未置位，跟随每帧先拉回底部，
  // 表现为来回弹滚不动。位置推断不可靠，改**意图判定**：滚轮/触摸向上
  // 即刻解除跟随（不依赖 scroll 位置）。
  useEffect(() => {
    const el = messageAreaRef.current;
    if (!el) return;
    let scrollTicking = false;
    const releaseFollow = () => {
      if (bottomFollowRef.current) {
        devLog("session", "贴底跟随解除（用户滚轮/触摸向上）", {});
        bottomFollowRef.current = false;
      }
    };
    // v0.9.8 需求24 续：这套意图判定同时记下「用户最近一次滚动操作的时刻」——
    // 恢复位置的等待靠它判断用户动过（见 userScrollAtRef）。横杠跳转、滚到底按钮
    // 同样算用户动过（它们不经过这里，各自在动作里记）。
    const onWheel = (e: WheelEvent) => {
      // 只有横向位移的是触控板左右轻扫，不是在竖向滚动，不算
      if (e.deltaY !== 0) userScrollAtRef.current = performance.now();
      if (e.deltaY < 0) releaseFollow();
    };
    const onTouchMove = (e: TouchEvent) => {
      userScrollAtRef.current = performance.now();
      const first = e.touches[0];
      if (!lastTouchYRef.current) {
        lastTouchYRef.current = first.clientY;
        return;
      }
      if (first.clientY > lastTouchYRef.current) releaseFollow(); // 手指下移=内容向上看
      lastTouchYRef.current = first.clientY;
    };
    const onTouchEnd = () => { lastTouchYRef.current = null; };
    // 拖竖向滚动条：按下点落在滚动条槽里（元素外沿与内沿之差就是滚动条宽度）
    const onPointerDown = (e: PointerEvent) => {
      const gutter = el.offsetWidth - el.clientWidth;
      if (gutter > 0 && e.clientX >= el.getBoundingClientRect().right - gutter) {
        userScrollAtRef.current = performance.now();
        releaseFollow();
      }
    };
    const onScroll = () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        scrollTicking = false;
        onScrollWork();
      });
    };
    const onScrollWork = () => {
      const el2 = messageAreaRef.current;
      if (!el2) return;
      const awayFromBottom = el2.scrollHeight - el2.scrollTop - el2.clientHeight > 100;
      syncAwayFromBottom(el2);
      if (selectedSession && !isNoSessionSelected(selectedSession) && scrollAction.current?.sessionId !== selectedSession) {
        lastPositionRef.current.set(selectedSession, awayFromBottom ? el2.scrollTop : "bottom");
      }
      setIsAwayFromBottom(awayFromBottom);
      // 底部恢复贴底跟随解除：用户明确上翻即停（程序性贴底不触发本条件）。
      if (awayFromBottom && bottomFollowRef.current) {
        devLog("session", "贴底跟随解除（用户上翻）", {});
      }
      if (awayFromBottom) bottomFollowRef.current = false;
      // 活动轮次 = 视口顶及以上最后一条用户消息的轮次。边界含容差 +1px
      //（平滑滚动的亚像素偏移）；作用域限定主会话列表（data-turn-scope=
      // "main"）：任务投影/流式气泡/追问占位不参与计数，与横杠列表同序。
      const containerTop = el2.getBoundingClientRect().top;
      let active = 0;
      el2.querySelectorAll<HTMLElement>('[data-turn-scope="main"] [data-turn-index]').forEach((message) => {
        if (message.getBoundingClientRect().top < containerTop + 1) {
          const idx = Number(message.dataset.turnIndex);
          if (!Number.isNaN(idx)) active = Math.max(active, idx);
        }
      });
      setActiveTurnIndex(active);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("pointerdown", onPointerDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSession, sessionMessages]);

  // 横杠导航跳转——滚动到第 index 轮的用户消息行（顶对齐视口顶）；先即时
  // 点亮该轮，滚动侦测随后接管。窗口外目标 → bump expandSignal 扩全窗重试。
  // 这是用户主动换位置：记一笔「用户动过」，恢复位置的等待就此停手，不把它拽回原处。
  const handleJumpToTurn = useCallback(
    (index: number) => {
      const el = messageAreaRef.current;
      if (!el) return;
      userScrollAtRef.current = performance.now();
      setActiveTurnIndex(index);
      const findTarget = () =>
        Array.from(el.querySelectorAll<HTMLElement>('[data-turn-scope="main"] [data-turn-index]')).find(
          (message) => Number(message.dataset.turnIndex) === index,
        );
      // 目标轮次的用户问题顶对齐视口；其后内容不足以撑满视口时滚到最底部。
      const scrollTargetToTop = (t: HTMLElement) => {
        const containerTop = el.getBoundingClientRect().top;
        const desired = el.scrollTop + t.getBoundingClientRect().top - containerTop;
        const maxTop = el.scrollHeight - el.clientHeight;
        el.scrollTo({ top: Math.min(desired, maxTop), behavior: "smooth" });
      };
      const target = findTarget();
      if (!target) {
        setMessageExpandSignal((n) => n + 1);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const t = findTarget();
            if (t) scrollTargetToTop(t);
          });
        });
        return;
      }
      scrollTargetToTop(target);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const lastScrollPositionOf = useCallback(
    (sessionId: string): "bottom" | number | undefined => lastPositionRef.current.get(sessionId),
    [],
  );
  const forgetScrollPosition = useCallback((sessionId: string) => {
    lastPositionRef.current.delete(sessionId);
  }, []);

  // 滚到底按钮：同样是用户主动换位置（恢复位置的等待就此停手）。
  const handleScrollToBottom = useCallback(() => {
    userScrollAtRef.current = performance.now();
    if (messageAreaRef.current) {
      messageAreaRef.current.scrollTo({ top: messageAreaRef.current.scrollHeight, behavior: "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    scrollAction,
    armScroll,
    disarmScroll,
    stopBottomFollow,
    isAwayFromBottomRef,
    isAwayFromBottom,
    activeTurnIndex,
    turnSummaries,
    handleJumpToTurn,
    messageExpandSignal,
    handleScrollToBottom,
    lastScrollPositionOf,
    forgetScrollPosition,
  };
}
