import { describe, expect, it, vi, beforeEach } from "vitest";
import { slugify, tomlStr } from "./plugin-wizard-utils";

/** 三轮评审 P1-3 回归：换行安全转义 + Unicode 感知 id + 占用检测。 */

describe("tomlStr（三轮 P1-3①：换行/控制字符安全转义）", () => {
  it("普通文本原样带引号", () => {
    expect(tomlStr("hello")).toBe('"hello"');
  });

  it("换行转义为 \\n——修前裸换行生成非法 TOML", () => {
    const encoded = tomlStr("第一行\n第二行");
    expect(encoded).not.toContain("\n");
    expect(encoded).toBe('"第一行\\n第二行"');
    // 生成的 TOML 行可被 TOML 解析器接受（无裸换行）
    expect(encoded.split("\n")).toHaveLength(1);
  });

  it("引号与反斜杠转义", () => {
    expect(tomlStr('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
  });

  it("制表符/回车转义", () => {
    expect(tomlStr("a\tb\rc")).toBe('"a\\tb\\rc"');
  });
});

describe("slugify（三轮 P1-3②：中文名不再坍缩为同一 id）", () => {
  it("英文名照旧折叠为连字符", () => {
    expect(slugify("My Cool Plugin", "flow")).toBe("my-cool-plugin");
  });

  it("不同中文名产生不同 slug——修前全部坍缩为 fallback 互相覆盖", () => {
    const a = slugify("识图流水线", "flow");
    const b = slugify("建站流水线", "flow");
    expect(a).not.toBe(b);
    expect(a).toBe("识图流水线");
    expect(b).toBe("建站流水线");
  });

  it("纯中文名不再回落 fallback", () => {
    expect(slugify("通知中心", "custom")).toBe("通知中心");
  });

  it("空名/纯符号名回落 fallback", () => {
    expect(slugify("", "hybrid")).toBe("hybrid");
    expect(slugify("!!!", "hybrid")).toBe("hybrid");
  });

  it("中英混合与全角符号折叠", () => {
    expect(slugify("导出 PDF 报告", "flow")).toBe("导出-pdf-报告");
  });
});

describe("composedIdTaken（三轮 P1-3③：占用检测）", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("id 已在清单中 → true", async () => {
    vi.doMock("@/hooks/use-invoke", () => ({
      invokeCommand: vi.fn().mockResolvedValue([{ id: "session.flow" }, { id: "session.other" }]),
    }));
    const { composedIdTaken: fn } = await import("./plugin-wizard-utils");
    expect(await fn("session.flow")).toBe(true);
    expect(await fn("session.missing")).toBe(false);
  });

  it("清单拉取失败 → false（不阻断创建，后端校验兜底）", async () => {
    vi.doMock("@/hooks/use-invoke", () => ({
      invokeCommand: vi.fn().mockRejectedValue(new Error("backend down")),
    }));
    const { composedIdTaken: fn } = await import("./plugin-wizard-utils");
    expect(await fn("session.any")).toBe(false);
  });
});
