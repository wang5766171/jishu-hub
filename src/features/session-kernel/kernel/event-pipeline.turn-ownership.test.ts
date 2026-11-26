/**
 * v0.9.8 评审修复轮 R1-4：停止后立刻重发——旧回合迟到的「已中止」回执
 * 不得终结新回合（管线级行为）。驱动 startAgentEventPipeline（mock listen
 * 捕获事件回调），复刻「停止 → 立刻重发 → 旧回执才到」的交错序列。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEventPayload, Session } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";
import { steerCoordinator } from "./steer-coordinator";
import type { StagedGuideApi } from "@/components/sessions/chat-input";
import { invokeCommand } from "@/hooks/use-invoke";
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

const emitTurnComplete = (reason: string) => {
  if (!listenCallback) throw new Error("pipeline not started");
  listenCallback({
    payload: {
      event_type: "chunk",
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason, usage: null },
    } as unknown as AgentEventPayload,
  });
};

const CTX = { projectPath: "D:/proj-A", agentId: "jishu-self" };

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
    stagedApiRef: { current: null } as MutableRefObject<StagedGuideApi | null>,
    supportsSteerRef: { current: true } as MutableRefObject<boolean>,
    syncSessionListMessagesRef: { current: null },
    // v0.9.8 评审修复轮 R2：排队压缩的执行器（本组用例不涉及，留空）
    runStagedCompactionRef: { current: null },
    takeCompactionRequest: () => true,
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

describe("v0.9.8 评审修复轮 R1-4：迟到的中止回执与回合归属", () => {
  let deps: ReturnType<typeof makeDeps>;
  let stop: (() => void) | null = null;
  let stagedApi: StagedGuideApi;

  /** 旧回合：发出消息、已有内容、用户点停止（本地提交 + 标记旧令牌）。 */
  const runOldTurnThenStop = () => {
    streamStore.start("s1", "旧回合的消息");
    streamStore.push("s1", {
      session_id: "s1", event_type: "chunk",
      data: { kind: "text_delta", delta: "旧回合的半截回复" },
    });
    const oldToken = streamStore.getState("s1")!.turnToken;
    deps.abortLocalCommitRef.current.set("s1", oldToken);
    return oldToken;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    steerCoordinator.clearAll();
    streamStore.drop("s1");
    deps = makeDeps();
    stagedApi = { claimAll: vi.fn(() => []), restore: vi.fn(), moveKey: vi.fn(), stage: vi.fn() };
    deps.stagedApiRef.current = stagedApi;
    stop = startAgentEventPipeline(deps as never);
  });

  afterEach(() => {
    stop?.();
    streamStore.drop("s1");
    deps.abortLocalCommitRef.current.clear();
  });

  it("U5-1 停止后立刻重发：旧回执不提交新流、不移除新流、不发完成通知", () => {
    const oldToken = runOldTurnThenStop();
    // 用户立刻重发：新回合的流挂在同一个键上（新令牌，尚无内容）。
    streamStore.start("s1", "新回合的消息");
    const newToken = streamStore.getState("s1")!.turnToken;
    expect(newToken).not.toBe(oldToken);

    emitTurnComplete("Aborted");

    const state = streamStore.getState("s1");
    expect(state).not.toBeNull();
    expect(state?.isStreaming).toBe(true);
    expect(state?.pendingUserMessage).toBe("新回合的消息");
    expect(deps.setSessionMessages).not.toHaveBeenCalled();
    // 旧回合的标记已结算；新回合没被停止，不该留下标记。
    expect(deps.abortLocalCommitRef.current.has("s1")).toBe(false);
  });

  it("U5-2 旧回合遗留的引导退回待发送区：不另发消息（不取消新回合）、不清丢", () => {
    runOldTurnThenStop();
    steerCoordinator.stage("s1", "旧回合的引导", undefined, CTX);
    streamStore.start("s1", "新回合的消息");

    emitTurnComplete("Aborted");

    expect(stagedApi.restore).toHaveBeenCalledTimes(1);
    const [key, messages] = (stagedApi.restore as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(key).toBe("s1");
    expect((messages as Array<{ content: string; context: unknown }>).map((m) => m.content)).toEqual(["旧回合的引导"]);
    // 引导队列（旧回合残留）已清空；没有发起任何投递。
    expect(steerCoordinator.isEmpty("s1")).toBe(true);
    expect(invokeCommand).not.toHaveBeenCalledWith("send_message", expect.anything());
    expect(invokeCommand).not.toHaveBeenCalledWith("steer_chat", expect.anything());
    expect(streamStore.getState("s1")?.pendingUserMessage).toBe("新回合的消息");
  });

  it("U5-3 正常停止（回执属于当前回合）：跳过重复提交并照常收口", () => {
    streamStore.start("s1", "本回合的消息");
    streamStore.push("s1", {
      session_id: "s1", event_type: "chunk",
      data: { kind: "text_delta", delta: "半截回复" },
    });
    deps.abortLocalCommitRef.current.set("s1", streamStore.getState("s1")!.turnToken);

    emitTurnComplete("Aborted");

    expect(streamStore.getState("s1")).toBeNull();
    expect(deps.refreshSessionUsage).toHaveBeenCalledWith("s1");
    // 本地已提交过：终结者到达时不再把它的消息与半截回复提交第二遍。
    const flat = JSON.stringify((deps.setSessionMessages as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(flat).not.toContain("本回合的消息");
    expect(flat).not.toContain("半截回复");
    expect(stagedApi.restore).not.toHaveBeenCalled();
  });

  it("U5-4 陈旧标记 + 当前回合有内容且自己中止：照常收口（不误判为旧回执）", () => {
    streamStore.start("s1", "上一回合");
    const staleToken = streamStore.getState("s1")!.turnToken;
    deps.abortLocalCommitRef.current.set("s1", staleToken); // 上一回合终结者丢失，标记残留
    streamStore.start("s1", "本回合的消息");
    streamStore.push("s1", {
      session_id: "s1", event_type: "chunk",
      data: { kind: "text_delta", delta: "本回合的半截回复" },
    });

    emitTurnComplete("Aborted");

    expect(streamStore.getState("s1")).toBeNull();
    expect(deps.refreshSessionUsage).toHaveBeenCalledWith("s1");
    // 本回合未本地提交过——终结者照常提交它的消息与半截回复。
    const flat = JSON.stringify((deps.setSessionMessages as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(flat).toContain("本回合的消息");
    expect(flat).toContain("本回合的半截回复");
  });

  // ── v0.9.8 需求21（补）：回合结束时的自动发送按「对话身份」领取暂存 ──
  it("U3-4 暂存记在临时键下、回合结束事件带真实 id：仍能领到并自动发送（修前领取落空，消息永远留在待发送区）", async () => {
    const PENDING = "pending-1795000000000";
    const REAL = "01ffff00-aaaa-7000-8000-000000000000";
    streamStore.start(PENDING, "首条消息");
    // 新对话 id 解析：真实 id 与临时键成为同一个对话的两个身份
    streamStore.push(PENDING, {
      session_id: PENDING, event_type: "chunk",
      data: { kind: "session_resolved", session_id: REAL },
    });
    // 用户在界面还没切到真实 id 时暂存了一条——它记在临时键下
    const staged = { id: "st-1", content: "暂存在临时键下的消息", files: [], context: CTX };
    const claimAll = vi.fn((key: string) => (key === PENDING ? [staged] : []));
    const restore = vi.fn();
    deps.stagedApiRef.current = { claimAll, restore, moveKey: vi.fn(), stage: vi.fn() };
    // 回合结束事件带着真实 id 到达（界面当前键、事件键、暂存键三者并不相同）
    listenCallback!({
      payload: {
        event_type: "chunk", agent_id: "jishu-self", session_id: REAL,
        data: { kind: "turn_complete", reason: "Aborted", usage: null },
      } as unknown as AgentEventPayload,
    });

    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("send_message", expect.objectContaining({
        sessionId: REAL,
        message: "暂存在临时键下的消息",
      }));
    });
    expect(deps.abortLocalCommitRef.current.size).toBe(0);
    streamStore.drop(PENDING);
    streamStore.drop(REAL);
  });

  it("streamStore.identityKeys：一个对话的全部身份键（规范键 + 自身 + 指向它的别名）", () => {
    const PENDING = "pending-1795000000001";
    const REAL = "01ffff00-bbbb-7000-8000-000000000000";
    streamStore.start(PENDING, null);
    streamStore.alias(PENDING, REAL);
    expect(new Set(streamStore.identityKeys(REAL))).toEqual(new Set([PENDING, REAL]));
    expect(new Set(streamStore.identityKeys(PENDING))).toEqual(new Set([PENDING, REAL]));
    // 无关会话不被牵连
    expect(streamStore.identityKeys("some-other-session")).toEqual(["some-other-session"]);
    expect(streamStore.identityKeys(null)).toEqual([]);
    streamStore.drop(PENDING);
    streamStore.drop(REAL);
  });
});
