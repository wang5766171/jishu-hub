import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordSessionUsage,
  clearSessionUsage,
  resetAllSessionUsageForTest,
  getSessionUsageSnapshotForTest,
} from "./session-usage";

describe("session-usage", () => {
  beforeEach(() => {
    resetAllSessionUsageForTest();
  });

  it("累加 in/out/cost，context_remaining 取最近值", () => {
    recordSessionUsage("s1", {
      input_tokens: 100,
      output_tokens: 50,
      total_cost: 0.01,
      context_remaining: 9000,
    });
    recordSessionUsage("s1", {
      input_tokens: 200,
      output_tokens: 30,
      total_cost: 0.02,
      context_remaining: 7000,
      context_window_total: 200_000,
    });
    const snap = getSessionUsageSnapshotForTest("s1");
    expect(snap).not.toBeNull();
    expect(snap!.inputTokens).toBe(300);
    expect(snap!.outputTokens).toBe(80);
    expect(Math.abs(snap!.totalCost - 0.03)).toBeLessThan(1e-9);
    expect(snap!.contextRemaining).toBe(7000);
    expect(snap!.contextWindowTotal).toBe(200_000);
  });

  it("context_window_total 缺省时保留上一次值（覆盖语义）", () => {
    recordSessionUsage("s1", { input_tokens: 1, context_window_total: 100_000 });
    recordSessionUsage("s1", { input_tokens: 1, context_remaining: 50_000 });
    const snap = getSessionUsageSnapshotForTest("s1")!;
    expect(snap.contextWindowTotal).toBe(100_000);
    expect(snap.contextRemaining).toBe(50_000);
  });

  it("context_remaining 缺省时保留上一次值", () => {
    recordSessionUsage("s1", { input_tokens: 1, context_remaining: 5000 });
    recordSessionUsage("s1", { input_tokens: 1 });
    expect(getSessionUsageSnapshotForTest("s1")!.contextRemaining).toBe(5000);
  });

  it("空 payload 与全空字段不入账", () => {
    recordSessionUsage("s2", null);
    recordSessionUsage("s2", {});
    expect(getSessionUsageSnapshotForTest("s2")).toBeNull();
  });

  it("会话之间互不影响；清空只作用于目标会话", () => {
    recordSessionUsage("a", { input_tokens: 1 });
    recordSessionUsage("b", { input_tokens: 2 });
    clearSessionUsage("a");
    expect(getSessionUsageSnapshotForTest("a")).toBeNull();
    expect(getSessionUsageSnapshotForTest("b")!.inputTokens).toBe(2);
  });
});

describe("session-usage 持久化（v0.8.0 需求8）", () => {
  beforeEach(() => {
    resetAllSessionUsageForTest();
  });

  it("记录后写入 localStorage；重新加载模块可水合（模拟重启）", async () => {
    recordSessionUsage("s1", {
      input_tokens: 100,
      output_tokens: 40,
      context_remaining: 9000,
      context_window_total: 200_000,
    });
    const raw = window.localStorage.getItem("jishu:session-usage");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { v: number; sessions: Record<string, unknown> };
    expect(parsed.v).toBe(1);
    expect(parsed.sessions.s1).toBeTruthy();

    // 模拟重启：重置模块注册表后重新 import，store 应从 localStorage 水合。
    vi.resetModules();
    const fresh = await import("./session-usage");
    const snap = fresh.getSessionUsageSnapshotForTest("s1");
    expect(snap).not.toBeNull();
    expect(snap!.inputTokens).toBe(100);
    expect(snap!.contextWindowTotal).toBe(200_000);
    fresh.resetAllSessionUsageForTest();
  });

  it("清空会话同步移除持久化条目", async () => {
    recordSessionUsage("s2", { input_tokens: 5 });
    clearSessionUsage("s2");
    const parsed = JSON.parse(window.localStorage.getItem("jishu:session-usage")!) as {
      sessions: Record<string, unknown>;
    };
    expect(parsed.sessions.s2).toBeUndefined();
  });

  it("超出 500 会话时按 updatedAt 保留最新", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    for (let i = 0; i < 501; i++) {
      recordSessionUsage(`s-${i}`, { input_tokens: 1 });
      vi.setSystemTime(1_000_000 + i + 1);
    }
    vi.useRealTimers();
    const parsed = JSON.parse(window.localStorage.getItem("jishu:session-usage")!) as {
      sessions: Record<string, unknown>;
    };
    const ids = Object.keys(parsed.sessions);
    expect(ids.length).toBe(500);
    // 最早记录的 s-0 被裁掉，最新的 s-500 保留。
    expect(parsed.sessions["s-0"]).toBeUndefined();
    expect(parsed.sessions["s-500"]).toBeTruthy();
  });

  it("存储损坏时回退空表，不影响运行期记录", async () => {
    window.localStorage.setItem("jishu:session-usage", "{not-json");
    vi.resetModules();
    const fresh = await import("./session-usage");
    expect(fresh.getSessionUsageSnapshotForTest("s1")).toBeNull();
    fresh.recordSessionUsage("s1", { input_tokens: 7 });
    expect(fresh.getSessionUsageSnapshotForTest("s1")!.inputTokens).toBe(7);
    fresh.resetAllSessionUsageForTest();
  });
});
