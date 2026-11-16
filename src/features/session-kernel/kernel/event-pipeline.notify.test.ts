/**
 * v0.9.5 测试期（用户实测「系统通知没有效果了」）：turn-complete 通知信号
 * 的窗口激活门控——「正在查看的会话不打扰」修正为「窗口激活在看时不打扰」。
 * 最小化/失焦时当前会话也通知（v0.9.5 起 subagent 集成主会话工具卡，后台
 * 会话通知的实际触发面归零——旧门控下通知永不再发）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEventPayload, Session } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";
import { subscribeSessionSignals } from "../signals";
import { setWindowActiveForTest } from "../window-activity";
import { startAgentEventPipeline } from "./event-pipeline";

let listenCallback: ((e: { payload: unknown }) => void) | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: unknown }) => void) => {
    listenCallback = cb;
    return () => {};
  }),
}));

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand: vi.fn(async () => null),
}));

vi.mock("@/features/task-instance/task-phase-debug", () => ({
  logTaskPhaseDebug: () => {},
}));

vi.mock("./session-cache", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./session-cache")>();
  return {
    ...orig,
    getCachedSessionMessages: vi.fn(() => null),
    setCachedSessionMessages: vi.fn(),
  };
});

const emit = (payload: Record<string, unknown> | Record<string, unknown>[]) => {
  if (!listenCallback) throw new Error("pipeline not started");
  const withDefaults = (Array.isArray(payload) ? payload : [payload]).map((p) => ({
    event_type: "chunk",
    ...p,
  })) as unknown as AgentEventPayload[];
  listenCallback({ payload: Array.isArray(payload) ? withDefaults : withDefaults[0] });
};

function makeDeps(selected: string) {
  return {
    activeIdRef: { current: "jishu-self" } as MutableRefObject<string | null>,
    activeTaskInstanceIdRef: { current: null },
    chatInputRef: { current: { restoreTexts: vi.fn() } } as unknown as MutableRefObject<{ restoreTexts: (t: string[]) => void } | null>,
    injectedLaunchSessionsRef: { current: new Set<string>() },
    isAwayFromBottomRef: { current: false },
    lastRealSessionIdRef: { current: null },
    messageAreaRef: { current: null },
    newSessionStreamIdsRef: { current: new Set<string>() },
    pendingReplyStartedAtRef: { current: new Map<string, number>() } as MutableRefObject<Map<string, number>>,
    abortLocalCommitRef: { current: new Map<string, number>() } as MutableRefObject<Map<string, number>>,
    projectIdRef: { current: "proj" },
    projectPathRef: { current: "D:/x" },
    refetchSessionsRef: { current: null },
    selectedSessionRef: { current: selected } as MutableRefObject<string | null>,
    selectedTaskSkillIdRef: { current: "" },
    sessionsRef: { current: null } as MutableRefObject<Session[] | null>,
    stagedApiRef: { current: null },
    supportsSteerRef: { current: true } as MutableRefObject<boolean>,
    taskLaunchOpenRef: { current: false },
    taskLaunchPhaseRef: { current: null },
    visitedSessions: { current: new Set<string>() },
    setLiveThinkingLevel: vi.fn() as unknown as Dispatch<SetStateAction<string | null>>,
    setOptimisticSessions: vi.fn(),
    setPendingApprovals: vi.fn(),
    setPendingInteractions: vi.fn(),
    setSelectedSession: vi.fn(),
    setSessionMessages: vi.fn(),
    applyTaskLaunchInstanceSnapshot: vi.fn(),
    refreshSessionUsage: vi.fn(),
    discoverConductorTask: vi.fn(async () => {}),
    t: ((k: string, d?: Record<string, unknown>) =>
      (d ? Object.entries(d).reduce<string>((acc, [kk, vv]) => acc.split(`{{${kk}}}`).join(String(vv)), k) : k)) as unknown as TFunction,
  };
}

describe("turn-complete 通知门控（窗口激活语义）", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    setWindowActiveForTest(true);
    streamStore.drop("s1");
  });

  afterEach(() => {
    stop?.();
    stop = null;
    streamStore.drop("s1");
    setWindowActiveForTest(true);
  });

  it("正在查看 + 窗口激活：不通知（原语义保持）", () => {
    stop = startAgentEventPipeline(makeDeps("s1") as never);
    streamStore.start("s1", "用户问题");
    const received: string[] = [];
    const off = subscribeSessionSignals((s) => received.push(s.type));
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Complete", usage: null },
    });
    off();
    expect(received).not.toContain("turn-complete");
  });

  it("正在查看 + 窗口失焦/最小化：通知（本次修复主场景）", () => {
    setWindowActiveForTest(false);
    stop = startAgentEventPipeline(makeDeps("s1") as never);
    streamStore.start("s1", "用户问题");
    const received: string[] = [];
    const off = subscribeSessionSignals((s) => received.push(s.type));
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Complete", usage: null },
    });
    off();
    expect(received).toContain("turn-complete");
  });

  it("后台会话 + 窗口激活：通知（原语义保持）", () => {
    stop = startAgentEventPipeline(makeDeps("other-viewed") as never);
    streamStore.start("s1", "用户问题");
    const received: string[] = [];
    const off = subscribeSessionSignals((s) => received.push(s.type));
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Error", usage: null },
    });
    off();
    expect(received).toContain("turn-complete");
  });

  it("窗口激活跟踪：blur → 失活，focus → 复活（jsdom 事件）", async () => {
    const { attachWindowActivityTracking } = await import("../window-activity");
    const detach = attachWindowActivityTracking();
    try {
      window.dispatchEvent(new Event("blur"));
      expect((await import("../window-activity")).isAppWindowActive()).toBe(false);
      window.dispatchEvent(new Event("focus"));
      expect((await import("../window-activity")).isAppWindowActive()).toBe(true);
    } finally {
      detach();
    }
  });
});
