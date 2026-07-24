import { describe, expect, it } from "vitest";

import { shouldRenderGlobalChatInput } from "./chat-page-layout";

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
