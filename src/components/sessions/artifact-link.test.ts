import { describe, expect, it } from "vitest";
import { repairEatenSeparator } from "./artifact-link";

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
