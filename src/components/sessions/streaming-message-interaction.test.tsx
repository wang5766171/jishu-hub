import i18n from "@/i18n";
import { render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { streamStore } from "@/hooks/use-stream-store";
import type { StreamChunk } from "@/types";
import { StreamingMessage } from "./streaming-message";

const sessionId = "session-streaming-interaction";

function chunk(data: StreamChunk["data"]): StreamChunk {
  return {
    session_id: sessionId,
    event_type: data.kind,
    data,
  };
}

describe("StreamingMessage interaction ordering", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    streamStore.drop(sessionId);
  });

  it("renders an extension UI response between the question and the continued answer", () => {
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, chunk({
      kind: "text_delta",
      delta: "What kind of workload is this?",
    }));
    streamStore.push(sessionId, chunk({
      kind: "interaction_request",
      request_id: "req-1",
      prompt: "Choose workload type",
      options: [],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
    }));
    streamStore.recordInteractionResponse(sessionId, "req-1", "Stateful worker service");
    streamStore.push(sessionId, chunk({
      kind: "tool_use_result",
      call_id: "call-1",
      output: "Stateful worker service",
      is_error: false,
    }));
    streamStore.push(sessionId, chunk({
      kind: "text_delta",
      delta: " Use a StatefulSet.",
    }));

    const { container } = render(
      <StreamingMessage sessionId={sessionId} />,
    );
    const text = container.textContent ?? "";

    // The InteractionCard is collapsed by default (defaultOpen=false),
    // showing the header "Interaction" instead of the answer text.
    // Verify the ordering: assistant text → interaction header → continued text.
    expect(text.indexOf("What kind of workload is this?")).toBeLessThan(
      text.indexOf("Ask user"),
    );
    expect(text.indexOf("Ask user")).toBeLessThan(
      text.indexOf("Use a StatefulSet."),
    );
  });
});
