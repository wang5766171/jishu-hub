/**
 * 消息视图里的工具标签——v0.9.8 评审修复轮 R2（用户裁决 8：「把标签放进容器内，标签的格式
 * 可以直接搜就行，标签不是 @[] 进行输送的吗，这种在搜索时识别原始文本即可」）。
 * 对应 tests/V-用例清单 第一、二、三节（V1 / V9 / V4）。
 *
 * jsdom 没有布局，「同一行」量不出来：用 DOM 结构守——正文文字节点与标签的最近公共祖先
 * 到二者之间不能有块级盒子。搜索三处（标题栏计数 / 正文登记的范围 / 侧栏徽标数）逐一比对。
 *
 * 工具目录用替身（不走后端请求）；高亮接口用最小替身，范围覆盖的文字用真实 Range 读出来。
 */
import i18n from "@/i18n";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, useLayoutEffect, useRef, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message, Session } from "@/types";
import { MessageView } from "./message-view";
import { pageText } from "./search-highlight";
import { searchSessions } from "@/lib/session-search";
import { blockSearchText } from "@/lib/session-search-text";
import { BlockRenderersProvider } from "@/features/session-kernel/plugins/mounts/use-block-renderers";
import { rangeText, stubTextHighlightApi } from "./__stubs__/text-highlight-api";
import { catalogStub } from "./__stubs__/tool-catalog";

vi.mock("@/lib/tool-catalog", async () => await import("./__stubs__/tool-catalog"));

const { listSessionPlugins } = vi.hoisted(() => ({ listSessionPlugins: vi.fn() }));
vi.mock("@/features/session-kernel/plugins/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/session-kernel/plugins/registry")>()),
  listSessionPlugins,
}));

const NAMES = { "dev-god": "写后诊断", plan: "方案规划" } as Record<string, string>;
const CATS = { "dev-god": "cli", plan: "skill" } as Record<string, string>;

const user = (text: string, toolIds?: string[]): Message => ({
  role: "user",
  timestamp: null,
  content: [{ type: "text", text, tool_ids: toolIds }],
});
const assistant = (text: string): Message => ({ role: "assistant", timestamp: null, content: [{ type: "text", text }] });

/** 历史消息（带工具、正文里没有字样）与内联字样的消息各一条，中间隔着助手回复。 */
const HISTORY: Message[] = [
  user("你好"),
  user("查一下这段代码", ["dev-god"]),
  assistant("好的，看过了。"),
  user("用 @[方案规划] 排期", ["plan"]),
  assistant("排好了。"),
];
const sessionOf = (messages: Message[]): Session => ({ id: "s1", path: "", messages, started_at: null, last_active: null });

// ── DOM 结构量法 ──
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIALOG", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
  "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
/** 默认显示类型是块级的元素（带 inline / inline-block / inline-flex / contents 类的不算）。 */
const isBlockLevel = (el: Element) =>
  BLOCK_TAGS.has(el.tagName) && !/\b(inline|inline-block|inline-flex|contents)\b/.test(el.getAttribute("class") ?? "");

/**
 * a、b 的最近公共祖先到二者之间的块级盒子（标签名）。
 * 同一个内联流里的两个节点：结果为空——它们共同的父容器可以是一个块级容器，但二者
 * 到这个容器之间不能再隔块级盒子。
 */
function blockBoxesBetween(a: Node, b: Node): string[] {
  const chain = (node: Node): Element[] => {
    const out: Element[] = [];
    for (let el = node.parentElement; el; el = el.parentElement) out.unshift(el);
    return out;
  };
  const ca = chain(a);
  const cb = chain(b);
  let i = 0;
  while (i < ca.length && i < cb.length && ca[i] === cb[i]) i += 1;
  return [...ca.slice(i), ...cb.slice(i)].filter(isBlockLevel).map((el) => el.tagName);
}

function textNodeIn(root: Node, needle: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue?.includes(needle)) return n as Text;
  }
  throw new Error(`没有找到文字「${needle}」`);
}

/** 跟在正文后面的标签（按 title 里的工具 id 找）。 */
const trailingPill = (root: ParentNode, id: string): HTMLElement => {
  const pill = root.querySelector<HTMLElement>(`span[title="${id}"]`);
  if (!pill) throw new Error(`没有找到工具 ${id} 的标签`);
  return pill;
};

/** 用户气泡的页面文字：行里参与搜索的文字（不含行外的「用户」标签）。 */
function bubblePageText(root: ParentNode, messageIndex: number): string {
  const row = root.querySelector(`[data-message-index="${messageIndex}"]`);
  if (!row) throw new Error(`没有第 ${messageIndex} 行`);
  const bubble = row.querySelector<HTMLElement>("div.space-y-1\\.5");
  if (!bubble) throw new Error(`第 ${messageIndex} 行没有气泡`);
  return pageText(bubble);
}

/**
 * 记下第一次提交时页面上的文字。父级的布局副作用排在子级的布局副作用之后、
 * 副作用（useEffect）之前——看到的就是首帧，不等任何请求。
 */
function FirstFrame({ onFirstFrame, children }: { onFirstFrame: () => void; children: ReactNode }) {
  const seen = useRef(false);
  useLayoutEffect(() => {
    if (seen.current) return;
    seen.current = true;
    onFirstFrame();
  });
  return <>{children}</>;
}

beforeAll(async () => {
  await i18n.changeLanguage("zh");
  Element.prototype.scrollIntoView ??= vi.fn();
  Element.prototype.scrollTo ??= vi.fn();
});

beforeEach(() => {
  catalogStub.reset();
  listSessionPlugins.mockReturnValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 渲染并装上高亮接口，返回搜索三处的读数（调用方负责 cleanup）。 */
function searchWithHighlight(messages: Message[], query: string) {
  const api = stubTextHighlightApi();
  const onSearchStatusChange = vi.fn();
  render(<MessageView messages={messages} sessionId="s1" flat searchQuery={query} onSearchStatusChange={onSearchStatusChange} />);
  const calls = onSearchStatusChange.mock.calls;
  const status = calls[calls.length - 1]?.[0] as { current: number; total: number } | undefined;
  const ranges = [...(api.highlights.get("jishu-search-match")?.ranges ?? []), ...(api.highlights.get("jishu-search-current")?.ranges ?? [])];
  return { status, ranges, current: api.highlights.get("jishu-search-current")?.ranges ?? [] };
}

describe("V-1 标签放进正文容器内（R2-8）", () => {
  it("尾随工具标签与正文同处一个内联流，标签在正文容器内——V1-U1", () => {
    catalogStub.set(NAMES, CATS);
    const { container } = render(<MessageView messages={HISTORY} sessionId="s1" flat />);
    const body = textNodeIn(container, "查一下这段代码");
    const pill = trailingPill(container, "dev-god");
    // 正文文字与标签之间没有块级盒子
    expect(blockBoxesBetween(body, pill)).toEqual([]);
    // 公共祖先就是包着正文的那个容器（overflow-hidden），标签组在它里面
    const bodyHost = body.parentElement!.parentElement!;
    expect(pill.parentElement!.parentElement).toBe(bodyHost);
    expect(bodyHost.className).toContain("overflow-hidden");
    expect(bodyHost.textContent).toBe("查一下这段代码@[写后诊断]");
  });

  it("正文含内联字样的消息：标签同样在正文的同一个内联流里（保持）——V1-U2", () => {
    catalogStub.set(NAMES, CATS);
    const { container } = render(<MessageView messages={HISTORY} sessionId="s1" flat />);
    const pill = container.querySelector("[data-tool-pill]")!;
    expect(blockBoxesBetween(textNodeIn(container, "用 "), pill)).toEqual([]);
    expect(blockBoxesBetween(textNodeIn(container, " 排期"), pill)).toEqual([]);
    expect(bubblePageText(container, 3)).toBe("用 @[方案规划] 排期");
  });

  it("无关重渲染后结构不变——V1-U3", () => {
    catalogStub.set(NAMES, CATS);
    const utils = render(<MessageView messages={HISTORY} sessionId="s1" flat />);
    const pill = trailingPill(utils.container, "dev-god");
    const body = textNodeIn(utils.container, "查一下这段代码");
    utils.rerender(<MessageView messages={HISTORY} sessionId="s1" flat expandSignal={1} />);
    expect(trailingPill(utils.container, "dev-god")).toBe(pill);
    expect(body.isConnected).toBe(true);
    expect(blockBoxesBetween(body, pill)).toEqual([]);
  });

  it("搜标签的显示名：计数 1/1，高亮落在标签看得见的名字上——V1-U4", () => {
    catalogStub.set(NAMES, CATS);
    const { status, ranges, current } = searchWithHighlight(HISTORY, "写后诊断");
    expect(status).toEqual({ current: 1, total: 1 });
    expect(ranges).toHaveLength(1);
    expect(rangeText(current[0])).toBe("写后诊断");
    const nameNode = current[0].startContainer as Text;
    expect(nameNode.nodeValue).toBe("写后诊断");
    expect(nameNode.parentElement?.closest("[data-no-search]")).toBeNull();
    expect(nameNode.parentElement?.className).toContain("truncate");
  });

  it("搜 @[显示名]、搜 @[ ：同样命中标签，范围读出来等于搜索词——V1-U5", () => {
    catalogStub.set(NAMES, CATS);
    const exact = searchWithHighlight(HISTORY, "@[写后诊断]");
    expect(exact.status).toEqual({ current: 1, total: 1 });
    expect(rangeText(exact.current[0])).toBe("@[写后诊断]");
    // 范围从 `@[` 那一段起、到 `]` 那一段止，跨三段文字
    expect((exact.current[0].startContainer as Text).nodeValue).toBe("@[");
    expect((exact.current[0].endContainer as Text).nodeValue).toBe("]");
    // 显示名是原始文本的一部分：搜 @[ 同样命中两个标签
    cleanup();
    const open = searchWithHighlight(HISTORY, "@[");
    expect(open.status).toEqual({ current: 1, total: 2 });
    expect(open.ranges.map(rangeText)).toEqual(["@[", "@["]);
  });

  it("三处一致：侧栏徽标数 = 正文登记的范围数 = 标题栏计数——V1-U6", () => {
    catalogStub.set(NAMES, CATS);
    for (const query of ["写后诊断", "@[写后诊断]", "@[", "方案规划", "@[方案规划]", "查一下", "排", "代码", "@[方案规划] 排"]) {
      const { status, ranges } = searchWithHighlight(HISTORY, query);
      cleanup();
      const sidebar = searchSessions([sessionOf(HISTORY)], query)[0]?.matchCount ?? 0;
      expect({ query, total: status?.total, ranges: ranges.length }, `搜索词「${query}」`).toEqual({ query, total: sidebar, ranges: sidebar });
    }
  });

  it("页面文字 = 搜索文本（逐块逐字相等）——V1-U7", () => {
    catalogStub.set(NAMES, CATS);
    const { container } = render(<MessageView messages={HISTORY} sessionId="s1" flat />);
    for (const [index, message] of HISTORY.entries()) {
      if (message.role !== "user") continue;
      const expected = message.content.map((block) => blockSearchText(block, "user", NAMES)).join("");
      expect(bubblePageText(container, index), `第 ${index} 条消息`).toBe(expected);
    }
    expect(bubblePageText(container, 1)).toBe("查一下这段代码@[写后诊断]");
    expect(bubblePageText(container, 3)).toBe("用 @[方案规划] 排期");
  });

  it("字样与没被它覆盖的工具并存：字样原位成标签，其余跟在后面；各算一次——V1-U8", () => {
    catalogStub.set(NAMES, CATS);
    const messages = [user("用 @[方案规划] 排期", ["plan", "dev-god"])];
    const { container } = render(<MessageView messages={messages} sessionId="s1" flat />);
    expect(bubblePageText(container, 0)).toBe("用 @[方案规划] 排期@[写后诊断]");
    cleanup();
    expect(searchWithHighlight(messages, "方案规划").status).toEqual({ current: 1, total: 1 });
    cleanup();
    expect(searchWithHighlight(messages, "写后诊断").status).toEqual({ current: 1, total: 1 });
  });

  it("回落方式（高亮接口不可用）：带标签的消息照常显示、计数正确、翻得到——V1-U9", async () => {
    catalogStub.set(NAMES, CATS);
    const onSearchStatusChange = vi.fn();
    const view = (navigation?: { direction: 1 | -1; nonce: number }) => (
      <MessageView messages={HISTORY} sessionId="s1" flat searchQuery="写后诊断" searchNavigation={navigation} onSearchStatusChange={onSearchStatusChange} />
    );
    const utils = render(view());
    expect(onSearchStatusChange).toHaveBeenLastCalledWith({ current: 1, total: 1 });
    expect(utils.container.querySelectorAll("mark[data-match-idx]")).toHaveLength(0);
    expect(trailingPill(utils.container, "dev-god").textContent).toBe("@[写后诊断]");
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    // 挂载后导航副作用会为第 1 处命中排一个 120ms 的定时器——等它跑完
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    scrollIntoView.mockClear();
    utils.rerender(view({ direction: 1, nonce: 1 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    // 标签上没有 <mark>：按它所在的行滚
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ behavior: "smooth", block: "center" });
    expect(scrollIntoView.mock.instances[0]).toBe(utils.container.querySelector('[data-message-index="1"]'));
  });

  it("显示名取不到的标签：显示 id，搜索文本按 @[id] 计——V1-U10", () => {
    catalogStub.set(NAMES, CATS);
    const messages = [user("看看这个", ["ghost"])];
    const { container } = render(<MessageView messages={messages} sessionId="s1" flat />);
    expect(trailingPill(container, "ghost").textContent).toBe("@[ghost]");
    expect(bubblePageText(container, 0)).toBe("看看这个@[ghost]");
    cleanup();
    expect(searchWithHighlight(messages, "ghost").status).toEqual({ current: 1, total: 1 });
  });

  it("内联字样 + 图片附件：回放气泡不露出图片标记，页面文字 = 搜索文本——V1-U11", () => {
    catalogStub.set(NAMES, CATS);
    const messages = [user(["看这张图 @[方案规划]", "<!--JISHU_HUB_IMAGES_BEGIN-->", "chart.png", "<!--JISHU_HUB_IMAGES_END-->"].join("\n"), ["plan"])];
    const { container, rerender } = render(<MessageView messages={messages} sessionId="s1" flat />);
    expect(bubblePageText(container, 0)).toBe("看这张图 @[方案规划]");
    for (const query of ["JISHU_HUB_IMAGES", "chart.png"]) {
      rerender(<MessageView messages={messages} sessionId="s1" flat searchQuery={query} />);
      expect(container.querySelector("[data-search-empty]"), `搜「${query}」`).not.toBeNull();
    }
  });

  it("任务启动包装 /jishu-task：气泡显示与搜索文本同一份——V1-U12", () => {
    catalogStub.set(NAMES, CATS);
    const messages = [user("/jishu-task dev 修复登录问题", ["dev-god"])];
    const { container } = render(<MessageView messages={messages} sessionId="s1" flat />);
    expect(bubblePageText(container, 0)).toBe("修复登录问题@[写后诊断]");
    cleanup();
    expect(searchWithHighlight(messages, "jishu-task").status).toEqual({ current: 0, total: 0 });
    cleanup();
    const hit = searchWithHighlight(messages, "修复登录");
    expect(hit.status).toEqual({ current: 1, total: 1 });
    expect(rangeText(hit.current[0])).toBe("修复登录");
  });
});

describe("V-4 不参与搜索的界面文字", () => {
  it("内联标签的不可见占位不计入搜索：搜显示名只算 1 处——V4-U1", () => {
    catalogStub.set(NAMES, CATS);
    const messages = [user("用 @[方案规划] 排期", ["plan"]), assistant("好")];
    const { status, ranges } = searchWithHighlight(messages, "方案规划");
    expect(status).toEqual({ current: 1, total: 1 });
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("方案规划");
  });

  it("插件接管的代码块角标不参与命中——V4-U2", () => {
    catalogStub.set(NAMES, CATS);
    listSessionPlugins.mockReturnValue([
      {
        id: "session.fake",
        source: "config",
        mounts: [
          {
            kind: "block-renderer",
            matching: "code",
            languages: ["mermaid"],
            detect: () => true,
            pluginId: "fake",
            pluginLabel: "graph",
            // 接管后照常把代码显示出来——页面文字里才有代码内容
            Component: ({ code }: { code: string }) => createElement("pre", null, code),
          },
        ],
      },
    ]);
    const messages = [assistant(["说明 graph", "", "```mermaid", "graph TD", "```"].join("\n"))];
    const api = stubTextHighlightApi();
    const onSearchStatusChange = vi.fn();
    const { container } = render(
      <BlockRenderersProvider enabled={new Set(["session.fake"])}>
        <MessageView messages={messages} sessionId="s1" flat searchQuery="graph" onSearchStatusChange={onSearchStatusChange} />
      </BlockRenderersProvider>,
    );
    // 正文里一处、代码里一处；角标上的「graph」不算
    expect(onSearchStatusChange).toHaveBeenLastCalledWith({ current: 1, total: 2 });
    const ranges = [...(api.highlights.get("jishu-search-match")?.ranges ?? []), ...(api.highlights.get("jishu-search-current")?.ranges ?? [])];
    expect(ranges.map(rangeText)).toEqual(["graph", "graph"]);
    const badge = [...container.querySelectorAll("[data-no-search]")].find((el) => el.textContent?.includes("graph"));
    expect(badge).toBeTruthy();
  });
});

describe("V-9 工具名映射是全局一份", () => {
  const INLINE = [user("用 @[方案规划] 排期", ["plan"])];

  it("别的会话已经取到工具名：新会话第一帧就按显示名渲染，不出现「字样 + 标签」双份——V9-U1", () => {
    catalogStub.set(NAMES, CATS);
    // 目录是现成的（别的会话取过）：第一次打开这个会话，首帧就该是渲染好的样子
    let firstFrame = "";
    const { container } = render(
      <FirstFrame onFirstFrame={() => (firstFrame = bubblePageText(document.body, 0))}>
        <MessageView messages={INLINE} sessionId="第一次打开的会话" flat />
      </FirstFrame>,
    );
    expect(firstFrame).toBe("用 @[方案规划] 排期");
    expect(container.querySelectorAll("[data-tool-pill]")).toHaveLength(1);
    expect(container.querySelector('span[title="plan"]')).toBeNull();
  });

  it("名字还没到的时候是双份（字样原文 + 以 id 显示的标签）；名字到了当场收成一份", () => {
    const { container, rerender } = render(<MessageView messages={INLINE} sessionId="s1" flat />);
    expect(bubblePageText(container, 0)).toBe("用 @[方案规划] 排期@[plan]");
    act(() => catalogStub.set(NAMES, CATS));
    rerender(<MessageView messages={INLINE} sessionId="s1" flat />);
    expect(bubblePageText(container, 0)).toBe("用 @[方案规划] 排期");
  });

  it("工具被卸载后名字取不到：字样按原文 + 以 id 显示的标签；搜索文本仍等于页面文字——V9-U4", () => {
    catalogStub.set(NAMES, CATS);
    const messages = [user("用 @[旧工具] 看看", ["gone"])];
    const { container } = render(<MessageView messages={messages} sessionId="s1" flat />);
    expect(bubblePageText(container, 0)).toBe("用 @[旧工具] 看看@[gone]");
    cleanup();
    expect(searchWithHighlight(messages, "旧工具").status).toEqual({ current: 1, total: 1 });
    cleanup();
    expect(searchWithHighlight(messages, "gone").status).toEqual({ current: 1, total: 1 });
  });
});
