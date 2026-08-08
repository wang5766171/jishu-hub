import { describe, expect, it } from "vitest";

import { resolvePhaseSessionId, shouldRenderGlobalChatInput } from "./chat-page-layout";

describe("shouldRenderGlobalChatInput", () => {
  it("hides the global input while the task phase container is active", () => {
    expect(shouldRenderGlobalChatInput({
      projectId: "demo",
      taskModeActive: true,
    })).toBe(false);
  });

  it("renders the global input for normal project chat", () => {
    expect(shouldRenderGlobalChatInput({
      projectId: "demo",
      taskModeActive: false,
    })).toBe(true);
  });
});

describe("resolvePhaseSessionId", () => {
  const instance = {
    requirement_session_id: "req-1",
    planning_session_id: "plan-1",
  };

  it("requirements 阶段用需求会话", () => {
    expect(resolvePhaseSessionId(instance, "requirements")).toBe("req-1");
  });

  it("planning 阶段用规划会话", () => {
    expect(resolvePhaseSessionId(instance, "planning")).toBe("plan-1");
  });

  it("execution 阶段沿用 conductor 会话而不是清空（P1 白屏回归）", () => {
    expect(resolvePhaseSessionId(instance, "execution")).toBe("plan-1");
  });

  it("无规划会话时回退需求会话", () => {
    expect(
      resolvePhaseSessionId({ requirement_session_id: "req-1", planning_session_id: null }, "execution"),
    ).toBe("req-1");
  });

  it("两个会话都缺失时返回 null", () => {
    expect(resolvePhaseSessionId({}, "execution")).toBeNull();
    expect(resolvePhaseSessionId(null, "execution")).toBeNull();
  });
});
