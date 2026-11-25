/**
 * 页面搜索态钩子单测——v0.9.8 需求23，对应 tests/06-测试清单：
 * S23-U16 有命中的会话才落到命中处；S23-U17 跳转信号成对；S23-U18 哪个会话在折叠显示；
 * S23-U29 「进入会话」的提交方式（清空搜索词与切会话落在同一次提交里，延迟生效的搜索词不慢一拍）。
 *
 * 输入经 ref 传入（页面在渲染期间写入）——测试里直接改 ref 模拟。
 */
import { act, render, renderHook } from "@testing-library/react";
import { useDeferredValue, useLayoutEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import { commitEnterSession, useSearchLens, type SearchLensInput } from "./use-search-lens";

const input: { current: SearchLensInput } = {
  current: { query: "", selectedSession: null, hitSessionIds: new Set() },
};

function mount() {
  return renderHook(() => useSearchLens(input));
}

const setInput = (patch: Partial<SearchLensInput>) => {
  input.current = { ...input.current, ...patch };
};

describe("useSearchLens", () => {
  it("搜索结果里的会话才是「打开时落到命中处」的目标；没有搜索词时没有目标", () => {
    const { result } = mount();
    setInput({ query: "关键词", selectedSession: "s1", hitSessionIds: new Set(["s1", "s3"]) });
    expect(result.current.landsOnSearchHit("s1")).toBe(true);
    expect(result.current.landsOnSearchHit("s2")).toBe(false);
    // 没有搜索词时搜索结果为空——谁都不到命中处
    setInput({ query: "", hitSessionIds: new Set() });
    expect(result.current.landsOnSearchHit("s1")).toBe(false);
  });

  it("跳转信号：目标会话 + 递增序号；处理完撤掉", () => {
    const { result } = mount();
    expect(result.current.searchJump).toBeNull();
    act(() => {
      result.current.jumpToSearchHit("s2");
    });
    expect(result.current.searchJump).toEqual({ sessionId: "s2", nonce: 1 });
    act(() => {
      result.current.jumpToSearchHit("s3");
      result.current.jumpToSearchHit("s3");
    });
    expect(result.current.searchJump).toEqual({ sessionId: "s3", nonce: 3 });
    act(() => {
      result.current.finishSearchJump();
    });
    expect(result.current.searchJump).toBeNull();
    // 撤掉之后再跳，序号接着涨（消息视图按序号认「新信号」）
    act(() => {
      result.current.jumpToSearchHit("s3");
    });
    expect(result.current.searchJump).toEqual({ sessionId: "s3", nonce: 4 });
  });

  it("正以搜索态显示的会话：有搜索词且就是当前会话；停在新对话或没有搜索词时都不是", () => {
    const { result } = mount();
    setInput({ query: "关键词", selectedSession: "s1", hitSessionIds: new Set(["s1"]) });
    expect(result.current.isInSearchLens("s1")).toBe(true);
    expect(result.current.isInSearchLens("s2")).toBe(false);
    setInput({ selectedSession: "new" });
    expect(result.current.isInSearchLens("new")).toBe(false);
    setInput({ selectedSession: null });
    expect(result.current.isInSearchLens("s1")).toBe(false);
    setInput({ query: "   ", selectedSession: "s1" });
    expect(result.current.isInSearchLens("s1")).toBe(false);
  });
});

describe("commitEnterSession · 「进入会话」的提交方式", () => {
  /** 探针：会话名 + 延迟生效的搜索词（与消息视图同样的用法）；每次提交记一笔「会话:延迟生效的搜索词」。 */
  const mountProbe = () => {
    const commits: string[] = [];
    const api: { setQuery?: (v: string) => void; setSession?: (v: string) => void } = {};
    function Probe() {
      const [query, setQuery] = useState("关键词");
      const [session, setSession] = useState("a");
      const deferred = useDeferredValue(query);
      api.setQuery = setQuery;
      api.setSession = setSession;
      useLayoutEffect(() => {
        commits.push(`${session}:${deferred}`);
      });
      return <span>{session}</span>;
    }
    render(<Probe />);
    commits.length = 0;
    return { commits, api: api as { setQuery: (v: string) => void; setSession: (v: string) => void } };
  };

  it("清空搜索词与切到新会话落在同一次提交里，延迟生效的搜索词不慢一拍——S23-U29", () => {
    const { commits, api } = mountProbe();
    act(() => {
      commitEnterSession(() => api.setQuery(""), () => api.setSession("b"));
    });
    // 新会话从第一帧起就没有搜索词（只提交一次）——不会先以搜索视角出现一帧
    expect(commits).toEqual(["b:"]);
  });

  it("对照：两步各走各的（紧急更新）时，新会话先带着旧搜索词出现一帧", () => {
    const { commits, api } = mountProbe();
    act(() => {
      api.setQuery("");
      api.setSession("b");
    });
    expect(commits[0]).toBe("b:关键词");
    expect(commits[commits.length - 1]).toBe("b:");
  });
});
