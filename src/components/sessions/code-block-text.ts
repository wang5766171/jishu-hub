import type { ReactNode } from "react";

/**
 * 递归提取 React 子树的纯文本（代码块咨询点取数）。
 *
 * v0.9.3 测试期修复：rehype-highlight 会把 html 等**已识别语言**的代码块
 * 拆成 hljs span 节点（hljs-tag/hljs-string…）——原先的取数只收集纯字符串
 * 子节点，tokenize 后取出的是残缺文本 → 块渲染器咨询点（matchBlockRenderer）
 * 判不中 → HTML 代码块恒不渲染（完整文档与片段皆然）。mermaid 非 hljs
 * 语言不被 tokenize，纯字符串子节点完好，故唯独它一直正常——这正是
 * 「只有 HTML 不渲染」的根因。
 */
export function extractCodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractCodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractCodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}
