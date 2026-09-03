import { describe, it, expect, beforeEach } from "vitest";
import {
  setSessionUsage,
  clearSessionUsage,
  resetAllSessionUsageForTest,
  getSessionUsageSnapshotForTest,
  type SessionUsage,
} from "./session-usage";

function row(over: Partial<SessionUsage> = {}): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalCost: 0,
    contextRemaining: null,
    contextWindowTotal: null,
    estThinking: 0,
    estText: 0,
    estBuiltinTool: 0,
    estMcpTool: 0,
    estToolResults: 0,
    toolCalls: 0,
    segments: 0,
    compactions: 0,
    updatedAt: 1,
    ...over,
  };
}

describe("session-usage 缓存层（v0.8.0 需求10：SQLite 权威、前端只读缓存）", () => {
  beforeEach(() => {
    resetAllSessionUsageForTest();
  });

  it("整行覆盖写入（后端拉取语义，不做前端累加）", () => {
    setSessionUsage("s1", row({ inputTokens: 300, outputTokens: 80, updatedAt: 1 }));
    setSessionUsage("s1", row({ inputTokens: 500, outputTokens: 120, updatedAt: 2 }));
    const snap = getSessionUsageSnapshotForTest("s1")!;
    expect(snap.inputTokens).toBe(500);
    expect(snap.outputTokens).toBe(120);
    expect(snap.updatedAt).toBe(2);
  });

  it("构成估算与压缩计数字段随行透传", () => {
    setSessionUsage(
      "s1",
      row({ estThinking: 10, estText: 40, estBuiltinTool: 60, estToolResults: 5, compactions: 2, segments: 9 }),
    );
    const snap = getSessionUsageSnapshotForTest("s1")!;
    expect(snap.estBuiltinTool).toBe(60);
    expect(snap.compactions).toBe(2);
    expect(snap.segments).toBe(9);
  });

  it("会话之间互不影响；清空只作用于目标会话", () => {
    setSessionUsage("a", row({ inputTokens: 1 }));
    setSessionUsage("b", row({ inputTokens: 2 }));
    clearSessionUsage("a");
    expect(getSessionUsageSnapshotForTest("a")).toBeNull();
    expect(getSessionUsageSnapshotForTest("b")!.inputTokens).toBe(2);
  });
});
