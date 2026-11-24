/**
 * v0.9.8 评审修复轮 R1-4：回合归属判定（纯函数，单测锁行为）。
 *
 * 背景：「回合结束」事件不带回合身份——前端把任何到达的结束事件都当作
 * **当前流**的终结者。同一会话键上先后有两个回合时（用户点停止后立刻
 * 重发），旧回合迟到的「已中止」回执就被当成了新回合的终结者：新回合的
 * 半截回复被提前提交、流被移除、新回合的引导队列被当僵尸清空。
 *
 * 判定依据全部来自前端自己记下的回合事实（不做时间猜测）：
 *  - 停止时，`abortLocalCommitRef` 记下「令牌为 T 的回合已本地提交、
 *    终结者尚未到达」（标记 = T）；
 *  - 新回合开始（`streamStore.start`）铸出新令牌 T'（单调递增）；
 *  - 引擎在取消善期把后继消息缓冲，**先发旧回合的终结回执、之后才送达
 *    新消息**——所以旧回执到达时，新回合的流还没有任何回合内容。
 */

/** 判定所需的流内容快照（`SessionStreamState` 结构兼容）。 */
export interface TurnContentSnapshot {
  content: unknown[];
  text: string;
  thinking: string;
  tools: unknown[];
  steps: unknown[];
  steerTexts: string[];
}

/** 当前流是否已有任何回合内容（回复/思考/工具/步骤/注入的引导）。 */
export function streamHasTurnContent(state: TurnContentSnapshot | null | undefined): boolean {
  if (!state) return false;
  return (
    state.content.length > 0
    || state.text !== ""
    || state.thinking !== ""
    || state.tools.length > 0
    || state.steps.length > 0
    || state.steerTexts.length > 0
  );
}

/**
 * 这个「已中止」回执是否属于**已被取代的旧回合**（当前流不是它的收口
 * 对象）。成立需同时满足：
 *  1. 回执是中止回执；
 *  2. 标记里存着一个回合令牌，且 ≠ 当前流令牌——那个回合已本地提交、
 *     终结者一直没到；
 *  3. 当前流还没有任何回合内容——新回合尚未开始。
 *
 * 第 3 条同时排除误伤：标记是陈旧残留（上一回合终结者丢失）而当前回合
 * 自己也以中止收场时，当前流已有内容——照常收口。
 *
 * @param markerTokens 该会话各键（真实 id / 临时键）上的本地提交标记
 */
export function isSupersededAbort(
  reason: string,
  currentTurnToken: number | null,
  markerTokens: Array<number | undefined>,
  state: TurnContentSnapshot | null | undefined,
): boolean {
  if (reason !== "Aborted" || currentTurnToken === null) return false;
  const superseded = markerTokens.some(
    (token) => token !== undefined && token !== currentTurnToken,
  );
  return superseded && !streamHasTurnContent(state);
}
