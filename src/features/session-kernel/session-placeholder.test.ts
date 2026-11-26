/**
 * 选中态里的占位值的单一判定——v0.9.8 评审修复轮 R2，对应
 * docs/v0.9.8/评审修复轮-R2/tests/O-用例清单.md O8-U1/U2。
 *
 * 背景：「节点待定」这个占位值的字面量原先散落在 5 处，其中一处在内核侧的未读模块里。
 * 现在只在这个模块里定义，别处一律经它判断——守卫用例盯着不再有新的字面量冒出来。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { isNoSessionSelected } from "./session-placeholder";

const srcRoot = join(__dirname, "..", "..");
const placeholderModule = join(srcRoot, "features", "session-kernel", "session-placeholder.ts");

/** src 下的非测试源码（测试替身、类型声明不算）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__stubs__" || entry === "__mocks__") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe("选中态里的占位值（v0.9.8 评审修复轮 R2）", () => {
  it("没有真实会话被打开的选中态：空、新对话、节点待定；真实会话 id 不算——O8-U1", () => {
    for (const value of [null, undefined, "", "new", "pending-node"]) {
      expect(isNoSessionSelected(value), String(value)).toBe(true);
    }
    for (const value of ["s1", "pending-1700000000000", "new-session", "pending-node-2"]) {
      expect(isNoSessionSelected(value), value).toBe(false);
    }
  });

  it("全仓源码里「节点待定」的字面量只在占位模块里——O8-U2", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (file === placeholderModule) continue;
      if (readFileSync(file, "utf-8").includes('"pending-node"')) offenders.push(relative(srcRoot, file).split(sep).join("/"));
    }
    expect(offenders).toEqual([]);
  });
});
