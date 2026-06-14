import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationInteractionRequest } from "@/types";
import { ChatInput } from "./chat-input";

const invokeCommand = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

vi.mock("@/hooks/use-stream-store", () => ({
  streamStore: {
    start: vi.fn(),
    alias: vi.fn(),
    getState: vi.fn(),
    drop: vi.fn(),
  },
  useIsSessionStreaming: () => false,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const request: ConversationInteractionRequest = {
  requestId: "req-chat-1",
  prompt: "请选择实现顺序",
  options: [
    { optionId: "frontend", label: "前端优先" },
    { optionId: "backend", label: "后端优先" },
  ],
  allowMultiple: false,
  allowCustomText: true,
  required: true,
};

describe("ChatInput interaction submission", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh");
  });

  beforeEach(() => {
    invokeCommand.mockReset();
    invokeCommand.mockResolvedValue({
      agent_id: "codex",
      session_id: "session-1",
      process_id: 1,
    });
  });

  it("submits a structured choice to the current regular session", async () => {
    const onInteractionSubmitted = vi.fn();
    render(
      <ChatInput
        sessionId="session-1"
        projectPath={"D:\\project"}
        interactionRequest={request}
        onInteractionSubmitted={onInteractionSubmitted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /后端优先/ }));
    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "接口先稳定" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("send_message", {
        projectPath: "D:\\project",
        sessionId: "session-1",
        message: expect.stringContaining("后端优先"),
      });
    });

    const message = invokeCommand.mock.calls[0][1].message as string;
    expect(message).toContain("接口先稳定");
    expect(message).not.toContain("req-chat-1");
    expect(onInteractionSubmitted).toHaveBeenCalledWith("req-chat-1");
  });
});
