// v0.9.8 需求8 D8-1 L2：市场目录更新红点信号——置位/抑制/清除三态。
import { beforeEach, describe, expect, it, vi } from "vitest";

// 捕获 store 模块副作用订阅的 Tauri 事件 handler（listen mock 收集）。
// vi.hoisted：mock 工厂提升后仍引用同一数组（普通顶层 const 会被 hoist 分离）。
const handlers = vi.hoisted(() => [] as Array<(e: { payload: unknown }) => void>);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, h: (e: { payload: unknown }) => void) => {
    handlers.push(h);
    return () => {};
  }),
}));

import { __resetForTest, isMarketUpdated, setMarketOpen, startMarketUpdateSignal, subscribeMarketUpdate } from "./market-update-signal";

function emitUpdate() {
  for (const h of handlers) h({ payload: null });
}

describe("market-update-signal（需求8 D8-1 红点）", () => {
  beforeEach(async () => {
    __resetForTest();
    startMarketUpdateSignal();
    // listen 是异步订阅——等微任务落定再触发。
    await new Promise((r) => setTimeout(r, 0));
    expect(handlers.length).toBeGreaterThan(0);
  });

  it("U8-2a 人在别页（市场页关）：预拉取事件到达 → 红点置位并通知订阅者", () => {
    const notified = vi.fn();
    const unsub = subscribeMarketUpdate(notified);
    emitUpdate();
    expect(isMarketUpdated()).toBe(true);
    expect(notified).toHaveBeenCalled();
    unsub();
  });

  it("U8-2b 市场页开着：事件由页内横幅承接——红点不置位", () => {
    setMarketOpen(true);
    emitUpdate();
    expect(isMarketUpdated()).toBe(false);
    setMarketOpen(false);
  });

  it("U8-2c 红点已亮 → 进入市场页即清除并通知", () => {
    emitUpdate();
    expect(isMarketUpdated()).toBe(true);
    const notified = vi.fn();
    const unsub = subscribeMarketUpdate(notified);
    setMarketOpen(true);
    expect(isMarketUpdated()).toBe(false);
    expect(notified).toHaveBeenCalled();
    unsub();
  });
});
