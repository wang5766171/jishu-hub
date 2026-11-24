/**
 * v0.9.8 需求9 D9-3/D9-4：重试成功判定（紧档规则，直播与回放共用单一实现
 * ——两处分叉即双标，单测锁行为）。
 *
 * 规则（紧档）：对每张 error 调用卡，检查其**之后的第一张同名调用**——
 * 那张 success 才翻绿（标 retriedSuccess）；若其后第一张同名也是失败，
 * 或再无同名调用，则不翻。宽档（失败后任意后续同名成功即翻）废弃——
 * bash 类通用工具「换了目的跑成功」不再洗白前面的失败。
 *
 * 直播（use-stream-store tool_use_result 增量重算）与回放（message-view
 * 有序调用序列）共用本函数。
 */
export interface RetryFlagCall {
  id: string;
  name: string;
  /** true = 失败；false = 成功；undefined = **尚无结果**（直播中还在运行）。
   * v0.9.8 评审修复轮 R1-3：运行中不算成功——「之后第一张同名调用 success
   * 才翻」里的 success 必须是已出结果的成功。此前直播侧把它折算成 false
   * 喂进来，重跑还在执行时失败卡就提前翻绿。 */
  isError: boolean | undefined;
}

export function computeRetriedSuccessFlags(calls: RetryFlagCall[]): Set<string> {
  const flags = new Set<string>();
  // 逆向扫描：nextIdx[i] = i 之后第一张同名调用的下标（无则 -1）。
  const nextIdx = new Array<number>(calls.length).fill(-1);
  const lastSeen = new Map<string, number>();
  for (let i = calls.length - 1; i >= 0; i--) {
    const seen = lastSeen.get(calls[i].name);
    nextIdx[i] = seen === undefined ? -1 : seen;
    lastSeen.set(calls[i].name, i);
  }
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].isError !== true) continue;
    const j = nextIdx[i];
    // 紧档：其后第一张同名调用必须**已出结果且成功**。那张还在运行时
    // 结果未知——不翻（等它出结果后重算：成功则翻、失败则不翻）。
    if (j > i && calls[j].isError === false) flags.add(calls[i].id);
  }
  return flags;
}
