/**
 * 会话工具目录单测——v0.9.8 评审修复轮 R2，对应 tests/V-用例清单 V9-U2 / V9-U3。
 * 目录是模块级的一份状态：每个用例重置模块，拿到干净的初始态。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeCommand, listen } = vi.hoisted(() => ({ invokeCommand: vi.fn(), listen: vi.fn() }));
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

type Catalog = typeof import("./tool-catalog");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 等在途的请求与微任务跑完。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 取一份干净的目录模块（模块级状态归零）。用例先配好替身，再调它。 */
async function freshCatalog(): Promise<Catalog> {
  vi.resetModules();
  return import("./tool-catalog");
}

beforeEach(() => {
  invokeCommand.mockReset();
  listen.mockReset();
});

const TOOL_A = [{ id: "dev-god", display_name: "写后诊断", category: "cli" }];

describe("工具目录", () => {
  it("同一时刻只有一个请求在途；取到后名字与类别都是现成的", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    invokeCommand.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const catalog = await freshCatalog();
    const p1 = catalog.refreshToolCatalog("s1");
    const p2 = catalog.refreshToolCatalog("s2");
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith("session_tool_list", { sessionId: "s1" });
    first.resolve(TOOL_A);
    await Promise.all([p1, p2]);
    expect(catalog.getToolNames()).toEqual({ "dev-god": "写后诊断" });
    expect(catalog.getToolCats()).toEqual({ "dev-god": "cli" });
    // 在途的那个请求不因为后来者而多发一次
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("第一次失败：目录保持为空，再有消费方用到时重试；成功后不再重复请求——V9-U2", async () => {
    invokeCommand
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(TOOL_A);
    const catalog = await freshCatalog();
    catalog.ensureToolCatalog("s1");
    await settle();
    expect(catalog.getToolNames()).toEqual({});
    catalog.ensureToolCatalog("s2");
    await settle();
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    expect(catalog.getToolNames()).toEqual({ "dev-god": "写后诊断" });
    catalog.ensureToolCatalog("s3");
    catalog.ensureToolCatalog(null);
    await settle();
    expect(invokeCommand).toHaveBeenCalledTimes(2);
  });

  it("返回的不是清单（异常响应）：按「没取到」处理——不记成已取到，下一个使用方挂载时会再试（二轮评审 R3 P2-4）", async () => {
    invokeCommand.mockResolvedValueOnce(false);
    invokeCommand.mockResolvedValue(TOOL_A);
    const catalog = await freshCatalog();
    catalog.ensureToolCatalog("s1");
    await settle();
    expect(catalog.getToolNames()).toEqual({});
    // 修前：这一份空目录被记成「已取到」，之后不再重试，标签一直按 id 显示
    catalog.ensureToolCatalog("s2");
    await settle();
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    expect(catalog.getToolNames()).toEqual({ "dev-god": "写后诊断" });
  });

  it("插件有变更（plugins-changed）时重取，订阅方收到新目录——V9-U3", async () => {
    const handlers: Array<() => void> = [];
    listen.mockImplementation(async (_event: string, handler: () => void) => {
      handlers.push(handler);
      return () => undefined;
    });
    const withPlan = [...TOOL_A, { id: "plan", display_name: "方案规划", category: "skill" }];
    // 第一次取到的是旧目录；之后每次重取都拿到带新工具的目录
    invokeCommand.mockResolvedValue(withPlan).mockResolvedValueOnce(TOOL_A);
    const catalog = await freshCatalog();
    catalog.ensureToolCatalog("s1");
    await settle();
    const seen: string[] = [];
    const unsubscribe = catalog.subscribeToolCatalog(() => seen.push(Object.keys(catalog.getToolNames()).join(",")));
    const before = catalog.getToolNames();
    expect(handlers).toHaveLength(1);
    handlers[0]();
    await settle();
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    expect(catalog.getToolNames()).toEqual({ "dev-god": "写后诊断", plan: "方案规划" });
    expect(seen).toEqual(["dev-god,plan"]);
    expect(catalog.getToolNames()).not.toBe(before);
    // 退订后目录再变也不再收到
    unsubscribe();
    handlers[0]();
    await settle();
    expect(seen).toEqual(["dev-god,plan"]);
    expect(catalog.getToolNames()).toEqual({ "dev-god": "写后诊断", plan: "方案规划" });
  });

  it("目录没换时快照的引用不变（订阅方不会白白重渲染）", async () => {
    const catalog = await freshCatalog();
    invokeCommand.mockResolvedValue(TOOL_A);
    const empty = catalog.getToolNames();
    catalog.ensureToolCatalog("s1");
    await settle();
    const loaded = catalog.getToolNames();
    expect(loaded).not.toBe(empty);
    // 再取一次、内容一样：还是同一个对象
    await catalog.refreshToolCatalog("s2");
    expect(catalog.getToolNames()).toBe(loaded);
  });

  it("非 Tauri 环境：事件监听挂不上也不报错，目录照常加载，不留未处理的拒绝", async () => {
    listen.mockImplementation(() => {
      throw new Error("no tauri");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const catalog = await freshCatalog();
      invokeCommand.mockResolvedValue(TOOL_A);
      catalog.ensureToolCatalog("s1");
      await settle();
      expect(catalog.getToolNames()).toEqual({ "dev-god": "写后诊断" });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
