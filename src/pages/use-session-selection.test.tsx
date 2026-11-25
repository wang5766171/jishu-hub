/**
 * 会话选择钩子单测——v0.9.8 需求23 / 需求24，对应 tests/06-测试清单：
 * S23-U20 搜索态下离开会话不覆盖滚动记忆；
 * S24-U8/U9/U11/U12 任务会话与普通会话走同一个打开函数、读消息只有一份实现。
 *
 * 外部依赖（IPC、事件、日志）全部替身；只看「离开会话时记了什么」与
 * 「打开会话时投了什么滚动指令、显示了什么消息」。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { deleteCachedSessionMessages, getCachedSessionMessages, setCachedSessionMessages } from "@/features/session-kernel/kernel/session-cache";
import { useSessionSelection } from "./use-session-selection";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));
vi.mock("@/lib/dev-log", () => ({ devLog: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function setup({ lensOn }: { lensOn: string | null }) {
  const el = document.createElement("div");
  // 停在会话中部：离底 300（不算在底部）
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });
  el.scrollTop = 200;
  const selectedSessionRef: { current: string | null } = { current: null };
  const scrollMemory = { current: new Map<string, number | "bottom">() };
  const scrollAction: { current: { type: "bottom" } | { type: "restore"; top: number } | null } = { current: null };
  const armScroll = vi.fn();
  const jumpToSearchHit = vi.fn();
  const setSessionMessages = vi.fn();
  const setSelectedSession = vi.fn();
  const closeViewer = vi.fn();
  const refreshSessionUsage = vi.fn();
  const taskSetters = {
    setTaskModeActive: vi.fn(),
    setTaskLaunchOpen: vi.fn(),
    setTaskLaunchReadOnly: vi.fn(),
    setActiveTaskInstanceId: vi.fn(),
    setActiveTaskRequirementFile: vi.fn(),
    setTaskSelectedNodeId: vi.fn(),
    setTaskNodeSessionAgentId: vi.fn(),
  };
  const hook = renderHook(() =>
    useSessionSelection({
      projectId: "p",
      activeId: "a",
      currentProject: null,
      sessions: [],
      setSessionMessages,
      sessionMessagesRef: { current: [] as Message[] },
      setSelectedSession,
      selectedSessionRef,
      messageAreaRef: { current: el },
      scrollMemory,
      visitedSessions: { current: new Set<string>() },
      scrollAction,
      armScroll,
      newSessionStreamIdsRef: { current: new Set<string>() },
      ...taskSetters,
      taskLaunchOpenRef: { current: false },
      taskLaunchPhaseRef: { current: "requirements" },
      taskLaunchGoalRef: { current: null },
      activeTaskInstanceIdRef: { current: null },
      activeTaskRequirementFileRef: { current: null },
      lastKnownStatusRef: { current: null },
      reloadSessionMessagesRef: { current: () => Promise.resolve([]) },
      closeViewer,
      refreshSessionUsageRef: { current: refreshSessionUsage },
      isInSearchLens: (sessionId: string) => lensOn === sessionId,
      landsOnSearchHit: (sessionId: string) => hits.has(sessionId),
      jumpToSearchHit,
    }),
  );
  return {
    ...hook,
    el,
    selectedSessionRef,
    scrollMemory,
    scrollAction,
    armScroll,
    jumpToSearchHit,
    setSessionMessages,
    closeViewer,
    refreshSessionUsage,
    taskSetters,
  };
}

let hits: Set<string>;

const open = async (h: ReturnType<typeof setup>, sessionId: string) => {
  await act(async () => {
    await h.result.current.handleSelectSession(sessionId);
  });
};

const msg = (role: "user" | "assistant", text: string): Message => ({ role, content: [{ type: "text", text }], timestamp: 1 });

beforeEach(() => {
  hits = new Set();
  invokeCommand.mockReset();
  invokeCommand.mockResolvedValue([]);
  // 消息缓存是模块级的——每条用例从没有缓存开始
  for (const id of ["s1", "s2", "s3", "t1", "t2", "n1"]) deleteCachedSessionMessages(id);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useSessionSelection · 搜索态下的滚动位置", () => {
  it("不在搜索态：离开会话时记下它的滚动位置", async () => {
    const h = setup({ lensOn: null });
    await open(h, "s1");
    expect(h.selectedSessionRef.current).toBe("s1");
    await open(h, "s2");
    expect(h.scrollMemory.current.get("s1")).toBe(200);
  });

  it("离开的会话正以搜索态显示：不记（保留它进入搜索前的位置）", async () => {
    const h = setup({ lensOn: "s1" });
    h.scrollMemory.current.set("s1", "bottom");
    await open(h, "s1");
    await open(h, "s2");
    expect(h.scrollMemory.current.get("s1")).toBe("bottom");
  });

  it("打开有命中的会话：不投「到底/恢复」，请求落到命中处；没有命中照旧到底", async () => {
    const h = setup({ lensOn: "s1" });
    hits.add("s2");
    await open(h, "s2");
    expect(h.jumpToSearchHit).toHaveBeenCalledWith("s2");
    expect(h.scrollAction.current).toBeNull();
    expect(h.armScroll).toHaveBeenCalled();
    await open(h, "s3");
    expect(h.jumpToSearchHit).toHaveBeenCalledTimes(1);
    expect(h.scrollAction.current).toEqual({ type: "bottom" });
  });

  it("带「完整视图」标记打开（「进入会话」）：即使有搜索词、该会话有命中，也按平时的方式落位——S23-U26", async () => {
    const h = setup({ lensOn: "s1" });
    hits.add("s2");
    await act(async () => {
      await h.result.current.handleSelectSession("s2", { fullView: true });
    });
    expect(h.jumpToSearchHit).not.toHaveBeenCalled();
    expect(h.scrollAction.current).toEqual({ type: "bottom" });
    // 对照：没带标记时仍然落到命中处
    hits.add("s3");
    await open(h, "s3");
    expect(h.jumpToSearchHit).toHaveBeenCalledWith("s3");
  });
});

describe("useSessionSelection · 任务会话与普通会话走同一个打开函数（需求24 续）", () => {
  it("带「保留任务上下文」打开：不动任务态，其余与普通会话相同——S24-U8", async () => {
    const h = setup({ lensOn: null });
    invokeCommand.mockResolvedValue([msg("user", "任务里的消息")]);
    await act(async () => {
      await h.result.current.handleSelectSession("t1", { keepTaskContext: true });
    });
    for (const [name, fn] of Object.entries(h.taskSetters)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
    expect(h.selectedSessionRef.current).toBe("t1");
    expect(h.closeViewer).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith("get_session_messages", expect.objectContaining({ sessionId: "t1", agentId: "a" }));
    expect(h.setSessionMessages).toHaveBeenCalledWith([msg("user", "任务里的消息")]);
    expect(h.refreshSessionUsage).toHaveBeenCalledWith("t1");
    expect(h.armScroll).toHaveBeenCalled();
    expect(h.scrollAction.current).toEqual({ type: "bottom" });

    // 对照：不带这个标记（打开普通会话）→ 任务态被清
    await open(h, "t2");
    expect(h.taskSetters.setTaskModeActive).toHaveBeenCalledWith(false);
    expect(h.taskSetters.setActiveTaskInstanceId).toHaveBeenCalledWith(null);
    expect(h.taskSetters.setTaskSelectedNodeId).toHaveBeenCalledWith(null);
  });

  it("节点会话：打开函数不读磁盘消息，但刷新用量、投滚动指令照做；补读按给定的智能体读最新——S24-U9", async () => {
    const h = setup({ lensOn: null });
    invokeCommand.mockResolvedValue([msg("user", "节点会话的消息")]);
    await act(async () => {
      await h.result.current.handleSelectSession("n1", { keepTaskContext: true, node: true });
    });
    expect(invokeCommand).not.toHaveBeenCalled();
    expect(h.setSessionMessages).not.toHaveBeenCalled();
    expect(h.selectedSessionRef.current).toBe("n1");
    expect(h.refreshSessionUsage).toHaveBeenCalledWith("n1");
    expect(h.scrollAction.current).toEqual({ type: "bottom" });

    let got: Message[] = [];
    await act(async () => {
      got = await h.result.current.reloadSessionMessagesRef.current("n1", "codex", true);
    });
    expect(invokeCommand).toHaveBeenCalledWith("get_session_messages", expect.objectContaining({ sessionId: "n1", agentId: "codex" }));
    expect(got).toEqual([msg("user", "节点会话的消息")]);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "节点会话的消息")]);
  });

  it("离开会话时：在底部记「底部」，停在中部记当时的高度——S24-U11", async () => {
    const h = setup({ lensOn: null });
    await open(h, "s1");
    await open(h, "s2");
    expect(h.scrollMemory.current.get("s1")).toBe(200);

    h.el.scrollTop = 500; // 1000 - 500：正好在底部
    await open(h, "s3");
    expect(h.scrollMemory.current.get("s2")).toBe("bottom");
  });

  it("读消息只有一份实现：有缓存不读磁盘；强制重读先显示缓存再替换；读失败有缓存就保留——S24-U12", async () => {
    const cached = [msg("user", "缓存里的")];
    setCachedSessionMessages("s1", cached);
    const h = setup({ lensOn: null });
    await open(h, "s1");
    expect(invokeCommand).not.toHaveBeenCalled();
    expect(h.setSessionMessages).toHaveBeenLastCalledWith(cached);

    const latest = [msg("assistant", "磁盘上的最新一条")];
    invokeCommand.mockResolvedValue(latest);
    let got: Message[] = [];
    await act(async () => {
      got = await h.result.current.reloadSessionMessagesRef.current("s1", "a", true);
    });
    // 强制重读：先把缓存显示出来（不闪空），磁盘回来后替换
    expect(h.setSessionMessages).toHaveBeenCalledWith(cached);
    expect(got).toEqual(latest);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith(latest);
    expect(getCachedSessionMessages("s1")).toEqual(latest);

    // 磁盘读失败：有缓存 → 保留缓存里的内容
    invokeCommand.mockRejectedValue(new Error("disk boom"));
    await act(async () => {
      got = await h.result.current.reloadSessionMessagesRef.current("s1", "a", true);
    });
    expect(got).toEqual(latest);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith(latest);

    // 磁盘读失败且没有缓存（打开一个没有缓存的会话）→ 显示空列表，不报错
    invokeCommand.mockRejectedValue(new Error("disk boom"));
    await open(h, "s2");
    expect(h.selectedSessionRef.current).toBe("s2");
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([]);
  });

  it("切走之后才返回的读取结果不覆盖当前会话（缓存照常记下）——S24-U12", async () => {
    const h = setup({ lensOn: null });
    let resolveS2: (v: Message[]) => void = () => {};
    invokeCommand.mockImplementation((_cmd: string, args: { sessionId: string }) =>
      args.sessionId === "s2" ? new Promise<Message[]>((r) => { resolveS2 = r; }) : Promise.resolve([msg("user", "s3 的消息")]),
    );
    let opening: Promise<void> = Promise.resolve();
    act(() => {
      opening = h.result.current.handleSelectSession("s2");
    });
    await open(h, "s3");
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "s3 的消息")]);

    await act(async () => {
      resolveS2([msg("user", "s2 晚到的消息")]);
      await opening;
    });
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "s3 的消息")]);
    expect(getCachedSessionMessages("s2")).toEqual([msg("user", "s2 晚到的消息")]);
  });
});
