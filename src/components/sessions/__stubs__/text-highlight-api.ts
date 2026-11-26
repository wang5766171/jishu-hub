/**
 * 文字高亮接口（CSS Custom Highlight API）的最小替身——测试环境（jsdom）默认没有。
 * 装上它，消息视图就走「正文正常渲染 + 渲染后标黄」这条主路径。
 *
 * 与真实浏览器一致：StaticRange 只有起止点，没有量位置的方法；Highlight 是一个
 * 可以逐个加入范围的集合。
 */
import { vi } from "vitest";

export type FakeRange = { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number };

export class FakeStaticRange implements FakeRange {
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

export class FakeHighlight {
  ranges: FakeRange[] = [];
  add(range: FakeRange): void {
    this.ranges.push(range);
  }
}

export interface TextHighlightApiFake {
  /** 两层高亮当前登记的范围：jishu-search-match（命中）/ jishu-search-current（当前命中）。 */
  highlights: Map<string, FakeHighlight>;
  /** `CSS.highlights.set` 被调用的次数（上色一次调用两次）。 */
  setCalls: () => number;
}

/**
 * 装上替身。调用方在 afterEach 里 `vi.unstubAllGlobals()`。
 */
export function stubTextHighlightApi(): TextHighlightApiFake {
  const highlights = new Map<string, FakeHighlight>();
  const set = vi.fn((name: string, value: FakeHighlight) => {
    highlights.set(name, value);
  });
  const existing = (globalThis as { CSS?: object }).CSS;
  vi.stubGlobal("StaticRange", FakeStaticRange);
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { ...(existing ?? {}), highlights: { set } });
  return { highlights, setCalls: () => set.mock.calls.length };
}

/** 一段范围覆盖的文字（用真实的 Range 读；起止点落在哪个节点上不重要，覆盖了什么才重要）。 */
export function rangeText(range: FakeRange): string {
  const probe = document.createRange();
  probe.setStart(range.startContainer, range.startOffset);
  probe.setEnd(range.endContainer, range.endOffset);
  return probe.toString();
}
