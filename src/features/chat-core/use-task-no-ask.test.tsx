/**
 * v0.9.8 需求22 / 评审修复轮 R2（契约 C4）：「不询问」开关按会话读写。
 * 对应 tests/S-用例清单 S3-U1～S3-U6。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { taskLaunchNoAsk, useTaskNoAsk } from "./use-task-no-ask";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

const callsTo = (command: string) => invokeCommand.mock.calls.filter(([cmd]) => cmd === command);

function settle(value: boolean) {
  let resolve!: (v: boolean) => void;
  let reject!: (e: unknown) => void;
  invokeCommand.mockReturnValue(new Promise<boolean>((res, rej) => { resolve = res; reject = rej; }));
  return { resolve, reject, value };
}

describe("评审修复轮 R2：不询问开关跟着选中的会话读写", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
    invokeCommand.mockResolvedValue(false);
  });

  it("S3-U1 读：按选中的会话读开关", async () => {
    const pending = settle(true);
    const { result } = renderHook(() => useTaskNoAsk("s1", null));
    expect(callsTo("task_get_no_ask")).toEqual([["task_get_no_ask", { sessionId: "s1" }]]);
    expect(result.current.taskNoAsk).toBe(false);
    await act(async () => {
      pending.resolve(true);
    });
    expect(result.current.taskNoAsk).toBe(true);
  });

  it("S3-U2 写：按会话写，先乐观更新，回执校正", async () => {
    const pending = settle(true);
    const { result } = renderHook(() => useTaskNoAsk("s1", null));
    await act(async () => {
      pending.resolve(false);
    });
    const ack = settle(true);
    act(() => result.current.handleTaskNoAskChange(true));
    expect(callsTo("task_set_no_ask")).toEqual([["task_set_no_ask", { sessionId: "s1", enabled: true }]]);
    expect(result.current.taskNoAsk).toBe(true);
    await act(async () => {
      ack.resolve(false); // 后端记下的值与请求不同：以回执为准
    });
    expect(result.current.taskNoAsk).toBe(false);
  });

  it("S3-U7（二轮评审 R3 P2-2）读回执晚于写回执到达：旧读作废，以写为准", async () => {
    // 刚切到 s1、读还没回来就点了开关
    const reading = settle(false);
    const { result } = renderHook(() => useTaskNoAsk("s1", null));
    const writing = settle(true);
    act(() => result.current.handleTaskNoAskChange(true));
    expect(result.current.taskNoAsk).toBe(true);
    // 写回执先到（true），旧读回执后到（写之前的值 false）
    await act(async () => {
      writing.resolve(true);
    });
    await act(async () => {
      reading.resolve(false);
    });
    // 修前：旧读把开关拨回 false，而后端已是 true
    expect(result.current.taskNoAsk).toBe(true);
  });

  it("S3-U3 切换会话：重读新会话的值；旧会话晚到的回执不写进新会话的显示", async () => {
    const ackS1 = settle(true);
    const { result, rerender } = renderHook<
      ReturnType<typeof useTaskNoAsk>,
      { sid: string | null }
    >(({ sid }) => useTaskNoAsk(sid, null), { initialProps: { sid: "s1" } });
    await act(async () => {
      ackS1.resolve(false);
    });
    // 在 s1 里打开开关，写请求还没回来
    const writing = settle(true);
    act(() => result.current.handleTaskNoAskChange(true));
    expect(result.current.taskNoAsk).toBe(true);

    // 切到 s2：读到的是 false（写请求的替身还在悬挂，读请求各回各的）
    invokeCommand.mockImplementation((cmd: string) =>
      cmd === "task_get_no_ask" ? Promise.resolve(false) : writing);
    rerender({ sid: "s2" });
    expect(callsTo("task_get_no_ask").map(([, args]) => args.sessionId)).toEqual(["s1", "s2"]);

    // s1 的写回执这时才到（true）——不能把 s2 的开关点亮
    await act(async () => {
      writing.resolve(true);
    });
    expect(result.current.taskNoAsk).toBe(false);
  });

  it("S3-U4 该会话所属任务上下文变化：重读", async () => {
    const { rerender } = renderHook<
      ReturnType<typeof useTaskNoAsk>,
      { task: string | null }
    >(({ task }) => useTaskNoAsk("s1", task), { initialProps: { task: null } });
    expect(callsTo("task_get_no_ask")).toHaveLength(1);
    rerender({ task: "task-9" });
    expect(callsTo("task_get_no_ask")).toEqual([
      ["task_get_no_ask", { sessionId: "s1" }],
      ["task_get_no_ask", { sessionId: "s1" }],
    ]);
  });

  it("S3-U5 写失败：回滚", async () => {
    const { result } = renderHook(() => useTaskNoAsk("s1", null));
    const ack = settle(true);
    act(() => result.current.handleTaskNoAskChange(true));
    expect(result.current.taskNoAsk).toBe(true);
    await act(async () => {
      ack.reject(new Error("db locked"));
    });
    expect(result.current.taskNoAsk).toBe(false);
  });

  it("S3-U6 没有选中会话：不读、不写", () => {
    const { result } = renderHook(() => useTaskNoAsk(null, null));
    expect(callsTo("task_get_no_ask")).toHaveLength(0);
    act(() => result.current.handleTaskNoAskChange(true));
    expect(callsTo("task_set_no_ask")).toHaveLength(0);
  });
});

describe("评审修复轮 R3：发消息之前点开关 / 读写带项目根", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
    invokeCommand.mockResolvedValue(false);
  });

  it("R3-1-FE2 新任务页还没有会话时点「不询问」：只记意图，不调后端；意图随首条消息带过去", () => {
    const { result } = renderHook(() => useTaskNoAsk(null, null));
    expect(result.current.taskNoAsk).toBe(false);
    expect(result.current.pendingNoAsk).toBe(false);

    act(() => result.current.handleTaskNoAskChange(true));
    // 此刻任务实例还不存在：没有可写的会话，不调 task_set_no_ask。
    expect(callsTo("task_set_no_ask")).toHaveLength(0);
    expect(callsTo("task_get_no_ask")).toHaveLength(0);
    expect(result.current.pendingNoAsk).toBe(true);
    expect(result.current.taskNoAsk).toBe(true);

    act(() => result.current.handleTaskNoAskChange(false));
    expect(result.current.pendingNoAsk).toBe(false);
  });

  it("R3-1-FE2 有了会话：意图作废，开关以读回的会话值为准", async () => {
    const reading = settle(true);
    const { result, rerender } = renderHook<
      ReturnType<typeof useTaskNoAsk>,
      { sid: string | null }
    >(({ sid }) => useTaskNoAsk(sid, null), { initialProps: { sid: null } });
    act(() => result.current.handleTaskNoAskChange(true));
    expect(result.current.pendingNoAsk).toBe(true);

    rerender({ sid: "task-session-1" });
    expect(result.current.pendingNoAsk).toBe(false);
    // 读还没回来：不显示旧的意图。
    expect(result.current.taskNoAsk).toBe(false);
    await act(async () => {
      reading.resolve(true);
    });
    expect(result.current.taskNoAsk).toBe(true);
  });

  it("R3-1-FE5 知道项目根时读、写都带上（后端省一次会话目录扫描）", async () => {
    const reading = settle(false);
    const { result } = renderHook(() => useTaskNoAsk("s1", null, "D:\\Work\\demo"));
    expect(callsTo("task_get_no_ask")).toEqual([
      ["task_get_no_ask", { sessionId: "s1", projectRoot: "D:\\Work\\demo" }],
    ]);
    await act(async () => {
      reading.resolve(false);
    });
    const ack = settle(false);
    act(() => result.current.handleTaskNoAskChange(true));
    expect(callsTo("task_set_no_ask")).toEqual([
      [
        "task_set_no_ask",
        { sessionId: "s1", enabled: true, projectRoot: "D:\\Work\\demo" },
      ],
    ]);
    // 读、写仍共用一个请求序号：写回执先到、旧读回执后到，以写为准。
    await act(async () => {
      ack.resolve(true);
    });
    expect(result.current.taskNoAsk).toBe(true);
  });

  it("R3-1-FE5 不知道项目根（没传）：参数里没有这个键，后端走会话目录定位", () => {
    renderHook(() => useTaskNoAsk("s1", null, null));
    expect(callsTo("task_get_no_ask")).toEqual([["task_get_no_ask", { sessionId: "s1" }]]);
  });

  it("R3-1-FE6 任务意图里的「不询问」：只有新任务带（发第一条之前点的那一下）；已有任务不带", () => {
    // 新任务：发第一条之前点开 / 没点，原样带过去。
    expect(taskLaunchNoAsk(null, true)).toBe(true);
    expect(taskLaunchNoAsk(null, false)).toBe(false);
    // 已有任务：开关在实例上、按会话读写——不带，免得把用户开的开关冲掉。
    expect(taskLaunchNoAsk("task-1", true)).toBeUndefined();
    expect(taskLaunchNoAsk("task-1", false)).toBeUndefined();
  });
});
