import { describe, expect, it } from "vitest";
import { detectAtToken } from "./at-file";

/** v0.9.0 需求10 契约锁定（用户裁决简化版）：任何 @ 都触发全文件搜索，
 * 匹配由用户选、不选即普通文本——无前置字符拦截。 */

describe("detectAtToken（@ 文件引用触发检测·简化版）", () => {
  it("任意位置与任意前字符的 @ 均触发（行首/空白/CJK/字母/连排@）", () => {
    expect(detectAtToken("@src")).toBe("src");
    expect(detectAtToken("看看 @src/ma")).toBe("src/ma");
    expect(detectAtToken("帮我看看@这个")).toBe("这个");
    // 用户裁决：邮箱/@@ 形态不做拦截——匹配不上自然不弹（需求9）
    expect(detectAtToken("user@host")).toBe("host");
    expect(detectAtToken("看看@@src")).toBe("src");
  });

  it("token 含空白即结束（@ 引用终止，回到普通文本）", () => {
    expect(detectAtToken("@src main")).toBeNull();
    expect(detectAtToken("@ 空格即关")).toBeNull();
  });

  it("多 @ 取最近；无 @ 为 null", () => {
    expect(detectAtToken("看看@旧 @新")).toBe("新");
    expect(detectAtToken("无符号文本")).toBeNull();
  });
});
