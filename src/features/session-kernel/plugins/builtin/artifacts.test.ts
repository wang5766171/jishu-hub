/**
 * 产物中心提取器单测（v0.9.2 测试期）。
 * 产物口径（用户裁决）：**生成或编辑过的本地文件**——浏览类
 * （read/find/grep/ls…）与引用类（preview/open/reveal…）工具排除；
 * 会话内渲染内容（mermaid 流程图等）不经 tool_use 文件参数，天然不在源内。
 */
import { describe, expect, it } from "vitest";
import { extractArtifactPathsFromRawMessages } from "./artifacts";

const PROJECT = "E:\\JishuTest";

describe("extractArtifactPathsFromRawMessages", () => {
  it("extracts any file type from producing tools across path key variants", () => {
    const messages = [
      {
        content: [
          { type: "tool_use", name: "write", input: { path: "E:/JishuTest/a.html" } },
          { type: "tool_use", name: "Edit", input: { file_path: "b.md" } },
          { type: "tool_use", name: "multi_edit", input: { filePath: "c.png" } },
          { type: "tool_use", name: "apply_patch", input: { file: "d.json" } },
        ],
      },
    ];
    expect(extractArtifactPathsFromRawMessages(messages, PROJECT)).toEqual([
      "E:/JishuTest/a.html",
      "E:/JishuTest/b.md",
      "E:/JishuTest/c.png",
      "E:/JishuTest/d.json",
    ]);
  });

  it("excludes non-producing tools: browsing and referencing", () => {
    const messages = [
      {
        content: [
          { type: "tool_use", name: "read_file", input: { path: "src/a.ts" } },
          { type: "tool_use", name: "grep", input: { path: "src" } },
          { type: "tool_use", name: "Glob", input: { path: "**/*.md" } },
          { type: "tool_use", name: "preview_html", input: { file: "a.html" } },
          { type: "tool_use", name: "open_file", input: { path: "x.txt" } },
          { type: "text", text: "E:/x/y.html" },
        ],
      },
    ];
    expect(extractArtifactPathsFromRawMessages(messages, PROJECT)).toEqual([]);
  });

  it("resolves relative paths against project root and normalizes separators", () => {
    const messages = [
      { content: [{ type: "tool_use", name: "write", input: { path: ".\\dist\\index.html" } }] },
    ];
    expect(extractArtifactPathsFromRawMessages(messages, PROJECT)).toEqual([
      "E:/JishuTest/dist/index.html",
    ]);
  });

  it("keeps absolute paths untouched (windows drive form normalized)", () => {
    const messages = [
      { content: [{ type: "tool_use", name: "write", input: { path: "E:\\other\\p.html" } }] },
    ];
    expect(extractArtifactPathsFromRawMessages(messages, PROJECT)).toEqual(["E:/other/p.html"]);
  });

  it("rewrites move the same file to the latest position (dedupe)", () => {
    const messages = [
      { content: [{ type: "tool_use", name: "write", input: { path: "a.html" } }] },
      { content: [{ type: "tool_use", name: "edit", input: { path: "b.html" } }] },
      { content: [{ type: "tool_use", name: "edit", input: { path: "a.html" } }] },
    ];
    expect(extractArtifactPathsFromRawMessages(messages, PROJECT)).toEqual([
      "E:/JishuTest/b.html",
      "E:/JishuTest/a.html",
    ]);
  });
});
