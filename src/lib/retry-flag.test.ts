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
