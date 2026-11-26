/**
 * 搜索词变化时已显示的行不重渲染——v0.9.8 需求23，对应 tests/06-测试清单 S23-U23。
 *
 * 高亮接口生效时，行的渲染结果不依赖搜索词（命中在渲染后登记上色）。长会话里
 * 重渲染一行要重新解析 Markdown（开发实例实测每次按键占主线程 50~210 毫秒）。
 * 这里把 Markdown 组件换成会计数的替身，断言换搜索词时它不再被调用。
 *
 * v0.9.8 评审修复轮 R2 追加（tests/V-用例清单 V7）：行缓存只为显示出来的行计算、
 * 「未送达」行的删除回调引用稳定。
 */
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/types";
import { MessageView } from "./message-view";

vi.mock("@/lib/tool-catalog", async () => await import("./__stubs__/tool-catalog"));

// 每算一行的渲染条目会调一次 computeRetriedSuccessFlags——拿它数「算了几行」。
const { retryFlags, inlineImagesRenders } = vi.hoisted(() => ({
  retryFlags: vi.fn(),
  inlineImagesRenders: { count: 0 },
}));
vi.mock("@/lib/retry-flag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/retry-flag")>();
  return { ...actual, computeRetriedSuccessFlags: retryFlags.mockImplementation(actual.computeRetriedSuccessFlags) };
});
// 气泡里的附件区换成不带 memo 的计数替身：父级（用户气泡）每渲染一次它就计一次。
vi.mock("./inline-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inline-image")>();
  return {
    ...actual,
    InlineImages: (props: { text: string }) => {
      inlineImagesRenders.count += 1;
      return createElement(actual.InlineImages, props);
    },
  };
});

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
  ranges: FakeRange[] = [];
  add(range: FakeRange): void {
    this.ranges.push(range);
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

/** 行缓存与回调的引用——v0.9.8 评审修复轮 R2（tests/V-用例清单 V7-U1～U3）。 */
describe("行缓存与回调的引用", () => {
  const row = (role: Message["role"], value: string, extra: Partial<Message> = {}): Message => ({
    role,
    timestamp: null,
    content: [{ type: "text", text: value }],
    ...extra,
  });

  beforeEach(() => {
    retryFlags.mockClear();
    inlineImagesRenders.count = 0;
  });

  it("只为显示出来的行计算 key / 渲染条目 / 复制文本——V7-U1", () => {
    // 130 行消息，常态只渲染最近 120 行
    const many = Array.from({ length: 130 }, (_, i) => row(i % 2 ? "assistant" : "user", `消息 ${i}`));
    const { container } = render(<MessageView messages={many} flat />);
    expect(container.querySelectorAll("[data-message-index]")).toHaveLength(120);
    expect(retryFlags).toHaveBeenCalledTimes(120);
  });

  it("搜索态只算命中行", () => {
    const many = Array.from({ length: 130 }, (_, i) => row("user", i % 10 === 0 ? `蓝鲸 ${i}` : `消息 ${i}`));
    const { container } = render(<MessageView messages={many} flat searchQuery="蓝鲸" />);
    expect(container.querySelectorAll("[data-message-index]")).toHaveLength(13);
    expect(retryFlags).toHaveBeenCalledTimes(13);
  });

  it("「未送达」行的删除回调引用稳定：父级重渲染时这一行不重渲染——V7-U2", () => {
    const onDismissUnsent = vi.fn();
    const list = [row("user", "你好"), row("user", "这条没发出去", { unsent: true }), row("user", "再问一句")];
    const view = render(<MessageView messages={list} flat onDismissUnsent={onDismissUnsent} />);
    const renders = inlineImagesRenders.count;
    view.rerender(<MessageView messages={list} flat onDismissUnsent={onDismissUnsent} expandSignal={1} />);
    expect(inlineImagesRenders.count).toBe(renders);
  });

  it("删除按钮删的是自己这条消息——V7-U3", () => {
    const onDismissUnsent = vi.fn();
    const list = [row("user", "你好"), row("user", "这条没发出去", { unsent: true })];
    render(<MessageView messages={list} flat onDismissUnsent={onDismissUnsent} />);
    fireEvent.click(screen.getByTitle("删除这条未送达消息"));
    expect(onDismissUnsent).toHaveBeenCalledTimes(1);
    expect(onDismissUnsent).toHaveBeenCalledWith(list[1]);
  });
});
