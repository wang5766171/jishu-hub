import { describe, expect, it } from "vitest";

import { streamStore } from "./use-stream-store";
import type { StreamChunk } from "@/types";

function chunk(data: StreamChunk["data"]): StreamChunk {
  return {
    session_id: "session-interaction",
    event_type: data.kind,
    data,
  };
}

describe("streamStore interaction requests", () => {
  it("records extension UI interaction responses at the request position", () => {
    streamStore.drop("session-interaction");
    streamStore.start("session-interaction", "plan a deployment");

    streamStore.push("session-interaction", chunk({
      kind: "text_delta",
      delta: "What kind of workload is this?",
    }));
    streamStore.push("session-interaction", chunk({
      kind: "interaction_request",
      request_id: "req-1",
      prompt: "Choose workload type",
      options: [],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
    }));

    expect(streamStore.recordInteractionResponse(
      "session-interaction",
      "req-1",
      "Stateful worker service",
    )).toBe(true);

    streamStore.push("session-interaction", chunk({
      kind: "tool_use_result",
      call_id: "call-1",
      output: "Stateful worker service",
      is_error: false,
    }));
    streamStore.push("session-interaction", chunk({
      kind: "text_delta",
      delta: " Use a StatefulSet.",
    }));

    expect(streamStore.getState("session-interaction")?.interactionSplits).toEqual([
      {
        requestId: "req-1",
        index: 1,
        text: "Stateful worker service",
        prompt: "Choose workload type",
        options: [],
        origin: undefined,
        selectedOptions: [],
      },
    ]);

    streamStore.drop("session-interaction");
  });
});
