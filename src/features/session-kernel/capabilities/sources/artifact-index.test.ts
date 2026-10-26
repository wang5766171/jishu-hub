import { describe, expect, it } from "vitest";
import {
  artifactPathsAggregator,
  extractArtifactPathsFromRawMessages,
  extractSessionArtifacts,
  isNonProducingTool,
  pickPathArg,
} from "./artifact-index";
import { getAggregator } from "./aggregate-source";

describe("产物口径（C5-slice1 自 builtin/artifacts 下沉）", () => {
  it("非产出工具排除：浏览/引用类不产出，write/edit 类产出", () => {
    expect(isNonProducingTool("read")).toBe(true);
    expect(isNonProducingTool("Grep")).toBe(true);
    expect(isNonProducingTool("preview_html")).toBe(true);
    expect(isNonProducingTool("open_in_folder")).toBe(true);
    expect(isNonProducingTool("write")).toBe(false);
    expect(isNonProducingTool("edit")).toBe(false);
    expect(isNonProducingTool(undefined)).toBe(false);
  });

  it("路径参数多形态识别（path/file_path/filePath/file）", () => {
    expect(pickPathArg({ path: "a.md" })).toBe("a.md");
    expect(pickPathArg({ file_path: "a.md" })).toBe("a.md");
    expect(pickPathArg({ filePath: "a.md" })).toBe("a.md");
    expect(pickPathArg({ file: "a.md" })).toBe("a.md");
    expect(pickPathArg({ path: "  " })).toBeNull();
    expect(pickPathArg({})).toBeNull();
  });

  it("主会话投影提取：归一去重 + 后写置尾 + 相对路径按项目根解析", () => {
    const messages = [
      {
        role: "assistant" as const,
        blocks: [
          { type: "text" as const, text: "说明" },
          { type: "tool_use" as const, text: "write", input: { path: "src\\a.md" } },
          { type: "tool_use" as const, text: "read", input: { path: "b.md" } },
        ],
      },
      {
        role: "assistant" as const,
        blocks: [
          { type: "tool_use" as const, text: "edit", input: { file_path: "./src/a.md" } },
          { type: "tool_use" as const, text: "write", input: { path: "D:/abs/c.png" } },
        ],
      },
    ];
    // 顺序口径：src\a.md 先写、edit 同路径置尾一次，随后 c.png 更晚 →
    // [a.md（edit 后位）, c.png]。
    expect(extractSessionArtifacts(messages, "D:/proj")).toEqual([
      "D:/proj/src/a.md",
      "D:/abs/c.png",
    ]);
  });

  it("子节点原始消息提取（get_session_messages 形状）", () => {
    const raw = [
      {
        content: [
          { type: "tool_use", name: "write", input: { file: "E:/JishuTest/声音的颜色.md" } },
          { type: "tool_use", name: "find", input: { path: "ignore.md" } },
        ],
      },
    ];
    expect(extractArtifactPathsFromRawMessages(raw, null)).toEqual(["E:/JishuTest/声音的颜色.md"]);
  });

  it("聚合器 artifact-paths 已注册（messages 源声明即得列表，不做项目根解析）", () => {
    const agg = getAggregator("artifact-paths");
    expect(agg).toBeDefined();
    const out = artifactPathsAggregator([
      {
        blocks: [
          { type: "tool_use", text: "write", input: { path: "rel/a.md" } },
          { type: "tool_use", text: "write", input: { path: "rel/a.md" } },
        ],
      },
    ]);
    expect(out).toEqual(["rel/a.md"]);
  });
});
