import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";
import type { AgentEventPayload, AgentStreamChunk } from "@/types";
import { useChatSession } from "./use-chat-session";

const invokeCommand = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-invoke", () => ({
  invokeCommand,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

let agentEventHandler: ((event: { payload: AgentEventPayload }) => void) | null = null;

function chunk(sessionId: string, data: AgentStreamChunk["data"]): AgentStreamChunk {
  return {
    agent_id: "jishu_agent",
    session_id: sessionId,
    event_type: data.kind,
    data,
  };
}

function Harness({ onTurnComplete }: { onTurnComplete?: () => void }) {
  const chat = useChatSession({
    sessionId: "session-a",
    projectPath: "D:/workspace/demo",
    readOnly: false,
    onTurnComplete,
  });

  return (
    <div>
      <div data-testid="stream-text">{chat.stream?.text ?? ""}</div>
      <div data-testid="interactions">
        {chat.pendingInteractions.map((item) => item.requestId).join(",")}
      </div>
    </div>
  );
}

describe("useChatSession agent-event handling", () => {
  beforeEach(() => {
    agentEventHandler = null;
    streamStore.drop("session-a");
    streamStore.drop("session-b");
    invokeCommand.mockReset();
    invokeCommand.mockResolvedValue([]);
    listenMock.mockReset();
    listenMock.mockImplementation(async (_eventName: string, handler: typeof agentEventHandler) => {
      agentEventHandler = handler;
      return vi.fn();
    });
  });

  it("routes array payload chunks only for the active session", async () => {
    render(<Harness />);

    await waitFor(() => expect(agentEventHandler).toBeTypeOf("function"));

    act(() => {
      agentEventHandler?.({
        payload: [
          chunk("session-b", { kind: "text_delta", delta: "wrong" }),
          chunk("session-a", { kind: "text_delta", delta: "right" }),
          chunk("session-a", {
            kind: "interaction_request",
            request_id: "req-a",
            prompt: "确认？",
            options: [{ option_id: "yes", label: "确认" }],
            allow_multiple: false,
            allow_custom_text: false,
            required: true,
          }),
        ],
      });
      streamStore.flushNow();
    });

    await waitFor(() => {
      expect(screen.getByTestId("stream-text")).toHaveTextContent("right");
      expect(screen.getByTestId("stream-text")).not.toHaveTextContent("wrong");
      expect(screen.getByTestId("interactions")).toHaveTextContent("req-a");
    });
  });

  it("turn_complete 翻转 isStreaming 并触发 onTurnComplete", async () => {
    const onTurnComplete = vi.fn();
    render(<Harness onTurnComplete={onTurnComplete} />);

    await waitFor(() => expect(agentEventHandler).toBeTypeOf("function"));

    // 流开始（模拟 send → streamStore.start，isStreaming=true）。
    act(() => {
      streamStore.start("session-a", null);
      streamStore.flushNow();
    });

    // 流结束：后端发 turn_complete → 监听器调 streamStore.end → isStreaming=false。
    act(() => {
      agentEventHandler?.({
        payload: chunk("session-a", {
          kind: "turn_complete",
          reason: "Complete",
          usage: null,
        }),
      });
      streamStore.flushNow();
    });

    // isStreaming true→false 边沿 → onTurnComplete 触发一次。
    await waitFor(() => expect(onTurnComplete).toHaveBeenCalledTimes(1));
  });
});
