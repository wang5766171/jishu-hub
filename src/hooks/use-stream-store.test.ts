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

    streamStore.push(
      "session-interaction",
      chunk({
      kind: "text_delta",
      delta: "What kind of workload is this?",
      }),
    );
    streamStore.push(
      "session-interaction",
      chunk({
      kind: "interaction_request",
      request_id: "req-1",
      prompt: "Choose workload type",
      options: [],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
      }),
    );

    expect(
      streamStore.recordInteractionResponse(
      "session-interaction",
      "req-1",
      "Stateful worker service",
      ),
    ).toBe(true);

    streamStore.push(
      "session-interaction",
      chunk({
      kind: "tool_use_result",
      call_id: "call-1",
      output: "Stateful worker service",
      is_error: false,
      }),
    );
    streamStore.push(
      "session-interaction",
      chunk({
      kind: "text_delta",
      delta: " Use a StatefulSet.",
      }),
    );

    expect(
      streamStore.getState("session-interaction")?.interactionSplits,
    ).toEqual([
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

  it("starts continuations for phase dividers and interactions only", () => {
    const sessionId = "session-continuation";
    streamStore.drop(sessionId);

    const divider = {
      ...chunk({ kind: "phase_divider", phase: "plan", title: "流程规划" }),
      session_id: sessionId,
    } satisfies StreamChunk;
    expect(streamStore.pushTracked(sessionId, divider)).toBe(true);
    expect(streamStore.getState(sessionId)?.content).toEqual([
      { type: "phase_divider", phase: "plan", title: "流程规划" },
    ]);

    expect(streamStore.pushTracked(sessionId, divider)).toBe(true);
    expect(streamStore.getState(sessionId)?.content).toHaveLength(1);
    streamStore.drop(sessionId);

    const completionData = {
      kind: "turn_complete",
      reason: "Complete",
      usage: null,
    } satisfies StreamChunk["data"];
    const completion = {
      ...chunk(completionData),
      session_id: sessionId,
    } satisfies StreamChunk;
    expect(streamStore.pushTracked(sessionId, completion)).toBe(false);
    expect(streamStore.getState(sessionId)).toBeNull();

    const interaction = {
      ...chunk({
        kind: "interaction_request",
        request_id: "gate-1",
        prompt: "是否进入规划？",
        options: [],
        allow_multiple: false,
        allow_custom_text: true,
        required: true,
      }),
      session_id: sessionId,
    } satisfies StreamChunk;
    expect(streamStore.pushTracked(sessionId, interaction)).toBe(true);
    expect(
      streamStore.getState(sessionId)?.interactionSplits[0]?.requestId,
    ).toBe("gate-1");
    streamStore.drop(sessionId);
  });

  it("rolls back an optimistic interaction response", () => {
    const sessionId = "session-rollback";
    streamStore.drop(sessionId);
    streamStore.start(sessionId, null);
    streamStore.push(sessionId, {
      ...chunk({
        kind: "interaction_request",
        request_id: "req-rollback",
        prompt: "继续吗？",
        options: [],
        allow_multiple: false,
        allow_custom_text: true,
        required: true,
      }),
      session_id: sessionId,
    });

    const checkpoint = streamStore.recordInteractionResponseWithCheckpoint(
      sessionId,
      "req-rollback",
      "继续",
    );
    expect(streamStore.getState(sessionId)?.interactionSplits[0]?.text).toBe(
      "继续",
    );
    expect(streamStore.rollbackInteractionResponse(checkpoint)).toBe(true);
    expect(
      streamStore.getState(sessionId)?.interactionSplits[0]?.text,
    ).toBeNull();
    streamStore.drop(sessionId);
  });
});
