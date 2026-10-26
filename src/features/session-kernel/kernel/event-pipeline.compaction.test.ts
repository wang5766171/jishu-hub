/**
 * v0.9.4 需求13：手动压缩后会话流永不终结——核心修复的行为验证。
 * 场景链（用户日志 #69-#102）：
 *  1. 压缩开始：phase_divider(compaction) 经 pushTracked 自动起纯压缩流 →
 *     无 turn_complete 可等（压缩是 operation 不是 turn）。
 *  2. 压缩结束：compaction_status(active=false) 到达 → 纯压缩流终结——
 *     divider 按回放形态（assistant 消息单 divider）提交缓存 + drop 流。
 *  3. 混合流（压缩期间用户发消息）不 drop——由后续 turn_complete 收尾。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEventPayload, Session } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";
import { startAgentEventPipeline } from "./event-pipeline";
import { getCachedSessionMessages, setCachedSessionMessages } from "./session-cache";

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
    setPendingInteractions: vi.fn(),
    setSelectedSession: vi.fn(),
    setSessionMessages: vi.fn(),
    applyTaskLaunchInstanceSnapshot: vi.fn(),
    refreshSessionUsage: vi.fn(),
    discoverConductorTask: vi.fn(async () => {}),
    t: ((k: string) => k) as unknown as TFunction,
  };
}

const dividerChunk = (title: string) => ({
  agent_id: "jishu-self",
  session_id: "s1",
  data: { kind: "phase_divider", phase: "compaction", title },
});

describe("v0.9.4 需求13：手动压缩流终结", () => {
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

  it("纯压缩流：divider 起流 → 压缩结束 status(false) 终结（divider 提交缓存 + drop）", () => {
    // 压缩开始：divider 到达（无活跃流 → pushTracked 自动起纯压缩流）
    emit(dividerChunk("上下文压缩中…"));
    const st = streamStore.getState("s1");
    expect(st).not.toBeNull();
    expect(st?.pendingUserMessage).toBeNull();

    // 压缩结束：active=false 到达
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "compaction_status", active: false, reason: "manual" },
    });

    // 流已终结（"处理中"永挂修复点）
    expect(streamStore.getState("s1")).toBeNull();
    // divider 按回放形态提交进缓存（assistant 消息单 divider）
    expect(setCachedSessionMessages).toHaveBeenCalledWith(
      "s1",
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ type: "phase_divider", phase: "compaction" })],
        }),
      ]),
    );
    expect(getCachedSessionMessages("s1")).toBeNull();
  });

  it("混合流（压缩期间用户发消息）：status(false) 不 drop——等 turn_complete 收尾", () => {
    // 用户消息先起流（真实回合），随后压缩 divider 到达（同一流内追加）
    streamStore.start("s1", "用户问题");
    emit(dividerChunk("上下文压缩中…"));
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "compaction_status", active: false, reason: "threshold" },
    });
    // 混合流不终结（有 pendingUserMessage），后续 turn_complete 正常收尾
    expect(streamStore.getState("s1")?.pendingUserMessage).toBe("用户问题");
    // 不提交 divider 缓存（由 turn_complete 的统一提交路径处理）
    expect(setCachedSessionMessages).not.toHaveBeenCalled();
  });

  it("压缩结束后（流已 drop）：后续 divider 不再重新起流挂死", () => {
    // 第一轮压缩：起流 → 终结
    emit(dividerChunk("上下文压缩中…"));
    emit({ agent_id: "jishu-self", session_id: "s1", data: { kind: "compaction_status", active: false, reason: "manual" } });
    expect(streamStore.getState("s1")).toBeNull();
    // 第二轮压缩（阈值级联）：同样起流 → 终结，不残留
    emit(dividerChunk("上下文压缩中…"));
    expect(streamStore.getState("s1")).not.toBeNull();
    emit({ agent_id: "jishu-self", session_id: "s1", data: { kind: "compaction_status", active: false, reason: "threshold" } });
    expect(streamStore.getState("s1")).toBeNull();
  });
});
