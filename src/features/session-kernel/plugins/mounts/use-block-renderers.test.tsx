import { describe, expect, it } from "vitest";
import { matchBlockRenderer, matchBlockTypeRenderer } from "./use-block-renderers";
import type { BlockRendererMount } from "../types";

const noop = () => null;

function mount(overrides: Partial<BlockRendererMount>): BlockRendererMount {
  return {
    kind: "block-renderer",
    languages: [],
    detect: () => false,
    Component: noop,
    ...overrides,
  };
}

describe("matchBlockRenderer（代码块路径）", () => {
  it("语言在声明集内且 detect 通过才命中", () => {
    const a = mount({ languages: ["html"], detect: () => true });
    expect(matchBlockRenderer([a], "html", "<html></html>")).toBe(a);
    expect(matchBlockRenderer([a], "mermaid", "graph TD;")).toBeNull();
  });

  it("注册序优先：多个命中取首个", () => {
    const a = mount({ languages: ["html"], detect: () => true });
    const b = mount({ languages: ["html"], detect: () => true });
    expect(matchBlockRenderer([a, b], "HTML", "x")).toBe(a);
  });

  it("语言大小写不敏感（传入侧归一）", () => {
    const a = mount({ languages: ["html"], detect: (lang) => lang === "html" });
    expect(matchBlockRenderer([a], "HTML", "x")).toBe(a);
  });
});

describe("matchBlockTypeRenderer（行级咨询点，v0.9.3 需求2）", () => {
  it("声明 blockTypes 且带 BlockComponent 才命中", () => {
    const a = mount({ blockTypes: ["interaction"], BlockComponent: noop });
    expect(matchBlockTypeRenderer([a], "interaction")).toBe(a);
    expect(matchBlockTypeRenderer([a], "phase_divider")).toBeNull();
  });

  it("仅声明 blockTypes 而无 BlockComponent 不命中（防渲染空挂载）", () => {
    const a = mount({ blockTypes: ["interaction"] });
    expect(matchBlockTypeRenderer([a], "interaction")).toBeNull();
  });

  it("注册序优先", () => {
    const a = mount({ blockTypes: ["interaction"], BlockComponent: noop });
    const b = mount({ blockTypes: ["interaction", "phase_divider"], BlockComponent: noop });
    expect(matchBlockTypeRenderer([a, b], "interaction")).toBe(a);
    expect(matchBlockTypeRenderer([a, b], "phase_divider")).toBe(b);
  });
});
