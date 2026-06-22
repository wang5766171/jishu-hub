import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PhaseConversationShell } from "./phase-conversation-shell";

const useChatSessionMock = vi.hoisted(() => vi.fn());
const chatInputPropsRef = vi.hoisted(() => ({ current: null as Record<string, any> | null }));

vi.mock("@/features/chat-core/use-chat-session", () => ({
  useChatSession: useChatSessionMock,
}));

vi.mock("@/components/sessions/chat-input", () => ({
  ChatInput: (props: Record<string, any>) => {
    chatInputPropsRef.current = props;
    return (
      <button
        type="button"
        data-testid="submit-interaction"
        onClick={() => props.onInteractionSubmit?.({
          requestId: props.interactionRequest?.requestId,
          selectedOptionIds: ["yes"],
          customText: "",
        })}
      >
        submit
      </button>
    );
  },
}));

vi.mock("@/components/sessions/message-view", () => ({
  MessageView: () => <div data-testid="messages" />,
}));

vi.mock("@/components/sessions/streaming-message", () => ({
  StreamingMessage: () => <div data-testid="streaming" />,
}));

describe("PhaseConversationShell", () => {
  beforeEach(() => {
    chatInputPropsRef.current = null;
    useChatSessionMock.mockReset();
  });

  it("passes pending interactions from useChatSession into ChatInput", async () => {
    const respondInteraction = vi.fn().mockResolvedValue(undefined);
    useChatSessionMock.mockReturnValue({
      messages: [],
      stream: null,
      pendingInteractions: [{
        requestId: "req-1",
        prompt: "进入下一阶段？",
        options: [{ optionId: "yes", label: "确认", description: null }],
        origin: "codex_tool_request_user_input",
        transport: "codex_app_server",
        deliveryHint: "follow_up",
        allowCustomText: false,
        allowMultiple: false,
        required: true,
      }],
      pendingApprovals: [],
      respondInteraction,
      canSend: true,
    });

    render(
      <PhaseConversationShell
        sessionId="session-1"
        phase="requirements"
        readOnly={false}
        projectPath="D:/workspace/demo"
      />,
    );

    await waitFor(() => {
      expect(chatInputPropsRef.current?.interactionRequest).toMatchObject({
        requestId: "req-1",
        prompt: "进入下一阶段？",
        options: [{ optionId: "yes", label: "确认", description: null }],
        allowCustomText: false,
        allowMultiple: false,
        required: true,
      });
    });

    fireEvent.click(screen.getByTestId("submit-interaction"));

    await waitFor(() => {
      expect(respondInteraction).toHaveBeenCalledWith({
        selectedOptionIds: ["yes"],
        customText: "",
      });
    });
  });
});
