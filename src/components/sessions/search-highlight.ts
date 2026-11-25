/**
 * 会话内搜索高亮——「渲染后标黄」（v0.9.8 需求23）。
 *
 * 做法：正文照常渲染成 Markdown，之后在渲染好的页面文字里找关键词，把每处
 * 命中登记成一个文字范围（StaticRange），交给浏览器的 CSS Custom Highlight
 * API 上色（样式见 index.css 的 `::highlight(jishu-search-match)`）。
 *
 * 为什么这样：原先搜索态把正文退回 Markdown 源码、在源码上按关键词切分来加
 * <mark>，于是搜索时看到的是带 `##`、`**`、竖线的源码。要「正常渲染 + 高亮」
 * 又不能去拆分 React 渲染出来的文字节点（拆过之后 React 再更新那段文字会出
 * 重复）。高亮 API 只登记范围、不动页面结构，两个问题一起避开；关键词变化时
 * 只重算范围，Markdown 不重新解析。
 *
 * 高亮 API 不可用时（极旧的内核；测试环境默认没有）由调用方回落到原有的
 * 「源码切分」方式。
 */
import { escapeRegExp } from "@/lib/session-search-text";

const MATCH_HIGHLIGHT = "jishu-search-match";
const CURRENT_HIGHLIGHT = "jishu-search-current";

/** 当前环境是否支持 CSS Custom Highlight API。 */
export function supportsTextHighlight(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof Highlight !== "undefined" &&
    typeof StaticRange !== "undefined" &&
    typeof CSS !== "undefined" &&
    typeof CSS.highlights?.set === "function"
  );
}

/** 不参与高亮的界面装饰：按钮文字、读屏文字、脚本样式。 */
const SKIP_SELECTOR = "button, script, style, .sr-only, [data-no-search]";

/**
 * 在 root 的可见文字里找出每一处命中，返回对应的文字范围（按出现先后）。
 * 先把所有文字节点拼成一整串再匹配：关键词即使跨了节点（粗体、行内代码、
 * 代码高亮的片段之间）也能命中，每一段各得一个范围。
 */
export function findMatchRanges(root: Node, query: string): StaticRange[] {
  if (!query.trim() || typeof document === "undefined") return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let total = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    starts.push(total.length);
    total += n.nodeValue ?? "";
    nodes.push(n as Text);
  }
  const ranges: StaticRange[] = [];
  if (!nodes.length) return ranges;
  const regex = new RegExp(escapeRegExp(query), "gi");
  const locate = (offset: number): [Text, number] => {
    // 找到包含 offset 的文字节点（offset 恰在节点末尾时归前一个节点）
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo], offset - starts[lo]];
  };
  for (const match of total.matchAll(regex)) {
    const start = locate(match.index ?? 0);
    const end = locate((match.index ?? 0) + match[0].length);
    try {
      ranges.push(
        new StaticRange({
          startContainer: start[0],
          startOffset: start[1],
          endContainer: end[0],
          endOffset: end[1],
        }),
      );
    } catch {
      // 范围无效（节点在匹配过程中被替换）——跳过这一处
    }
  }
  return ranges;
}

/**
 * 一处命中在页面上的位置。
 *
 * StaticRange 没有量位置的方法（只有 Range 有 getBoundingClientRect）——这里用
 * 同一组起止点临时建一个 Range 来量，量完即弃。行还没排版（在视口外）时返回的
 * 矩形宽高都是 0；起止点已经失效（那段文字被替换掉了）也按「量不到」处理。
 */
export function rectOfMatch(range: StaticRange): DOMRect | null {
  try {
    const probe = document.createRange();
    probe.setStart(range.startContainer, range.startOffset);
    probe.setEnd(range.endContainer, range.endOffset);
    const rect = probe.getBoundingClientRect();
    return rect;
  } catch {
    return null;
  }
}

/**
 * 把一处命中放到滚动容器正中间所需的滚动位置。
 * 命中在视口里偏低就往下滚、偏高就往上滚；内容不足一屏时结果超出范围，
 * 浏览器会收到合法位置。
 */
export function scrollTopToCenter(input: {
  scrollTop: number;
  containerTop: number;
  containerHeight: number;
  targetTop: number;
  targetHeight: number;
}): number {
  return input.scrollTop + (input.targetTop - input.containerTop) - (input.containerHeight - input.targetHeight) / 2;
}

/** 立即（不平滑）把 target 放到 container 正中间。 */
export function centerInScroller(container: HTMLElement, target: DOMRect): void {
  const box = container.getBoundingClientRect();
  container.scrollTop = scrollTopToCenter({
    scrollTop: container.scrollTop,
    containerTop: box.top,
    containerHeight: container.clientHeight,
    targetTop: target.top,
    targetHeight: target.height,
  });
}

/**
 * 一个会话视图的高亮登记处。各文字块把自己的范围登记进来（带全局起始序号），
 * 这里负责汇总并真正上色；当前命中（上一处 / 下一处）单独一层颜色。
 */
export class SearchHighlightRegistry {
  private blocks = new Map<string, { base: number; ranges: StaticRange[] }>();
  private current = -1;
  private indexed: Map<number, StaticRange> | null = null;

  setBlock(key: string, baseOffset: number, ranges: StaticRange[]): void {
    this.blocks.set(key, { base: baseOffset, ranges });
    this.indexed = null;
    this.apply();
  }

  removeBlock(key: string): void {
    if (!this.blocks.delete(key)) return;
    this.indexed = null;
    this.apply();
  }

  setCurrent(index: number): void {
    if (this.current === index) return;
    this.current = index;
    this.apply();
  }

  /** 全局第 index 处命中对应的文字范围；没有（比如那一处落在没渲染出来的内容里）返回 undefined。 */
  getMatchRange(index: number): StaticRange | undefined {
    return this.byIndex().get(index);
  }

  private byIndex(): Map<number, StaticRange> {
    if (this.indexed) return this.indexed;
    const map = new Map<number, StaticRange>();
    for (const { base, ranges } of this.blocks.values()) {
      ranges.forEach((range, k) => {
        if (!map.has(base + k)) map.set(base + k, range);
      });
    }
    this.indexed = map;
    return map;
  }

  private apply(): void {
    if (!supportsTextHighlight()) return;
    const all: StaticRange[] = [];
    let current: StaticRange | undefined;
    for (const [index, range] of this.byIndex()) {
      if (index === this.current) current = range;
      else all.push(range);
    }
    CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...all));
    CSS.highlights.set(CURRENT_HIGHLIGHT, new Highlight(...(current ? [current] : [])));
  }
}
