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
import { invokeCommand } from "@/hooks/use-invoke";
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

  // ── v0.9.6 需求1：真实事件顺序（Rust 调序后 end = divider 在前、status 在后）──

  it("真实顺序：start divider → end divider(终态) → status(false) → 流终结且缓存 title 为终态", () => {
    // compaction_start：divider(压缩中) 起纯压缩流
    emit(dividerChunk("上下文压缩中…"));
    emit({ agent_id: "jishu-self", session_id: "s1", data: { kind: "compaction_status", active: true, reason: "manual" } });
    expect(streamStore.getState("s1")).not.toBeNull();

    // compaction_end（调序后）：终态 divider 先到——原位替换 title（流仍在）
    emit(dividerChunk("上下文已压缩"));
    // status(false) 后到——终结纯压缩流，提交的 divider title 应已是终态
    emit({ agent_id: "jishu-self", session_id: "s1", data: { kind: "compaction_status", active: false, reason: "manual" } });

    expect(streamStore.getState("s1")).toBeNull();
    expect(setCachedSessionMessages).toHaveBeenCalledWith(
      "s1",
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ type: "phase_divider", phase: "compaction", title: "上下文已压缩" })],
        }),
      ]),
    );
  });


  // ── v0.9.6 需求1 完善修复②：完成 divider 同步当前视图（修「分隔线消失」） ──
  it("完善②：压缩完成时正在查看该会话 → setSessionMessages 同步完成分隔线", () => {
    // 起纯压缩流 → 终态 divider → status(false)
    emit(dividerChunk("上下文压缩中…"));
    emit(dividerChunk("上下文已压缩"));
    emit({ agent_id: "jishu-self", session_id: "s1", data: { kind: "compaction_status", active: false, reason: "manual" } });
    // selectedSessionRef 指向 s1（makeDeps 默认 selectedSessionRef.current = "s1"）
    expect(deps.setSessionMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ type: "phase_divider", phase: "compaction", title: "上下文已压缩" })],
        }),
      ]),
    );
    expect(streamStore.getState("s1")).toBeNull();
  });

  it("完善②：查看的是别的会话 → 不动当前视图（只写缓存）", () => {
    const otherDeps = { ...deps, selectedSessionRef: { current: "s2" } } as never;
    stop?.();
    stop = startAgentEventPipeline(otherDeps);
    emit(dividerChunk("上下文压缩中…"));
    emit(dividerChunk("上下文已压缩"));
    emit({ agent_id: "jishu-self", session_id: "s1", data: { kind: "compaction_status", active: false, reason: "manual" } });
    expect((otherDeps as { setSessionMessages: ReturnType<typeof vi.fn> }).setSessionMessages).not.toHaveBeenCalled();
  });

  it("防御层：终态 divider 在无流状态下不自动起流（堵「复活出无人终结的流」）", () => {
    // 流不存在时直接到达终态 divider（异常残余路径）——不得起流
    emit(dividerChunk("上下文已压缩"));
    expect(streamStore.getState("s1")).toBeNull();
    emit(dividerChunk("上下文压缩失败"));
    expect(streamStore.getState("s1")).toBeNull();
    emit(dividerChunk("上下文压缩已取消"));
    expect(streamStore.getState("s1")).toBeNull();
    // 进行中 divider 仍正常起流（既有行为不回归）
    emit(dividerChunk("上下文压缩中…"));
    expect(streamStore.getState("s1")).not.toBeNull();
  });

  // ── v0.9.8 需求7 补充轮：压缩结束 = 引擎空闲 → 自动发出暂存消息 ──
  const STAGED_CTX = { projectPath: "D:/x", agentId: "jishu-self" };
  const compactionStatus = (active: boolean) => ({
    agent_id: "jishu-self",
    session_id: "s1",
    data: { kind: "compaction_status", active, reason: "manual" },
  });

  it("UC-13 压缩结束：暂存区有两条 → 自动发出队首一条，其余放回暂存区", async () => {
    const staged = [
      { id: "st-1", content: "继续", files: [], context: STAGED_CTX },
      { id: "st-2", content: "再看一下接口设计", files: [], context: STAGED_CTX },
    ];
    const claimAll = vi.fn(() => staged);
    const restore = vi.fn();
    deps.stagedApiRef.current = { claimAll, restore, moveKey: vi.fn() } as never;

    emit(dividerChunk("上下文压缩中…"));
    emit(dividerChunk("上下文已压缩"));
    emit(compactionStatus(false));

    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith(
        "send_message",
        expect.objectContaining({ sessionId: "s1", message: "继续", agentId: "jishu-self" }),
      );
    });
    expect(restore).toHaveBeenCalledWith("s1", [staged[1]]);
    // 压缩流已终结；为这条消息的回复起了新流（等引擎回话）
    expect(streamStore.getState("s1")?.isStreaming).toBe(true);
    expect(streamStore.getState("s1")?.pendingUserMessage).toBeNull();
  });

  it("UC-14 压缩进行中不领取暂存（开始、进行态分隔线替换都不领取）", () => {
    const claimAll = vi.fn(() => []);
    deps.stagedApiRef.current = { claimAll, restore: vi.fn(), moveKey: vi.fn() } as never;

    emit(dividerChunk("上下文压缩中…"));
    emit(compactionStatus(true));
    emit(dividerChunk("上下文压缩中…"));
    expect(claimAll).not.toHaveBeenCalled();
    expect(invokeCommand).not.toHaveBeenCalledWith("send_message", expect.anything());
  });

  it("UC-14 压缩被用户取消同样算引擎空闲：暂存消息照常发出", async () => {
    const claimAll = vi.fn(() => [{ id: "st-1", content: "继续", files: [], context: STAGED_CTX }]);
    deps.stagedApiRef.current = { claimAll, restore: vi.fn(), moveKey: vi.fn() } as never;

    emit(dividerChunk("上下文压缩中…"));
    emit(dividerChunk("上下文压缩已取消"));
    emit(compactionStatus(false));

    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith(
        "send_message",
        expect.objectContaining({ sessionId: "s1", message: "继续" }),
      );
    });
  });

  it("UC-14 混合流（压缩期间用户已发出消息）：压缩结束不领取暂存——留给回合结束", () => {
    const claimAll = vi.fn(() => []);
    deps.stagedApiRef.current = { claimAll, restore: vi.fn(), moveKey: vi.fn() } as never;

    streamStore.start("s1", "用户问题");
    emit(dividerChunk("上下文压缩中…"));
    emit(dividerChunk("上下文已压缩"));
    emit({ ...compactionStatus(false), data: { kind: "compaction_status", active: false, reason: "threshold" } });

    expect(claimAll).not.toHaveBeenCalled();
    expect(streamStore.getState("s1")?.pendingUserMessage).toBe("用户问题");
  });
});
