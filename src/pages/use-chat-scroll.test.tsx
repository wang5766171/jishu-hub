/**
 * 会话滚动系统单测——v0.9.8 需求23，对应 tests/06-测试清单 S23-U19：
 * 搜索态下不启动贴底跟随；v0.9.8 需求24 续 S24-U15/U17/U19/U21。
 *
 * v0.9.8 评审修复轮 R2，对应 docs/v0.9.8/评审修复轮-R2/tests/O-用例清单.md：
 * O1-U6/U7（指令与遮蔽的会话归属、落到底部当场更新标记）、O2-U1/U2（旧放回循环）、
 * O3-U1/U4/U5/U6（遮蔽保险）、O4-U1～U3（「用户动过」的口径）。
 *
 * jsdom 不排版：滚动容器的尺寸用属性替身，逐帧回调（requestAnimationFrame）
 * 收进数组里手动执行；遮蔽保险的定时器收进手写的队列里手动拨时间。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { useChatScroll, type ScrollAction } from "./use-chat-scroll";
import type { SearchLensInput } from "./use-search-lens";

const message: Message = { role: "user", timestamp: null, content: [{ type: "text", text: "你好" }] };

const frames: FrameRequestCallback[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  frames.length = 0;
});

/** 执行当前排队的帧（每个只跑一次；跑的过程中新排的帧留到下一轮）。 */
function runFrames() {
  const queued = frames.splice(0, frames.length);
  for (const frame of queued) frame(0);
}

/**
 * 遮蔽保险用的定时器：收进队列，时间由 clock 说了算（只接管 window.setTimeout——
 * 滚动系统调的就是它；React 调度器在模块加载时已经拿走了原函数，不受影响）。
 */
function manualTimers(clock: { now: number }) {
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void, ms = 0) => {
    pending.set(++seq, { at: clock.now + ms, fn });
    return seq;
  }) as unknown as typeof window.setTimeout);
  vi.spyOn(window, "clearTimeout").mockImplementation(((id?: number) => {
    if (id !== undefined) pending.delete(id);
  }) as unknown as typeof window.clearTimeout);
  return {
    /** 时间走过 ms：中途到点的定时器按到点先后依次执行。 */
    elapse(ms: number) {
      const until = clock.now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock.now = due[1].at;
        pending.delete(due[0]);
        due[1].fn();
      }
      clock.now = until;
    },
  };
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
  const view = renderHook(
    (props: { messages: Message[]; selectedSession: string }) =>
      useChatScroll({
        messageAreaRef: { current: el },
        sessionMessages: props.messages,
        selectedSession: props.selectedSession,
        searchLensInputRef,
      }),
    { initialProps: { messages: [] as Message[], selectedSession: "s1" } },
  );
  /** 投「到底」指令并让消息到达（指令在消息到达的那一帧被消费）。 */
  const openAtBottom = () => {
    view.result.current.scrollAction.current = { type: "bottom", sessionId: "s1" };
    view.rerender({ messages: [message], selectedSession: "s1" });
  };
  return {
    el,
    size,
    searchLensInputRef,
    result: view.result,
    rerender: (messages: Message[], selectedSession = "s1") => view.rerender({ messages, selectedSession }),
    openAtBottom,
  };
}

/** 打开一个有滚动记忆的会话：首帧内容还没撑到最终高度，最多只能滚到 280。 */
function openClamped(h: ReturnType<typeof mount>, top = 300) {
  h.size.scrollHeight = 780;
  h.result.current.scrollAction.current = { type: "restore", top, sessionId: "s1" } satisfies ScrollAction;
  h.rerender([message]);
  expect(h.el.scrollTop).toBe(280);
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
      result.current.armScroll("s1");
    });
    expect(el.style.visibility).toBe("hidden");
    act(() => {
      result.current.disarmScroll();
    });
    expect(el.style.visibility).toBe("");
  });
});

describe("useChatScroll · 指令与遮蔽都属于投给它们的那个会话（v0.9.8 评审修复轮 R2）", () => {
  it("读盘期间去了「新对话」这种不经打开函数的地方：旧指令作废、遮蔽解除——O1-U6", () => {
    const h = mount();
    act(() => {
      h.result.current.armScroll("s1");
    });
    h.result.current.scrollAction.current = { type: "bottom", sessionId: "s1" };
    // 用户点了「新对话」：页面的效果把选中态改成占位、消息清空——没有人再替这条指令收尾
    h.rerender([], "new");
    expect(h.result.current.scrollAction.current).toBeNull();
    expect(h.el.style.visibility).toBe("");
    // 之后显示出来的消息不会被这条旧指令按到底
    h.rerender([message], "new");
    expect(h.el.scrollTop).toBe(0);
  });

  it("遮蔽属于的会话不再显示（搜索跳转的打开没有指令）：同样解除——O1-U6", () => {
    const h = mount();
    act(() => {
      h.result.current.armScroll("s1");
    });
    h.rerender([], "pending-node");
    expect(h.el.style.visibility).toBe("");
  });

  it("还显示着投给它的那个会话：指令与遮蔽都留着（对照）——O1-U6", () => {
    const h = mount();
    act(() => {
      h.result.current.armScroll("s1");
    });
    h.result.current.scrollAction.current = { type: "bottom", sessionId: "s1" };
    h.rerender([]);
    expect(h.result.current.scrollAction.current).toEqual({ type: "bottom", sessionId: "s1" });
    expect(h.el.style.visibility).toBe("hidden");
  });

  it("从往上翻着的会话切到别的会话：消费「到底」指令后标记当场为假，贴底首轮解除遮蔽，内容长高跟到底——O1-U7", () => {
    const h = mount();
    // 上一个会话：按记忆恢复到中间——「离开底部」标记为真（用户是往上翻着离开的）
    h.result.current.scrollAction.current = { type: "restore", top: 200, sessionId: "s1" };
    h.rerender([message]);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);

    // 打开另一个会话（有缓存：消息就绪的同一轮提交里消费）
    act(() => {
      h.result.current.armScroll("s1");
    });
    h.result.current.scrollAction.current = { type: "bottom", sessionId: "s1" };
    h.rerender([message, message]);
    expect(h.el.scrollTop).toBe(500);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(false);
    expect(h.el.style.visibility).toBe("hidden"); // 遮蔽到贴底首轮才解除
    runFrames();
    expect(h.el.style.visibility).toBe("");

    // 内容继续撑高（图片、图表后置加载）：跟到新的底部
    h.size.scrollHeight = 1300;
    runFrames();
    expect(h.el.scrollTop).toBe(800);
  });
});

describe("useChatScroll · 上一个会话的放回循环不碰新会话（v0.9.8 评审修复轮 R2）", () => {
  let clock: { now: number };

  beforeEach(() => {
    // 放回循环的等待按时间算——测试里时间由这里说了算
    clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  });

  /** 时间走过 n 帧（每帧 16 毫秒），帧回调照常执行。 */
  const runFramesFor = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.now += 16;
      runFrames();
    }
  };

  it("上一个会话的放回循环没停就打开了新会话：不动新会话的等待保护、不解除它的遮蔽——O2-U1", () => {
    const h = mount();
    act(() => {
      h.result.current.armScroll("s1");
    });
    // 上一个会话：按记忆恢复、首帧被压低，放回循环已经排帧
    openClamped(h);
    // 打开新会话（有缓存，同一轮提交里消费）：同样被压低——标记为真、遮蔽重新武装
    act(() => {
      h.result.current.armScroll("s1");
    });
    h.result.current.scrollAction.current = { type: "restore", top: 600, sessionId: "s1" };
    h.rerender([message, message]);
    expect(h.el.scrollTop).toBe(280);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
    expect(h.el.style.visibility).toBe("hidden");

    // 旧会话的循环跑到（也已过了旧武装的保险时长）：新会话的标记与遮蔽原样不动
    runFramesFor(8);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
    expect(h.el.style.visibility).toBe("hidden");

    // 新会话的内容长出来：放回它自己的位置，才解除遮蔽
    h.size.scrollHeight = 1200;
    runFramesFor(4);
    expect(h.el.scrollTop).toBe(600);
    expect(h.el.style.visibility).toBe("");
  });

  it("新指令已投、还没消费时旧循环跑到：同样什么都不动——O2-U2", () => {
    const h = mount();
    openClamped(h);
    // 用户打开了另一个要走磁盘的会话：指令已投、遮蔽已武装，消息还没到（不消费）
    act(() => {
      h.result.current.armScroll("s2");
    });
    h.result.current.scrollAction.current = { type: "bottom", sessionId: "s2" };
    h.rerender([], "s2");
    runFramesFor(8);
    expect(h.result.current.scrollAction.current).toEqual({ type: "bottom", sessionId: "s2" });
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
    expect(h.el.style.visibility).toBe("hidden");
  });
});

describe("useChatScroll · 遮蔽保险（v0.9.8 评审修复轮 R2）", () => {
  let clock: { now: number };

  beforeEach(() => {
    clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  });

  /** 走 n 帧（每帧 16 毫秒）：拨一格时间，再执行这一帧的回调。 */
  const runFramesFor = (n: number, timers: { elapse: (ms: number) => void }) => {
    for (let i = 0; i < n; i++) {
      timers.elapse(16);
      runFrames();
    }
  };

  it("恢复位置的等待期比保险时长长：等待期间保险续期，不露出半路位置——O3-U1", () => {
    const h = mount();
    const timers = manualTimers(clock);
    act(() => {
      h.result.current.armScroll("s1");
    });
    openClamped(h);
    // 等待循环逐帧在跑；时间走过 896 毫秒（保险时长 800 毫秒）
    runFramesFor(56, timers);
    expect(clock.now).toBe(896);
    expect(h.el.scrollTop).toBe(280);
    expect(h.el.style.visibility).toBe("hidden");
    // 一路等到 2 秒内容才长出来：放回原位之后才上屏
    runFramesFor(69, timers);
    expect(clock.now).toBe(2000);
    expect(h.el.style.visibility).toBe("hidden");
    h.size.scrollHeight = 1000;
    runFramesFor(4, timers);
    expect(h.el.scrollTop).toBe(300);
    expect(h.el.style.visibility).toBe("");
  });

  it("没有明确解除点时保险仍在：到点解除——O3-U4", () => {
    const h = mount();
    const timers = manualTimers(clock);
    act(() => {
      h.result.current.armScroll("s1");
    });
    expect(h.el.style.visibility).toBe("hidden");
    timers.elapse(799);
    expect(h.el.style.visibility).toBe("hidden");
    timers.elapse(1);
    expect(h.el.style.visibility).toBe("");
  });

  it("解除函数只解除它那一次武装：之后又被重新武装过，解除不生效——O3-U5", () => {
    const h = mount();
    const timers = manualTimers(clock);
    let release = () => {};
    act(() => {
      release = h.result.current.armScroll("s1");
    });
    act(() => {
      h.result.current.armScroll("s1");
    });
    act(() => {
      release();
    });
    expect(h.el.style.visibility).toBe("hidden"); // 新的那次武装不受影响
    // 真正解除它自己那一次武装：立刻可见
    let releaseAgain = () => {};
    act(() => {
      releaseAgain = h.result.current.armScroll("s1");
    });
    act(() => {
      releaseAgain();
    });
    expect(h.el.style.visibility).toBe("");
    timers.elapse(1000);
    expect(h.el.style.visibility).toBe("");
  });

  it("等不到（超过约 3 秒内容还不长）：停手并解除遮蔽，标记回到按实际位置算——O3-U6 / S24-U17", () => {
    const h = mount();
    const timers = manualTimers(clock);
    act(() => {
      h.result.current.armScroll("s1");
    });
    openClamped(h);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
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
    timers.elapse(5000);
    expect(h.el.style.visibility).toBe("");
  });
});

describe("useChatScroll · 「用户动过」的口径（v0.9.8 评审修复轮 R2）", () => {
  let clock: { now: number };

  beforeEach(() => {
    clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  });

  /** jsdom 没有实现元素的 scrollTo：替身直接落到目标位置。 */
  const stubScrollTo = (h: ReturnType<typeof mount>) => {
    h.el.scrollTo = ((options: ScrollToOptions) => {
      h.el.scrollTop = options.top ?? h.el.scrollTop;
    }) as typeof h.el.scrollTo;
  };

  it("恢复等待期点横杠跳转：算用户动过，停手不拽回——O4-U1", () => {
    const h = mount();
    openClamped(h);
    stubScrollTo(h);
    clock.now += 16; // 点击发生在恢复之后
    act(() => {
      h.result.current.handleJumpToTurn(1);
    });
    // 跳转之后用户又停在了别处
    h.el.scrollTop = 50;
    h.size.scrollHeight = 1000;
    for (let i = 0; i < 4; i++) {
      clock.now += 16;
      runFrames();
    }
    expect(h.el.scrollTop).toBe(50);
  });

  it("恢复等待期点「滚到底」按钮：同样停手——O4-U2", () => {
    const h = mount();
    openClamped(h);
    stubScrollTo(h);
    clock.now += 16; // 点击发生在恢复之后
    act(() => {
      h.result.current.handleScrollToBottom();
    });
    h.el.scrollTop = 50;
    h.size.scrollHeight = 1000;
    for (let i = 0; i < 4; i++) {
      clock.now += 16;
      runFrames();
    }
    expect(h.el.scrollTop).toBe(50);
  });

  it("横向触控板轻扫（只有横向位移）不算用户动过：位置被挪了仍放回原位——O4-U3", () => {
    const h = mount();
    openClamped(h);
    // 时间往前走一点：这次轻扫发生在恢复之后
    clock.now += 16;
    h.el.dispatchEvent(new WheelEvent("wheel", { deltaX: 120, deltaY: 0 }));
    h.el.scrollTop = 250;
    h.size.scrollHeight = 1000;
    for (let i = 0; i < 4; i++) {
      clock.now += 16;
      runFrames();
    }
    expect(h.el.scrollTop).toBe(300);
  });

  it("对照：竖向滚轮算用户动过——O4-U4 / S24-U15", () => {
    const h = mount();
    openClamped(h);
    clock.now += 16;
    h.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));
    h.el.scrollTop = 100;
    h.size.scrollHeight = 1000;
    for (let i = 0; i < 4; i++) {
      clock.now += 16;
      runFrames();
    }
    expect(h.el.scrollTop).toBe(100);
  });
});

describe("useChatScroll · 恢复位置首帧被压低（v0.9.8 需求24 续）", () => {
  it("只被压低十几像素：内容长出来后也放回原位——S24-U15", () => {
    const h = mount();
    openClamped(h);
    h.size.scrollHeight = 1000;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(300);
    expect(h.el.style.visibility).toBe("");
  });
  it("没被压低、直接落到中间位置：标记同样当场为真——S24-U19", () => {
    const h = mount();
    h.result.current.scrollAction.current = { type: "restore", top: 200, sessionId: "s1" };
    h.rerender([message]);
    expect(h.el.scrollTop).toBe(200);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
  });

  it("等布局的这几帧里用户自己滚了：停手，不再把视图拽回去——S24-U15", () => {
    const h = mount();
    openClamped(h);
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
    const h = mount();
    openClamped(h);
    // 没有滚轮 / 触摸事件，位置却变了——滚动锚定
    h.el.scrollTop = 250;
    h.size.scrollHeight = 1000;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(300);
  });

  it("等待期间换了会话（消息变了）：停手，不把上一个会话的位置按到新会话上，标记按实际位置算——S24-U21", () => {
    const h = mount();
    openClamped(h);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
    // 换了会话：消息数组变了，没有新的定位指令
    h.rerender([message, message]);
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

  it("内容长出来之前已经过了几十帧（约一秒）：仍在等，长出来就放回原位——S24-U17", () => {
    const h = mount();
    openClamped(h);
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
    const h = mount();
    openClamped(h);
    h.size.scrollHeight = 1000;
    runFrames();
    runFrames();
    expect(h.el.scrollTop).toBe(300);
    // 标记是别处判断「用户在不在底部」的依据（任务执行流的贴底跟随）；它由滚动事件更新、慢两三帧，
    // 程序性恢复位置的那一刻就得对——否则在这几帧里触发的「贴底」会把刚恢复的位置盖掉
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
  });

  it("恢复还没放到位（内容没撑到目标高度、正在逐帧等）：标记即为真——视图在半路上，不算在底部——S24-U19", () => {
    const h = mount();
    openClamped(h);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
    for (let i = 0; i < 20; i++) {
      clock.now += 16;
      runFrames();
    }
    expect(h.el.scrollTop).toBe(280);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(true);
  });

  it("超过约 3 秒内容还不长：停手，标记回到按实际位置算——S24-U17", () => {
    const h = mount();
    openClamped(h);
    clock.now = 4000;
    runFrames();
    runFrames();
    expect(frames).toHaveLength(0);
    expect(h.result.current.isAwayFromBottomRef.current).toBe(false);
    h.size.scrollHeight = 1000;
    runFrames();
    expect(h.el.scrollTop).toBe(280);
  });
});
