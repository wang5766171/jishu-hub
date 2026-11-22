// v0.9.8 需求13 复测取证：缓存总闸指纹（userFingerprints）与缓存行为锚定。
import { describe, expect, it } from "vitest";

import type { Message } from "@/types";
import {
  deleteCachedSessionMessages,
  getCachedSessionMessages,
  setCachedSessionMessages,
  userFingerprints,
} from "./session-cache";

function userMsg(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text, tool_ids: [] }],
    timestamp: 1,
  };
}

function assistantMsg(): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: "回复" }],
    timestamp: 2,
  };
}

describe("session-cache（需求13 复测取证）", () => {
  it("U-RC1: 指纹统计——同文本多份 uniq<total，其余各计一份", () => {
    const fp = userFingerprints([
      userMsg("复测窗口期停止-第1轮"),
      assistantMsg(),
      userMsg("再发验证-1"),
      userMsg("复测窗口期停止-第1轮"),
    ]);
    expect(fp.total).toBe(3);
    expect(fp.uniq).toBe(2);
    expect(fp.fps).toEqual(["复测窗口期停止-第1轮".slice(0, 12), "再发验证-1", "复测窗口期停止-第1轮".slice(0, 12)]);
  });

  it("U-RC2: 无 user / 指纹取首个 text block 并截断 12 字", () => {
    expect(userFingerprints([assistantMsg()])).toEqual({ total: 0, uniq: 0, fps: [] });
    const long = userFingerprints([userMsg("一二三四五六七八九十一二三四五")]);
    expect(long.fps[0].length).toBe(12);
  });

  it("U-RC3: 缓存写入/读取/删除行为不因埋点改变", () => {
    const key = `req13-test-${Date.now()}`;
    const list = [userMsg("标记消息"), assistantMsg()];
    setCachedSessionMessages(key, list);
    expect(getCachedSessionMessages(key)).toBe(list);
    deleteCachedSessionMessages(key);
    expect(getCachedSessionMessages(key)).toBeUndefined();
  });
});
