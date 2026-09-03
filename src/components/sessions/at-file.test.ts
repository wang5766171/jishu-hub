import { describe, expect, it } from "vitest";
import { detectAtToken } from "./at-file";

/** v0.9.0 需求10 契约锁定：@ 行中触发 + 邮箱/路径误触保护。 */

describe("detectAtToken（@ 文件引用触发检测）", () => {
  it("行首与空白前触发（既有行为不回归）", () => {
    expect(detectAtToken("@src")).toBe("src");
    expect(detectAtToken("看看 @src/ma")).toBe("src/ma");
  });

  it("行中间 CJK 字符后触发（本需求主场景：中文不打空格）", () => {
    expect(detectAtToken("帮我看看@这个")).toBe("这个");
    expect(detectAtToken("请优化@src/main.rs")).toBe("src/main.rs");
  });

  it("标点后触发", () => {
    expect(detectAtToken("（见@附件")).toBe("附件");
    expect(detectAtToken("，@src")).toBe("src");
  });

  it("ASCII 词字符前不触发（邮箱/标识符保护）", () => {
    expect(detectAtToken("user@host")).toBeNull();
    expect(detectAtToken("foo_bar@baz")).toBeNull();
    expect(detectAtToken("a1@")).toBeNull();
  });

  it("连排 @ 不触发（@@ 形态）", () => {
    expect(detectAtToken("看看@@src")).toBeNull();
  });

  it("token 含空白即关闭；多 @ 取最近", () => {
    expect(detectAtToken("@src main")).toBeNull();
    expect(detectAtToken("看看@旧 @新")).toBe("新");
    expect(detectAtToken("无符号文本")).toBeNull();
  });
});
