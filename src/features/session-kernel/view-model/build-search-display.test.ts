/**
 * 搜索态显示条目单测——v0.9.8 需求23，对应 tests/06-测试清单：S23-U4 搜索态只留命中行。
 * v0.9.8 评审修复轮 R2 追加：命中行上限（tests/V-用例清单 V2-U1 / V2-U2）。
 */
import { describe, expect, it } from "vitest";

import { buildSearchDisplayItems } from "./build-search-display";

const rowsOf = (...indices: number[]) => indices.map((messageIndex) => ({ messageIndices: [messageIndex] }));

const shape = (items: ReturnType<typeof buildSearchDisplayItems>) =>
  items.map((item) => {
    if (item.kind === "gap") return `gap:${item.position}:${item.count}@${item.before}`;
    if (item.kind === "more") return `more:${item.hidden}`;
    return `row:${item.row.messageIndices[0]}`;
  });

describe("buildSearchDisplayItems（S23-U4）", () => {
  it("第 2、5 行含命中：前面省略 1、中间省略 2、后面省略 1", () => {
    const items = buildSearchDisplayItems(rowsOf(0, 1, 2, 3, 4, 5), new Set([1, 4]));
    expect(shape(items)).toEqual(["gap:before:1@-1", "row:1", "gap:middle:2@1", "row:4", "gap:after:1@4"]);
  });

  it("首尾都是命中时不产生前、后细条", () => {
    const items = buildSearchDisplayItems(rowsOf(0, 1, 2, 3, 4, 5), new Set([0, 5]));
    expect(shape(items)).toEqual(["row:0", "gap:middle:4@0", "row:5"]);
  });

  it("全部命中：只有行", () => {
    const items = buildSearchDisplayItems(rowsOf(0, 1, 2), new Set([0, 1, 2]));
    expect(shape(items)).toEqual(["row:0", "row:1", "row:2"]);
  });

  it("没有命中：空数组（由调用方显示「没有找到」）", () => {
    expect(buildSearchDisplayItems(rowsOf(0, 1, 2), new Set())).toEqual([]);
  });

  it("助手组的任一条消息命中，整行保留", () => {
    const group = { messageIndices: [3, 4, 5] };
    expect(buildSearchDisplayItems([group], new Set([4]))).toEqual([{ kind: "row", row: group }]);
    expect(buildSearchDisplayItems([group], new Set([9]))).toEqual([]);
  });

  it("相邻两段省略各有一条细条，键（before）互不重复", () => {
    const items = buildSearchDisplayItems(rowsOf(0, 1, 2, 3, 4, 5), new Set([1, 4]));
    const gapKeys = items.filter((item) => item.kind === "gap").map((item) => item.kind === "gap" && `${item.position}-${item.before}`);
    expect(new Set(gapKeys).size).toBe(gapKeys.length);
  });
});

describe("命中行上限（v0.9.8 评审修复轮 R2）", () => {
  it("4 行命中、上限 2：只显示前 2 行，末尾一条「还有 2 条」——V2-U1", () => {
    const items = buildSearchDisplayItems(rowsOf(0, 1, 2, 3, 4, 5), new Set([1, 2, 4, 5]), 2);
    expect(shape(items)).toEqual(["gap:before:1@-1", "row:1", "row:2", "more:2"]);
  });

  it("上限之前的细条照常；最后一条显示出来的命中之后不再出「后面省略」", () => {
    const items = buildSearchDisplayItems(rowsOf(0, 1, 2, 3, 4, 5, 6), new Set([1, 4, 6]), 2);
    expect(shape(items)).toEqual(["gap:before:1@-1", "row:1", "gap:middle:2@1", "row:4", "more:1"]);
  });

  it("没超上限：不出「还有几条」，与原先完全一致——V2-U2", () => {
    expect(shape(buildSearchDisplayItems(rowsOf(0, 1, 2, 3, 4, 5), new Set([1, 4]), 2))).toEqual([
      "gap:before:1@-1",
      "row:1",
      "gap:middle:2@1",
      "row:4",
      "gap:after:1@4",
    ]);
    expect(shape(buildSearchDisplayItems(rowsOf(0, 1, 2, 3, 4, 5), new Set([1, 4]), 5))).toEqual([
      "gap:before:1@-1",
      "row:1",
      "gap:middle:2@1",
      "row:4",
      "gap:after:1@4",
    ]);
  });

  it("不传上限：全部显示", () => {
    expect(shape(buildSearchDisplayItems(rowsOf(0, 1, 2), new Set([0, 1, 2])))).toEqual(["row:0", "row:1", "row:2"]);
  });
});
