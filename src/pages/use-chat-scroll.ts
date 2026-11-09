/**
 * use-chat-scroll —— 会话滚动系统（v0.9.7 需求2 补充：chat-page 简化簇A，
 * 自 chat-page.tsx §12 预案迁移，零逻辑变更纯移动）。
 *
 * 职责（原文件 839-996 区域 + 相关 refs/state）：
 * ① scrollAction 指令消费（bottom / restore）——useLayoutEffect 挂消息到达；
 * ② 贴底跟随（200ms × 10s 短轮询，覆盖 markdown/图片后置撑高；用户上翻即解除）；
 * ③ restore clamp 扩窗重试（渲染窗口化配套：目标在窗口外 → expandSignal）；
 * ④ 滚动事件 rAF 节流 + 离底判定 + 活动轮次计算（turn-rail 高亮数据源）；
 * ⑤ 横杠导航跳转（handleJumpToTurn，窗口外目标双 rAF 扩窗重试）。
 *
 * 隐式执行序警示（fix22 教训，迁移时保留原序）：scrollAction 消费 →
 * 消息加载 → 节点会话轮询回填。本 hook 只拥有滚动域；指令的「写入方」
 * （use-session-selection / 任务会话加载）仍经 scrollAction ref 外部投递。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildTurnSummaries } from "@/components/sessions/turn-rail";
import { devLog } from "@/lib/dev-log";
import type { Message } from "@/types";

export interface ChatScrollHandle {
  /** 滚动指令（外部写入：bottom / restore；本 hook 消费后置 null）。 */
  scrollAction: RefObject<{ type: "bottom" } | { type: "restore"; top: number } | null>;
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
}

export function useChatScroll({
  messageAreaRef,
  sessionMessages,
  selectedSession,
}: {
  messageAreaRef: RefObject<HTMLDivElement | null>;
  sessionMessages: Message[];
  selectedSession: string | null;
}): ChatScrollHandle {
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const [activeTurnIndex, setActiveTurnIndex] = useState(0);
  const [messageExpandSignal, setMessageExpandSignal] = useState(0);
  const isAwayFromBottomRef = useRef(false);
  // v0.9.4 需求7 修复八 / v0.9.6 需求11：贴底跟随（用户主动到底或 bottom 指令
  // 置 true；上翻解除）+ 200ms × 10s 短轮询定时器（消费点直接启动）。
  const bottomFollowRef = useRef(false);
  const bottomFollowTimerRef = useRef<number | null>(null);
  const scrollAction = useRef<{ type: "bottom" } | { type: "restore"; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!scrollAction.current || !messageAreaRef.current) return;
    // v0.9.2 测试期修复：消息未加载时消费滚动指令 → scrollHeight=0 → 定位到
    // 顶部而非底部。等待 sessionMessages 非空后再执行（restore 同理）。
    if (sessionMessages.length === 0) return;
    const action = scrollAction.current;
    scrollAction.current = null;
    bottomFollowRef.current = action.type === "bottom";
    devLog("session", "scrollAction 消费", { type: action.type, top: action.type === "restore" ? action.top : undefined });
    if (action.type === "bottom") {
      messageAreaRef.current.scrollTop = messageAreaRef.current.scrollHeight;
      // v0.9.6 需求11：贴底跟随由消费点直接启动——原独立 effect 挂在
      // [selectedSession] 上，而消息异步晚于 selectedSession 到达：轮询
      // effect 执行时 bottomFollowRef 尚为 false 直接 return「死亡」。
      // 200ms × 10s：覆盖一切撑高来源；用户上翻即刻解除。
      if (bottomFollowTimerRef.current !== null) {
        window.clearInterval(bottomFollowTimerRef.current);
      }
      const t0 = Date.now();
      bottomFollowTimerRef.current = window.setInterval(() => {
        if (!bottomFollowRef.current || isAwayFromBottomRef.current || Date.now() - t0 > 10_000) {
          if (bottomFollowTimerRef.current !== null) {
            window.clearInterval(bottomFollowTimerRef.current);
            bottomFollowTimerRef.current = null;
          }
          return;
        }
        const el = messageAreaRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, 200);
    } else {
      const el = messageAreaRef.current;
      el.scrollTop = action.top;
      // v0.9.4 性能优化配套（渲染窗口化）：restore 的绝对像素基于全量渲染
      // 时代的高度，窗口化后 scrollHeight 偏小会被 clamp 到底——检测到
      // clamp 即 bump expandSignal 扩全窗，下一帧重设原位置。
      const maxTop = el.scrollHeight - el.clientHeight;
      if (action.top > maxTop + 50) {
        setMessageExpandSignal((n) => n + 1);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const el2 = messageAreaRef.current;
            if (el2) el2.scrollTop = Math.min(action.top, el2.scrollHeight - el2.clientHeight);
          });
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionMessages]);

  // 卸载清理贴底跟随定时器（防泄漏）。
  useEffect(
    () => () => {
      if (bottomFollowTimerRef.current !== null) {
        window.clearInterval(bottomFollowTimerRef.current);
      }
    },
    [],
  );

  // 轮次摘要（每轮用户问题 + agent 前几句回答）——横杠导航轨的数据源。
  const turnSummaries = useMemo(() => buildTurnSummaries(sessionMessages), [sessionMessages]);

  // 滚动事件（rAF 节流）：离底判定 + 活动轮次计算（全消息 DOM 遍历是滚动
  // 卡顿主因之一，节流后每帧至多一次）。
  useEffect(() => {
    const el = messageAreaRef.current;
    if (!el) return;
    let scrollTicking = false;
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
      isAwayFromBottomRef.current = awayFromBottom;
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
    return () => el.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSession, sessionMessages]);

  // 横杠导航跳转——滚动到第 index 轮的用户消息行（顶对齐视口顶）；先即时
  // 点亮该轮，滚动侦测随后接管。窗口外目标 → bump expandSignal 扩全窗重试。
  const handleJumpToTurn = useCallback(
    (index: number) => {
      const el = messageAreaRef.current;
      if (!el) return;
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

  const handleScrollToBottom = useCallback(() => {
    if (messageAreaRef.current) {
      messageAreaRef.current.scrollTo({ top: messageAreaRef.current.scrollHeight, behavior: "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    scrollAction,
    isAwayFromBottomRef,
    isAwayFromBottom,
    activeTurnIndex,
    turnSummaries,
    handleJumpToTurn,
    messageExpandSignal,
    handleScrollToBottom,
  };
}
