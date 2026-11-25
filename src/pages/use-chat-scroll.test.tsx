/**
 * 会话滚动系统单测——v0.9.8 需求23，对应 tests/06-测试清单 S23-U19：
 * 搜索态下不启动贴底跟随。
 *
 * jsdom 不排版：滚动容器的尺寸用属性替身，逐帧回调（requestAnimationFrame）
 * 收进数组里手动执行。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("等布局的这几帧里用户自己滚了：停手，不再把视图拽回去——S24-U15", () => {
    const h = openClamped();
    h.size.scrollHeight = 1000;
    h.el.scrollTop = 100;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(100);
  });
});
