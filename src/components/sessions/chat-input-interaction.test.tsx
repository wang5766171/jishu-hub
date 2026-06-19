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
  prompt: "Choose implementation order",
  options: [
    { optionId: "frontend", label: "Frontend first" },
    { optionId: "backend", label: "Backend first" },
  ],
  allowMultiple: false,
  allowCustomText: true,
  required: true,
};

describe("ChatInput interaction submission", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    invokeCommand.mockReset();
    invokeCommand.mockResolvedValue({
      agent_id: "codex",
      session_id: "session-1",
      process_id: 1,
    });
  });

  it("submits a structured interaction response without sending a regular chat message", async () => {
    const onInteractionSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatInput
        sessionId="session-1"
        projectPath={"D:\\project"}
        interactionRequest={request}
        onInteractionSubmit={onInteractionSubmit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Backend first/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit choice" }));

    await waitFor(() => {
      expect(onInteractionSubmit).toHaveBeenCalledWith({
        requestId: "req-chat-1",
        selectedOptionIds: ["backend"],
        customText: "",
      });
    });
    expect(invokeCommand).not.toHaveBeenCalledWith(
      "send_message",
      expect.anything(),
    );
  });

  it("allows submitting an interaction while the current turn is waiting on user input", async () => {
    const onInteractionSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatInput
        sessionId="session-1"
        projectPath={"D:\\project"}
        isSessionStreaming
        interactionRequest={request}
        onInteractionSubmit={onInteractionSubmit}
      />,
    );

    const backendOption = screen.getByRole("button", { name: /Backend first/ });
    fireEvent.click(backendOption);
    expect(backendOption).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Submit choice" }));

    await waitFor(() => {
      expect(onInteractionSubmit).toHaveBeenCalledWith({
        requestId: "req-chat-1",
        selectedOptionIds: ["backend"],
        customText: "",
      });
    });
    expect(invokeCommand).not.toHaveBeenCalledWith(
      "send_message",
      expect.anything(),
    );
  });

  it("keeps staged guide messages scoped to the active session", async () => {
    const { rerender } = render(
      <ChatInput
        sessionId="session-a"
        projectPath={"D:\\project"}
        isSessionStreaming
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "guide for A" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(screen.getByText("guide for A")).toBeInTheDocument();

    rerender(
      <ChatInput
        sessionId="session-b"
        projectPath={"D:\\project"}
        isSessionStreaming
      />,
    );

    expect(screen.queryByText("guide for A")).not.toBeInTheDocument();

    rerender(
      <ChatInput
        sessionId="session-a"
        projectPath={"D:\\project"}
        isSessionStreaming
      />,
    );

    expect(screen.getByText("guide for A")).toBeInTheDocument();
  });
});
