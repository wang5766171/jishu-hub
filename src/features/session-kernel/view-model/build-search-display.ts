/**
 * 搜索态的显示条目（v0.9.8 需求23）：只保留含命中的行，其余行折成细条。
 *
 * 搜索时正文区不再把整个会话都渲染出来——渲染量只跟命中数有关，跟会话长度
 * 无关（长对话安全检索的前提）。被省略的行原位置放一条「省略了 N 条消息」
 * 的细条（最前面、中间、最后各一种说法），让用户知道上下文还在。
 *
 * v0.9.8 评审修复轮 R2：命中行本身也有上限。常见字在超长会话里可能每行都
 * 命中，等于把整个会话完整渲染——超出上限的命中行先不显示，末尾折成一条
 * 「还有 N 条」的条目，由调用方提供继续显示的入口。
 */
export type SearchGapPosition = "before" | "middle" | "after";

export type SearchDisplayItem<Row> =
  | { kind: "row"; row: Row }
  /**
   * `position`：细条在第一个命中之前、两个命中之间、还是最后一个命中之后；
   * `before` = 细条之前最后一条显示出来的行的下标（作 React key，最前面的细条为 -1）；
   * `count` = 省略了几行。
   */
  | { kind: "gap"; position: SearchGapPosition; before: number; count: number }
  /** 命中行超过上限：后面还有 `hidden` 条命中行没有显示（列表的最后一条）。 */
  | { kind: "more"; hidden: number };

/**
 * @param maxRows 最多显示几条命中行；省略或为 Infinity 时不设上限。
 */
export function buildSearchDisplayItems<Row extends { messageIndices: readonly number[] }>(
  rows: readonly Row[],
  hitMessages: ReadonlySet<number>,
  maxRows: number = Number.POSITIVE_INFINITY,
): SearchDisplayItem<Row>[] {
  const items: SearchDisplayItem<Row>[] = [];
  let gapCount = 0;
  let gapBefore = -1;
  let shownAny = false;
  let shownRows = 0;
  let hiddenRows = 0;
  const flushGap = (position: SearchGapPosition) => {
    if (gapCount > 0) items.push({ kind: "gap", position, before: gapBefore, count: gapCount });
    gapCount = 0;
  };
  rows.forEach((row, index) => {
    const hit = row.messageIndices.some((messageIndex) => hitMessages.has(messageIndex));
    if (!hit) {
      gapCount += 1;
      return;
    }
    if (shownRows >= maxRows) {
      // 超出上限的命中行只计数：它和它前面的非命中行都算进「还有 N 条」
      hiddenRows += 1;
      return;
    }
    flushGap(shownAny ? "middle" : "before");
    items.push({ kind: "row", row });
    shownAny = true;
    shownRows += 1;
    gapBefore = index;
  });
  // 一个命中都没有时不折细条（调用方显示「没有找到」）；有命中行没显示时列表在
  // 上限处截断，最后一条命中之后不再是「会话到此为止」，不出「后面省略」细条。
  if (shownAny && hiddenRows === 0) flushGap("after");
  if (hiddenRows > 0) items.push({ kind: "more", hidden: hiddenRows });
  return items;
}
