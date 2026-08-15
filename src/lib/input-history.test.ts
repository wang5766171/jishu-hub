import { describe, it, expect, beforeEach } from "vitest";
import {
  getInputHistory,
  pushInputHistory,
  getSessionDraft,
  setSessionDraft,
} from "./input-history";

describe("input-history", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("push 按最新在前去重累积", () => {
    pushInputHistory("proj-1", "第一条");
    pushInputHistory("proj-1", "第二条");
    expect(getInputHistory("proj-1")).toEqual(["第二条", "第一条"]);

    // 重复发送同一内容：移到最前而非重复入列
    pushInputHistory("proj-1", "第一条");
    expect(getInputHistory("proj-1")).toEqual(["第一条", "第二条"]);
  });

  it("空内容与空项目不入历史", () => {
    pushInputHistory("proj-1", "   ");
    pushInputHistory(null, "有内容");
    expect(getInputHistory("proj-1")).toEqual([]);
    expect(getInputHistory(null)).toEqual([]);
  });

  it("历史上限 100 条", () => {
    for (let i = 0; i < 120; i++) {
      pushInputHistory("proj-1", `消息-${i}`);
    }
    const list = getInputHistory("proj-1");
    expect(list).toHaveLength(100);
    expect(list[0]).toBe("消息-119");
    expect(list[99]).toBe("消息-20");
  });

  it("项目之间历史隔离", () => {
    pushInputHistory("proj-1", "a");
    pushInputHistory("proj-2", "b");
    expect(getInputHistory("proj-1")).toEqual(["a"]);
    expect(getInputHistory("proj-2")).toEqual(["b"]);
  });

  it("草稿写入/读取/清空", () => {
    setSessionDraft("proj-1:s1", "未发送的内容");
    expect(getSessionDraft("proj-1:s1")).toBe("未发送的内容");
    expect(getSessionDraft("proj-1:s2")).toBe("");

    setSessionDraft("proj-1:s1", "");
    expect(getSessionDraft("proj-1:s1")).toBe("");
  });

  it("损坏的历史 JSON 静默降级为空", () => {
    localStorage.setItem("jishu-hub:input-history:proj-1", "{not json");
    expect(getInputHistory("proj-1")).toEqual([]);
  });
});
