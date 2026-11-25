/**
 * use-search-lens —— 搜索态下「哪个会话正被折叠显示、打开会话要不要落到命中处」
 *（v0.9.8 需求23）。
 *
 * 搜索态只显示命中行，视图位置的含义随之改变。两处要知道这件事：
 * - 打开会话：在当前搜索词下有命中的会话，视图落到第一处命中（不是底部）——
 *   发一个「搜索跳转」信号给消息视图，由它当帧定位；
 * - 离开会话：搜索态下看到的像素位置在完整列表里没有意义，不记进滚动记忆。
 *
 * 「打开会话后视图落在哪」只有这一处决定：有命中 → 命中处；没有 → 照旧到底/恢复。
 * 此前两方各管各的（打开一律滚到底并逐帧贴底跟随，搜索导航 120ms 后平滑滚到
 * 命中处），搜索态下点搜索结果时贴底跟随每帧把视图拉回底部，命中留在屏幕外。
 *
 * 输入经 ref 传入：搜索域（useMessageSearch）在页面里声明得比滚动系统、任务会话
 * 加载晚，页面在渲染期间把本轮的搜索词、当前会话、命中会话写进 ref；这里的函数
 * 都在事件与副作用里调用（渲染完成后），读到的是本轮的值。
 */
import { useCallback, startTransition, useRef, useState, type RefObject } from "react";
import type { SearchJump } from "@/components/sessions/message-view";

/**
 * 「进入会话」（需求23 补充轮）的提交方式：清空搜索词与打开会话放进**同一次非紧急更新**。
 *
 * 消息视图里的搜索词是「延迟生效」的（useDeferredValue）：紧急更新时它慢一拍，仍显示上一个
 * 搜索词。若两步各走各的，新会话会先以搜索视角出现一帧，再展开——落位会被这一帧带偏
 *（先按折叠的列表滚到底，列表展开后位置就不对了）。非紧急更新里延迟生效的值不慢这一拍，
 * 新会话从第一帧起就是完整视图。
 */
export function commitEnterSession(clearSearch: () => void, openSession: () => void): void {
  startTransition(() => {
    clearSearch();
    openSession();
  });
}

export interface SearchLensInput {
  /** 搜索词（未延迟的那份，与消息视图收到的同一个）。 */
  query: string;
  selectedSession: string | null;
  /** 侧栏搜索结果里的会话 id（没有搜索词时为空集）。 */
  hitSessionIds: ReadonlySet<string>;
}

export function useSearchLens(inputRef: RefObject<SearchLensInput>) {
  const [searchJump, setSearchJump] = useState<SearchJump | null>(null);
  // 序号只增不减：信号撤掉后下一次不能从头数——消息视图按「序号见过了」认旧信号，
  // 从头数会撞上它记着的上一个序号，把新跳转当成旧的跳过。
  const jumpNonceRef = useRef(0);

  /** 该会话此刻正以搜索态（只显示命中行）显示着。停在新对话页时没有会话被显示。 */
  const isInSearchLens = useCallback(
    (sessionId: string) =>
      sessionId !== "new" &&
      !!inputRef.current.query.trim() &&
      inputRef.current.selectedSession === sessionId,
    [inputRef],
  );
  /** 打开该会话时视图落到第一处命中。 */
  const landsOnSearchHit = useCallback(
    (sessionId: string) => inputRef.current.hitSessionIds.has(sessionId),
    [inputRef],
  );
  /** 请求消息视图把该会话的第一处命中定位到视口里（在它的消息就绪的同一批更新里调用）。 */
  const jumpToSearchHit = useCallback((sessionId: string) => {
    const nonce = jumpNonceRef.current + 1;
    jumpNonceRef.current = nonce;
    setSearchJump({ sessionId, nonce });
  }, []);
  /** 消息视图已处理（定位完成，或没有可定位的命中）——信号只在处理前存在。 */
  const finishSearchJump = useCallback(() => setSearchJump(null), []);

  return { isInSearchLens, landsOnSearchHit, searchJump, jumpToSearchHit, finishSearchJump };
}
