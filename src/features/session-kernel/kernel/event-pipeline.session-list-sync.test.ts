/**
 * v0.9.8 需求23 补充轮验证中追加：回合结束后，会话列表里该会话的消息换成正文那一份
 *（tests/06-测试清单 S23-U30、S23-U31）。
 *
 * 侧栏搜索与摘要读的是列表；列表只在读取时从磁盘读一次，同一个会话第二轮起再聊的
 * 内容列表里没有——搜不到刚聊的内容，徽标数停在第一轮。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEventPayload, Message, Session } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";
import { getCachedSessionMessages, setCachedSessionMessages } from "./session-cache";
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

const emitTurnComplete = (sessionId: string) => {
  if (!listenCallback) throw new Error("pipeline not started");
  listenCallback({ payload: { event_type: "chunk", agent_id: "jishu-self", session_id: sessionId, data: { kind: "turn_complete", reason: "Complete", usage: null } } as unknown as AgentEventPayload });
};

const message = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
  timestamp: 1,
});

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
    // 「把这个会话的消息写进列表」——本组用例的被测对象
    syncSessionListMessagesRef: { current: vi.fn<(sessionId: string, messages: Message[]) => void>() },
    stagedApiRef: { current: null },
    supportsSteerRef: { current: true } as MutableRefObject<boolean>,
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

describe("v0.9.8 需求23：回合结束后，列表里该会话的消息换成正文那一份", () => {
  let deps: ReturnType<typeof makeDeps>;
  let stop: (() => void) | null = null;
  /** 回合开始前缓存里已有的两条消息（上一轮的问答）。 */
  const base = [message("user", "上一轮的问题"), message("assistant", "上一轮的回答")];

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
    vi.mocked(getCachedSessionMessages).mockReturnValue(base);
    stop = startAgentEventPipeline(deps as never);
  });

  afterEach(() => {
    stop?.();
    streamStore.drop("s1");
  });

  it("已有的会话：写进列表的那一份就是写进正文、写进缓存的同一个数组；不重读列表——S23-U30", () => {
    streamStore.start("s1", "这一轮的问题");
    emitTurnComplete("s1");

    const sync = vi.mocked(deps.syncSessionListMessagesRef.current);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0]).toBe("s1");

    const written = sync.mock.calls[0][1];
    // 前两条是原有的，后面跟着这一轮新聊的
    expect(written.slice(0, 2)).toEqual(base);
    expect(written.length).toBeGreaterThan(2);
    expect(written.some((item) => item.content.some((block) => block.type === "text" && block.text.includes("这一轮的问题")))).toBe(true);
    // 与正文、缓存拿到的是同一个数组——不是另抄一份
    const toBody = vi.mocked(deps.setSessionMessages).mock.calls;
    expect(toBody.length).toBeGreaterThan(0);
    expect(toBody[toBody.length - 1][0]).toBe(written);
    const toCache = vi.mocked(setCachedSessionMessages).mock.calls;
    expect(toCache[toCache.length - 1][1]).toBe(written);

    // 已有的会话不重读列表（重读要把项目里每个会话文件全量解析一遍）
    expect(deps.refetchSessionsRef.current).toBeNull();
  });

  it("新会话的第一轮：重读列表完成后再写入一次——S23-U31", async () => {
    deps.newSessionStreamIdsRef.current = new Set(["s1"]);
    let finishRefetch: ((list: Session[]) => void) | null = null;
    const refetch = vi.fn(() => new Promise<Session[]>((resolve) => { finishRefetch = resolve; }));
    deps.refetchSessionsRef.current = refetch;

    streamStore.start("s1", "这一轮的问题");
    emitTurnComplete("s1");

    const sync = vi.mocked(deps.syncSessionListMessagesRef.current);
    // 重读还没完成：已经写入过一次，重读发起了
    expect(sync).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);

    finishRefetch!([]);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    // 第二次写入的仍是同一份消息、同一个会话
    expect(sync.mock.calls[1][0]).toBe("s1");
    expect(sync.mock.calls[1][1]).toBe(sync.mock.calls[0][1]);
    // 标记已清掉——下一轮按「已有的会话」走，不再重读
    expect(deps.newSessionStreamIdsRef.current.has("s1")).toBe(false);
  });
});
