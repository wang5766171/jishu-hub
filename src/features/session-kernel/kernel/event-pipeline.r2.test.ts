/**
 * v0.9.8 评审修复轮 R2（S 域）：事件管线的行为增量。
 *  - C1 扩展命令：回合以 `Handled` 结束 → 丢弃这条流（不留用户消息）；
 *  - C3 压缩排队：轮到排队的压缩 → 执行压缩而不是发消息，压缩结束再发下一条；
 *  - P2：自动发送失败只放回第一条、纯压缩流终结结算标记、新会话重读后同步
 *    缓存里最新的一份、会话 id 解析搬待发送区、中止回合不投递下一条引导、
 *    无从投递的 steering 回填输入框。
 * 对应 tests/S-用例清单。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEventPayload, Message, Session } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";
import { steerCoordinator } from "./steer-coordinator";
import type { StagedCompactionRunner, StagedGuideApi } from "@/components/sessions/chat-input";
import type { StagedMessage } from "@/components/sessions/message-staging";
import { invokeCommand } from "@/hooks/use-invoke";
import { setCachedSessionMessages } from "./session-cache";
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

// 缓存替身的行为与真实缓存一致（写进去的读得回来）。
const cacheMemory = vi.hoisted(() => new Map<string, Message[]>());
vi.mock("./session-cache", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./session-cache")>();
  return {
    ...orig,
    getCachedSessionMessages: vi.fn((key: string) => cacheMemory.get(key)),
    setCachedSessionMessages: vi.fn((key: string, messages: Message[]) => {
      cacheMemory.set(key, messages);
    }),
  };
});

const emit = (payload: Record<string, unknown>) => {
  if (!listenCallback) throw new Error("pipeline not started");
  listenCallback({ payload: { event_type: "chunk", agent_id: "jishu-self", ...payload } as unknown as AgentEventPayload });
};

const turnComplete = (sessionId: string, reason: string) =>
  emit({ session_id: sessionId, data: { kind: "turn_complete", reason, usage: null } });

const compactionDivider = (sessionId: string, title: string) =>
  emit({ session_id: sessionId, data: { kind: "phase_divider", phase: "compaction", title } });

const compactionStatus = (sessionId: string, active: boolean) =>
  emit({ session_id: sessionId, data: { kind: "compaction_status", active, reason: "manual" } });

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
    refetchSessionsRef: { current: null } as MutableRefObject<((silent?: boolean) => Promise<Session[]>) | null>,
    selectedSessionRef: { current: "s1" } as MutableRefObject<string | null>,
    selectedTaskSkillIdRef: { current: "" },
    sessionsRef: { current: null } as MutableRefObject<Session[] | null>,
    stagedApiRef: { current: null } as MutableRefObject<StagedGuideApi | null>,
    supportsSteerRef: { current: true } as MutableRefObject<boolean>,
    syncSessionListMessagesRef: { current: vi.fn<(sessionId: string, messages: Message[]) => void>() },
    runStagedCompactionRef: { current: null } as MutableRefObject<StagedCompactionRunner | null>,
    takeCompactionRequest: () => true,
    taskLaunchOpenRef: { current: false },
    taskLaunchPhaseRef: { current: null },
    visitedSessions: { current: new Set<string>() },
    setLiveThinkingLevel: vi.fn() as unknown as Dispatch<SetStateAction<string | null>>,
    setOptimisticSessions: vi.fn(),
    setPendingApprovals: vi.fn(),
    setPendingInteractions: vi.fn((update: (cur: unknown[]) => unknown[]) => update),
    setSelectedSession: vi.fn(),
    setSessionMessages: vi.fn(),
    applyTaskLaunchInstanceSnapshot: vi.fn(),
    refreshSessionUsage: vi.fn(),
    discoverConductorTask: vi.fn(async () => {}),
    t: ((k: string) => k) as unknown as TFunction,
  };
}

type Deps = ReturnType<typeof makeDeps>;

/** 待发送区替身：一个数组——领取清空、放回插回队首（与 chat-input 的实现同语义）。 */
function makeStaging(initial: StagedMessage[]) {
  const queue = [...initial];
  const api: StagedGuideApi = {
    claimAll: vi.fn(() => queue.splice(0)),
    restore: vi.fn((_key: string, messages: StagedMessage[]) => {
      queue.unshift(...messages);
    }),
    moveKey: vi.fn(),
    stage: vi.fn(),
  };
  return { api, queue, claimAll: api.claimAll as ReturnType<typeof vi.fn>, restore: api.restore as ReturnType<typeof vi.fn> };
}

const staged = (id: string, content: string, extra: Partial<StagedMessage> = {}): StagedMessage => ({
  id,
  content,
  context: CTX,
  ...extra,
});

const sendMessages = () =>
  vi.mocked(invokeCommand).mock.calls.filter(([cmd]) => cmd === "send_message");

const steerCalls = () =>
  vi.mocked(invokeCommand).mock.calls.filter(([cmd]) => cmd === "steer_chat");

describe("评审修复轮 R2：事件管线", () => {
  let deps: Deps;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheMemory.clear();
    steerCoordinator.clearAll();
    vi.mocked(invokeCommand).mockReset();
    vi.mocked(invokeCommand).mockImplementation(async () => null);
    setWindowActiveForTest(true);
    deps = makeDeps();
    stop = startAgentEventPipeline(deps as never);
  });

  afterEach(() => {
    stop?.();
    for (const sid of ["s1", "pending-1795000000000", "01ffff00-aaaa-7000-8000-000000000000", "s-fresh"]) {
      streamStore.drop(sid);
    }
    setWindowActiveForTest(true);
  });

  // ── C1：扩展命令 ─────────────────────────────────────────────────────────

  it("S1-U2 回合以 Handled 结束（扩展命令已执行）：流丢弃，不留用户消息、不通知、不生成标题", () => {
    cacheMemory.set("s1", [{ role: "assistant", content: [{ type: "text", text: "上一轮回答" }], timestamp: 1 }]);
    streamStore.start("s1", "/todos", [], { extensionCommand: true });
    const received: string[] = [];
    const off = subscribeSessionSignals((signal) => received.push(signal.type));
    setWindowActiveForTest(false); // 失焦时普通回合完成会通知——Handled 不通知

    turnComplete("s1", "Handled");
    off();

    expect(streamStore.getState("s1")).toBeNull();
    expect(cacheMemory.get("s1")).toHaveLength(1); // 缓存里没有多出用户消息
    expect(deps.setSessionMessages).not.toHaveBeenCalled();
    expect(received).not.toContain("turn-complete");
    expect(vi.mocked(invokeCommand).mock.calls.some(([cmd]) => cmd === "session_generate_title")).toBe(false);
  });

  it("S1-U3 Handled 之后引擎空闲：丢弃这条流，待发送区的下一条照常投递，且只发一条", async () => {
    const staging = makeStaging([staged("st-1", "继续"), staged("st-2", "再看一下")]);
    deps.stagedApiRef.current = staging.api;
    streamStore.start("s1", "/todos", [], { extensionCommand: true });

    turnComplete("s1", "Handled");

    await vi.waitFor(() => expect(sendMessages()).toHaveLength(1));
    expect(sendMessages()[0][1]).toEqual(expect.objectContaining({ sessionId: "s1", message: "继续" }));
    expect(staging.restore).toHaveBeenCalledWith("s1", [staged("st-2", "再看一下")]);
    // 投递是 Handled 分支做的，不是落进普通回合收口：那条命令没有留下用户消息
    expect(JSON.stringify(cacheMemory.get("s1"))).not.toContain("/todos");
    expect(vi.mocked(deps.setSessionMessages).mock.calls.some(([messages]) => JSON.stringify(messages).includes("/todos"))).toBe(false);
  });

  it("S1-U4 新会话的第一条是扩展命令：回合结束后重读会话列表一次，新会话标记清除，不留用户消息", () => {
    const refetch = vi.fn(() => Promise.resolve([]));
    deps.refetchSessionsRef.current = refetch;
    deps.newSessionStreamIdsRef.current = new Set(["s1"]);
    streamStore.start("s1", "/todos", [], { extensionCommand: true });

    turnComplete("s1", "Handled");

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(deps.newSessionStreamIdsRef.current.has("s1")).toBe(false);
    expect(streamStore.getState("s1")).toBeNull();
    // 收尾是 Handled 分支做的，不是落进普通回合收口：那条命令没有留下用户消息
    expect(JSON.stringify([...cacheMemory.values()])).not.toContain("/todos");
  });

  it("S1-U5 扩展命令流以中止收场：只收口，用户消息不进缓存与正文", () => {
    streamStore.start("s1", "/todos", [], { extensionCommand: true });
    streamStore.push("s1", { session_id: "s1", event_type: "chunk", data: { kind: "text_delta", delta: "半截输出" } } as never);

    turnComplete("s1", "Aborted");

    expect(streamStore.getState("s1")).toBeNull();
    const flat = JSON.stringify({
      cache: [...cacheMemory.values()],
      body: vi.mocked(deps.setSessionMessages).mock.calls,
    });
    expect(flat).not.toContain("/todos");
    // 流上的输出照常收口提交（它属于这次执行，不是用户消息）
    expect(flat).toContain("半截输出");
  });

  it("S1-U11（二轮评审 R3 P2-4）扩展命令以中止 / 错误收场：不生成标题（它不是一次对话回合）", () => {
    for (const reason of ["Aborted", "Error"] as const) {
      streamStore.start("s2", "/todos", [], { extensionCommand: true });
      turnComplete("s2", reason);
      expect(streamStore.getState("s2")).toBeNull();
    }
    expect(vi.mocked(invokeCommand).mock.calls.some(([cmd]) => cmd === "session_generate_title")).toBe(false);
    // 对照：普通消息回合结束照常生成标题
    streamStore.start("s3", "普通问题");
    turnComplete("s3", "Complete");
    expect(vi.mocked(invokeCommand).mock.calls.some(([cmd]) => cmd === "session_generate_title")).toBe(true);
  });

  it("普通消息流以中止收场：用户消息照常提交（对照组）", () => {
    streamStore.start("s1", "普通问题");

    turnComplete("s1", "Aborted");

    expect(JSON.stringify([...cacheMemory.values()])).toContain("普通问题");
  });

  // ── C3：排队的压缩 ───────────────────────────────────────────────────────

  it("S2-U6 轮到排队的压缩：回合结束 → 执行压缩，不当成消息发出去", () => {
    const runner = vi.fn();
    deps.runStagedCompactionRef.current = runner;
    deps.stagedApiRef.current = makeStaging([
      staged("cp-1", "/compact 只保留接口设计", { kind: "compaction" }),
      staged("st-1", "压缩后再问的"),
    ]).api;
    streamStore.start("s1", "正在回答的问题");

    turnComplete("s1", "Complete");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith("s1", "只保留接口设计", CTX);
    expect(sendMessages()).toHaveLength(0);
    // 没有起「等回复」的流，也没有把命令原文写成用户消息
    expect(streamStore.getState("s1")).toBeNull();
    expect(JSON.stringify([...cacheMemory.values()])).not.toContain("/compact");
  });

  it("S2-U7 压缩条目后面还有排队消息：先放回，压缩结束后再发出一次", async () => {
    const runner = vi.fn();
    deps.runStagedCompactionRef.current = runner;
    const staging = makeStaging([
      staged("cp-1", "/compact", { kind: "compaction" }),
      staged("st-1", "压缩后再问的"),
    ]);
    deps.stagedApiRef.current = staging.api;
    streamStore.start("s1", "正在回答的问题");

    turnComplete("s1", "Complete");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(staging.queue.map((m) => m.id)).toEqual(["st-1"]);
    expect(sendMessages()).toHaveLength(0);

    // 排队的压缩执行：引擎的压缩开始 / 结束事件依次到达
    compactionDivider("s1", "上下文压缩中…");
    expect(runner).toHaveBeenCalledTimes(1);
    compactionDivider("s1", "上下文已压缩");
    compactionStatus("s1", false);

    await vi.waitFor(() => expect(sendMessages()).toHaveLength(1));
    expect(sendMessages()[0][1]).toEqual(expect.objectContaining({ sessionId: "s1", message: "压缩后再问的" }));
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("S2-U12（二轮评审 R3 P2-1；收口轮改）排队的压缩执行失败：条目不放回（执行器已弹窗告诉用户），接着发出排在它后面的消息", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("compact refused"));
    deps.runStagedCompactionRef.current = runner;
    const staging = makeStaging([
      staged("cp-1", "/compact", { kind: "compaction" }),
      staged("st-1", "压缩后再问的"),
    ]);
    deps.stagedApiRef.current = staging.api;
    streamStore.start("s1", "正在回答的问题");

    turnComplete("s1", "Complete");

    await vi.waitFor(() => expect(sendMessages()).toHaveLength(1));
    expect(sendMessages()[0][1]).toEqual(expect.objectContaining({ sessionId: "s1", message: "压缩后再问的" }));
    expect(runner).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(staging.queue.map((m) => m.id)).toEqual([]);
    // 放回只发生过一次：领取时把排在后面的放回待发送区。失败的那条没有被放回
    expect(staging.restore).toHaveBeenCalledTimes(1);
    expect(staging.restore).toHaveBeenCalledWith("s1", [expect.objectContaining({ id: "st-1" })]);
    // 引擎的压缩结束事件晚一步才到：待发送区已经空了，不会再发一遍
    compactionDivider("s1", "上下文压缩中…");
    compactionDivider("s1", "上下文压缩失败");
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessages()).toHaveLength(1);
  });

  it("S2-U15（收口轮）排队的压缩失败之后的下一个回合结束：不再领到它——不再次执行、不再次放回", async () => {
    // 界面实跑到的缺陷（收口轮）：失败的那条被放回队首，之后每个回合结束都被再领一次、再失败一次、
    // 再弹一次「压缩失败」窗，会话里一次多一条「上下文压缩失败」分隔线；压缩条目没有手动重试的入口，
    // 用户只能手动删掉它才停得下来
    const runner = vi.fn().mockRejectedValue(new Error("会话内容还不多，暂时不需要压缩"));
    deps.runStagedCompactionRef.current = runner;
    const staging = makeStaging([staged("cp-1", "/compact", { kind: "compaction" })]);
    deps.stagedApiRef.current = staging.api;
    streamStore.start("s1", "正在回答的问题");

    turnComplete("s1", "Complete");
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(staging.queue).toEqual([]);

    // 用户照常再聊一轮
    streamStore.start("s1", "失败之后照常发的消息");
    turnComplete("s1", "Complete");
    await new Promise((r) => setTimeout(r, 20));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(staging.queue).toEqual([]);
    expect(sendMessages()).toHaveLength(0);
  });

  it("S2-U16（收口轮）引擎的压缩结束事件先到、执行器的失败后到：排在后面的消息只发一次", async () => {
    let rejectRun!: (e: Error) => void;
    const runner = vi.fn(
      () =>
        new Promise<never>((_resolve, rej) => {
          rejectRun = rej;
        }),
    );
    deps.runStagedCompactionRef.current = runner;
    const staging = makeStaging([
      staged("cp-1", "/compact", { kind: "compaction" }),
      staged("st-1", "压缩后再问的"),
    ]);
    deps.stagedApiRef.current = staging.api;
    streamStore.start("s1", "正在回答的问题");

    turnComplete("s1", "Complete");
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    // 真实顺序（页面日志）：压缩开始 / 结束事件比发送调用的失败先到；结束的权威信号是
    // compaction_status(active=false)，它到达时「这次压缩是用户发起的」标记还没被取走
    compactionDivider("s1", "上下文压缩中…");
    compactionDivider("s1", "上下文压缩失败");
    compactionStatus("s1", false);
    await vi.waitFor(() => expect(sendMessages()).toHaveLength(1));
    expect(sendMessages()[0][1]).toEqual(expect.objectContaining({ message: "压缩后再问的" }));

    rejectRun(new Error("compact refused"));
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessages()).toHaveLength(1);
    expect(staging.queue.map((m) => m.id)).toEqual([]);
  });

  it("S2-U13（二轮评审 R3 P2-1）轮到排队的压缩时这个会话已有压缩在途：条目放回队首，等那一次结束再轮到它", async () => {
    const runner = vi.fn().mockResolvedValue("skipped");
    deps.runStagedCompactionRef.current = runner;
    const staging = makeStaging([
      staged("cp-1", "/compact", { kind: "compaction" }),
      staged("st-1", "压缩后再问的"),
    ]);
    deps.stagedApiRef.current = staging.api;
    streamStore.start("s1", "正在回答的问题");

    turnComplete("s1", "Complete");

    await vi.waitFor(() => expect(staging.queue.map((m) => m.id)).toEqual(["cp-1", "st-1"]));
    expect(sendMessages()).toHaveLength(0);
  });

  it("S2-U14（二轮评审 R3 P2-1 对照）排队的压缩正常做完：条目销掉，不放回", async () => {
    const runner = vi.fn().mockResolvedValue("done");
    deps.runStagedCompactionRef.current = runner;
    const staging = makeStaging([staged("cp-1", "/compact", { kind: "compaction" })]);
    deps.stagedApiRef.current = staging.api;
    streamStore.start("s1", "正在回答的问题");

    turnComplete("s1", "Complete");

    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(staging.queue.map((m) => m.id)).toEqual([]);
  });

  it("S2-U8 排队的压缩条目被编辑成普通内容：按普通消息发出", async () => {
    const runner = vi.fn();
    deps.runStagedCompactionRef.current = runner;
    deps.stagedApiRef.current = makeStaging([staged("cp-1", "你好", { kind: "compaction" })]).api;
    streamStore.start("s1", "正在回答的问题");

    turnComplete("s1", "Complete");

    await vi.waitFor(() => expect(sendMessages()).toHaveLength(1));
    expect(sendMessages()[0][1]).toEqual(expect.objectContaining({ message: "你好" }));
    expect(runner).not.toHaveBeenCalled();
  });

  // ── P2 ───────────────────────────────────────────────────────────────────

  it("S5-U1 自动发送失败：只放回发失败的那一条，其余不重复放回", async () => {
    vi.mocked(invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === "send_message") throw new Error("engine refused");
      return null;
    });
    const staging = makeStaging([staged("a", "A"), staged("b", "B"), staged("c", "C")]);
    deps.stagedApiRef.current = staging.api;
    streamStore.start("s1", "正在回答的问题");

    turnComplete("s1", "Complete");

    await vi.waitFor(() => expect(staging.restore).toHaveBeenCalledTimes(2));
    expect(staging.restore.mock.calls[0]).toEqual(["s1", [staged("b", "B"), staged("c", "C")]]);
    expect(staging.restore.mock.calls[1]).toEqual(["s1", [staged("a", "A")]]);
    // 待发送区恢复成原来的三条，一条不多
    expect(staging.queue.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(streamStore.getState("s1")).toBeNull();
  });

  it("S6-U1 纯压缩流上「点过停止」的标记随流终结清除", () => {
    compactionDivider("s1", "上下文压缩中…");
    deps.abortLocalCommitRef.current.set("s1", streamStore.getState("s1")!.turnToken);

    compactionDivider("s1", "上下文压缩已取消");
    compactionStatus("s1", false);

    expect(streamStore.getState("s1")).toBeNull();
    expect(deps.abortLocalCommitRef.current.has("s1")).toBe(false);
  });

  it("S6-U2 别的回合留下的标记（等它自己的终结者）不随压缩流终结被清", () => {
    compactionDivider("s1", "上下文压缩中…");
    const otherTurnToken = streamStore.getState("s1")!.turnToken + 999;
    deps.abortLocalCommitRef.current.set("s1", otherTurnToken);

    compactionDivider("s1", "上下文已压缩");
    compactionStatus("s1", false);

    expect(streamStore.getState("s1")).toBeNull();
    expect(deps.abortLocalCommitRef.current.get("s1")).toBe(otherTurnToken);
  });

  it("S10-U1 新会话重读列表后：同步的是缓存里此刻最新的一份", async () => {
    const sync = vi.mocked(deps.syncSessionListMessagesRef.current);
    deps.newSessionStreamIdsRef.current = new Set(["s1"]);
    let finishRefetch: ((list: Session[]) => void) | null = null;
    const refetch = vi.fn(() => new Promise<Session[]>((resolve) => { finishRefetch = resolve; }));
    deps.refetchSessionsRef.current = refetch;

    streamStore.start("s1", "新会话的第一问");
    turnComplete("s1", "Complete");
    expect(sync).toHaveBeenCalledTimes(1);
    const atTurnEnd = sync.mock.calls[0][1];

    // 重读还在路上：这个会话的缓存已经前进（下一条消息的回合都结束了）
    const newer: Message[] = [...(cacheMemory.get("s1") ?? []), { role: "user", content: [{ type: "text", text: "自动发出的下一条" }], timestamp: 2 }];
    setCachedSessionMessages("s1", newer);

    finishRefetch!([]);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    expect(sync.mock.calls[1][0]).toBe("s1");
    expect(sync.mock.calls[1][1]).toBe(newer);
    expect(sync.mock.calls[1][1]).not.toBe(atTurnEnd);
  });

  it("S11-U3 会话 id 解析：待发送区跟着从临时键搬到真实键；id 没变时不搬", () => {
    const PENDING = "pending-1795000000000";
    const REAL = "01ffff00-aaaa-7000-8000-000000000000";
    const staging = makeStaging([]);
    deps.stagedApiRef.current = staging.api;
    streamStore.start(PENDING, "首条消息");

    emit({ session_id: PENDING, data: { kind: "session_resolved", session_id: REAL } });
    expect(staging.api.moveKey).toHaveBeenCalledTimes(1);
    expect(staging.api.moveKey).toHaveBeenCalledWith(PENDING, REAL);

    emit({ session_id: REAL, data: { kind: "session_resolved", session_id: REAL } });
    expect(staging.api.moveKey).toHaveBeenCalledTimes(1);
  });

  it("S13-U1 中止的回合不投递下一条引导；残留的引导作为新消息重发一次", async () => {
    steerCoordinator.stage("s1", "引导C", undefined, CTX);
    streamStore.start("s1", "用户问题");

    turnComplete("s1", "Aborted");

    await vi.waitFor(() => expect(sendMessages()).toHaveLength(1));
    expect(sendMessages()[0][1]).toEqual(expect.objectContaining({ sessionId: "s1", message: "引导C" }));
    expect(steerCalls()).toHaveLength(0);
  });

  it("S13-U2 正常完成的回合照常把下一条引导交给引擎", () => {
    steerCoordinator.stage("s1", "引导D", undefined, CTX);
    streamStore.start("s1", "用户问题");

    turnComplete("s1", "Complete");

    expect(steerCalls()).toEqual([["steer_chat", { sessionId: "s1", message: "引导D" }]]);
  });

  it("S15-U3 这个会话没有入队记录、无从投递的 steering：回填输入框，不发消息", () => {
    deps.selectedSessionRef.current = "s-fresh";

    emit({ session_id: "s-fresh", data: { kind: "steer_queue_cleared", texts: ["别处注入的引导"], follow_up_texts: [] } });

    expect(deps.chatInputRef.current?.restoreTexts).toHaveBeenCalledWith(["别处注入的引导"]);
    expect(sendMessages()).toHaveLength(0);
    expect(steerCoordinator.takeResend("s-fresh")).toEqual([]);
  });
});
