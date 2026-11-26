import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMessageSearch } from "./use-message-search";
import { searchSessions } from "@/lib/session-search";
import type { Message, Session } from "@/types";

/** v0.9.0 需求7 D 域拆分契约锁定：搜索状态组行为与拆分前一致（纯移动）。 */

// 评审修复轮 R2：包一层可断言的替身，实现仍是真实的搜索——用例要看「传进
// 搜索的列表是什么」。
vi.mock("@/lib/session-search", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/session-search")>();
  return { ...orig, searchSessions: vi.fn(orig.searchSessions) };
});

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

// ── v0.9.8 评审修复轮 R2（S-18）：侧栏搜索与正文用同一份可见消息 ───────────

/** 一条不可见的用户消息：注入的方法论全文（display:false 但仍写进了会话）。 */
const invisible = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 3,
});

describe("useMessageSearch 评审修复轮 R2：可见消息过滤", () => {
  it("S18-U1 不可见的用户消息不参与搜索：命中数与正文一致，预览来自可见那条", () => {
    const mixed: Session[] = [{
      ...sessions[0],
      id: "s-mixed",
      messages: [
        invisible("[JISHU-TASK:research] 调研鉴权方案的说明……鉴权"),
        { role: "user", content: [{ type: "text", text: "登录功能的鉴权怎么设计", tool_ids: [] }], timestamp: 2 },
      ],
    }];
    const { result, rerender } = render({ sessions: mixed, selectedSession: "s-mixed" });
    act(() => result.current.setQuery("鉴权"));
    rerender({ sessions: mixed, selectedSession: "s-mixed" });

    expect(result.current.searchResults).toHaveLength(1);
    // 不可见那条里「鉴权」出现两次，可见那条一次——只数可见的
    expect(result.current.searchResults[0].matchCount).toBe(1);
    expect(result.current.searchResults[0].previewText).toContain("登录功能的鉴权怎么设计");
  });

  it("S18-U2 没有不可见消息的会话：传进搜索的就是原列表项（不另建一份）", () => {
    const withInvisible: Session = {
      ...sessions[0],
      id: "s-mixed",
      messages: [invisible("[JISHU-TASK:research] 鉴权"), sessions[0].messages[0]],
    };
    const list = [sessions[0], withInvisible, sessions[1]];
    const { result, rerender } = render({ sessions: list, selectedSession: "s1" });
    act(() => result.current.setQuery("鉴权"));
    rerender({ sessions: list, selectedSession: "s1" });

    const searchCalls = vi.mocked(searchSessions).mock.calls;
    const passed = searchCalls[searchCalls.length - 1]?.[0] ?? [];
    expect(passed[0]).toBe(sessions[0]); // 全部可见：原对象
    expect(passed[2]).toBe(sessions[1]);
    expect(passed[1]).not.toBe(withInvisible); // 含不可见消息：换成过滤后的那一份
    expect(passed[1].messages).toEqual([sessions[0].messages[0]]);
  });
});
