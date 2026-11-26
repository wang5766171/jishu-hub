/**
 * 流式气泡的贴底服从滚动系统——v0.9.8 评审修复轮 R2，对应
 * docs/v0.9.8/评审修复轮-R2/tests/O-用例清单.md O5-U1～U5。
 *
 * 背景：气泡原先挂载即无条件拉底，另带一套自己的「用户上翻过」判定（80 像素）。打开一个
 * 正在输出的会话、刚按滚动记忆恢复到中间，气泡一挂载就被拽到底，滚动记忆等于不生效。
 * 现在拉不拉只听滚动系统的「离开底部」标记；调用方没传这个标记时才用组件自己的判定
 *（初值按挂载那一刻的位置定）。
 *
 * 整个组件用真的（与 streaming-message-interaction.test.tsx 同款）：流式状态仓库逐帧通知
 * 订阅者，推入增量后要跑一帧；滚动容器是属性替身：scrollTop 按浏览器的规矩压到可滚动范围内、
 * 不派发滚动事件。
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";
import type { StreamChunk } from "@/types";
import { StreamingMessage } from "./streaming-message";

const sessionId = "session-streaming-scroll";

function chunk(data: StreamChunk["data"]): StreamChunk {
  return { session_id: sessionId, event_type: data.kind, data };
}

function mount({ flag, top }: { flag: boolean | null; top: number }) {
  const el = document.createElement("div");
  const size = { scrollHeight: 1000, clientHeight: 500 };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => size.clientHeight });
  let current = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      current = Math.max(0, Math.min(v, size.scrollHeight - size.clientHeight));
    },
  });
  el.scrollTop = top;
  const scrollContainerRef = { current: el };
  // flag 为 null：调用方没有传滚动系统的标记
  const isAwayFromBottomRef = flag === null ? undefined : { current: flag };
  streamStore.start(sessionId, "问题");
  const view = render(
    <StreamingMessage sessionId={sessionId} scrollContainerRef={scrollContainerRef} isAwayFromBottomRef={isAwayFromBottomRef} />,
  );
  return { el, size, isAwayFromBottomRef, ...view };
}

let frameSeq = 0;
const queued = new Map<number, FrameRequestCallback>();

/** 执行当前排队的帧（跑的过程中新排的帧留到下一轮）。 */
function runFrames() {
  const due = [...queued.values()];
  queued.clear();
  for (const frame of due) frame(0);
}

/** 输出多了一段正文（仓库下一帧才通知，这里把那一帧也跑掉）。 */
const pushText = (delta: string) =>
  act(() => {
    streamStore.push(sessionId, chunk({ kind: "text_delta", delta }));
    runFrames();
  });

beforeEach(() => {
  // 先接管逐帧回调，再动仓库：仓库只允许同时排一帧，排出去的那一帧没人执行的话，
  // 「已排帧」的标记会一直留着，之后再也不通知订阅者。
  frameSeq = 0;
  queued.clear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queued.set(++frameSeq, cb);
    return frameSeq;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queued.delete(id);
  });
  streamStore.drop(sessionId);
  streamStore.flushNow(); // 清掉上一条用例可能留下的「已排帧」标记
});

afterEach(() => {
  streamStore.drop(sessionId);
  vi.unstubAllGlobals();
});

describe("StreamingMessage · 贴底服从滚动系统", () => {
  it("挂载那一拍不拉底：视图按滚动记忆停在中间（标记为「离开底部」）——O5-U1", () => {
    const h = mount({ flag: true, top: 200 });
    expect(h.el.scrollTop).toBe(200);
  });

  it("输出内容更新：滚动系统说不在底部就不拉——O5-U2", () => {
    const h = mount({ flag: true, top: 200 });
    pushText("回复的第一段。");
    expect(h.el.scrollTop).toBe(200);
  });

  it("恢复等待中（标记为真，哪怕此刻停在当前内容的底部）不拉，交给滚动系统放回——O5-U3", () => {
    const h = mount({ flag: true, top: 500 });
    // 视口上方的内容长出来了（执行卡加载完）：视图此刻离底部 300 像素
    h.size.scrollHeight = 1300;
    pushText("回复的第一段。");
    expect(h.el.scrollTop).toBe(500); // 没被拉到 800
  });

  it("在底部时照旧跟到底（回归）——O5-U4", () => {
    const h = mount({ flag: false, top: 500 });
    h.size.scrollHeight = 1300;
    pushText("回复的第一段。");
    expect(h.el.scrollTop).toBe(800);
  });

  it("调用方没传滚动系统的标记：挂载那一刻按位置定——视图停在中间就不拉——O5-U5", () => {
    const h = mount({ flag: null, top: 200 });
    expect(h.el.scrollTop).toBe(200);
    pushText("回复的第一段。");
    expect(h.el.scrollTop).toBe(200);
  });

  it("调用方没传滚动系统的标记：用户上翻过之后不拉；滚回底部附近又跟——O5-U5", () => {
    const h = mount({ flag: null, top: 500 });
    // 用户往上翻：位置变了，随后的滚动事件告诉气泡「不在底部了」
    h.el.scrollTop = 100;
    act(() => {
      h.el.dispatchEvent(new Event("scroll"));
    });
    h.size.scrollHeight = 1300;
    pushText("回复的第一段。");
    expect(h.el.scrollTop).toBe(100);
    // 用户滚回底部附近（80 像素以内）之后又跟上
    h.el.scrollTop = 780;
    act(() => {
      h.el.dispatchEvent(new Event("scroll"));
    });
    h.size.scrollHeight = 1500;
    pushText("回复的第二段。");
    expect(h.el.scrollTop).toBe(1000);
  });
});
