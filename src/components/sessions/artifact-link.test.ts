import { describe, expect, it } from "vitest";
import { repairEatenSeparator, artifactDisplayName } from "./artifact-link";

// 需求9 #2：CommonMark 吞「反斜杠+标点」反斜杠的存量坏链修复（启发式：
// 非分隔符字符粘连 .jishu-hub = 被吞形态，插回反斜杠）。
describe("repairEatenSeparator", () => {
  it("粘连形态插回反斜杠", () => {
    expect(repairEatenSeparator("C:\\Users\\zhang.jishu-hub\\tasks\\t1\\out\\report.html"))
      .toBe("C:\\Users\\zhang\\.jishu-hub\\tasks\\t1\\out\\report.html");
  });

  it("正常路径（分隔符在前）不动", () => {
    const ok = "C:\\Users\\zhang\\.jishu-hub\\tasks\\t1\\report.html";
    expect(repairEatenSeparator(ok)).toBe(ok);
    expect(repairEatenSeparator("tasks/t1/out/report.html")).toBe("tasks/t1/out/report.html");
  });

  it("正斜杠粘连形态同样修复", () => {
    expect(repairEatenSeparator("C:/Users/zhang.jishu-hub/tasks/t1/report.html"))
      .toBe("C:/Users/zhang\\.jishu-hub/tasks/t1/report.html");
  });
});

// 需求9 追加：显示名派生（URL 文本→文件名；人话标题保留）。
describe("artifactDisplayName", () => {
  it("文本即 URL → 只显示文件名（剥 📄 前缀与 %20 解码）", () => {
    expect(artifactDisplayName("jishu-artifact://tasks/draft/ok.txt", "📄 jishu-artifact://tasks/draft/ok.txt"))
      .toBe("ok.txt");
    expect(artifactDisplayName("jishu-artifact://docs/%E8%AE%BE%E8%AE%A1%E5%9B%BE.png", "jishu-artifact://docs/%E8%AE%BE%E8%AE%A1%E5%9B%BE.png"))
      .toBe("设计图.png");
  });

  it("模型写了人话标题 → 原样保留", () => {
    expect(artifactDisplayName("jishu-artifact://out/report.html", "打开 设计报告"))
      .toBe("打开 设计报告");
  });

  it("空文本 → 文件名兜底", () => {
    expect(artifactDisplayName("jishu-artifact://a/b/c.md", ""))
      .toBe("c.md");
  });
});
