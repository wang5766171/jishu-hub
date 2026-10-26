import { describe, expect, it } from "vitest";
import { matchBlockRenderer, matchBlockTypeRenderer } from "./use-block-renderers";
import type { BlockRendererMount, BlockTypeRendererMount, CodeBlockRendererMount } from "../types";

const noop = () => null;

function codeMount(overrides: Partial<CodeBlockRendererMount>): CodeBlockRendererMount {
  return {
    kind: "block-renderer",
    matching: "code",
    languages: ["html"],
    detect: () => true,
    Component: noop,
    ...overrides,
  };
}

function blockTypeMount(overrides: Partial<BlockTypeRendererMount>): BlockTypeRendererMount {
  return {
    kind: "block-renderer",
    matching: "block-type",
    blockTypes: ["interaction"],
    BlockComponent: noop,
    ...overrides,
  };
}

describe("matchBlockRenderer（代码块路径——仅代码块域，显式语言封闭集）", () => {
  it("语言在声明集内且 detect 通过才命中", () => {
    const a = codeMount({ languages: ["html"] });
    expect(matchBlockRenderer([a], "html", "<html></html>")).toBe(a);
    expect(matchBlockRenderer([a], "mermaid", "graph TD;")).toBeNull();
  });

  it("注册序优先：多个命中取首个", () => {
    const a = codeMount({ languages: ["html"] });
    const b = codeMount({ languages: ["html"] });
    expect(matchBlockRenderer([a, b], "HTML", "x")).toBe(a);
  });

  it("语言大小写不敏感（传入侧归一）", () => {
    const a = codeMount({ languages: ["html"], detect: (lang) => lang === "html" });
    expect(matchBlockRenderer([a], "HTML", "x")).toBe(a);
  });

  // 测试期修复23：无通配——空语言集不匹配任何东西。v0.9.2 的
  // “空数组=全部语言由 detect 判定”使挂载可捕获 bash 等常规对话代码块。
  it("空语言集不匹配任何语言（无通配）", () => {
    const a = codeMount({ languages: [], detect: () => true });
    expect(matchBlockRenderer([a], "bash", "sudo apt-get install")).toBeNull();
    expect(matchBlockRenderer([a], "", "裸代码块")).toBeNull();
    expect(matchBlockRenderer([a], "html", "<html></html>")).toBeNull();
  });

  // 测试期修复23（原始事故）：块类型域挂载（phase-divider 组合插件形状）
  // 类型层即不可进入语言路径——常规模型输出的 bash 代码块永不被劫持。
  it("块类型域挂载不参与代码块语言匹配（联合臂隔离）", () => {
    const a = blockTypeMount({ blockTypes: ["phase_divider"] });
    expect(matchBlockRenderer([a as unknown as BlockRendererMount], "bash", "sudo apt-get install")).toBeNull();
    // 块类型路径不受影响。
    expect(matchBlockTypeRenderer([a as unknown as BlockRendererMount], "phase_divider")).toBe(a);
  });
});

describe("matchBlockTypeRenderer（行级咨询点——仅块类型域）", () => {
  it("声明该 blockTypes 才命中", () => {
    const a = blockTypeMount({ blockTypes: ["interaction"] });
    expect(matchBlockTypeRenderer([a], "interaction")).toBe(a);
    expect(matchBlockTypeRenderer([a], "phase_divider")).toBeNull();
  });

  it("代码块域挂载不参与块类型匹配（联合臂隔离）", () => {
    const a = codeMount({ languages: ["html"] });
    expect(matchBlockTypeRenderer([a as unknown as BlockRendererMount], "interaction")).toBeNull();
  });

  it("注册序优先", () => {
    const a = blockTypeMount({ blockTypes: ["interaction"] });
    const b = blockTypeMount({ blockTypes: ["interaction", "phase_divider"] });
    expect(matchBlockTypeRenderer([a, b], "interaction")).toBe(a);
    expect(matchBlockTypeRenderer([a, b], "phase_divider")).toBe(b);
  });
});
