import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMessageSearch } from "./use-message-search";
import type { Session } from "@/types";

/** v0.9.0 需求7 D 域拆分契约锁定：搜索状态组行为与拆分前一致（纯移动）。 */

const sessions: Session[] = [
  {
    id: "s1",
    path: "/p/a",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "帮我调试登录功能的鉴权问题", tool_ids: [] }],
        timestamp: null,
      },
    ],
    started_at: null,
    display_name: "登录功能调试",
    last_active: null,
  },
  {
    id: "s2",
    path: "/p/b",
    messages: [],
    started_at: null,
    display_name: "数据库迁移",
    last_active: null,
  },
];

function render(opts: { sessions: Session[] | null; selectedSession: string | null }) {
  return renderHook((next = opts) => useMessageSearch(next), { initialProps: opts });
}

describe("useMessageSearch（chat-page D 域）", () => {
  it("空查询：无结果、控件隐藏", () => {
    const { result } = render({ sessions, selectedSession: "s1" });
    expect(result.current.query).toBe("");
    expect(result.current.searchResults).toEqual([]);
    expect(result.current.showMessageSearchControls).toBe(false);
    expect(result.current.label).toBe("0/0");
  });

  it("输入查询：命中过滤 + 选中真实会话时控件可见", () => {
    const { result, rerender } = render({ sessions, selectedSession: "s1" });
    act(() => result.current.setQuery("登录"));
    // deferredValue 滞后一轮渲染——补一次 rerender 收敛
    rerender({ sessions, selectedSession: "s1" });
    expect(result.current.hasSearchQuery).toBe(true);
    expect(result.current.showMessageSearchControls).toBe(true);
    expect(result.current.searchResults.map((r) => r.sessionId)).toEqual(["s1"]);
  });

  it("选中 new 会话：即便有查询控件也隐藏", () => {
    const { result } = render({ sessions, selectedSession: "new" });
    act(() => result.current.setQuery("登录"));
    expect(result.current.showMessageSearchControls).toBe(false);
  });

  it("导航回调与状态回传：nonce 递增、状态去重、隐藏时清零", () => {
    const { result } = render({ sessions, selectedSession: "s1" });
    act(() => result.current.setQuery("登录"));
    act(() => result.current.requestNavigation(1));
    expect(result.current.navigation).toEqual({ direction: 1, nonce: 1 });
    act(() => result.current.requestNavigation(-1));
    expect(result.current.navigation).toEqual({ direction: -1, nonce: 2 });
    act(() => result.current.handleStatusChange({ current: 2, total: 5 }));
    expect(result.current.total).toBe(5);
    expect(result.current.label).toBe("2/5");
    // 同值状态不触发更新（去重分支）
    act(() => result.current.handleStatusChange({ current: 2, total: 5 }));
    expect(result.current.total).toBe(5);
    // 清空查询 → 控件隐藏 → 清零 effect 生效
    act(() => result.current.setQuery(""));
    expect(result.current.total).toBe(0);
    expect(result.current.label).toBe("0/0");
  });
});
