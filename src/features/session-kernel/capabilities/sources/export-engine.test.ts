import { describe, expect, it } from "vitest";
import {
  composeSessionMarkdown,
  projectTextBlockForExport,
  toolResultErrorLine,
  toolSummaryLine,
} from "./export-engine";
import type { PluginBlock, PluginMessage } from "../../plugins/types";

const t = (_key: string, fallback: string) => fallback;

describe("会话导出引擎（C5 后续轮自 builtin/session-export 逐字下沉）", () => {
  it("工具摘要行：关键字段优先（path/command），两条封顶，超长截断", () => {
    const block = {
      type: "tool_use",
      text: "edit",
      input: { path: "a.md", command: "x".repeat(100) },
    } as PluginBlock;
    const line = toolSummaryLine(block)!;
    expect(line).toContain("`edit`");
    expect(line).toContain("path=a.md");
    expect(line).toContain("command=xxxx");
    expect(line.endsWith("…")).toBe(true);
    expect(toolSummaryLine({ type: "text", text: "hi" } as PluginBlock)).toBeNull();
  });

  it("错误结果摘要：仅错误工具结果输出片段（160 截断），成功结果 null", () => {
    expect(
      toolResultErrorLine({ type: "tool_result", text: "", isError: true, output: "boom ".repeat(60) } as PluginBlock),
    ).toContain("⚠️");
    expect(
      toolResultErrorLine({ type: "tool_result", text: "", isError: false, output: "ok" } as PluginBlock),
    ).toBeNull();
  });

  it("文本块图片标记剥离与图片行收集（内嵌标记行格式 = 标签: 路径）", () => {
    const text = "前文<!--JISHU_HUB_IMAGES_BEGIN-->截图1: E:/x.png<!--JISHU_HUB_IMAGES_END-->后文";
    const { body, imageLines } = projectTextBlockForExport(text);
    expect(body).toBe("前文后文");
    expect(imageLines).toEqual(["![截图1](E:/x.png)"]);
  });

  it("整稿组装：标题/导出时间/逐消息逐块（工具行与错误行入稿）", () => {
    const messages: PluginMessage[] = [
      { role: "user", blocks: [{ type: "text", text: "你好" }] },
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", text: "write", input: { path: "out.md" } },
          { type: "tool_result", text: "", isError: true, output: "failed" },
          { type: "text", text: "完成" },
        ],
      },
    ];
    const md = composeSessionMarkdown({ title: "测试会话", sessionId: null, messages, t });
    expect(md).toContain("# 测试会话");
    expect(md).toContain("## 用户");
    expect(md).toContain("你好");
    expect(md).toContain("`write` · path=out.md");
    expect(md).toContain("⚠️ failed");
    expect(md).toContain("完成");
  });
});
