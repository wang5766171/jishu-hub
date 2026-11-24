// v0.9.8 评审修复轮 R1-4：回合归属判定（纯函数行为锚定）。
import { describe, expect, it } from "vitest";

import { isSupersededAbort, streamHasTurnContent } from "./turn-ownership";

const EMPTY = { content: [], text: "", thinking: "", tools: [], steps: [], steerTexts: [] };
const WITH_TEXT = { ...EMPTY, text: "半截回复" };

describe("streamHasTurnContent", () => {
  it("无流 / 空流 = 新回合尚未开始；有任何内容即已开始", () => {
    expect(streamHasTurnContent(null)).toBe(false);
    expect(streamHasTurnContent(EMPTY)).toBe(false);
    expect(streamHasTurnContent(WITH_TEXT)).toBe(true);
    expect(streamHasTurnContent({ ...EMPTY, tools: [{}] })).toBe(true);
    expect(streamHasTurnContent({ ...EMPTY, steerTexts: ["引导"] })).toBe(true);
  });
});

describe("isSupersededAbort（迟到的中止回执属于已被取代的旧回合）", () => {
  it("U5-1 标记是旧回合令牌 + 当前流尚无内容 → 属于旧回合", () => {
    expect(isSupersededAbort("Aborted", 2, [1], EMPTY)).toBe(true);
    // 两个键上的标记取任一命中即可（真实 id / 临时键各存一份）
    expect(isSupersededAbort("Aborted", 2, [undefined, 1], EMPTY)).toBe(true);
  });

  it("U5-3 标记就是当前回合（用户停的是当前流）→ 不是被取代的，照常收口", () => {
    expect(isSupersededAbort("Aborted", 2, [2], WITH_TEXT)).toBe(false);
    expect(isSupersededAbort("Aborted", 2, [2], EMPTY)).toBe(false);
  });

  it("U5-4 陈旧标记 + 当前流已有内容（当前回合自己也中止了）→ 照常收口，不误伤", () => {
    expect(isSupersededAbort("Aborted", 2, [1], WITH_TEXT)).toBe(false);
  });

  it("没有标记 / 不是中止回执 / 没有流 → 都不判为被取代", () => {
    expect(isSupersededAbort("Aborted", 2, [undefined], EMPTY)).toBe(false);
    expect(isSupersededAbort("Complete", 2, [1], EMPTY)).toBe(false);
    expect(isSupersededAbort("Aborted", null, [1], EMPTY)).toBe(false);
  });
});
