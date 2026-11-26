/**
 * v0.9.8 评审修复轮 R3（R 域 / P1-1）：任务实例改在**发送入口**建——首条消息把任务
 * 意图随 `send_message` 带给后端，后端在拉起进程之前建实例、会话解析后改绑。
 * `session_resolved` 到达时事件管线不再创建任务实例，只按任务号读回刷新（带真实
 * 会话号的那一份）。对应 tests/R-R3修复记录.md 的 R3-1-FE4。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEventPayload, Message, Session } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";
import { steerCoordinator } from "./steer-coordinator";
import type { StagedCompactionRunner, StagedGuideApi } from "@/components/sessions/chat-input";
import { invokeCommand } from "@/hooks/use-invoke";
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

const PENDING = "pending-1795000000000";
const REAL = "01ffff00-aaaa-7000-8000-000000000000";

const emit = (payload: Record<string, unknown>) => {
  if (!listenCallback) throw new Error("pipeline not started");
  listenCallback({ payload: { event_type: "chunk", agent_id: "jishu-self", ...payload } as unknown as AgentEventPayload });
};

const sessionResolved = () =>
  emit({ session_id: PENDING, data: { kind: "session_resolved", session_id: REAL } });

function makeDeps() {
  return {
    activeIdRef: { current: "jishu-self" } as MutableRefObject<string | null>,
    activeTaskInstanceIdRef: { current: null } as MutableRefObject<string | null>,
    chatInputRef: { current: { restoreTexts: vi.fn() } } as unknown as MutableRefObject<{ restoreTexts: (t: string[]) => void } | null>,
    injectedLaunchSessionsRef: { current: new Set<string>() },
    isAwayFromBottomRef: { current: false },
    lastRealSessionIdRef: { current: null },
    messageAreaRef: { current: null },
    newSessionStreamIdsRef: { current: new Set<string>([PENDING]) },
    pendingReplyStartedAtRef: { current: new Map<string, number>() } as MutableRefObject<Map<string, number>>,
    abortLocalCommitRef: { current: new Map<string, number>() } as MutableRefObject<Map<string, number>>,
    projectIdRef: { current: "proj" },
    projectPathRef: { current: "D:/x" },
    refetchSessionsRef: { current: null } as MutableRefObject<((silent?: boolean) => Promise<Session[]>) | null>,
    selectedSessionRef: { current: PENDING } as MutableRefObject<string | null>,
    selectedTaskSkillIdRef: { current: "" },
    sessionsRef: { current: null } as MutableRefObject<Session[] | null>,
    stagedApiRef: { current: null } as MutableRefObject<StagedGuideApi | null>,
    supportsSteerRef: { current: true } as MutableRefObject<boolean>,
    syncSessionListMessagesRef: { current: vi.fn<(sessionId: string, messages: Message[]) => void>() },
    runStagedCompactionRef: { current: null } as MutableRefObject<StagedCompactionRunner | null>,
    takeCompactionRequest: () => true,
    taskLaunchOpenRef: { current: false },
    taskLaunchPhaseRef: { current: null },
    taskLaunchGoalRef: { current: null },
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

const callsTo = (command: string) =>
  vi.mocked(invokeCommand).mock.calls.filter(([cmd]) => cmd === command);

describe("评审修复轮 R3：会话解析时任务实例只读刷新", () => {
  let deps: Deps;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    steerCoordinator.clearAll();
    vi.mocked(invokeCommand).mockReset();
    vi.mocked(invokeCommand).mockImplementation(async () => null);
    setWindowActiveForTest(true);
    deps = makeDeps();
    stop = startAgentEventPipeline(deps as never);
  });

  afterEach(() => {
    stop?.();
    for (const sid of [PENDING, REAL]) streamStore.drop(sid);
  });

  it("R3-1-FE4 任务发起：session_resolved 到达时不再创建任务实例，按任务号读回带真实会话号的那一份", async () => {
    deps.taskLaunchOpenRef.current = true;
    // 发送入口已经建好了实例（send_message 的返回值带 task_instance，页面据此落了任务号）。
    deps.activeTaskInstanceIdRef.current = "task-123";
    const record = {
      task_id: "task-123",
      task_session_id: REAL,
      title: "把登录页改成深色",
      skill_id: "jishu-task-runner",
      status: "active",
    };
    vi.mocked(invokeCommand).mockImplementation(
      async (cmd: string) => (cmd === "task_launch_get_instance" ? record : null) as never,
    );

    sessionResolved();

    await vi.waitFor(() =>
      expect(deps.applyTaskLaunchInstanceSnapshot).toHaveBeenCalledWith(record),
    );
    expect(callsTo("task_launch_get_instance")).toEqual([
      ["task_launch_get_instance", { projectRoot: "D:/x", taskId: "task-123" }],
    ]);
    // 修前：这里调 task_launch_mark_session 创建实例——晚于首条 prompt。
    expect(vi.mocked(invokeCommand).mock.calls.some(([cmd]) => cmd === "task_launch_mark_session")).toBe(false);
  });

  it("R3-1-FE4 这次不是任务发起（没有任务号）：不读回、不创建", () => {
    deps.taskLaunchOpenRef.current = true;
    sessionResolved();

    expect(deps.applyTaskLaunchInstanceSnapshot).not.toHaveBeenCalled();
    expect(callsTo("task_launch_get_instance")).toHaveLength(0);
    expect(callsTo("task_launch_mark_session")).toHaveLength(0);
  });

  it("R3-1-FE4 读回为空（实例不在了）：不应用快照、不报错", async () => {
    deps.taskLaunchOpenRef.current = true;
    deps.activeTaskInstanceIdRef.current = "task-gone";
    sessionResolved();

    await vi.waitFor(() => expect(callsTo("task_launch_get_instance")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.applyTaskLaunchInstanceSnapshot).not.toHaveBeenCalled();
  });
});
