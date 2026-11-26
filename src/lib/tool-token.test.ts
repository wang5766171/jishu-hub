/**
 * 工具 token 单测——v0.9.8 评审修复轮 R2（裁决 8），对应 tests/V-用例清单 V1-U13。
 */
import { describe, expect, it } from "vitest";

import { findToolTokens, toolTokenText, trailingToolIds } from "./tool-token";

const names = { "dev-god": "写后诊断", "skill-a": "方案规划" } as Record<string, string>;

describe("toolTokenText", () => {
  it("原始文本 = @[显示名]", () => {
    expect(toolTokenText("写后诊断")).toBe("@[写后诊断]");
  });
});

describe("findToolTokens", () => {
  it("按出现先后给出位置与名字", () => {
    expect(findToolTokens("用 @[写后诊断] 和 @[方案规划] 查")).toEqual([
      { index: 2, name: "写后诊断" },
      { index: 12, name: "方案规划" },
    ]);
  });

  it("没有字样、空串：空数组；方括号里没有字的 @[] 不算", () => {
    expect(findToolTokens("纯文本")).toEqual([]);
    expect(findToolTokens("")).toEqual([]);
    expect(findToolTokens("@[]")).toEqual([]);
  });
});

describe("trailingToolIds：哪些工具跟在正文后面", () => {
  it("正文没有字样：全部尾随", () => {
    expect(trailingToolIds("查一下这段代码", ["dev-god", "skill-a"], names)).toEqual(["dev-god", "skill-a"]);
  });

  it("正文里的字样覆盖到的工具不再尾随；没覆盖到的照旧尾随", () => {
    expect(trailingToolIds("用 @[方案规划] 排期", ["skill-a", "dev-god"], names)).toEqual(["dev-god"]);
    expect(trailingToolIds("用 @[方案规划] 排期", ["skill-a"], names)).toEqual([]);
  });

  it("名字对不上的字样（已卸载的工具、用户手打）不算覆盖", () => {
    expect(trailingToolIds("用 @[不认识的] 查", ["dev-god"], names)).toEqual(["dev-god"]);
  });

  it("没有工具集：空数组（不去扫正文）", () => {
    expect(trailingToolIds("用 @[方案规划] 排期", [], names)).toEqual([]);
  });
});
