/**
 * 节点会话补读钩子单测——v0.9.8 需求24 续，对应 tests/06-测试清单 S24-U13。
 *
 * 打开任何会话都走同一个打开函数之后，节点子代理的会话只剩「数据晚到」时要补读：
 * 进入后总从磁盘读最新；读到空隔 1.5 秒重试、最多 3 次；绑定的智能体回填后按它重读。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { useNodeSessionReload } from "./use-node-session-reload";

type Reload = (sessionId: string, agentId: string | null, fresh?: boolean) => Promise<Message[]>;

type Overrides = Partial<Parameters<typeof useNodeSessionReload>[0]>;

function setup(overrides: Overrides = {}, readResult: Message[] = [msg("有内容")]) {
  const reload = vi.fn<Reload>().mockResolvedValue(readResult);
  const hook = renderHook((props) => useNodeSessionReload({ taskModeActive: true, selectedSession: "node-sess", projectId: "p", taskSelectedNodeId: "node-1", taskNodeSessionAgentId: null, activeId: "a", streamTextStarted: false, reloadSessionMessagesRef: { current: reload }, ...props }), {
    initialProps: overrides,
  });
  return { ...hook, reload };
}

const msg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useNodeSessionReload · 节点会话的数据晚到补读", () => {
  it("进入节点会话：按当前智能体从磁盘读最新（强制重读）", async () => {
    const h = setup();
    await advance(0);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledWith("node-sess", "a", true);
  });

  it("读到空：隔 1.5 秒重试，最多 3 次，然后停", async () => {
    const h = setup({}, []);
    await advance(0);
    expect(h.reload).toHaveBeenCalledTimes(1);
    await advance(1500);
    expect(h.reload).toHaveBeenCalledTimes(2);
    await advance(1500);
    expect(h.reload).toHaveBeenCalledTimes(3);
    await advance(1500);
    expect(h.reload).toHaveBeenCalledTimes(4);
    await advance(10_000);
    expect(h.reload).toHaveBeenCalledTimes(4);
  });

  it("读到内容：不再重试", async () => {
    const h = setup();
    await advance(10_000);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("绑定的智能体回填：按绑定的智能体重读", async () => {
    const h = setup();
    await advance(0);
    h.rerender({ taskNodeSessionAgentId: "codex" } as Overrides);
    await advance(0);
    expect(h.reload).toHaveBeenCalledTimes(2);
    expect(h.reload).toHaveBeenLastCalledWith("node-sess", "codex", true);
  });

  it("重试途中切走：不再继续重试", async () => {
    const h = setup({}, []);
    await advance(0);
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.rerender({ taskSelectedNodeId: null } as Overrides);
    await advance(10_000);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("不是节点会话（任务主会话）、还没回填（占位）：不补读", async () => {
    const a = setup({ taskSelectedNodeId: null });
    await advance(10_000);
    expect(a.reload).not.toHaveBeenCalled();
    a.unmount();
    const b = setup({ selectedSession: "pending-node" });
    await advance(10_000);
    expect(b.reload).not.toHaveBeenCalled();
  });
});
