/**
 * v0.9.8 评审修复轮 R2：装备安装执行器——安装结果如实落行、已装跳过、取消语义。
 * 执行器被套装弹层与会话推荐卡共用，这里直接测 hook（页面级可见结果另见
 * plugin-market-bundle.test.tsx / equip-recommend-card.test.tsx）。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, alert: async () => {}, dialogNode: null }),
}));

import { useEquipmentRunner } from "./runner";
import type { RunState } from "./runner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 后端替身：三份已装台账 + 各安装命令的应答（onCommand 优先）。 */
function mockBackend(opts: {
  installed?: { plugins?: string[]; skills?: string[]; pi?: string[] };
  onCommand?: (cmd: string, args: Record<string, unknown>) => unknown;
}) {
  invokeCommand.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "plugin_list") {
      return Promise.resolve({ plugins: (opts.installed?.plugins ?? []).map((id) => ({ id })) });
    }
    if (cmd === "skillhub_installed") {
      return Promise.resolve(Object.fromEntries((opts.installed?.skills ?? []).map((s) => [s, "1.0.0"])));
    }
    if (cmd === "pi_package_installed_sources") return Promise.resolve(opts.installed?.pi ?? []);
    if (cmd === "pi_package_install_confirmed") {
      return Promise.resolve({ disabled: [{ opponent_display: "联网搜索" }] });
    }
    const custom = opts.onCommand?.(cmd, args);
    return custom instanceof Promise ? custom : Promise.resolve(custom ?? "installed");
  });
}

const installCalls = (cmd: string) =>
  invokeCommand.mock.calls.filter(([c]) => c === cmd).map(([, args]) => [cmd, args]);

const states = (result: { current: ReturnType<typeof useEquipmentRunner> }): Record<string, RunState> =>
  Object.fromEntries(result.current.statuses.map((s) => [s.ref, s.state]));

const stateOf = (result: { current: ReturnType<typeof useEquipmentRunner> }, ref: string): RunState | undefined =>
  result.current.statuses.find((s) => s.ref === ref)?.state;

const CONFLICT = {
  status: "conflict",
  conflicts: [{ tool: "web_search", opponent_source: "npm:pi-web-access@0.32.0", opponent_display: "联网搜索", opponent_builtin: true }],
};

describe("执行器 · 已装跳过", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
    confirmMock.mockReset();
  });

  it("M1-7 执行时已装的件不再安装，行直接是已装", async () => {
    mockBackend({ installed: { plugins: ["a"] } });
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => result.current.run([{ ref: "curated:a" }, { ref: "curated:b" }]));
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(installCalls("market_install")).toEqual([["market_install", { pluginId: "b", meta: { via: "manual" } }]]);
    expect(states(result)).toEqual({ "curated:a": "ok", "curated:b": "ok" });
  });

  it("M1-8 已装清单读不到：不发起安装，行给出原因", async () => {
    invokeCommand.mockImplementation((cmd: string) =>
      cmd === "plugin_list" ? Promise.reject("后端不可用") : Promise.resolve([]),
    );
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => result.current.run([{ ref: "curated:a" }, { ref: "skillhub:s" }]));
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(installCalls("market_install")).toHaveLength(0);
    expect(installCalls("skillhub_install")).toHaveLength(0);
    expect(states(result)).toEqual({ "curated:a": "fail", "skillhub:s": "fail" });
    // 二轮评审 R3（P2-15）：修前落行用 String(e)，出口抛的是 Error 对象，行上是
    // 「Error: 无法读取已安装清单…」——英文前缀上屏。
    expect(result.current.statuses.map((s) => s.error)).toEqual([
      "无法读取已安装清单，本次未安装",
      "无法读取已安装清单，本次未安装",
    ]);
  });
});

describe("执行器 · 失败原因可直接显示（P2-15）", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
    confirmMock.mockReset();
  });

  it("P2-15-U1 行上的失败原因去掉了机器前缀与括号里的英文原文；中文括号说明保留", async () => {
    mockBackend({
      onCommand: (_cmd, args) => {
        const id = (args as { pluginId: string }).pluginId;
        if (id === "a") return Promise.reject("[install_failed] 安装失败（npm ERR! network）");
        if (id === "b") return Promise.reject("提交超时（10 秒无响应），请重试");
        if (id === "c") return Promise.reject(new Error("技能包缺少 SKILL.md，已拒绝"));
        return "installed";
      },
    });
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => result.current.run([{ ref: "curated:a" }, { ref: "curated:b" }, { ref: "curated:c" }]));
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.statuses.map((s) => s.error)).toEqual([
      "安装失败",
      "提交超时（10 秒无响应），请重试",
      "技能包缺少 SKILL.md，已拒绝",
    ]);
  });
});

describe("执行器 · 安装结果如实落行（扩展撞名）", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
    confirmMock.mockReset();
  });

  it("M2-R1 撞名：行落「需确认」并弹确认卡；取消 → 未安装，不算成功", async () => {
    const answer = deferred<boolean>();
    confirmMock.mockReturnValue(answer.promise);
    mockBackend({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? CONFLICT : "installed") });
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => result.current.run([{ ref: "pi:npm:pkg-x" }]));
    await waitFor(() => expect(stateOf(result, "pi:npm:pkg-x")).toBe("confirm"));
    expect(result.current.running).toBe(true);
    // 确认卡与市场在线库卡片同一份文案
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({ title: "能力重叠：pkg-x", confirmText: "停用并安装" });
    expect(confirmMock.mock.calls[0][0].description).toContain("「联网搜索」（工具 web_search）");

    await act(async () => {
      answer.resolve(false);
    });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(states(result)).toEqual({ "pi:npm:pkg-x": "skipped" });
    expect(installCalls("pi_package_install_confirmed")).toHaveLength(0);
  });

  it("M2-R2 撞名：确认 → 停用对手并安装，行打勾", async () => {
    confirmMock.mockResolvedValue(true);
    mockBackend({ onCommand: (cmd) => (cmd === "pi_package_install_online" ? CONFLICT : "installed") });
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => result.current.run([{ ref: "pi:npm:pkg-x", meta: { via: "market-zone" } }]));
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(installCalls("pi_package_install_online")).toEqual([
      ["pi_package_install_online", { source: "npm:pkg-x", meta: { via: "market-zone" } }],
    ]);
    expect(installCalls("pi_package_install_confirmed")).toEqual([
      ["pi_package_install_confirmed", { source: "npm:pkg-x", meta: { via: "market-zone" } }],
    ]);
    expect(states(result)).toEqual({ "pi:npm:pkg-x": "ok" });
  });

  it("安装命令抛错 → 行失败并带原因，后续项继续", async () => {
    mockBackend({
      onCommand: (cmd, args) => (cmd === "market_install" && args.pluginId === "a" ? Promise.reject("网络不可达") : "installed"),
    });
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => result.current.run([{ ref: "curated:a" }, { ref: "curated:b" }]));
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(states(result)).toEqual({ "curated:a": "fail", "curated:b": "ok" });
    expect(result.current.statuses.find((s) => s.ref === "curated:a")?.error).toContain("网络不可达");
  });
});

describe("执行器 · 取消与运行生命周期", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
    confirmMock.mockReset();
  });

  it("M3-1 取消剩余项：没轮到的记未安装（不是失败）；在途项落定后才结束并回调", async () => {
    const b = deferred<string>();
    mockBackend({ onCommand: (cmd, args) => (cmd === "market_install" && args.pluginId === "b" ? b.promise : "installed") });
    const onDone = vi.fn();
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => {
      result.current.setOnDone(onDone);
      result.current.run([{ ref: "curated:a" }, { ref: "curated:b" }, { ref: "curated:c" }]);
    });
    await waitFor(() => expect(stateOf(result, "curated:a")).toBe("ok"));
    await waitFor(() => expect(stateOf(result, "curated:b")).toBe("running"));
    act(() => result.current.cancel());
    expect(stateOf(result, "curated:c")).toBe("skipped");
    // 在途项还没落定：运行没结束
    expect(result.current.running).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => {
      b.resolve("installed");
    });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(states(result)).toEqual({ "curated:a": "ok", "curated:b": "ok", "curated:c": "skipped" });
    expect(onDone).toHaveBeenCalledTimes(1);
    // 没轮到的件没有发起安装
    expect(installCalls("market_install").map(([, args]) => (args as { pluginId: string }).pluginId)).toEqual(["a", "b"]);
  });

  it("M3-6 取消后再点安装：与上一轮结果合并（先前装成的 ✓ 保留），汇总覆盖全部行", async () => {
    const slow = deferred<string>();
    mockBackend({ onCommand: (cmd, args) => (cmd === "market_install" && args.pluginId === "b" ? slow.promise : "installed") });
    const onDone = vi.fn();
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => {
      result.current.setOnDone(onDone);
      result.current.run([{ ref: "curated:a" }, { ref: "curated:b" }, { ref: "curated:c", meta: { via: "market-zone" } }]);
    });
    await waitFor(() => expect(stateOf(result, "curated:a")).toBe("ok"));
    await waitFor(() => expect(stateOf(result, "curated:b")).toBe("running"));
    act(() => result.current.cancel());
    await act(async () => {
      slow.resolve("installed");
    });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(states(result)).toEqual({ "curated:a": "ok", "curated:b": "ok", "curated:c": "skipped" });

    // 用户改主意，把没装的那件再点上
    act(() => result.current.run([{ ref: "curated:c", meta: { via: "market-zone" } }]));
    await waitFor(() => expect(result.current.running).toBe(false));
    // 先前装成的两件还在结果里（✓ 保留），新装的一件是 ok
    expect(states(result)).toEqual({ "curated:a": "ok", "curated:b": "ok", "curated:c": "ok" });
    expect(installCalls("market_install").map(([, args]) => (args as { pluginId: string }).pluginId)).toEqual(["a", "b", "c"]);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("M3-4 运行未落定前再次 run / retryFailed 不重复发起", async () => {
    const a = deferred<string>();
    mockBackend({ onCommand: () => a.promise });
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => result.current.run([{ ref: "curated:a" }]));
    await waitFor(() => expect(installCalls("market_install")).toHaveLength(1));
    act(() => {
      result.current.run([{ ref: "curated:a" }]);
      result.current.retryFailed();
    });
    expect(installCalls("market_install")).toHaveLength(1);
    await act(async () => {
      a.resolve("installed");
    });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(installCalls("market_install")).toHaveLength(1);
    expect(states(result)).toEqual({ "curated:a": "ok" });
  });

  it("reset 后在途结果不再写入（R1-7 运行代际语义不变）", async () => {
    const a = deferred<string>();
    mockBackend({ onCommand: () => a.promise });
    const onDone = vi.fn();
    const { result } = renderHook(() => useEquipmentRunner());
    act(() => {
      result.current.setOnDone(onDone);
      result.current.run([{ ref: "curated:a" }]);
    });
    await waitFor(() => expect(installCalls("market_install")).toHaveLength(1));
    act(() => result.current.reset());
    expect(result.current.statuses).toEqual([]);
    expect(result.current.running).toBe(false);
    // 重置后立刻开新一轮：旧一轮落定不得碰新一轮的状态
    const b = deferred<string>();
    mockBackend({ onCommand: (_cmd, args) => ((args as { pluginId: string }).pluginId === "b" ? b.promise : a.promise) });
    act(() => result.current.run([{ ref: "curated:b" }]));
    await waitFor(() => expect(installCalls("market_install")).toHaveLength(2));
    await act(async () => {
      a.resolve("installed");
    });
    expect(result.current.running).toBe(true);
    expect(states(result)).toEqual({ "curated:b": "running" });
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => {
      b.resolve("installed");
    });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(states(result)).toEqual({ "curated:b": "ok" });
  });
});
