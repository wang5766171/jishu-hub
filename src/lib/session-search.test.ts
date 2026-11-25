/**
 * 侧栏会话搜索单测——v0.9.8 需求23，对应 tests/06-测试清单：
 * S23-U3 命中数与摘要取自可见文字。
 */
import { describe, expect, it } from "vitest";

import { searchSessions } from "./session-search";
import type { Message, Session } from "@/types";

const text = (role: Message["role"], value: string): Message => ({
  role,
  timestamp: null,
  content: [{ type: "text", text: value }],
});

function session(id: string, messages: Message[]): Session {
  return { id, messages } as unknown as Session;
}

describe("searchSessions：计数与摘要取自可见文字（S23-U3）", () => {
  const withImage = session("s-image", [
    text(
      "user",
      [
        "这张图的访问量怎么样",
        "<!--JISHU_HUB_IMAGES_BEGIN-->",
        "[用户在本次对话中上传了以下文件…] E:\\x\\chart.png",
        "<!--JISHU_HUB_IMAGES_END-->",
      ].join("\n"),
    ),
    text("assistant", "## 结论\n\n10 月的 **访问量** 最高，见 [月报](https://example.com/访问量-report)。"),
  ]);
  const withLink = session("s-link", [
    text("assistant", "接口文档在 https://example.com/docs/访问量 这个地址。"),
  ]);

  it("摘要取自可见文字：不含内部标记，也不含链接地址", () => {
    const [result] = searchSessions([withImage], "访问量");
    expect(result.sessionId).toBe("s-image");
    expect(result.previewText).not.toContain("<!--");
    expect(result.previewText).not.toContain("JISHU");
    expect(result.previewText.startsWith("这张图的访问量怎么样")).toBe(true);
  });

  it("命中数 = 可见文字里的次数（链接地址里看不见的那次不算）", () => {
    const [result] = searchSessions([withImage], "访问量");
    // 用户原话 1 次 + 助手「访问量 最高」1 次；链接地址里的那次渲染后看不见
    expect(result.matchCount).toBe(2);
  });

  it("裸网址渲染后看得见，照常计入（只有网址里那一次）", () => {
    const [result] = searchSessions([withLink], "访问量");
    expect(result.matchCount).toBe(1);
  });

  it("内部标记里的词搜不到", () => {
    expect(searchSessions([withImage], "session_files")).toEqual([]);
    expect(searchSessions([withImage], "chart.png")).toEqual([]);
  });

  it("大小写不敏感；空关键词返回空", () => {
    expect(searchSessions([session("s", [text("assistant", "UsePosts 与 useposts")])], "useposts")[0].matchCount).toBe(2);
    expect(searchSessions([withImage], "   ")).toEqual([]);
  });

  it("摘要里的换行与多余空白压成一行（侧栏只显示两行）", () => {
    const [result] = searchSessions([withImage], "结论");
    expect(result.previewText).not.toContain("\n");
    expect(result.previewText.length).toBeLessThanOrEqual(120);
  });

  it("firstMatchIndex 指向第一个含命中的消息", () => {
    const [result] = searchSessions([withImage], "访问量");
    expect(result.firstMatchIndex).toBe(0);
  });
});
