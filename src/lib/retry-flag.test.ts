// v0.9.8 需求9 D9-3/D9-4：重试成功判定（紧档）——直播与回放共用规则的行为锚定。
import { describe, expect, it } from "vitest";

import { computeRetriedSuccessFlags } from "./retry-flag";

describe("computeRetriedSuccessFlags（需求9 紧档）", () => {
  it("U9-3 紧档正例：bash 失败→bash 成功 → 失败卡翻", () => {
    const flags = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "bash", isError: false },
    ]);
    expect([...flags]).toEqual(["c1"]);
  });

  it("U9-4a 紧档反例：失败→失败→无关工具成功 → 两失败卡都不翻", () => {
    const flags = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "bash", isError: true },
      { id: "c3", name: "grep", isError: false },
    ]);
    expect(flags.size).toBe(0);
  });

  it("U9-4b 紧档反例：失败→（隔多步/换目的）成功 → 其后第一张同名 success 才翻", () => {
    // bash 失败 → grep 成功 → bash 失败 → bash 成功：前失败卡其后第一张
    // 同名是**失败**（不翻）；第三张失败其后第一张同名是成功（翻）。
    const flags = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "grep", isError: false },
      { id: "c3", name: "bash", isError: true },
      { id: "c4", name: "bash", isError: false },
    ]);
    expect([...flags]).toEqual(["c3"]);
  });

  it("同名链跨多张：失败→成功→失败→成功 → 前失败翻、中失败翻、成功不参与", () => {
    const flags = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "bash", isError: false },
      { id: "c3", name: "bash", isError: true },
      { id: "c4", name: "bash", isError: false },
    ]);
    expect([...flags]).toEqual(["c1", "c3"]);
  });

  it("无失败/无同名后续 → 空", () => {
    expect(computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: false },
    ]).size).toBe(0);
    expect(computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
    ]).size).toBe(0);
  });
});

describe("computeRetriedSuccessFlags（v0.9.8 评审修复轮 R1-3：运行中不算成功）", () => {
  // 直播：tool_use_start 建的卡 isError 为 undefined（尚无结果）。
  it("U4-1 重跑还在运行时旧失败卡不翻绿（别的工具出结果也不触发误翻）", () => {
    const flags = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "bash", isError: undefined },
      { id: "c3", name: "Read", isError: false },
    ]);
    expect(flags.size).toBe(0);
  });

  it("U4-2 重跑出结果：成功才翻；重跑失败不翻", () => {
    const succeeded = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "bash", isError: false },
    ]);
    expect([...succeeded]).toEqual(["c1"]);
    const failedAgain = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "bash", isError: true },
    ]);
    expect(failedAgain.size).toBe(0);
  });

  it("U4-3 重跑最终失败：旧失败卡自始至终没有可翻的时机（修前在重跑运行中已提前翻绿且不回红）", () => {
    const running = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "bash", isError: undefined },
      { id: "c3", name: "Read", isError: false },
    ]);
    expect(running.size).toBe(0);
    const rerunFailed = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "bash", isError: true },
      { id: "c3", name: "Read", isError: false },
    ]);
    expect(rerunFailed.size).toBe(0);
    // 紧档看的是「其后第一张同名调用」：那张还在运行 = 结果未知，不翻——
    // 更后面再有一张同名成功也不顶替它（那张才是它的下一张同名调用）。
    const nextStillRunning = computeRetriedSuccessFlags([
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "bash", isError: undefined },
      { id: "c3", name: "bash", isError: false },
    ]);
    expect(nextStillRunning.size).toBe(0);
  });

  it("U4-4 回放口径（全是已完成调用）不受影响：同一序列两种入参形态结果一致", () => {
    const replay = [
      { id: "c1", name: "bash", isError: true },
      { id: "c2", name: "grep", isError: false },
      { id: "c3", name: "bash", isError: false },
    ];
    expect([...computeRetriedSuccessFlags(replay)]).toEqual(["c1"]);
  });
});
