import { describe, expect, it } from "vitest";

import {
  commitAssistantThenDeferredUser,
  commitAssistantWithUserInsertions,
  commitAssistantWithInteractions,
} from "./deferred-user-message";
import type { ContentBlock } from "@/types";

describe("commitAssistantThenDeferredUser", () => {
  it("places the deferred user response after the current assistant turn", () => {
    const assistantContent: ContentBlock[] = [
      { type: "text", text: "Which workload do you want to deploy?" },
    ];

    const result = commitAssistantThenDeferredUser({
      assistantContent,
      queuedUserMessages: ["Stateful worker service"],
      timestamp: 1000,
    });

    expect(result.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(result.messages[0].content).toEqual(assistantContent);
    expect(result.messages[1].content).toEqual([
      { type: "text", text: "Stateful worker service" },
    ]);
    expect(result.consumedUserMessageCount).toBe(1);
    expect(result.followUpExpected).toBe(true);
  });

  it("interleaves interaction responses at their extension UI request positions", () => {
    const assistantContent: ContentBlock[] = [
      { type: "text", text: "What kind of workload is this?" },
      { type: "tool_result", tool_use_id: "call-1", content: "Stateful worker service" },
      { type: "text", text: "Use a StatefulSet." },
    ];

    const result = commitAssistantWithUserInsertions({
      assistantContent,
      userInsertions: [
        { index: 1, text: "Stateful worker service" },
      ],
      timestamp: 1000,
    });

    expect(result.messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "What kind of workload is this?" },
    ]);
    expect(result.messages[1].content).toEqual([
      { type: "text", text: "Stateful worker service" },
    ]);
    expect(result.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call-1", content: "Stateful worker service" },
      { type: "text", text: "Use a StatefulSet." },
    ]);
    expect(result.consumedUserMessageCount).toBe(1);
  });
});

describe("commitAssistantWithInteractions", () => {
  it("embeds interactions as interaction blocks and does not duplicate them", () => {
    const assistantContent: ContentBlock[] = [
      { type: "text", text: "Hello" },
    ];
    const result = commitAssistantWithInteractions({
      assistantContent,
      interactionInsertions: [
        {
          index: 1,
          prompt: "What is your name?",
          options: [],
          answer: "Alice",
        },
      ],
      timestamp: 1000,
    });

    expect(result.messages.length).toBe(1);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "Hello" },
      {
        type: "interaction",
        prompt: "What is your name?",
        options: [],
        answer: "Alice",
        selected_options: undefined,
        origin: undefined,
      },
    ]);
  });
});
