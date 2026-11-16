import i18n from "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationInteractionRequest } from "@/types";
import { ChatInput, extractToolTokens } from "./chat-input";

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
        agentId="claude-code"
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
        agentId="claude-code"
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
        agentId="claude-code"
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
        agentId="claude-code"
        isSessionStreaming
      />,
    );

    expect(screen.queryByText("guide for A")).not.toBeInTheDocument();

    rerender(
      <ChatInput
        sessionId="session-a"
        projectPath={"D:\\project"}
        agentId="claude-code"
        isSessionStreaming
      />,
    );

    expect(screen.getByText("guide for A")).toBeInTheDocument();
  });

  it("auto-sends a background session's staged guides via stagedApiRef.claimAll(sessionKey)", async () => {
    // Reproduces the core of the Route 2 fix: a session whose turn completed
    // while the user is viewing a DIFFERENT conversation must still be able to
    // claim its own staged guides. stagedApiRef methods take an explicit
    // sessionKey so they target the completed session, not the viewed one.
    const stagedApiRef: React.MutableRefObject<import("./chat-input").StagedGuideApi | null> = { current: null };
    const { rerender } = render(
      <ChatInput
        sessionId="session-a"
        projectPath={"D:\\project"}
        agentId="claude-code"
        isSessionStreaming
        stagedApiRef={stagedApiRef}
      />,
    );

    // Stage a guide in session A while it is streaming.
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "guide for A" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(screen.getByText("guide for A")).toBeInTheDocument();

    // Switch the viewed session to B. A's staging UI disappears but its staged
    // messages remain in the partitioned store.
    rerender(
      <ChatInput
        sessionId="session-b"
        projectPath={"D:\\project"}
        agentId="claude-code"
        isSessionStreaming
        stagedApiRef={stagedApiRef}
      />,
    );
    expect(screen.queryByText("guide for A")).not.toBeInTheDocument();

    // A's turn completes while viewing B. Route 2 claims A's guides by key.
    expect(stagedApiRef.current).not.toBeNull();
    let claimed = await act(async () => stagedApiRef.current!.claimAll("session-a"));
    expect(claimed.map((m) => m.content)).toEqual(["guide for A"]);

    // Re-claiming the same session yields nothing (exactly-once).
    await act(async () => {
      expect(stagedApiRef.current!.claimAll("session-a")).toEqual([]);
      // Claiming a different session yields nothing (scoped, not global).
      expect(stagedApiRef.current!.claimAll("session-b")).toEqual([]);
    });

    // On send failure, restore(sessionKey, ...) puts A's guide back.
    await act(async () => stagedApiRef.current!.restore("session-a", claimed));
    rerender(
      <ChatInput
        sessionId="session-a"
        projectPath={"D:\\project"}
        agentId="claude-code"
        isSessionStreaming
        stagedApiRef={stagedApiRef}
      />,
    );
    expect(screen.getByText("guide for A")).toBeInTheDocument();
  });
});

// 评审 P1-15：编辑重发与发送链同构——extractToolTokens 导出为单源管线，
// chat-page 编辑重发复用。此处锁定剥离/归一/保留行为。
describe("extractToolTokens（P1-15 编辑重发单源管线）", () => {
  const tools = [
    { id: "tool-alpha", display_name: "工具甲" },
    { id: "tool-beta", display_name: "工具乙" },
  ];

  it("剥离已注册 token、归一为插件 id、去首部空白", () => {
    const { text, toolIds } = extractToolTokens("@[工具甲] 请处理附件", tools);
    expect(text).toBe("请处理附件");
    expect(toolIds).toEqual(["tool-alpha"]);
  });

  it("多 token 依次归一（顺序保留）", () => {
    const { text, toolIds } = extractToolTokens("@[工具甲]@[工具乙]", tools);
    expect(text).toBe("");
    expect(toolIds).toEqual(["tool-alpha", "tool-beta"]);
  });

  it("未匹配插件的 token 原样保留（不吞字）", () => {
    const { text, toolIds } = extractToolTokens("@[不存在的工具] 原样", tools);
    expect(text).toBe("@[不存在的工具] 原样");
    expect(toolIds).toEqual([]);
  });
});
