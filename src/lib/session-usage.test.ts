import { describe, it, expect, beforeEach } from "vitest";
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
