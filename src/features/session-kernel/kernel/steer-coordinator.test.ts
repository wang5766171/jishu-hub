/**
 * v0.9.8 评审修复轮 R2（S 域，S-15）：引导协调器的发送上下文。
 *
 * 清队事件带回的 steering 文本在回合中止后要重发，地址（项目 / 智能体）只能
 * 来自**这个会话真实入队过的**上下文。修前地址挂在会话状态上，引导一旦全部
 * 注入、状态整条删除，地址就跟着没了——重发时落成空地址。
 * 对应 tests/S-用例清单 S15-U1～S15-U3。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { steerCoordinator } from "./steer-coordinator";

vi.mock("@/lib/dev-log", () => ({ devLog: vi.fn() }));

const CTX = { projectPath: "D:/proj-A", agentId: "jishu-self" };

describe("评审修复轮 R2：引导重发的地址来自该会话真实入队过的上下文", () => {
  beforeEach(() => {
    steerCoordinator.clearAll();
  });

  it("S15-U1 读队列不建状态；这个会话没有入队过——清队事件带回的 steering 不落成空地址条目", () => {
    const key = "never-staged-session";
    expect(steerCoordinator.textsOf(key)).toEqual([]);
    expect(steerCoordinator.isEmpty(key)).toBe(true);

    const result = steerCoordinator.reconcileCleared(key, ["别处注入的引导"], []);

    expect(result.undeliverable).toEqual(["别处注入的引导"]);
    expect(steerCoordinator.takeResend(key)).toEqual([]);
  });

  it("S15-U2 引导全部注入后（队列清空）地址仍在：清队带回的 steering 带原地址重发", () => {
    const key = "staged-then-injected";
    steerCoordinator.stage(key, "引导A", undefined, CTX);
    steerCoordinator.consumeInjected(key, "引导A");
    expect(steerCoordinator.isEmpty(key)).toBe(true);

    const result = steerCoordinator.reconcileCleared(key, ["注入后仍在引擎队列里的"], []);

    expect(result.undeliverable).toEqual([]);
    expect(steerCoordinator.takeResend(key)).toEqual([
      { text: "注入后仍在引擎队列里的", context: CTX },
    ]);
  });

  it("S15-U3 会话换键后地址跟着对话走", () => {
    const pending = "pending-1795000000000";
    const real = "01ffff00-cccc-7000-8000-000000000000";
    steerCoordinator.stage(pending, "引导", undefined, CTX);
    steerCoordinator.consumeInjected(pending, "引导");
    steerCoordinator.moveKey(pending, real);

    steerCoordinator.reconcileCleared(real, ["带回的"], []);

    expect(steerCoordinator.takeResend(real)).toEqual([{ text: "带回的", context: CTX }]);
  });

  it("队列里有条目时：被移除的条目带着自己的地址进重发，其余留在队列", () => {
    const key = "queued";
    const other = { projectPath: "D:/proj-B", agentId: "codex" };
    steerCoordinator.stage(key, "引导A", undefined, other);
    steerCoordinator.stage(key, "引导B", undefined, CTX);

    steerCoordinator.reconcileCleared(key, ["引导A"], []);

    expect(steerCoordinator.textsOf(key)).toEqual(["引导B"]);
    expect(steerCoordinator.takeResend(key)).toEqual([{ text: "引导A", context: other }]);
  });

  it("展开变形（回传文本与原文不等）：按条数移除最旧的条目，地址仍是真实入队过的那个", () => {
    const key = "expanded";
    steerCoordinator.stage(key, "/skill:x 原文", undefined, CTX);

    const result = steerCoordinator.reconcileCleared(key, ["展开后的全文"], []);

    expect(result.undeliverable).toEqual([]);
    expect(steerCoordinator.textsOf(key)).toEqual([]);
    expect(steerCoordinator.takeResend(key)).toEqual([{ text: "展开后的全文", context: CTX }]);
  });

  it("followUp 与 steering 分组不变：followUp 不进重发", () => {
    const key = "grouping";
    steerCoordinator.stage(key, "引导A", undefined, CTX);

    const result = steerCoordinator.reconcileCleared(key, ["引导A", "排队B"], ["排队B"]);

    expect(result.followUps).toEqual(["排队B"]);
    expect(steerCoordinator.takeResend(key)).toEqual([{ text: "引导A", context: CTX }]);
  });

  it("S15-U4（二轮评审 R3 P2-6）会话没了：队列、待重发条目、发送上下文一并清掉；别的会话不受影响", () => {
    const gone = "deleted-session";
    const kept = "kept-session";
    steerCoordinator.stage(gone, "引导A", undefined, CTX);
    steerCoordinator.stage(kept, "引导B", undefined, CTX);
    steerCoordinator.forgetSession(gone);
    expect(steerCoordinator.textsOf(gone)).toEqual([]);
    // 上下文也清了：清队事件带回的 steering 不再按这个会话的真实入队地址重发
    const result = steerCoordinator.reconcileCleared(gone, ["带回的"], []);
    expect(steerCoordinator.takeResend(gone)).toEqual([]);
    // 地址没了：这条带回的 steering 按「无地址」如实上报，不落成空地址条目
    expect(result).toEqual({ steering: ["带回的"], followUps: [], undeliverable: ["带回的"] });
    expect(steerCoordinator.textsOf(kept)).toEqual(["引导B"]);
  });
});
