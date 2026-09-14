import { describe, expect, it } from "vitest";
import {
  projectTextBlockForExport,
  toolResultErrorLine,
  toolSummaryLine,
} from "./session-export";

describe("导出增强（v0.9.3 需求6）", () => {
  it("文本块内嵌图片标记转为 markdown 图片引用并从正文剥离", () => {
    // 注意：夹具路径避开 \n 前缀（parseFileRefs 按既有规则以 \\n/换行拆条目）。
    const text =
      "先看图\n<!--JISHU_HUB_IMAGES_BEGIN-->截图（批次 1）: D:\\p\\a.png\n说明: D:\\p\\docs.txt<!--JISHU_HUB_IMAGES_END-->\n后文";
    const { body, imageLines } = projectTextBlockForExport(text);
    expect(body).not.toContain("JISHU_HUB_IMAGES");
    expect(body).toContain("先看图");
    expect(body).toContain("后文");
    expect(imageLines).toContain("![截图](D:\\p\\a.png)");
    expect(imageLines).toContain("[说明](D:\\p\\docs.txt)");
  });

  it("无标记文本原样保留（仅规范化转义换行）", () => {
    const { body, imageLines } = projectTextBlockForExport("普通正文\\n第二行");
    expect(body).toBe("普通正文\n第二行");
    expect(imageLines).toEqual([]);
  });

  it("工具摘要行：工具名 + 关键参数截断", () => {
    const line = toolSummaryLine({
      type: "tool_use",
      text: "write_file",
      input: { path: "D:\\" + "x".repeat(100) },
    });
    expect(line).toContain("`write_file`");
    expect(line).toContain("path=D:\\x");
    expect(line).toContain("…");
    expect((line ?? "").length).toBeLessThan(120);
  });

  it("无关键参数的工具只出工具名；非 tool_use 块返回 null", () => {
    expect(toolSummaryLine({ type: "tool_use", text: "list_dir", input: {} })).toBe(
      "> 🔧 `list_dir`",
    );
    expect(toolSummaryLine({ type: "text", text: "hi" })).toBeNull();
  });

  it("仅错误 tool_result 出摘要行，成功结果不出", () => {
    expect(
      toolResultErrorLine({ type: "tool_result", output: "boom " + "y".repeat(200), isError: true }),
    ).toContain("⚠️");
    expect(toolResultErrorLine({ type: "tool_result", output: "ok", isError: false })).toBeNull();
    expect(toolResultErrorLine({ type: "tool_result" })).toBeNull();
  });
});
