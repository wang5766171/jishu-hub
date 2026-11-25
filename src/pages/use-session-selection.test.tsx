/**
 * 会话选择钩子单测——v0.9.8 需求23，对应 tests/06-测试清单：
 * S23-U20 搜索态下离开会话不覆盖滚动记忆。
 *
 * 外部依赖（IPC、事件、日志）全部替身；只看「离开会话时记了什么」与
 * 「打开会话时投了什么滚动指令」。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { useSessionSelection } from "./use-session-selection";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));
vi.mock("@/lib/dev-log", () => ({ devLog: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const noop = () => {};

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
  const hook = renderHook(() =>
    useSessionSelection({
      projectId: "p",
      activeId: "a",
      currentProject: null,
      sessions: [],
      setSessionMessages: noop,
      sessionMessagesRef: { current: [] as Message[] },
      setSelectedSession: noop,
      selectedSessionRef,
      messageAreaRef: { current: el },
      scrollMemory,
      visitedSessions: { current: new Set<string>() },
      scrollAction,
      armScroll,
      newSessionStreamIdsRef: { current: new Set<string>() },
      setTaskModeActive: noop,
      setTaskLaunchOpen: noop,
      setTaskLaunchReadOnly: noop,
      taskLaunchOpenRef: { current: false },
      taskLaunchPhaseRef: { current: "requirements" },
      taskLaunchGoalRef: { current: null },
      activeTaskInstanceIdRef: { current: null },
      activeTaskRequirementFileRef: { current: null },
      lastKnownStatusRef: { current: null },
      setActiveTaskInstanceId: noop,
      setActiveTaskRequirementFile: noop,
      setTaskSelectedNodeId: noop,
      setTaskNodeSessionAgentId: noop,
      closeViewer: noop,
      refreshSessionUsageRef: { current: noop },
      isInSearchLens: (sessionId: string) => lensOn === sessionId,
      landsOnSearchHit: (sessionId: string) => hits.has(sessionId),
      jumpToSearchHit,
    }),
  );
  return { ...hook, el, selectedSessionRef, scrollMemory, scrollAction, armScroll, jumpToSearchHit };
}

let hits: Set<string>;

const open = async (h: ReturnType<typeof setup>, sessionId: string) => {
  await act(async () => {
    await h.result.current.handleSelectSession(sessionId);
  });
};

beforeEach(() => {
  hits = new Set();
  invokeCommand.mockReset();
  invokeCommand.mockResolvedValue([]);
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
