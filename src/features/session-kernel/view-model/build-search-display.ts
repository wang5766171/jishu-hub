/**
 * 搜索态的显示条目（v0.9.8 需求23）：只保留含命中的行，其余行折成细条。
 *
 * 搜索时正文区不再把整个会话都渲染出来——渲染量只跟命中数有关，跟会话长度
 * 无关（长对话安全检索的前提）。被省略的行原位置放一条「省略了 N 条消息」
 * 的细条（最前面、中间、最后各一种说法），让用户知道上下文还在。
 */
export type SearchGapPosition = "before" | "middle" | "after";

export type SearchDisplayItem<Row> =
  | { kind: "row"; row: Row }
  /**
   * `position`：细条在第一个命中之前、两个命中之间、还是最后一个命中之后；
   * `before` = 细条之前最后一条显示出来的行的下标（作 React key，最前面的细条为 -1）；
   * `count` = 省略了几行。
   */
  | { kind: "gap"; position: SearchGapPosition; before: number; count: number };

export function buildSearchDisplayItems<Row extends { messageIndices: readonly number[] }>(
  rows: readonly Row[],
  hitMessages: ReadonlySet<number>,
): SearchDisplayItem<Row>[] {
  const items: SearchDisplayItem<Row>[] = [];
  let gapCount = 0;
  let gapBefore = -1;
  let shownAny = false;
  const flushGap = (position: SearchGapPosition) => {
    if (gapCount > 0) items.push({ kind: "gap", position, before: gapBefore, count: gapCount });
    gapCount = 0;
  };
  rows.forEach((row, index) => {
    const hit = row.messageIndices.some((messageIndex) => hitMessages.has(messageIndex));
    if (hit) {
      flushGap(shownAny ? "middle" : "before");
      items.push({ kind: "row", row });
      shownAny = true;
      gapBefore = index;
    } else {
      gapCount += 1;
    }
  });
  // 一个命中都没有时不折细条（调用方显示「没有找到」）
  if (shownAny) flushGap("after");
  return items;
}
