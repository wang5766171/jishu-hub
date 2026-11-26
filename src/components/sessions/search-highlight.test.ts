/**
 * 搜索高亮登记处单测——v0.9.8 需求23。findMatchRanges 在真实 DOM 上验证：
 * 跨节点的关键词、按钮文字不参与；rectOfMatch 用真实 Range 量位置
 *（StaticRange 自己没有量位置的方法——界面验证时实测抓到过这个错，替身不再补这个方法）。
 * v0.9.8 评审修复轮 R2 追加：一次提交只上色一次、页面文字、高亮样式的静态契约。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SearchHighlightRegistry, centerInScroller, findMatchRanges, pageText, rectOfMatch, scrollTopToCenter } from "./search-highlight";

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
  constructor() {
    this.ranges = [];
  }
  add(range: FakeRange): void {
    this.ranges.push(range);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const mount = (html: string) => {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
};

const textOf = (range: FakeRange) => {
  // 用真实的 Range 读出这处范围覆盖的文字（起止点落在哪 个节点上不重要，覆盖了什么才重要）
  const probe = document.createRange();
  probe.setStart(range.startContainer, range.startOffset);
  probe.setEnd(range.endContainer, range.endOffset);
  return probe.toString();
};

describe("findMatchRanges", () => {
  it("普通段落里的多处命中，按出现先后", () => {
    const root = mount("<p>关键词出现了一次，又出现了关键词，还是关键词。</p>");
    const ranges = findMatchRanges(root, "关键词");
    expect(ranges.map(textOf)).toEqual(["关键词", "关键词", "关键词"]);
  });

  it("关键词跨了节点（粗体、行内代码之间）也能命中", () => {
    const root = mount("<p>严重的<strong>问题</strong>，见 <code>usePosts</code> 一段</p>");
    const ranges = findMatchRanges(root, "严重的问题");
    expect(ranges).toHaveLength(1);
    expect(textOf(ranges[0])).toBe("严重的问题");
    expect(ranges[0].startContainer).not.toBe(ranges[0].endContainer);
  });

  it("按钮、读屏文字里的同名文字不参与", () => {
    const root = mount("<div><p>正文里的关键词</p><button>复制关键词</button><span class='sr-only'>关键词</span></div>");
    expect(findMatchRanges(root, "关键词").map(textOf)).toEqual(["关键词"]);
  });

  it("标了 data-no-search 的文字不参与（工具标签里排版用的占位）——v0.9.8 评审修复轮 R2", () => {
    const root = mount("<p>查代码<span data-no-search=''>@[写后诊断]</span><span>@[写后诊断]</span></p>");
    expect(findMatchRanges(root, "写后诊断").map(textOf)).toEqual(["写后诊断"]);
    expect(findMatchRanges(root, "@[写后诊断]").map(textOf)).toEqual(["@[写后诊断]"]);
  });

  it("大小写不敏感；关键词里有正则符号按字面匹配", () => {
    const root = mount("<p>UsePosts 与 useposts；a.c 与 abc</p>");
    expect(findMatchRanges(root, "useposts")).toHaveLength(2);
    expect(findMatchRanges(root, "a.c").map(textOf)).toEqual(["a.c"]);
  });

  it("空关键词或没有文字 → 空", () => {
    const root = mount("<p></p>");
    expect(findMatchRanges(root, "   ")).toEqual([]);
    expect(findMatchRanges(root, "词")).toEqual([]);
  });
});

describe("rectOfMatch", () => {
  beforeAll(() => {
    // jsdom 的 Range 没有量位置的方法（真实浏览器有）——补一个返回零尺寸矩形的替身
    const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect };
    if (typeof proto.getBoundingClientRect !== "function") {
      proto.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0 }) as DOMRect;
    }
  });

  it("用同一组起止点的 Range 量位置（StaticRange 自己量不了）", () => {
    const root = mount("<p>一句话里有<strong>关键词</strong>。</p>");
    const range = findMatchRanges(root, "关键词")[0];
    const bare: unknown = range;
    expect((bare as { getBoundingClientRect?: unknown }).getBoundingClientRect).toBeUndefined();
    const rect = rectOfMatch(range);
    expect(rect).not.toBeNull();
    // jsdom 不排版，尺寸为 0；真实浏览器里是那几个字的矩形
    expect(rect!.width).toBe(0);
  });

  it("起止点已失效（偏移越界）→ 量不到，返回空而不是抛错", () => {
    const node = document.createTextNode("关键词");
    const stale = new StaticRange({ startContainer: node, startOffset: 99, endContainer: node, endOffset: 100 });
    expect(rectOfMatch(stale)).toBeNull();
  });
});

describe("把一处命中放到视口正中", () => {
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top }) as DOMRect;

  it("命中在视口下方：滚动位置 = 当前 + 命中到视口顶的距离 - 上下留边的余量", () => {
    expect(
      scrollTopToCenter({ scrollTop: 4000, containerTop: 100, containerHeight: 600, targetTop: 5000, targetHeight: 20 }),
    ).toBe(4000 + 4900 - 290);
  });

  it("命中在视口上方：往上滚", () => {
    expect(
      scrollTopToCenter({ scrollTop: 4000, containerTop: 100, containerHeight: 600, targetTop: -400, targetHeight: 20 }),
    ).toBe(4000 - 500 - 290);
  });

  it("centerInScroller 直接写容器的滚动位置", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 600 });
    container.scrollTop = 4000;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(100, 600));
    centerInScroller(container, rect(5000, 20));
    expect(container.scrollTop).toBe(4000 + 4900 - 290);
  });
});

describe("SearchHighlightRegistry", () => {
  const setup = () => {
    const highlights = new Map<string, FakeRange[]>();
    /** `CSS.highlights.set`（上色一次 = 命中层、当前层各调一次）。 */
    const set = vi.fn((name: string, value: FakeHighlight) => {
      highlights.set(name, value.ranges);
    });
    vi.stubGlobal("StaticRange", FakeStaticRange);
    vi.stubGlobal("Highlight", FakeHighlight);
    vi.stubGlobal("CSS", { highlights: { set } });
    return { highlights, set, registry: new SearchHighlightRegistry() };
  };
  const range = (n: number) => ({ startContainer: document.createTextNode(String(n)), startOffset: 0, endContainer: null, endOffset: 0 }) as unknown as StaticRange;

  it("按全局序号取范围；当前命中不与普通命中重复", () => {
    const { highlights, registry } = setup();
    registry.setBlock("0-0", 0, [range(1), range(2)]);
    registry.setBlock("1-0", 2, [range(3)]);
    // 登记只记下来；取范围不依赖上色
    expect(registry.getMatchRange(2)).toBeDefined();
    expect(registry.getMatchRange(3)).toBeUndefined();
    registry.setCurrent(1);
    registry.flush();
    expect(highlights.get("jishu-search-match")!.length).toBe(2);
    expect(highlights.get("jishu-search-current")!.length).toBe(1);
    registry.removeBlock("0-0");
    registry.flush();
    expect(highlights.get("jishu-search-match")!.length).toBe(1);
    expect(registry.getMatchRange(0)).toBeUndefined();
  });

  it("一次提交只上色一次：多块登记 + 当前命中变化，flush 一次、上色一次；没有变化时 flush 什么都不做", () => {
    const { highlights, set, registry } = setup();
    registry.setBlock("0-0", 0, [range(1)]);
    registry.setBlock("1-0", 1, [range(2), range(3)]);
    registry.setBlock("2-0", 3, [range(4)]);
    registry.setCurrent(2);
    expect(set).not.toHaveBeenCalled();
    registry.flush();
    // 命中层、当前层各一次
    expect(set).toHaveBeenCalledTimes(2);
    expect(highlights.get("jishu-search-match")!.length).toBe(3);
    expect(highlights.get("jishu-search-current")!.length).toBe(1);
    registry.flush();
    expect(set).toHaveBeenCalledTimes(2);
    registry.setCurrent(3);
    registry.flush();
    expect(set).toHaveBeenCalledTimes(4);
    expect(highlights.get("jishu-search-current")!.length).toBe(1);
  });

  it("sync：按登记的现状重新上色；登记清空后撤掉全部高亮", () => {
    const { highlights, set, registry } = setup();
    registry.setBlock("0-0", 0, [range(1)]);
    registry.setCurrent(0);
    registry.sync();
    expect(set).toHaveBeenCalledTimes(2);
    expect(highlights.get("jishu-search-current")!.length).toBe(1);
    // 各文字块注销后（视图卸载）：高亮撤干净
    registry.removeBlock("0-0");
    registry.sync();
    expect(highlights.get("jishu-search-match")!.length).toBe(0);
    expect(highlights.get("jishu-search-current")!.length).toBe(0);
    expect(registry.getMatchRange(0)).toBeUndefined();
  });
});

describe("页面文字", () => {
  it("参与搜索的文字节点按先后拼起来；按钮与 data-no-search 的文字不在其中", () => {
    const root = mount("<p>正文<button>复制</button><span data-no-search=''>占位</span><span>尾部</span></p>");
    expect(pageText(root)).toBe("正文尾部");
  });
});

/**
 * 高亮与文字选区叠加的样式契约（v0.9.8 评审修复轮 R2）。
 * jsdom 不加载样式表，这里直接读样式表：选区画在搜索命中上面，选中的字用最上面那层
 * 高亮自己的颜色重画——消息区的选区必须自带成对的颜色，当前命中要有底色之外的标记。
 */
describe("高亮样式（index.css 静态契约）", () => {
  const css = readFileSync(join(__dirname, "..", "..", "index.css"), "utf-8");
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, `缺少规则 ${selector}`).toBeGreaterThanOrEqual(0);
    const end = css.indexOf("}", start);
    return css.slice(start, end);
  };

  it("消息区的文字选区同时声明了底色与字色", () => {
    const selection = rule(".message-stream ::selection");
    expect(selection).toMatch(/background-color\s*:/);
    expect(selection).toMatch(/[^-]color\s*:/);
  });

  it("当前命中带下划线标记与下划线颜色；普通命中与当前命中都自带字色", () => {
    const current = rule("::highlight(jishu-search-current)");
    expect(current).toMatch(/text-decoration\s*:\s*underline/);
    expect(current).toMatch(/text-decoration-color\s*:/);
    for (const name of ["jishu-search-match", "jishu-search-current"]) {
      expect(rule(`::highlight(${name})`)).toMatch(/[^-]color\s*:/);
    }
  });
});
