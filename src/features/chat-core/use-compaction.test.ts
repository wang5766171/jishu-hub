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
