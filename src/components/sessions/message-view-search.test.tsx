/**
 * MessageView 搜索态单测——v0.9.8 需求23，对应 tests/06-测试清单：
 * S23-U5 渲染态下搜索只显示命中消息；S23-U6 不支持高亮接口时走原有方式；
 * S23-U9~U14 打开命中会话当帧定位、清空关键词后正在看的消息不动；
 * S23-U21 没有命中时消息照常显示。
 *
 * 测试环境默认没有文字高亮接口（回落方式）；另用最小替身把接口补上，验证
 * 「正文正常渲染 + 渲染后标黄」这条主路径（登记了多少处命中、当前命中是哪一处）。
 *
 * jsdom 不排版：滚动容器与消息行的位置用替身给出（行按 data-message-index 查表），
 * 「滚到了哪里」直接读容器的 scrollTop。
 */
import i18n from "@/i18n";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startTransition } from "react";
import type { Message } from "@/types";
import { MessageView } from "./message-view";

const text = (role: Message["role"], value: string): Message => ({
  role,
  timestamp: null,
  content: [{ type: "text", text: value }],
});

const messages: Message[] = [
  text("user", "你好"),
  text("assistant", "## 结论\n\n**关键词** 在这里，`code` 一段。\n\n| 列一 | 列二 |\n| --- | --- |\n| 关键词 | 2 |"),
  text("user", "第二问"),
  text("assistant", "没有命中"),
];

// ── 几何替身 ──
/** 矩形（top/height 给定，其余取定值；与 DOMRect 同形）。 */
const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
type Rect = DOMRect;
/** 零尺寸：没登记位置、或所在行还没被浏览器排版——量不到位置。 */
const ZERO: Rect = Object.freeze({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
/** 滚动容器的矩形（视口顶在页面 y=100，高 600）。 */
const VIEWPORT_TOP = 100;
const VIEWPORT_HEIGHT = 600;
/**
 * 行的矩形，按 data-message-index 查——搜索态（只显示命中行）与完整列表各一份，
 * 由 isFullLayout 判断当前页面是哪一种；没登记的元素零尺寸。
 */
let lensRowRects: Record<string, Rect>;
let fullRowRects: Record<string, Rect>;
/** 当前渲染的是不是完整列表（测试里按「只在完整列表里才有的行」判断）。 */
let isFullLayout: () => boolean;
let markRects: Record<string, Rect>;
/** 命中范围（Range）的矩形，按起点在文字节点里的偏移登记。 */
let rangeRects: Map<number, Rect>;
/** 滚动容器的矩形（直接登记进表——对实例再打 spy 会和原型上的 spy 合并成一个）。 */
const scrollerRects = new WeakMap<Element, Rect>();
/** 当前测试用的滚动容器——行与命中的屏幕位置随它的滚动位置变化（和真实页面一致）。 */
let scrollerEl: HTMLElement | null = null;
const scrolled = (base: Rect, by: number): Rect =>
  by ? ({ ...base, top: base.top - by, bottom: base.bottom - by, y: base.y - by }) : base;

function makeScroller() {
  const el = document.createElement("div");
  const size = { scrollHeight: 5000 };
  Object.defineProperty(el, "clientHeight", { configurable: true, value: VIEWPORT_HEIGHT });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  scrollerRects.set(el, rect(VIEWPORT_TOP, VIEWPORT_HEIGHT));
  scrollerEl = el;
  document.body.appendChild(el);
  return { el, size };
}

beforeAll(async () => {
  await i18n.changeLanguage("zh");
  resetRects();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const scroller = scrollerRects.get(this);
    if (scroller) return scroller;
    // 表里登记的是滚动位置为 0 时的屏幕位置；实际位置要减去当前滚动位置
    const by = scrollerEl?.scrollTop ?? 0;
    const mark = this.getAttribute("data-match-idx");
    if (mark !== null) return scrolled(markRects[mark] ?? ZERO, by);
    const row = this.getAttribute("data-message-index");
    if (row !== null) return scrolled((isFullLayout() ? fullRowRects : lensRowRects)[row] ?? ZERO, by);
    return ZERO;
  });
  // jsdom 没有这几个排版相关的方法；导航 effect 120ms 后会调到
  Element.prototype.scrollIntoView ??= vi.fn();
  Element.prototype.scrollTo ??= vi.fn();
  Range.prototype.getBoundingClientRect = function (this: Range) {
    if (!this.toString()) return ZERO;
    // 和真实浏览器一致：所在行在视口外、浏览器跳过排版时量不到位置（宽高为 0）；
    // 只有 withRenderedRows 临时把行设为可见、强制排版之后才量得到
    const row = this.startContainer.parentElement?.closest<HTMLElement>("[data-message-index]");
    if (!row || row.style.contentVisibility !== "visible") return ZERO;
    return rangeRects.get(this.startOffset) ?? ZERO;
  } as () => DOMRect;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  resetRects();
});

function resetRects() {
  lensRowRects = {};
  fullRowRects = {};
  markRects = {};
  rangeRects = new Map();
  isFullLayout = () => false;
}

describe("回落方式（没有文字高亮接口）——S23-U5 / S23-U6 / S23-U21", () => {
  it("只显示含命中的行，其余折成细条；命中处仍有黄底", () => {
    const { container } = render(<MessageView messages={messages} flat searchQuery="关键词" />);
    expect(screen.queryByText("你好")).toBeNull();
    expect(screen.queryByText("第二问")).toBeNull();
    expect(screen.queryByText("没有命中")).toBeNull();
    expect(screen.getByText("前面省略 1 条消息")).toBeTruthy();
    expect(screen.getByText("后面省略 2 条消息")).toBeTruthy();
    expect(screen.queryByText(/中间省略/)).toBeNull();
    expect(screen.queryByText("结论")).toBeNull(); // 整条助手回复里没有「结论」二字的独立节点——回落方式下正文是源码
    expect(container.querySelectorAll("mark[data-match-idx]").length).toBe(2);
  });

  it("没有命中时：消息照常显示，顶部有「没有找到」提示，没有细条", () => {
    const { container } = render(<MessageView messages={messages} flat searchQuery="不存在的词" />);
    expect(screen.getByText("没有找到「不存在的词」")).toBeTruthy();
    expect(screen.getByText("你好")).toBeTruthy();
    expect(screen.getByText("第二问")).toBeTruthy();
    expect(container.querySelectorAll("[data-message-index]").length).toBe(4);
    expect(container.querySelector("[data-search-gap]")).toBeNull();
  });

  it("不在搜索时与原先一致：全部消息照常渲染", () => {
    render(<MessageView messages={messages} flat />);
    expect(screen.getByText("你好")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "结论" })).toBeTruthy();
    expect(screen.getByText("第二问")).toBeTruthy();
    expect(screen.getByText("没有命中")).toBeTruthy();
    expect(screen.queryByText(/省略|没有找到/)).toBeNull();
  });
});

describe("渲染后标黄（文字高亮接口可用）——S23-U5", () => {
  type FakeRange = { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number };
  // 与真实浏览器一致：StaticRange 只有起止点，没有量位置的方法（量位置走 rectOfMatch）
  class FakeStaticRange {
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

  const stubHighlightApi = () => {
    highlights.clear();
    const existing = (globalThis as { CSS?: object }).CSS;
    vi.stubGlobal("StaticRange", FakeStaticRange);
    vi.stubGlobal("Highlight", FakeHighlight);
    vi.stubGlobal("CSS", { ...(existing ?? {}), highlights });
  };

  it("正文按正常样式渲染（标题、粗体、表格），不再退回源码；命中登记为 2 处，当前命中 1 处", () => {
    stubHighlightApi();
    const { container } = render(<MessageView messages={messages} flat searchQuery="关键词" />);
    expect(screen.getByRole("heading", { name: "结论" })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("关键词");
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll("mark[data-match-idx]")).toHaveLength(0);
    expect(screen.queryByText(/##|\*\*/)).toBeNull();
    // 当前命中单独一层颜色：命中层 1 处 + 当前层 1 处 = 共 2 处
    expect(highlights.get("jishu-search-match")?.ranges).toHaveLength(1);
    expect(highlights.get("jishu-search-current")?.ranges).toHaveLength(1);
  });

  it("命中范围落在渲染出来的文字上（粗体里的关键词、表格单元格里的关键词）", () => {
    stubHighlightApi();
    render(<MessageView messages={messages} flat searchQuery="关键词" />);
    const current = highlights.get("jishu-search-current")?.ranges[0];
    const all = highlights.get("jishu-search-match")?.ranges ?? [];
    // 当前命中 = 第 0 处（粗体里）；其余 1 处在表格单元格里
    expect(current).toBeTruthy();
    const allText = [current, ...all].map((range) => {
      const node = range?.startContainer as Node | undefined;
      return node?.parentElement?.tagName;
    });
    expect(allText).toEqual(["STRONG", "TD"]);
  });

  it("「下一处」切换当前命中，不新增登记", () => {
    stubHighlightApi();
    const { rerender } = render(<MessageView messages={messages} flat searchQuery="关键词" />);
    const first = highlights.get("jishu-search-current")?.ranges[0];
    rerender(<MessageView messages={messages} flat searchQuery="关键词" searchNavigation={{ direction: 1, nonce: 1 }} />);
    const second = highlights.get("jishu-search-current")?.ranges[0];
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(highlights.get("jishu-search-match")?.ranges).toHaveLength(1);
  });

  it("清空关键词后注销全部高亮", () => {
    stubHighlightApi();
    const { rerender } = render(<MessageView messages={messages} flat searchQuery="关键词" />);
    rerender(<MessageView messages={messages} flat searchQuery="" />);
    expect(highlights.get("jishu-search-match")?.ranges ?? []).toHaveLength(0);
    expect(highlights.get("jishu-search-current")?.ranges ?? []).toHaveLength(0);
  });

  it("打开命中会话（搜索跳转）：当帧按登记的命中范围把第一处放到视口正中，并回报完成一次——S23-U9", () => {
    stubHighlightApi();
    const { el } = makeScroller();
    rangeRects.set(0, rect(5000, 20));
    const onSearchJumpDone = vi.fn();
    const onSearchStatusChange = vi.fn();
    const { rerender } = render(
      <MessageView
        messages={messages}
        flat
        searchQuery="关键词"
        searchJump={{ sessionId: null, nonce: 1 }}
        onSearchJumpDone={onSearchJumpDone}
        onSearchStatusChange={onSearchStatusChange}
        scrollContainerRef={{ current: el }}
      />,
      { container: el },
    );
    // 5000 - 100（命中相对视口顶的距离）- (600 - 20) / 2（留出上下等边的余量）
    expect(el.scrollTop).toBe(5000 - VIEWPORT_TOP - (VIEWPORT_HEIGHT - 20) / 2);
    expect(onSearchJumpDone).toHaveBeenCalledTimes(1);
    // 同一个信号不重复处理（别的属性变化引起的重渲染）
    rerender(
      <MessageView
        messages={messages}
        flat
        searchQuery="关键词"
        searchJump={{ sessionId: null, nonce: 1 }}
        onSearchJumpDone={onSearchJumpDone}
        onSearchStatusChange={onSearchStatusChange}
        scrollContainerRef={{ current: el }}
      />,
    );
    expect(onSearchJumpDone).toHaveBeenCalledTimes(1);
  });
  it("命中都在一个很高的行里、行还没排版：「下一处」先让这一行排版，再按命中自己的位置滚——S23-U25", async () => {
    stubHighlightApi();
    const { el } = makeScroller();
    // 三个命中都在同一条助手消息的同一个文字节点里；这行比屏幕高得多
    const body = "关键词000000关键词000000关键词";
    const second = body.indexOf("关键词", 1);
    const third = body.indexOf("关键词", second + 1);
    const tall: Message[] = [text("user", "你好"), text("assistant", body)];
    rangeRects.set(second, rect(5000, 20));
    rangeRects.set(third, rect(9000, 20));
    const view = (navigation?: { direction: 1 | -1; nonce: number }) => (
      <MessageView messages={tall} flat searchQuery="关键词" searchNavigation={navigation} scrollContainerRef={{ current: el }} />
    );
    const { rerender } = render(view(), { container: el });
    // 挂载后导航 effect 会为第 1 处命中排一个 120ms 的定时器——等它跑完再开始计数
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    const scrollTo = Element.prototype.scrollTo as unknown as ReturnType<typeof vi.fn>;
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    scrollTo.mockClear();
    scrollIntoView.mockClear();

    rerender(view({ direction: 1, nonce: 1 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    // 按第 2 处命中的位置滚到视口正中，而不是去滚「整行」（行比屏幕高，滚整行等于没滚）
    expect(scrollTo).toHaveBeenCalledWith({ top: 5000 - VIEWPORT_TOP - (VIEWPORT_HEIGHT - 20) / 2, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(highlights.get("jishu-search-current")?.ranges).toHaveLength(1);
    // 量完之后这一行的行内样式还原成原值——置空会把 content-visibility: auto 删掉，
    // 这一行此后不再被浏览器跳过排版
    expect(el.querySelector<HTMLElement>('[data-message-index="1"]')?.style.getPropertyValue("content-visibility")).toBe("auto");
  });
});

describe("打开命中会话与退出搜索——S23-U9~U14（回落方式）", () => {
  const mount = (props: Record<string, unknown>, el: HTMLDivElement) =>
    render(<MessageView messages={messages} flat scrollContainerRef={{ current: el }} {...props} />, { container: el });

  it("搜索跳转：把第一处命中滚到视口正中，计数从 1 起——S23-U9", () => {
    const { el } = makeScroller();
    markRects["0"] = rect(5000, 20);
    const onSearchJumpDone = vi.fn();
    const onSearchStatusChange = vi.fn();
    mount({ searchQuery: "关键词", searchJump: { sessionId: null, nonce: 1 }, onSearchJumpDone, onSearchStatusChange }, el);
    expect(el.scrollTop).toBe(5000 - VIEWPORT_TOP - (VIEWPORT_HEIGHT - 20) / 2);
    expect(onSearchJumpDone).toHaveBeenCalledTimes(1);
    expect(onSearchStatusChange).toHaveBeenLastCalledWith({ current: 1, total: 2 });
  });

  it("跳转信号指向别的会话、或没有信号：不滚动、不回报——S23-U10", () => {
    const { el } = makeScroller();
    markRects["0"] = rect(5000, 20);
    const onSearchJumpDone = vi.fn();
    mount({ searchQuery: "关键词", searchJump: { sessionId: "别的会话", nonce: 1 }, onSearchJumpDone }, el);
    expect(onSearchJumpDone).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe(0);
    mount({ searchQuery: "关键词", searchJump: null, onSearchJumpDone }, el);
    expect(onSearchJumpDone).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe(0);
  });

  it("已经翻到第 2 处，再收到跳转信号：当前命中回到第 1 处——S23-U11", () => {
    const { el } = makeScroller();
    const onSearchStatusChange = vi.fn();
    const { rerender } = render(
      <MessageView messages={messages} flat searchQuery="关键词" scrollContainerRef={{ current: el }} onSearchStatusChange={onSearchStatusChange} />,
      { container: el },
    );
    rerender(
      <MessageView
        messages={messages}
        flat
        searchQuery="关键词"
        searchNavigation={{ direction: 1, nonce: 1 }}
        scrollContainerRef={{ current: el }}
        onSearchStatusChange={onSearchStatusChange}
      />,
    );
    expect(onSearchStatusChange).toHaveBeenLastCalledWith({ current: 2, total: 2 });
    rerender(
      <MessageView
        messages={messages}
        flat
        searchQuery="关键词"
        searchJump={{ sessionId: null, nonce: 1 }}
        scrollContainerRef={{ current: el }}
        onSearchStatusChange={onSearchStatusChange}
      />,
    );
    expect(onSearchStatusChange).toHaveBeenLastCalledWith({ current: 1, total: 2 });
  });

  it("清空关键词：视口顶上那条行还在原来的屏幕位置（上下的消息补进来后滚动位置跟着补）——S23-U12", () => {
    const { el } = makeScroller();
    // 搜索态：只显示第 1 条消息所在的行，它的顶离视口顶 200
    lensRowRects["1"] = rect(VIEWPORT_TOP + 200, 600);
    isFullLayout = () => document.querySelector('[data-message-index="0"]') !== null;
    const { rerender } = render(
      <MessageView messages={messages} flat searchQuery="关键词" scrollContainerRef={{ current: el }} />,
      { container: el },
    );
    expect(el.querySelectorAll("[data-message-index]").length).toBe(1);
    // 完整列表：第 0 条消息的行补在它上面，第 1 行的顶被推到 y=1500
    fullRowRects["1"] = rect(1500, 600);
    rerender(<MessageView messages={messages} flat searchQuery="" scrollContainerRef={{ current: el }} />);
    expect(el.querySelectorAll("[data-message-index]").length).toBe(4);
    // 滚动位置补上这条行被推下去的距离，它在屏幕上还在视口顶下方 200 处
    expect(el.scrollTop).toBe(1500 - VIEWPORT_TOP - 200);
  });

  it("搜索态下停在列表最底（命中行都在视口上方）：清空关键词后仍在最底——S23-U13", () => {
    const { el } = makeScroller();
    lensRowRects["1"] = rect(-500, 400);
    isFullLayout = () => document.querySelector('[data-message-index="0"]') !== null;
    // 内容高度跟着列表状态走：折叠时 5000，展开后 9000（和真实页面一致——列表展开那次提交才变高）
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => (isFullLayout() ? 9000 : 5000) });
    el.scrollTop = 5000 - VIEWPORT_HEIGHT;
    const { rerender } = render(
      <MessageView messages={messages} flat searchQuery="关键词" scrollContainerRef={{ current: el }} />,
      { container: el },
    );
    expect(el.scrollTop).toBe(5000 - VIEWPORT_HEIGHT);
    // 完整列表更高：退出后要跟到新的底部，而不是停在原来的位置
    rerender(<MessageView messages={messages} flat searchQuery="" scrollContainerRef={{ current: el }} />);
    expect(el.scrollTop).toBe(9000 - VIEWPORT_HEIGHT);
  });

  it("正在看的行在渲染窗口之外：先扩窗把它渲染出来，再放回原处——S23-U14", () => {
    const { el } = makeScroller();
    const many: Message[] = Array.from({ length: 130 }, (_, i) =>
      text(i % 2 === 0 ? "user" : "assistant", i === 0 ? "开头 关键词" : `消息 ${i}`),
    );
    lensRowRects["0"] = rect(VIEWPORT_TOP + 200, 600);
    isFullLayout = () => document.querySelector('[data-message-index="1"]') !== null;
    const { rerender } = render(
      <MessageView messages={many} flat searchQuery="关键词" scrollContainerRef={{ current: el }} />,
      { container: el },
    );
    expect(el.querySelectorAll("[data-message-index]").length).toBe(1);
    fullRowRects["0"] = rect(1500, 600);
    rerender(<MessageView messages={many} flat searchQuery="" scrollContainerRef={{ current: el }} />);
    // 完整列表默认只渲染最近 120 行——第 0 行本不在窗口里
    expect(el.querySelectorAll("[data-message-index]").length).toBe(130);
    expect(el.scrollTop).toBe(1500 - VIEWPORT_TOP - 200);
  });

  it("切到另一个会话的同时退出搜索（「进入会话」）：不把上一个会话记的行套到新会话上——S23-U28", () => {
    const { el } = makeScroller();
    const inA: Message[] = [text("user", "你好"), text("assistant", "关键词在 A 会话里")];
    const inB: Message[] = [
      text("user", "B 会话第一问"),
      text("assistant", "关键词在 B 会话里"),
      text("user", "B 会话第二问"),
    ];
    lensRowRects["1"] = rect(VIEWPORT_TOP + 200, 600);
    isFullLayout = () => document.querySelector('[data-message-index="2"]') !== null;
    const { rerender } = render(
      <MessageView messages={inA} sessionId="a" flat searchQuery="关键词" scrollContainerRef={{ current: el }} />,
      { container: el },
    );
    expect(el.querySelectorAll("[data-message-index]").length).toBe(1);
    fullRowRects["1"] = rect(1500, 600);
    // 同一次更新里：会话从 A 换成 B、搜索词清空
    rerender(<MessageView messages={inB} sessionId="b" flat searchQuery="" scrollContainerRef={{ current: el }} />);
    expect(el.querySelectorAll("[data-message-index]").length).toBe(3);
    // A 会话里记的「视口顶上那行」对 B 没有意义——视图不动，落位交给页面（首次到底 / 重访恢复）
    expect(el.scrollTop).toBe(0);
  });

  it("同上，但搜索词立即生效（非紧急更新里不存在慢一拍）：靠「先作废旧会话的行、再处理退出搜索」的顺序——S23-U28", async () => {
    const { el } = makeScroller();
    const inA: Message[] = [text("user", "你好"), text("assistant", "关键词在 A 会话里")];
    const inB: Message[] = [
      text("user", "B 会话第一问"),
      text("assistant", "关键词在 B 会话里"),
      text("user", "B 会话第二问"),
    ];
    lensRowRects["1"] = rect(VIEWPORT_TOP + 200, 600);
    isFullLayout = () => document.querySelector('[data-message-index="2"]') !== null;
    const { rerender } = render(
      <MessageView messages={inA} sessionId="a" flat searchQuery="关键词" scrollContainerRef={{ current: el }} />,
      { container: el },
    );
    expect(el.querySelectorAll("[data-message-index]").length).toBe(1);
    fullRowRects["1"] = rect(1500, 600);
    // 非紧急更新：延迟生效的搜索词不慢一拍——这次提交里列表已经展开、搜索已经退出
    await act(async () => {
      startTransition(() => {
        rerender(<MessageView messages={inB} sessionId="b" flat searchQuery="" scrollContainerRef={{ current: el }} />);
      });
    });
    expect(el.querySelectorAll("[data-message-index]").length).toBe(3);
    expect(el.scrollTop).toBe(0);
  });
});
