/**
 * v0.9.6 需求1 完善修复①：乐观压缩分隔线（use-compaction runCompact）。
 * 验证：无活跃流时点击立即压缩 → streamStore 立即出现纯压缩流（乐观
 * divider）；失败回滚 drop；有活跃流时不推（避免污染混合流）。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand: (...args: unknown[]) => invokeMock(...args),
  useInvoke: vi.fn(() => ({ data: null })),
}));

import { useCompaction } from "./use-compaction";
import { streamStore } from "@/hooks/use-stream-store";

const SID = "test-compact-1";

describe("v0.9.6 需求1 完善修复①：乐观压缩分隔线", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamStore.drop(SID);
  });

  it("无活跃流：runCompact 立即推乐观 divider（不等后端 spawn）", async () => {
    invokeMock.mockReturnValue(new Promise(() => {})); // invoke 悬挂（模拟 spawn 长连接）
    const { result } = renderHook(() => useCompaction("jishu-self", true));
    await act(async () => {
      void result.current.runCompact(SID, null);
    });
    // 乐观层立即生效：纯压缩流已起，content 含 compaction divider
    const st = streamStore.getState(SID);
    expect(st).not.toBeNull();
    expect(st?.isStreaming).toBe(true);
    expect(st?.pendingUserMessage).toBeNull();
    expect(
      st?.content.some(b => b.type === "phase_divider" && b.phase === "compaction"),
    ).toBe(true);
  });

  it("失败回滚：invoke reject 且流仍纯压缩 → drop 恢复点击前状态", async () => {
    invokeMock.mockRejectedValue(new Error("连接超时"));
    const { result } = renderHook(() => useCompaction("jishu-self", true));
    await act(async () => {
      await result.current.runCompact(SID, null).catch(() => {});
    });
    expect(streamStore.getState(SID)).toBeNull();
  });

  it("有活跃流（混合流）：不推乐观层（真实事件即刻到，乐观多余）", async () => {
    invokeMock.mockReturnValue(new Promise(() => {}));
    // 预置混合流：pendingUserMessage 非空（真实对话流）
    streamStore.start(SID, "正在进行的用户消息");
    const { result } = renderHook(() => useCompaction("jishu-self", true));
    await act(async () => {
      void result.current.runCompact(SID, null);
    });
    const st = streamStore.getState(SID);
    expect(st?.pendingUserMessage).toBe("正在进行的用户消息");
    expect(
      st?.content.some(b => b.type === "phase_divider"),
    ).toBe(false);
    streamStore.drop(SID);
  });
});

// ── v0.9.8 评审修复轮 R2：压缩进行态按会话隔离 ─────────────────────────────

describe("评审修复轮 R2：压缩进行态按会话隔离", () => {
  const A = "test-compact-session-a";
  const B = "test-compact-session-b";

  beforeEach(() => {
    vi.clearAllMocks();
    streamStore.drop(A);
    streamStore.drop(B);
  });

  it("S9-U1 A 在压缩：只标记 A；B 的压缩请求照常发出，不被 A 的请求拦下", async () => {
    invokeMock.mockReturnValue(new Promise(() => {})); // IPC 悬挂（压缩未返回）
    const { result } = renderHook(() => useCompaction("jishu-self", true));
    await act(async () => {
      void result.current.runCompact(A, null);
    });
    expect(result.current.isCompacting(A)).toBe(true);
    expect(result.current.isCompacting(B)).toBe(false);
    expect(result.current.compactingSessions.has(A)).toBe(true);
    expect(result.current.compactingSessions.has(B)).toBe(false);

    await act(async () => {
      void result.current.runCompact(B, null);
    });
    expect(invokeCommandCalls()).toEqual([
      ["compact_agent_session", expect.objectContaining({ sessionId: A })],
      ["compact_agent_session", expect.objectContaining({ sessionId: B })],
    ]);
    expect(result.current.isCompacting(B)).toBe(true);
  });

  it("S9-U2 同一会话连点两次只发一个请求（同步闸按会话生效）", async () => {
    invokeMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useCompaction("jishu-self", true));
    await act(async () => {
      void result.current.runCompact(A, null);
      void result.current.runCompact(A, null);
    });
    expect(invokeCommandCalls()).toHaveLength(1);
  });

  it("S9-U2 B 的压缩返回：只清 B 的进行态，A 仍在压缩", async () => {
    let finishB: () => void = () => {};
    invokeMock.mockImplementation((_cmd: string, args: { sessionId: string }) =>
      args.sessionId === B ? new Promise<void>((resolve) => { finishB = resolve; }) : new Promise(() => {}));
    const { result } = renderHook(() => useCompaction("jishu-self", true));
    await act(async () => {
      void result.current.runCompact(A, null);
      void result.current.runCompact(B, null);
    });
    await act(async () => {
      finishB();
      await Promise.resolve();
    });
    expect(result.current.isCompacting(A)).toBe(true);
    expect(result.current.isCompacting(B)).toBe(false);
    // 渲染用的快照同样只清了 B（水位环按钮的禁用态读它）
    expect(result.current.compactingSessions.has(A)).toBe(true);
    expect(result.current.compactingSessions.has(B)).toBe(false);
  });

  it("R3-P2-8 用户发起的压缩留标记（取一次即清）；没发起过的会话与做失败的压缩都没有", async () => {
    invokeMock.mockImplementation((_cmd: string, args: { sessionId: string }) =>
      args.sessionId === "s-fail" ? Promise.reject(new Error("没有可压缩的内容")) : new Promise(() => {}));
    const { result } = renderHook(() => useCompaction("jishu-self", true));
    // 没发起过：不是用户发起的压缩（引擎在回合开头自己做的自动压缩）
    expect(result.current.takeCompactionRequest("s-other")).toBe(false);
    await act(async () => {
      void result.current.runCompact(SID, null);
      await result.current.runCompact("s-fail", null).catch(() => {});
    });
    // 做失败的压缩：标记已清（不会有压缩结束事件来取它）
    expect(result.current.takeCompactionRequest("s-fail")).toBe(false);
    // 发起中的压缩：标记在（压缩结束事件可能晚于命令返回，所以留着等事件管线来取）；取走即清
    expect(result.current.takeCompactionRequest(SID)).toBe(true);
    expect(result.current.takeCompactionRequest(SID)).toBe(false);
  });

  function invokeCommandCalls() {
    return invokeMock.mock.calls.filter(([cmd]) => cmd === "compact_agent_session");
  }
});
