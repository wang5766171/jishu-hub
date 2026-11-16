import { describe, expect, it } from "vitest";
import { repairEatenSeparator, artifactDisplayName, decodeArtifactRel, artifactErrorKind } from "./artifact-link";

// 需求6 反馈（2026-11-11）：模型把链接目标中文文件名写成 percent-编码——
// 路径消费（打开校验/悬停）统一解码；非法编码序列保留原串不抛错。
describe("decodeArtifactRel", () => {
  it("中文 percent-编码解码为明文路径", () => {
    expect(decodeArtifactRel("tasks/draft/out/%E6%8E%92%E6%9F%A5%E6%8A%A5%E5%91%8A.md"))
      .toBe("tasks/draft/out/排查报告.md");
  });

  it("明文/混合路径原样（无需解码）", () => {
    expect(decodeArtifactRel("tasks/draft/ok.txt")).toBe("tasks/draft/ok.txt");
    expect(decodeArtifactRel("tasks/a%20b/c.md")).toBe("tasks/a b/c.md");
  });

  it("非法编码序列（孤立 %）不抛错、保留原串", () => {
    expect(decodeArtifactRel("tasks/100%/report.md")).toBe("tasks/100%/report.md");
  });
});

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

// 评审 P2-8：错误码分流——优先匹配机器标记前缀，无标记回退中文子串
// （向后兼容旧后端错误串），未知错误返回 null。
describe("artifactErrorKind", () => {
  it("机器标记前缀优先命中", () => {
    expect(artifactErrorKind("[not_found] 文件不存在: tasks/a.md")).toBe("not_found");
    expect(artifactErrorKind("[out_of_scope] 路径越出项目根")).toBe("out_of_scope");
    expect(artifactErrorKind("[too_large] 文件超过预览上限")).toBe("too_large");
    expect(artifactErrorKind("[unsupported] 二进制类型不支持预览")).toBe("unsupported");
  });

  it("无标记回退中文子串匹配（旧后端兼容）", () => {
    expect(artifactErrorKind("校验失败：文件不存在或已被移动")).toBe("not_found");
    expect(artifactErrorKind("目标超出项目范围")).toBe("out_of_scope");
    expect(artifactErrorKind("文件过大，无法预览")).toBe("too_large");
    expect(artifactErrorKind("该类型不支持预览")).toBe("unsupported");
  });

  it("未知错误串返回 null", () => {
    expect(artifactErrorKind("permission denied")).toBeNull();
    expect(artifactErrorKind("")).toBeNull();
  });
});
