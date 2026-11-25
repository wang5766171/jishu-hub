/**
 * 会话滚动系统单测——v0.9.8 需求23，对应 tests/06-测试清单 S23-U19：
 * 搜索态下不启动贴底跟随。
 *
 * jsdom 不排版：滚动容器的尺寸用属性替身，逐帧回调（requestAnimationFrame）
 * 收进数组里手动执行。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { useChatScroll } from "./use-chat-scroll";
import type { SearchLensInput } from "./use-search-lens";

const message: Message = { role: "user", timestamp: null, content: [{ type: "text", text: "你好" }] };

const frames: FrameRequestCallback[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  frames.length = 0;
});

/** 执行当前排队的帧（每个只跑一次；跑的过程中新排的帧留到下一轮）。 */
function runFrames() {
  const queued = frames.splice(0, frames.length);
  for (const frame of queued) frame(0);
}

function mount() {
  const el = document.createElement("div");
  const size = { scrollHeight: 1000, clientHeight: 500 };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => size.clientHeight });
  // jsdom 给 scrollTop 赋值不会压到可滚动范围内；浏览器会——按浏览器的规矩来
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, size.scrollHeight - size.clientHeight));
    },
  });
  const searchLensInputRef: { current: SearchLensInput } = {
    current: { query: "", selectedSession: "s1", hitSessionIds: new Set() },
  };
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { result, rerender } = renderHook(
    ({ messages }: { messages: Message[] }) =>
      useChatScroll({
        messageAreaRef: { current: el },
        sessionMessages: messages,
        selectedSession: "s1",
        searchLensInputRef,
      }),
    { initialProps: { messages: [] as Message[] } },
  );
  /** 投「到底」指令并让消息到达（指令在消息到达的那一帧被消费）。 */
  const openAtBottom = () => {
    result.current.scrollAction.current = { type: "bottom" };
    rerender({ messages: [message] });
  };
  return { el, size, searchLensInputRef, result, openAtBottom, rerender };
}

describe("useChatScroll · 贴底跟随与搜索态", () => {
  it("非搜索态：「到底」指令滚到底并启动贴底跟随——视图离开底部后被拉回", () => {
    const { el, result, openAtBottom } = mount();
    openAtBottom();
    expect(el.scrollTop).toBe(500); // 到底 = 可滚动范围的末端（1000 - 500）
    // 贴底跟随在跑：内容变高后的下一帧把视图拉回新的底部
    runFrames();
    act(() => {
      el.scrollTop = 300;
    });
    runFrames();
    expect(el.scrollTop).toBeGreaterThan(300);
    expect(result.current.scrollAction.current).toBeNull();
  });

  it("搜索态：「到底」指令照常滚到底，但不启动贴底跟随", () => {
    const { el, searchLensInputRef, openAtBottom } = mount();
    searchLensInputRef.current.query = "关键词";
    openAtBottom();
    expect(el.scrollTop).toBe(500); // 到底 = 可滚动范围的末端
    // 消费这一次排的帧里没有「跟随」帧：跑完一轮没有新帧（跟随帧每轮会再排一帧）
    runFrames();
    expect(frames).toHaveLength(0);
    act(() => {
      el.scrollTop = 300;
    });
    runFrames();
    expect(el.scrollTop).toBe(300);
  });

  it("贴底跟随中进入搜索态：调用停止后不再把视图拉回底部", () => {
    const { el, result, openAtBottom } = mount();
    openAtBottom();
    runFrames();
    act(() => {
      result.current.stopBottomFollow();
      el.scrollTop = 300;
    });
    runFrames();
    expect(el.scrollTop).toBe(300);
    expect(frames).toHaveLength(0);
  });

  it("解除遮蔽：武装后调用解除，滚动容器恢复可见", () => {
    const { el, result } = mount();
    act(() => {
      result.current.armScroll();
    });
    expect(el.style.visibility).toBe("hidden");
    act(() => {
      result.current.disarmScroll();
    });
    expect(el.style.visibility).toBe("");
  });
});

describe("useChatScroll · 恢复位置首帧被压低（v0.9.8 需求24 续）", () => {
  /** 打开一个有滚动记忆的会话：首帧内容还没撑到最终高度，最多只能滚到 280。 */
  const openClamped = () => {
    const h = mount();
    h.size.scrollHeight = 780;
    h.result.current.scrollAction.current = { type: "restore", top: 300 };
    h.rerender({ messages: [message] });
    expect(h.el.scrollTop).toBe(280);
    return h;
  };

  it("只被压低十几像素：内容长出来后也放回原位——S24-U15", () => {
    const h = openClamped();
    h.size.scrollHeight = 1000;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(300);
    expect(h.el.style.visibility).toBe("");
  });
  it("没被压低、直接落到中间位置：标记同样当场为真——S24-U19", () => {
    const h = mount();
    h.result.current.scrollAction.current = { type: "restore", top: 200 };
    h.rerender({ messages: [message] });
    expect(h.el.scrollTop).toBe(200);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
  });

  it("等布局的这几帧里用户自己滚了：停手，不再把视图拽回去——S24-U15", () => {
    const h = openClamped();
    h.size.scrollHeight = 1000;
    // 真实用户的滚动：滚轮事件 + 位置变化
    h.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));
    h.el.scrollTop = 100;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(100);
    expect(h.el.style.visibility).toBe("");
  });

  it("位置被浏览器自己挪了（视口上方的内容撑高，滚动锚定补偿）：不算用户操作，仍放回原位——S24-U21", () => {
    const h = openClamped();
    // 没有滚轮 / 触摸事件，位置却变了——滚动锚定
    h.el.scrollTop = 250;
    h.size.scrollHeight = 1000;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(300);
  });

  it("等待期间换了会话（消息变了）：停手，不把上一个会话的位置按到新会话上，标记按实际位置算——S24-U21", () => {
    const h = openClamped();
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
    // 换了会话：消息数组变了，没有新的定位指令
    h.rerender({ messages: [message, message] });
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(280);
    // 停手之后按停手那一刻的实际位置算：280 在 780 高的内容里就是底部
    expect(h.result.current.isAwayFromBottomRef.current).toBe(false);
    expect(h.el.style.visibility).toBe("");
    expect(frames).toHaveLength(0);
    // 内容随后长到 1000：等待已经停了，不会再把视图按到 300
    h.size.scrollHeight = 1000;
    runFrames();
    expect(h.el.scrollTop).toBe(280);
  });
});

describe("useChatScroll · 恢复位置：内容过了一会儿才长出来（v0.9.8 需求24 续）", () => {
  let clock: { now: number };

  beforeEach(() => {
    // 重试窗口按时间算——测试里时间由这里说了算
    clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 打开一个有滚动记忆的会话：首帧内容还没撑到最终高度，最多只能滚到 280。 */
  const openClamped = () => {
    const h = mount();
    h.size.scrollHeight = 780;
    h.result.current.scrollAction.current = { type: "restore", top: 300 };
    h.rerender({ messages: [message] });
    expect(h.el.scrollTop).toBe(280);
    return h;
  };

  it("内容长出来之前已经过了几十帧（约一秒）：仍在等，长出来就放回原位——S24-U17", () => {
    const h = openClamped();
    // 带任务图的任务：执行卡要等任务图加载完才出现（约 0.8 秒）
    for (let i = 0; i < 60; i++) {
      clock.now += 16;
      runFrames();
    }
    expect(h.el.scrollTop).toBe(280);
    h.size.scrollHeight = 1000;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(300);
    expect(h.el.style.visibility).toBe("");
  });

  it("恢复位置落在中间：「离开底部」的标记当场为真，不等滚动事件——S24-U19", () => {
    const h = openClamped();
    h.size.scrollHeight = 1000;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(300);
    // 标记是别处判断「用户在不在底部」的依据（任务执行流的贴底跟随）；它由滚动事件更新、慢两三帧，
    // 程序性恢复位置的那一刻就得对——否则在这几帧里触发的「贴底」会把刚恢复的位置盖掉
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
  });

  it("恢复还没放到位（内容没撑到目标高度、正在逐帧等）：标记即为真——视图在半路上，不算在底部——S24-U19", () => {
    const h = openClamped();
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
    for (let i = 0; i < 20; i++) {
      clock.now += 16;
      runFrames();
    }
    expect(h.el.scrollTop).toBe(280);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
  });

  it("超过约 3 秒内容还不长：停手，解除遮蔽，标记回到按实际位置算——S24-U17", () => {
    const h = openClamped();
    clock.now = 4000;
    runFrames();
    runFrames();
    expect(frames).toHaveLength(0);
    expect(h.el.style.visibility).toBe("");
    // 停手之后视图就停在当前内容的底部——标记如实为假
    expect(h.result.current.isAwayFromBottomRef.current).toBe(false);
    h.size.scrollHeight = 1000;
    runFrames();
    expect(h.el.scrollTop).toBe(280);
  });
});
