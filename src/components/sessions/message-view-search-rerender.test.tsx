/**
 * 搜索词变化时已显示的行不重渲染——v0.9.8 需求23，对应 tests/06-测试清单 S23-U23。
 *
 * 高亮接口生效时，行的渲染结果不依赖搜索词（命中在渲染后登记上色）。长会话里
 * 重渲染一行要重新解析 Markdown（开发实例实测每次按键占主线程 50~210 毫秒）。
 * 这里把 Markdown 组件换成会计数的替身，断言换搜索词时它不再被调用。
 */
import i18n from "@/i18n";
import { render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { MessageView } from "./message-view";

const markdown = vi.hoisted(() => ({ renders: 0 }));

vi.mock("react-markdown", async () => {
  const { createElement } = await import("react");
  return {
    // 不带 memo：父级（文字块）每重渲染一次，这里就计一次——哪怕属性没变。
    // 带 memo 的替身会把「重渲染了但属性相同」吞掉，测不出文字块被重渲染（对照实测）。
    default: function CountingMarkdown(props: { children?: unknown }) {
      markdown.renders += 1;
      return createElement("div", { "data-testid": "markdown" }, String(props.children));
    },
  };
});

// 连续的助手消息会并成同一「行」——要换行，中间得隔一条用户消息。
const messages: Message[] = [
  { role: "user", timestamp: null, content: [{ type: "text", text: "你好" }] },
  { role: "assistant", timestamp: null, content: [{ type: "text", text: "## 结论\n\n表格在这里。" }] },
  { role: "user", timestamp: null, content: [{ type: "text", text: "第二问" }] },
  { role: "assistant", timestamp: null, content: [{ type: "text", text: "第二段正文" }] },
];

type FakeRange = { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number };
class FakeStaticRange implements FakeRange {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
  constructor(init: FakeRange) {
    this.startContainer = init.startContainer;
    this.startOffset = init.startOffset;
    this.endContainer = init.endContainer;
    this.endOffset = init.endOffset;
  }
}
class FakeHighlight {
  ranges: FakeRange[];
  constructor(...ranges: FakeRange[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();

beforeAll(async () => {
  await i18n.changeLanguage("zh");
});

afterEach(() => {
  vi.unstubAllGlobals();
  highlights.clear();
  markdown.renders = 0;
});

function enableHighlightApi() {
  const existing = (globalThis as { CSS?: object }).CSS;
  vi.stubGlobal("StaticRange", FakeStaticRange);
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { ...(existing ?? {}), highlights });
}

describe("搜索词变化时已显示的行不重渲染", () => {
  it("同一行换一个也命中的搜索词：Markdown 不重新渲染，命中仍重新登记", () => {
    enableHighlightApi();
    const view = render(<MessageView messages={messages} flat searchQuery="结论" />);
    expect(highlights.get("jishu-search-current")?.ranges).toHaveLength(1);
    const rendersOnMount = markdown.renders;
    expect(rendersOnMount).toBeGreaterThan(0);

    view.rerender(<MessageView messages={messages} flat searchQuery="表格" />);
    expect(markdown.renders).toBe(rendersOnMount);
    // 命中换了：当前命中落在「表格」上（同一行里），不再是「结论」
    const probe = document.createRange();
    const current = highlights.get("jishu-search-current")?.ranges[0];
    probe.setStart(current!.startContainer, current!.startOffset);
    probe.setEnd(current!.endContainer, current!.endOffset);
    expect(probe.toString()).toBe("表格");
  });

  it("新出现的命中行才渲染：从只命中第 1 段换成只命中第 2 段，Markdown 只多渲染一行", () => {
    enableHighlightApi();
    const view = render(<MessageView messages={messages} flat searchQuery="结论" />);
    const before = markdown.renders;
    // 「第二段」只在后面那一行里——前面那一行卸载、后面那一行新挂载，Markdown 渲染一次
    view.rerender(<MessageView messages={messages} flat searchQuery="第二段" />);
    expect(markdown.renders).toBe(before + 1);
    expect(highlights.get("jishu-search-current")?.ranges).toHaveLength(1);
  });
});
