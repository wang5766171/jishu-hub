import { describe, expect, it } from "vitest";
import { extractCodeText } from "./code-block-text";

/** 模拟 rehype-highlight tokenize 后的 React 元素子树（v0.9.3 测试期根因场景）。 */
function el(props: { className?: string; children?: unknown }) {
  return { type: "span", props } as never;
}

describe("extractCodeText（代码块咨询点取数，v0.9.3 测试期修复）", () => {
  it("纯字符串子节点（未 tokenize，如 mermaid）原样提取", () => {
    expect(extractCodeText("graph TD; A-->B")).toBe("graph TD; A-->B");
  });

  it("hljs tokenize 的嵌套 span 子树完整提取（html 块恒不渲染的根因）", () => {
    const tokenized = el({
      children: [
        el({ children: "<" }),
        el({ className: "hljs-name", children: "div" }),
        " ",
        el({ className: "hljs-attr", children: "style" }),
        "=",
        el({ className: "hljs-string", children: '"color:red"' }),
        ">卡片</",
        el({ className: "hljs-name", children: "div" }),
        ">",
      ],
    });
    expect(extractCodeText(tokenized)).toBe('<div style="color:red">卡片</div>');
  });

  it("数组与空值安全", () => {
    expect(extractCodeText(["a", ["b", 1], null, false, true, undefined])).toBe("ab1");
    expect(extractCodeText(null)).toBe("");
    expect(extractCodeText(undefined)).toBe("");
  });
});
