import { describe, it, expect } from "vitest";
import type { Message } from "@/types";
import {
  normalizeText,
  hashString,
  extractUserText,
  buildDispatchFingerprints,
  makeDispatchRoleResolver,
} from "./fingerprint";

function makeUserMessage(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: null,
  };
}

describe("normalizeText", () => {
  it("trims leading/trailing whitespace", () => {
    expect(normalizeText("  hello  ")).toBe("hello");
  });

  it("collapses internal whitespace runs to single space", () => {
    expect(normalizeText("请\n  基于   方案\n设计")).toBe("请 基于 方案 设计");
  });

  it("handles tabs and newlines uniformly", () => {
    expect(normalizeText("a\t\tb\n\nc")).toBe("a b c");
  });
});

describe("hashString", () => {
  it("is deterministic for identical input", () => {
    expect(hashString("请基于方案设计")).toBe(hashString("请基于方案设计"));
  });

  it("differs for different input", () => {
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });

  it("is stable across calls", () => {
    const a = hashString("x");
    const b = hashString("x");
    const c = hashString("x");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("extractUserText", () => {
  it("extracts text from text blocks", () => {
    const msg = makeUserMessage("干预该节点");
    expect(extractUserText(msg)).toBe("干预该节点");
  });

  it("returns empty for non-user role", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "reply" }],
      timestamp: null,
    };
    expect(extractUserText(msg)).toBe("");
  });

  it("concatenates multiple text blocks with newline", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
      timestamp: null,
    };
    expect(extractUserText(msg)).toBe("line one\nline two");
  });
});

describe("buildDispatchFingerprints + makeDispatchRoleResolver", () => {
  const dispatchPrompt = "请基于方案设计完成用户中心的接口改造";

  it("matches an exact dispatch prompt → orchestrator role", () => {
    const fps = buildDispatchFingerprints([dispatchPrompt]);
    const resolve = makeDispatchRoleResolver(fps, "任务助手");
    const msg = makeUserMessage(dispatchPrompt);
    const view = resolve(msg);
    expect(view).not.toBeNull();
    expect(view!.role).toBe("orchestrator");
    expect(view!.label).toBe("任务助手");
  });

  it("matches a prompt with only whitespace differences (normalize)", () => {
    const fps = buildDispatchFingerprints([dispatchPrompt]);
    const resolve = makeDispatchRoleResolver(fps, "任务助手");
    const msg = makeUserMessage(`  ${dispatchPrompt}  \n  `);
    expect(resolve(msg)?.role).toBe("orchestrator");
  });

  it("does not match a human-authored message", () => {
    const fps = buildDispatchFingerprints([dispatchPrompt]);
    const resolve = makeDispatchRoleResolver(fps, "任务助手");
    const msg = makeUserMessage("注意保持向后兼容");
    expect(resolve(msg)).toBeNull();
  });

  it("returns null for assistant messages (no change to default path)", () => {
    const fps = buildDispatchFingerprints([dispatchPrompt]);
    const resolve = makeDispatchRoleResolver(fps, "任务助手");
    const msg: Message = {
      role: "assistant",
      content: [{ type: "text", text: dispatchPrompt }],
      timestamp: null,
    };
    expect(resolve(msg)).toBeNull();
  });

  it("returns null for empty user text", () => {
    const fps = buildDispatchFingerprints([dispatchPrompt]);
    const resolve = makeDispatchRoleResolver(fps, "任务助手");
    const msg = makeUserMessage("");
    expect(resolve(msg)).toBeNull();
  });

  it("handles multiple attempts (fingerprint set)", () => {
    const fps = buildDispatchFingerprints([
      "请基于方案设计完成用户中心的接口改造",
      "请修复登录失败的问题",
      "请补充单元测试",
    ]);
    const resolve = makeDispatchRoleResolver(fps, "任务助手");
    expect(resolve(makeUserMessage("请修复登录失败的问题"))?.role).toBe("orchestrator");
    expect(resolve(makeUserMessage("请补充单元测试"))?.role).toBe("orchestrator");
    expect(resolve(makeUserMessage("无关的人类输入"))).toBeNull();
  });
});
