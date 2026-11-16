/**
 * v0.9.6 需求8 F2：回合终结撤卡——行为验证（评审 P2-3 补）。
 * 规则：turn_complete 到达时，本会话 mid_turn 交互卡（陈旧卡）撤除；
 * follow_up 卡与 hint 省略（undefined，按 follow_up 回落）的卡保留——
 * 它们的语义就是回合结束后等用户补答；其他会话的卡不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEventPayload, Session } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";
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

const emit = (payload: Record<string, unknown>) => {
  if (!listenCallback) throw new Error("pipeline not started");
  listenCallback({ payload: { event_type: "chunk", ...payload } as unknown as AgentEventPayload });
};

function makeDeps() {
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
    selectedSessionRef: { current: "s1" } as MutableRefObject<string | null>,
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
    // 函数式更新：记录回调并返回「回调执行后的结果」供断言
    setPendingInteractions: vi.fn((update: (cur: unknown[]) => unknown[]) => update),
    setSelectedSession: vi.fn(),
    setSessionMessages: vi.fn(),
    applyTaskLaunchInstanceSnapshot: vi.fn(),
    refreshSessionUsage: vi.fn(),
    discoverConductorTask: vi.fn(async () => {}),
    t: ((k: string) => k) as unknown as TFunction,
  };
}

/** 构造一张交互卡（item 形状对齐 PendingInteraction 消费面） */
const card = (sessionId: string, deliveryHint?: "mid_turn" | "follow_up") => ({
  sessionId,
  request: {
    requestId: `req-${sessionId}-${deliveryHint ?? "none"}`,
    agentId: "jishu-self",
    prompt: "选一个",
    options: [],
    multiSelect: false,
    deliveryHint,
  },
});

describe("v0.9.6 需求8 F2：回合终结撤卡", () => {
  let deps: ReturnType<typeof makeDeps>;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
    stop = startAgentEventPipeline(deps as never);
  });

  afterEach(() => {
    stop?.();
    streamStore.drop("s1");
  });

  it("turn_complete：本会话 mid_turn 卡撤除，follow_up / hint 省略卡保留，他会话不动", () => {
    // 真实回合起流（含用户消息），随后 turn_complete 收口
    streamStore.start("s1", "用户问题");
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Complete", usage: null },
    });

    const calls = vi.mocked(deps.setPendingInteractions).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const filterFn = calls[calls.length - 1][0] as (cur: unknown[]) => unknown[];

    const current = [
      card("s1", "mid_turn"),    // 本会话陈旧卡 → 应撤
      card("s1", "follow_up"),   // 本会话补答卡 → 应留
      card("s1"),                // hint 省略（follow_up 回落）→ 应留（评审修正点）
      card("other-session", "mid_turn"), // 他会话卡 → 不动
    ];
    const kept = filterFn(current) as typeof current;
    const keptIds = kept.map(c => (c.request as { requestId: string }).requestId);
    expect(keptIds).toEqual([
      "req-s1-follow_up",
      "req-s1-none",
      "req-other-session-mid_turn",
    ]);
  });

  it("非 turn_complete 事件不触发撤卡", () => {
    streamStore.start("s1", "用户问题");
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "thinking", level: "high" },
    });
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "phase_divider", phase: "compaction", title: "上下文压缩中…" },
    });
    expect(deps.setPendingInteractions).not.toHaveBeenCalled();
  });
});
