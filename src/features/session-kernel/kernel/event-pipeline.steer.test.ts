/**
 * v0.9.4 需求7：steer 停止链路管线行为（steer_queue_cleared 对账重发 /
 * Abort 兜底不预创建 follow-up thinking）。集成式驱动 startAgentEventPipeline
 * （mock listen 捕获事件回调），验证两个根因修复点：
 *  - 缺陷二主修：clear_queue 分组回传 → 前端队列对账 + steering 自动重发
 *    （send_message 真实调用），followUp 回填输入框。
 *  - 缺陷二兜底：TurnComplete(Aborted) + 队列残留 → 不预创建无超时
 *    thinking 态（streamStore 无 start），走真实重发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEventPayload, Session } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";
import { steerCoordinator } from "./steer-coordinator";
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

const emit = (payload: Record<string, unknown> | Record<string, unknown>[]) => {
  if (!listenCallback) throw new Error("pipeline not started");
  // 测试便捷：缺省 event_type 字段（管线读取 data 分发，不依赖它）。
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
    t: ((k: string, d?: Record<string, unknown>) =>
      (d ? Object.entries(d).reduce<string>((acc, [kk, vv]) => acc.split(`{{${kk}}}`).join(String(vv)), k) : k)) as unknown as TFunction,
  };
}

describe("v0.9.4 需求7：steer 停止链路", () => {
  let deps: ReturnType<typeof makeDeps>;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    steerCoordinator.clearAll();
    deps = makeDeps();
    stop = startAgentEventPipeline(deps as never);
    // 会话流态就绪（simulating an in-flight turn）
    streamStore.start("s1", "用户问题");
  });

  afterEach(() => {
    stop?.();
    streamStore.drop("s1");
  });

  it("steer_queue_cleared 分组：steering 暂存并延后到 Abort 终结重发，followUp 回填输入框", async () => {
    steerCoordinator.stage("s1", "引导A"); steerCoordinator.stage("s1", "排队B");
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "steer_queue_cleared", texts: ["引导A", "排队B"], follow_up_texts: ["排队B"] },
    });
    // followUp（排队B）回填输入框（正查看的会话）
    expect(deps.chatInputRef.current?.restoreTexts).toHaveBeenCalledWith(["排队B"]);
    // 前端队列已对账清空（占位随队列投影消失）；pendingResend 保留待 Abort 终结重发
    expect(steerCoordinator.queueOf("s1")).toHaveLength(0);
    // 测试期修复二：重发延后——不立即 start（不重置原回合流）也不发送
    expect(streamStore.getState("s1")?.pendingUserMessage).toBe("用户问题");
    expect(invokeCommand).not.toHaveBeenCalledWith("send_message", expect.objectContaining({ message: "引导A" }));
    // Abort 回合终结后统一重发
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Aborted", usage: null },
    });
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("send_message", expect.objectContaining({
        sessionId: "s1",
        message: "引导A",
      }));
    });
    // A 的原回合内容（pendingUserMessage）在重发前已提交（顺序：A 在前 B 在后）
    const setCalls = (deps.setSessionMessages as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const flat = JSON.stringify(setCalls);
    expect(flat).toContain("用户问题");
  });

  it("旧形状事件（无 follow_up_texts）：全部视为 steering（对账语义不变，重发延后）", async () => {
    steerCoordinator.stage("s1", "旧引导");
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "steer_queue_cleared", texts: ["旧引导"] },
    });
    expect(steerCoordinator.queueOf("s1")).toHaveLength(0);
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Aborted", usage: null },
    });
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("send_message", expect.objectContaining({
        sessionId: "s1",
        message: "旧引导",
      }));
    });
  });

  it("TurnComplete(Aborted) + 队列残留：走真实重发（thinking 态有 send_message 支撑），非裸等待", async () => {
    steerCoordinator.stage("s1", "引导C");
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Aborted", usage: null },
    });
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("send_message", expect.objectContaining({
        sessionId: "s1",
        message: "引导C",
      }));
    });
    // 关键区分（vs 旧缺陷）：旧路径预创建**无来源**的无超时 thinking 态等
    // 一个永不会来的 follow-up；新路径的 thinking 态由真实 send_message 支撑，
    // 且带防伪守卫标记（保护新流不被旧回合迟到完成事件误杀）。
    expect(deps.pendingReplyStartedAtRef.current.has("s1")).toBe(true);
    expect(steerCoordinator.isEmpty("s1")).toBe(true);
  });



  it("测试期复现（用户实测双条）：引导+停止后占位必清零、消息恰一条", async () => {
    // 场景 A：steer 未注入（pi 队列被清）——steer_queue_cleared 对账+重发
    steerCoordinator.stage("s1", "引导A");

    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "steer_queue_cleared", texts: ["引导A"], follow_up_texts: [] },
    });
    expect(steerCoordinator.queueOf("s1")).toHaveLength(0);
    expect(steerCoordinator.queueOf("s1")).toHaveLength(0);
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Aborted", usage: null },
    });
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("send_message", expect.objectContaining({ message: "引导A" }));
    });

    // 场景 B：文本展开变形（对账匹配失败）——占位仍按事件数清，队列残留被
    // Abort 终结闸门清零，不产生第二条。
    streamStore.drop("s1");
    streamStore.start("s1", "继续");
    steerCoordinator.stage("s1", "原文");

    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "steer_queue_cleared", texts: ["展开后的文本"], follow_up_texts: [] },
    });
    expect(steerCoordinator.queueOf("s1")).toHaveLength(0);
    // 对账匹配失败残留的队列 + 暂存重发由 Abort 终结统一收口：
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Aborted", usage: null },
    });
    await vi.waitFor(() => {
      expect(steerCoordinator.isEmpty("s1")).toBe(true);
      expect(invokeCommand).toHaveBeenCalledWith("send_message", expect.objectContaining({ message: "展开后的文本" }));
    });
  });


  it("测试期重构补丁：steer 注入即消费队列 + turn_complete 以 steerTexts 交错提交（多 turn 形态）", async () => {
    steerCoordinator.stage("s1", "监控方案怎么做");
    // A 回复流式
    streamStore.push("s1", { session_id: "s1", event_type: "text_delta", data: { kind: "text_delta", delta: "部署方式如下" } } as never);
    // steer 注入（pi turn 边界转新 turn，message_start user 回显归一化为 SteerInjected）
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "steer_injected", content: "监控方案怎么做" },
    });
    // 注入即消费：占位（队列投影）立即消失
    expect(steerCoordinator.queueOf("s1")).toHaveLength(0);
    // B 回复流式（同一流，steerSplits 之后）
    streamStore.push("s1", { session_id: "s1", event_type: "text_delta", data: { kind: "text_delta", delta: "监控用 Prometheus" } } as never);
    // 缓冲合并后的唯一 TurnComplete
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Complete", usage: null },
    });
    await vi.waitFor(() => {
      expect(streamStore.getState("s1")).toBeNull();
    });
    // 提交消息含 [A 回复, B 引导, B 回复] 交错（B 以流内 steerTexts 为源）
    const setCalls = (deps.setSessionMessages as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const last = JSON.stringify(setCalls[setCalls.length - 1]);
    expect(last).toContain("部署方式如下");
    expect(last).toContain("监控方案怎么做");
    expect(last).toContain("监控用 Prometheus");
    expect(steerCoordinator.isEmpty("s1")).toBe(true);
  });

  it("正常完成不清残队列（多条引导第 2+ 条等 follow-up turn，闸门仅限 Abort）", async () => {
    streamStore.drop("s1");
    streamStore.start("s1", "问");
    steerCoordinator.stage("s1", "第一条"); steerCoordinator.stage("s1", "第二条");
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Complete", usage: null },
    });
    await vi.waitFor(() => {
      expect(streamStore.getState("s1")).not.toBeNull();
    });
    // 第一条被提交（followUpExpected），第二条留在队列等 pi follow-up turn
    expect(steerCoordinator.textsOf("s1")).toEqual(["第二条"]);
  });

  it("v0.9.4 需求8：tool_use_progress 200ms 节流（同 call_id 第二发被吞，异 call_id 放行）", async () => {
    streamStore.push("s1", {
      session_id: "s1",
      event_type: "tool_use_start",
      data: { kind: "tool_use_start", call_id: "c1", tool: "bash", input: {} },
    } as never);
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "tool_use_progress", call_id: "c1", partial_output: "first" },
    });
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "tool_use_progress", call_id: "c1", partial_output: "second-throttled" },
    });
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "tool_use_progress", call_id: "c2", partial_output: "other-call" },
    });
    await new Promise((r) => setTimeout(r, 10));
    const tools = streamStore.getState("s1")!.tools;
    const c1 = tools.find((t) => t.id === "c1");
    const c2 = tools.find((t) => t.id === "c2");
    expect(c1?.partialOutput).toBe("first");
    expect(c2?.partialOutput).toBeUndefined(); // c2 无 start，不建条目
  });


  it("测试期复现三（用户实测 B 消失）：onAbort 本地提交+标记 → TurnComplete 凭标记跳过重复但收口重发", async () => {
    steerCoordinator.stage("s1", "B引导");
    // 事件序：steer_queue_cleared（对账+暂存）→ onAbort（本地标记）→ TurnComplete。
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "steer_queue_cleared", texts: ["B引导"], follow_up_texts: [] },
    });
    // onAbort 本地乐观提交后设标记（chat-page handleAbort 行为）。
    deps.abortLocalCommitRef.current.set("s1", Date.now());
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Aborted", usage: null },
    });
    // 收口必须执行：B 被重发（旧代码因本地 drop 流导致收口被拒，B 消失）。
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("send_message", expect.objectContaining({
        sessionId: "s1",
        message: "B引导",
      }));
    });
    expect(steerCoordinator.isEmpty("s1")).toBe(true);
    // 标记已被终结者清理。
    expect(deps.abortLocalCommitRef.current.has("s1")).toBe(false);
  });

  it("TurnComplete(Complete) + 队列残留：维持 follow-up 预创建（正常路径不回归）", async () => {
    steerCoordinator.stage("s1", "引导D");
    emit({
      agent_id: "jishu-self",
      session_id: "s1",
      data: { kind: "turn_complete", reason: "Complete", usage: null },
    });
    await vi.waitFor(() => {
      // followUpExpected 预创建空流式态（thinking 指示）
      expect(streamStore.getState("s1")).not.toBeNull();
    });
    // 正常完成不触发 send_message（pi 自己消化 follow-up）
    expect(invokeCommand).not.toHaveBeenCalledWith("send_message", expect.objectContaining({ message: "引导D" }));
    expect(steerCoordinator.isEmpty("s1")).toBe(true);
  });
});
