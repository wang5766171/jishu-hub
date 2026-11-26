/**
 * v0.9.8 评审修复轮 R2（S 域，S-11）：会话列表里某一个会话的消息替换。
 * 对应 tests/S-用例清单 S11-U1。
 */
import { describe, expect, it } from "vitest";

import type { Message, Session } from "@/types";
import { replaceSessionMessages } from "./session-list-sync";

const msg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

function session(id: string, messages: Message[]): Session {
  return { id, path: `/p/${id}`, messages, started_at: null, display_name: id, last_active: null };
}

describe("评审修复轮 R2：列表里这一个会话的消息换成给定的一份", () => {
  it("S11-U1 列表里有这个会话：只换它，其余项保持原引用", () => {
    const a = session("a", [msg("a1")]);
    const b = session("b", [msg("b1")]);
    const c = session("c", []);
    const fresh = [msg("b1"), msg("b2")];

    const next = replaceSessionMessages([a, b, c], "b", fresh);

    expect(next).toHaveLength(3);
    expect(next?.[0]).toBe(a);
    expect(next?.[2]).toBe(c);
    expect(next?.[1]).not.toBe(b);
    expect(next?.[1]?.messages).toBe(fresh);
    // 原列表不被改动
    expect(b.messages).toEqual([msg("b1")]);
  });

  it("列表里没有这个会话：返回原列表（新会话要等重读列表后才加进来）", () => {
    const list = [session("a", [])];
    expect(replaceSessionMessages(list, "not-yet", [msg("x")])).toBe(list);
  });

  it("列表还没加载（null）：仍是 null", () => {
    expect(replaceSessionMessages(null, "a", [])).toBeNull();
  });
});
