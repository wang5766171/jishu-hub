/**
 * 侧栏会话搜索单测——v0.9.8 需求23，对应 tests/06-测试清单：
 * S23-U3 命中数与摘要取自可见文字。
 * v0.9.8 评审修复轮 R2 追加：消息里的工具标签计入侧栏命中（tests/V-用例清单 V1-U6 / V9-U5）。
 */
import { describe, expect, it, vi } from "vitest";

import { searchSessions } from "./session-search";
import type { Message, Session } from "@/types";

const { invokeCommand, listen } = vi.hoisted(() => ({ invokeCommand: vi.fn(), listen: vi.fn() }));
vi.mock("@/hooks/use-invoke", () => ({ invokeCommand }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

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

/** 消息里的工具标签计入侧栏命中——v0.9.8 评审修复轮 R2（用户裁决「标签的格式可以直接搜」）。 */
describe("searchSessions：消息里的工具标签按原始文本计入", () => {
  const NAMES = { "dev-god": "写后诊断", "skill-a": "方案规划" } as Record<string, string>;
  const user = (text: string, tool_ids?: string[]): Message => ({
    role: "user",
    timestamp: null,
    content: [{ type: "text", text, tool_ids }],
  });
  /** 历史消息：带工具，正文里没有内联字样（工具来自 tool_ids）。 */
  const trailingOnly = session("s-trailing", [user("查一下这段代码", ["dev-god"]), text("assistant", "好的")]);

  it("只带尾随标签的消息：搜显示名、搜 @[名] 都找得到，徽标数把标签算进去", () => {
    expect(searchSessions([trailingOnly], "写后诊断", NAMES)).toEqual([
      { sessionId: "s-trailing", matchCount: 1, previewText: "查一下这段代码@[写后诊断]", firstMatchIndex: 0 },
    ]);
    expect(searchSessions([trailingOnly], "@[写后诊断]", NAMES)[0].matchCount).toBe(1);
    expect(searchSessions([trailingOnly], "@[", NAMES)[0].matchCount).toBe(1);
    expect(searchSessions([trailingOnly], "方案规划", NAMES)).toEqual([]);
  });

  it("正文与标签各有一处：徽标数是 2；摘要取自同一份搜索文本", () => {
    const both = session("s-both", [user("写后诊断 看看", ["dev-god"])]);
    const [result] = searchSessions([both], "写后诊断", NAMES);
    expect(result.matchCount).toBe(2);
    expect(result.previewText).toBe("写后诊断 看看@[写后诊断]");
  });

  it("带内联字样的消息：字样算一次，没被它覆盖到的工具跟在后面", () => {
    const inline = session("s-inline", [user("用 @[方案规划] 排期", ["skill-a", "dev-god"])]);
    expect(searchSessions([inline], "方案规划", NAMES)[0].matchCount).toBe(1);
    expect(searchSessions([inline], "写后诊断", NAMES)[0].matchCount).toBe(1);
    expect(searchSessions([inline], "@[方案规划]", NAMES)[0].matchCount).toBe(1);
  });

  it("不传映射时读工具目录的当前一份——侧栏不必先打开会话就认得出标签——V9-U5", async () => {
    listen.mockResolvedValue(() => undefined);
    invokeCommand.mockResolvedValue([{ id: "dev-god", display_name: "写后诊断", category: "cli" }]);
    vi.resetModules();
    const { ensureToolCatalog } = await import("./tool-catalog");
    const { searchSessions: search } = await import("./session-search");
    // 目录还没取到：标签按显示出来的 id 计
    expect(search([trailingOnly], "写后诊断")).toEqual([]);
    ensureToolCatalog(null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(search([trailingOnly], "写后诊断")[0].matchCount).toBe(1);
  });
});
