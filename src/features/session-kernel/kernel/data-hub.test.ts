import { describe, expect, it, vi } from "vitest";
import { SessionDataHub } from "./data-hub";

describe("SessionDataHub（v0.9.3 需求3：真订阅）", () => {
  it("订阅即回放当前快照", () => {
    const hub = new SessionDataHub();
    hub.publishMessages([{ role: "user", blocks: [{ type: "text", text: "hi" }] }]);
    const cb = vi.fn();
    hub.subscribeMessages(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith([{ role: "user", blocks: [{ type: "text", text: "hi" }] }]);
  });

  it("publish 逐个回调全部订阅者（不再是一次性快照）", () => {
    const hub = new SessionDataHub();
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribeStreamState(a);
    hub.subscribeStreamState(b);
    const state = { isStreaming: true, text: "x", retry: null, error: null, steerTexts: [] };
    hub.publishStreamState(state);
    hub.publishStreamState({ ...state, text: "xy" });
    expect(a).toHaveBeenCalledTimes(3); // 回放 1 + publish 2
    expect(b).toHaveBeenCalledTimes(3);
  });

  it("退订真实移除：退订后 publish 不再回调", () => {
    const hub = new SessionDataHub();
    const cb = vi.fn();
    const unsub = hub.subscribeTurns(cb);
    unsub();
    hub.publishTurns([]);
    expect(cb).toHaveBeenCalledTimes(1); // 仅注册回放
  });

  it("seed 刷新快照但不通知既有订阅者；晚订阅者回放 seed 值", () => {
    const hub = new SessionDataHub();
    const early = vi.fn();
    hub.subscribeMessages(early);
    const seeded = [{ role: "assistant", blocks: [] }];
    hub.seed({ messages: seeded });
    expect(early).toHaveBeenCalledTimes(1); // seed 不通知
    const late = vi.fn();
    hub.subscribeMessages(late);
    expect(late).toHaveBeenCalledWith(seeded);
  });

  it("订阅者抛错不阻断其他订阅者", () => {
    const hub = new SessionDataHub();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    hub.subscribeMessages(bad);
    hub.subscribeMessages(good);
    expect(() => hub.publishMessages([])).not.toThrow();
    expect(good).toHaveBeenCalledTimes(2); // 注册回放 1 + publish 1
  });

  it("sessionMeta 未 seed 时订阅不回放（null 语义保留给组件默认值）", () => {
    const hub = new SessionDataHub();
    const cb = vi.fn();
    hub.subscribeSessionMeta(cb);
    expect(cb).not.toHaveBeenCalled();
    hub.seed({ sessionMeta: { agentId: "jishu", agentName: null, model: null, thinkingLevel: null, contextUsed: null, contextTotal: null, projectPath: null, projectEncodedName: null } });
    const cb2 = vi.fn();
    hub.subscribeSessionMeta(cb2);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
