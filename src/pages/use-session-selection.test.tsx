/**
 * 会话选择钩子单测——v0.9.8 需求23 / 需求24，对应 tests/06-测试清单：
 * S23-U20 搜索态下离开会话不覆盖滚动记忆；
 * S24-U8/U9/U11/U12 任务会话与普通会话走同一个打开函数、读消息只有一份实现。
 *
 * v0.9.8 评审修复轮 R2，对应 docs/v0.9.8/评审修复轮-R2/tests/O-用例清单.md：
 * O1-U2/U3/U5/U9/U10/U12（指令在读取之前挂好、不等读取结果、晚到的结果不留痕迹）、
 * O6-U1（占位态不记离开位置）、O10-U2/U3（读取按次序认最新结果、日志补 to）。
 *
 * 外部依赖（IPC、事件、日志）全部替身；只看「离开会话时记了什么」与
 * 「打开会话时投了什么滚动指令、显示了什么消息」。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { deleteCachedSessionMessages, getCachedSessionMessages, setCachedSessionMessages } from "@/features/session-kernel/kernel/session-cache";
import { devLog } from "@/lib/dev-log";
import { useSessionSelection, type SelectSessionOptions } from "./use-session-selection";

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
  const visitedSessions = { current: new Set<string>() };
  const scrollAction: { current: Parameters<typeof useSessionSelection>[0]["scrollAction"]["current"] } = { current: null };
  const armScroll = vi.fn();
  const jumpToSearchHit = vi.fn();
  const setSessionMessages = vi.fn();
  // 选中态：页面里是 state；这里记在台子上，open() 之后重渲染一次把变化提交上去
  //（离开记录挂在选中态的变化上——二轮评审 R3 P1-1）
  const selected = { value: null as string | null };
  const setSelectedSession = (id: string | null) => {
    selected.value = id;
  };
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
      visitedSessions,
      scrollAction,
      selectedSession: selected.value,
      // 滚动系统的位置样本：这里没有真的滚动系统，按元素此刻的位置给
      lastScrollPositionOf: () => (el.scrollHeight - el.scrollTop - el.clientHeight <= 100 ? "bottom" : el.scrollTop),
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
    visitedSessions,
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

const open = async (h: ReturnType<typeof setup>, sessionId: string, options?: SelectSessionOptions) => {
  await act(async () => {
    await h.result.current.handleSelectSession(sessionId, options);
  });
  // 选中态变了：提交这一轮（真实页面里由 React 自己提交），离开记录随之发生
  await act(async () => {
    h.rerender();
  });
};

const msg = (role: "user" | "assistant", text: string): Message => ({ role, content: [{ type: "text", text }], timestamp: 1 });

/** 让之后的读盘都挂起；settle 放回其中一次（按发起顺序从 0 数）——两次读可以乱序返回。 */
function holdReads() {
  const resolvers: ((v: Message[]) => void)[] = [];
  invokeCommand.mockImplementation(() => new Promise<Message[]>((r) => { resolvers.push(r); }));
  return {
    settle: async (index: number, messages: Message[]) => {
      await act(async () => {
        resolvers[index](messages);
      });
    },
  };
}

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

  it("打开有命中的会话：不投「到底/恢复」，请求落到命中处；没有命中照旧到底——S23-U20", async () => {
    const h = setup({ lensOn: "s1" });
    setCachedSessionMessages("s2", [msg("user", "s2 的消息")]);
    hits.add("s2");
    await open(h, "s2");
    expect(h.jumpToSearchHit).toHaveBeenCalledWith("s2");
    expect(h.scrollAction.current).toBeNull();
    expect(h.armScroll).toHaveBeenCalledWith("s2");
    setCachedSessionMessages("s3", [msg("user", "s3 的消息")]);
    await open(h, "s3");
    expect(h.jumpToSearchHit).toHaveBeenCalledTimes(1);
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s3" });
  });

  it("带「完整视图」标记打开（「进入会话」）：即使有搜索词、该会话有命中，也按平时的方式落位——S23-U26", async () => {
    const h = setup({ lensOn: "s1" });
    setCachedSessionMessages("s2", [msg("user", "s2 的消息")]);
    setCachedSessionMessages("s3", [msg("user", "s3 的消息")]);
    hits.add("s2");
    await open(h, "s2", { fullView: true });
    expect(h.jumpToSearchHit).not.toHaveBeenCalled();
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s2" });
    // 对照：没带标记时仍然落到命中处
    hits.add("s3");
    await open(h, "s3");
    expect(h.jumpToSearchHit).toHaveBeenCalledWith("s3");
  });
});

describe("useSessionSelection · 打开后视图停在哪只由打开函数决定（v0.9.8 评审修复轮 R2）", () => {
  it("打开函数不等读取结果：调用返回那一刻选中态已改、首次访问已登记、指令已挂好、遮蔽已武装；用量刷新等读完了再做——O1-U2", async () => {
    const h = setup({ lensOn: null });
    const held = holdReads();
    let returned: unknown = "还没返回";
    act(() => {
      returned = h.result.current.handleSelectSession("s1");
    });
    expect(returned).toBeUndefined(); // 同步返回——没有等读取
    expect(h.selectedSessionRef.current).toBe("s1");
    expect(h.visitedSessions.current.has("s1")).toBe(true);
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s1" });
    expect(h.armScroll).toHaveBeenCalledTimes(1);
    expect(h.armScroll).toHaveBeenCalledWith("s1");
    expect(h.setSessionMessages).toHaveBeenCalledWith([]); // 读盘期间屏幕上没有内容
    expect(h.refreshSessionUsage).not.toHaveBeenCalled();
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    await held.settle(0, [msg("user", "读回来的")]);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "读回来的")]);
    // 内容上屏时遮蔽与消息同一批武装（指令此刻才执行）
    expect(h.armScroll).toHaveBeenCalledTimes(2);
    expect(h.refreshSessionUsage).toHaveBeenCalledTimes(1);
    expect(h.refreshSessionUsage).toHaveBeenCalledWith("s1");
  });

  it("读盘期间屏幕上不放上一个会话的消息——O1-U3", async () => {
    const h = setup({ lensOn: null });
    setCachedSessionMessages("s1", [msg("user", "s1 的消息")]);
    await open(h, "s1");
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "s1 的消息")]);

    const held = holdReads();
    act(() => {
      h.result.current.handleSelectSession("s2");
    });
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([]);

    await held.settle(0, [msg("user", "s2 的消息")]);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "s2 的消息")]);
  });

  it("读盘期间切到别的会话：晚到的结果不留任何痕迹（缓存照常记下）——O1-U5 / S24-U12", async () => {
    const h = setup({ lensOn: null });
    setCachedSessionMessages("s3", [msg("user", "s3 的消息")]);
    const held = holdReads();
    act(() => {
      h.result.current.handleSelectSession("s2");
    });
    // s2 自己的遮蔽与指令（读盘之前就挂好）
    expect(h.armScroll).toHaveBeenCalledTimes(1);
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s2" });

    // 读盘还没回来，用户点开了有缓存的 s3：s3 的遮蔽与指令（消息上屏时遮蔽再武装一次），
    // 同一次提交里消费
    await open(h, "s3");
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "s3 的消息")]);
    expect(h.armScroll.mock.calls.map((call) => call[0])).toEqual(["s2", "s3", "s3"]);
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s3" });

    // s2 这才读回来：只进缓存——屏幕、指令、遮蔽、用量刷新都没动
    await held.settle(0, [msg("user", "s2 晚到的消息")]);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "s3 的消息")]);
    expect(h.armScroll.mock.calls.map((call) => call[0])).toEqual(["s2", "s3", "s3"]);
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s3" });
    expect(h.refreshSessionUsage).not.toHaveBeenCalledWith("s2");
    expect(h.refreshSessionUsage).toHaveBeenCalledWith("s3");
    expect(getCachedSessionMessages("s2")).toEqual([msg("user", "s2 晚到的消息")]);
  });

  it("读盘期间离开后又回到同一个会话：前一次读回来的结果不作数，收尾以最后一次打开为准——O1-U5", async () => {
    const h = setup({ lensOn: null });
    const held = holdReads();
    act(() => {
      h.result.current.handleSelectSession("s1");
    });
    setCachedSessionMessages("s2", [msg("user", "s2 的消息")]);
    await open(h, "s2");
    act(() => {
      h.result.current.handleSelectSession("s1"); // 读盘又挂起（这是第二次读 s1）
    });
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    // 第一次读 s1 的结果这时才回来
    await held.settle(0, [msg("user", "第一次读回来的")]);
    // 屏幕上不出现它（第二次打开 s1 时屏幕已清空，等着）、它的收尾不做：第二次读回来才显示、才刷新用量
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([]);
    expect(h.setSessionMessages).not.toHaveBeenCalledWith([msg("user", "第一次读回来的")]);
    expect(h.refreshSessionUsage).not.toHaveBeenCalledWith("s1");
    expect(getCachedSessionMessages("s1")).toBeUndefined();
    await held.settle(1, [msg("user", "第二次读回来的")]);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "第二次读回来的")]);
    expect(h.refreshSessionUsage).toHaveBeenCalledWith("s1");
    expect(getCachedSessionMessages("s1")).toEqual([msg("user", "第二次读回来的")]);
  });

  it("任务主会话首次打开（走磁盘）：同样在读盘之前挂好指令，读回后显示消息、刷新用量——O1-U12 / S24-U8", async () => {
    const h = setup({ lensOn: null });
    invokeCommand.mockResolvedValue([msg("user", "任务里的消息")]);
    await open(h, "t1", { keepTaskContext: true });
    for (const [name, fn] of Object.entries(h.taskSetters)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
    expect(h.selectedSessionRef.current).toBe("t1");
    expect(h.closeViewer).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith("get_session_messages", expect.objectContaining({ sessionId: "t1", agentId: "a" }));
    expect(h.setSessionMessages).toHaveBeenCalledWith([msg("user", "任务里的消息")]);
    expect(h.refreshSessionUsage).toHaveBeenCalledWith("t1");
    expect(h.armScroll).toHaveBeenCalledWith("t1");
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "t1" });

    // 对照：不带这个标记（打开普通会话）→ 任务态被清
    await open(h, "t2");
    expect(h.taskSetters.setTaskModeActive).toHaveBeenCalledWith(false);
    expect(h.taskSetters.setActiveTaskInstanceId).toHaveBeenCalledWith(null);
    expect(h.taskSetters.setTaskSelectedNodeId).toHaveBeenCalledWith(null);
  });

  it("节点会话：打开函数不读磁盘消息、先把屏幕清空，但刷新用量、投滚动指令照做；补读按给定的智能体读最新——O1-U13 / S24-U9", async () => {
    const h = setup({ lensOn: null });
    invokeCommand.mockResolvedValue([msg("user", "节点会话的消息")]);
    await open(h, "n1", { keepTaskContext: true, node: true });
    expect(invokeCommand).not.toHaveBeenCalled();
    // 屏幕上不放上一个会话的消息；消息由补读提供
    expect(h.setSessionMessages).toHaveBeenCalledTimes(1);
    expect(h.setSessionMessages).toHaveBeenCalledWith([]);
    expect(h.selectedSessionRef.current).toBe("n1");
    expect(h.refreshSessionUsage).toHaveBeenCalledWith("n1");
    expect(h.armScroll).toHaveBeenCalledWith("n1");
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "n1" });

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

  it("离开时的位置决定重访时投的指令：在底部离开投「到底」，停在中部投「恢复到原处」——O1-U8（单元）", async () => {
    const h = setup({ lensOn: null });
    setCachedSessionMessages("s1", [msg("user", "s1 的消息")]);
    await open(h, "s1");
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s1" }); // 首次打开：到底
    await open(h, "s2"); // 离开 s1 时停在 200
    await open(h, "s1");
    expect(h.scrollAction.current).toEqual({ type: "restore", top: 200, sessionId: "s1" });
    // 在 s1 里滚到底部再离开：回来投「到底」
    h.el.scrollTop = 500;
    await open(h, "s2");
    expect(h.scrollMemory.current.get("s1")).toBe("bottom");
    await open(h, "s1");
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s1" });
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
});

describe("useSessionSelection · 搜索态下打开有命中的会话（v0.9.8 评审修复轮 R2）", () => {
  it("走磁盘的：读盘挂起时不发跳转信号（消息视图收到信号当场处理，消息没就绪时发它定位不到），读回来才发——O1-U9", async () => {
    const h = setup({ lensOn: null });
    setCachedSessionMessages("s2", [msg("user", "s2 的消息")]);
    hits.add("s2");
    await open(h, "s2");
    expect(h.jumpToSearchHit).toHaveBeenCalledTimes(1); // 有缓存：打开时当场发

    hits.add("s3");
    const held = holdReads();
    act(() => {
      h.result.current.handleSelectSession("s3");
    });
    expect(h.jumpToSearchHit).toHaveBeenCalledTimes(1); // 读盘挂起：不发
    expect(h.armScroll).toHaveBeenCalledWith("s3"); // 遮蔽已武装：定位完成前不上屏
    expect(h.scrollAction.current).toBeNull(); // 不投「到底/恢复」
    await held.settle(0, [msg("user", "s3 的消息")]);
    expect(h.jumpToSearchHit).toHaveBeenLastCalledWith("s3");
  });

  it("走磁盘的搜索跳转：读盘期间切走了就不再发——O1-U9", async () => {
    const h = setup({ lensOn: null });
    hits.add("s2");
    const held = holdReads();
    act(() => {
      h.result.current.handleSelectSession("s2");
    });
    setCachedSessionMessages("s3", [msg("user", "s3 的消息")]);
    await open(h, "s3");
    await held.settle(0, [msg("user", "s2 的消息")]);
    expect(h.jumpToSearchHit).not.toHaveBeenCalled();
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s3" });
  });

  it("打开有命中的会话时，上一个会话还没执行的指令被撤掉——O1-U9", async () => {
    const h = setup({ lensOn: null });
    holdReads(); // s1 的读盘一直不回来
    act(() => {
      h.result.current.handleSelectSession("s1");
    });
    expect(h.scrollAction.current).toEqual({ type: "bottom", sessionId: "s1" });
    setCachedSessionMessages("s2", [msg("user", "s2 的消息")]);
    hits.add("s2");
    await open(h, "s2");
    // 搜索跳转由消息视图定位，这里不投指令；s1 的指令留着的话，会按到 s2 的消息上
    expect(h.scrollAction.current).toBeNull();
  });
});

describe("useSessionSelection · 位置记忆与离开记录（v0.9.8 评审修复轮 R2）", () => {
  it("位置记忆只在本次运行期：打开、离开、再打开一轮，不写任何持久化存储——O1-U10", async () => {
    // 前面的用例也走过「离开记录」：从清空后的状态起量，否则同一个键早已存在、键数不变，
    // 这条守卫在整文件运行里就成了空转
    localStorage.clear();
    const h = setup({ lensOn: null });
    await open(h, "s1");
    await open(h, "s2");
    expect(h.scrollMemory.current.get("s1")).toBe(200);
    expect(h.visitedSessions.current.has("s1")).toBe(true);
    expect(localStorage.length).toBe(0);
  });

  it("当前是占位（新对话 / 节点待定）时打开别的会话：不记离开位置——O6-U1", async () => {
    const h = setup({ lensOn: null });
    for (const placeholder of ["new", "pending-node"]) {
      // 选中态就是占位（页面上点「新对话」/ 选中节点后提交的那一轮）
      h.selectedSessionRef.current = placeholder;
      await open(h, "s1");
      expect(h.scrollMemory.current.has(placeholder)).toBe(false);
      expect(h.scrollMemory.current.has("s1")).toBe(false); // 刚打开、还没显示过，不记
    }
    // 对照：从真实会话离开照旧记
    await open(h, "s2");
    expect(h.scrollMemory.current.get("s1")).toBe(200);
  });

  it("离开记录的日志写明离开的会话与记下的位置——O10-U3", async () => {
    const h = setup({ lensOn: null });
    await open(h, "s1");
    await open(h, "s2");
    // 二轮评审 R3：日志里不再有「去哪」——记录跟着选中态走，不再由打开函数带着目的地名调用
    expect(devLog).toHaveBeenCalledWith("session", "离开会话（记下滚动位置）", { session: "s1", position: 200 });
  });
});

describe("useSessionSelection · 读取按次序认最新结果（v0.9.8 评审修复轮 R2）", () => {
  it("同一个会话两次读乱序返回：晚到的旧结果不上屏、不覆盖缓存——O10-U2", async () => {
    const h = setup({ lensOn: null });
    h.selectedSessionRef.current = "n1";
    const held = holdReads();
    let first: Message[] | Promise<Message[]> = [];
    let second: Message[] | Promise<Message[]> = [];
    act(() => {
      first = h.result.current.reloadSessionMessagesRef.current("n1", "codex", true);
    });
    // 绑定的智能体回填，按它重读；第一次读还没回来
    act(() => {
      second = h.result.current.reloadSessionMessagesRef.current("n1", "claude_code", true);
    });
    expect(invokeCommand).toHaveBeenLastCalledWith("get_session_messages", expect.objectContaining({ sessionId: "n1", agentId: "claude_code" }));

    // 后发起的先回来：上屏、进缓存
    await held.settle(1, [msg("user", "后发起的读")]);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "后发起的读")]);
    expect(getCachedSessionMessages("n1")).toEqual([msg("user", "后发起的读")]);

    // 先发起的后回来：只把结果交给调用方（补读据此决定要不要重试），不上屏、不覆盖缓存
    await held.settle(0, [msg("user", "先发起的读")]);
    expect(await first).toEqual([msg("user", "先发起的读")]);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "后发起的读")]);
    expect(getCachedSessionMessages("n1")).toEqual([msg("user", "后发起的读")]);
    expect(await second).toEqual([msg("user", "后发起的读")]);
  });

  it("先发起的读晚到、而且失败：不清屏、不动缓存——O10-U2", async () => {
    const h = setup({ lensOn: null });
    h.selectedSessionRef.current = "n1";
    let rejectFirst: (reason: Error) => void = () => {};
    invokeCommand
      .mockImplementationOnce(() => new Promise<Message[]>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce([msg("user", "后发起的读")]);
    let first: Message[] | Promise<Message[]> = [];
    act(() => {
      first = h.result.current.reloadSessionMessagesRef.current("n1", "codex", true);
    });
    await act(async () => {
      await h.result.current.reloadSessionMessagesRef.current("n1", "claude_code", true);
    });
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "后发起的读")]);

    let got: Message[] = [msg("user", "占位")];
    await act(async () => {
      rejectFirst(new Error("disk boom"));
      got = await first;
    });
    // 结果照常交给调用方（没有缓存，失败就是空）；屏幕与缓存都不动
    expect(got).toEqual([]);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "后发起的读")]);
    expect(getCachedSessionMessages("n1")).toEqual([msg("user", "后发起的读")]);
  });

  it("对照：两次读先后有序返回时，后一次的结果照常替换前一次——O10-U2", async () => {
    const h = setup({ lensOn: null });
    h.selectedSessionRef.current = "n1";
    invokeCommand.mockResolvedValueOnce([msg("user", "第一次")]).mockResolvedValueOnce([msg("user", "第二次")]);
    let first: Message[] | Promise<Message[]> = [];
    act(() => {
      first = h.result.current.reloadSessionMessagesRef.current("n1", "codex", true);
    });
    await act(async () => {
      await h.result.current.reloadSessionMessagesRef.current("n1", "claude_code", true);
    });
    expect(await first).toEqual([msg("user", "第一次")]);
    expect(h.setSessionMessages).toHaveBeenLastCalledWith([msg("user", "第二次")]);
    expect(getCachedSessionMessages("n1")).toEqual([msg("user", "第二次")]);
  });
});
