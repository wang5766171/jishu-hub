import { describe, expect, it } from "vitest";

import {
  buildInteractionInsertions,
  commitAssistantThenDeferredUser,
  commitAssistantWithUserInsertions,
  commitAssistantWithInteractions,
  interactionToolIdFromRequestId,
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
  it("derives the source tool id from normalized interaction request ids", () => {
    expect(interactionToolIdFromRequestId("call-1:architecture")).toBe("call-1");
    expect(interactionToolIdFromRequestId("call_002:1")).toBe("call_002");
    expect(interactionToolIdFromRequestId("17_0", "acp_elicitation")).toBe("17");
    expect(interactionToolIdFromRequestId("call_002")).toBe("call_002");
    expect(interactionToolIdFromRequestId("plain-request")).toBe("plain-request");
  });

  it("builds insertions from answered tool-backed interactions and filters raw tool blocks", () => {
    const assistantContent: ContentBlock[] = [
      { type: "text", text: "Before" },
      {
        type: "tool_use",
        id: "call-1",
        name: "request_user_input",
        input: {
          question: "Choose implementation order",
          options: [{ id: "backend", label: "Backend first" }],
        },
      },
      { type: "tool_result", tool_use_id: "call-1", content: "Backend first" },
      { type: "text", text: "After" },
    ];

    const insertions = buildInteractionInsertions({
      assistantContent,
      interactionSplits: [{
        requestId: "call-1:architecture",
        index: 1,
        text: "Backend first",
        prompt: "Choose implementation order",
        options: [{ option_id: "backend", label: "Backend first" }],
        selectedOptions: ["backend"],
        origin: "extension_ui",
      }],
    });

    expect(insertions).toEqual([{
      requestId: "call-1:architecture",
      index: 1,
      prompt: "Choose implementation order",
      options: [{ option_id: "backend", label: "Backend first" }],
      answer: "Backend first",
      selectedOptions: ["backend"],
      origin: "extension_ui",
    }]);

    const result = commitAssistantWithInteractions({
      assistantContent,
      interactionInsertions: insertions,
      timestamp: 1000,
    });

    expect(result.messages[0].content).toEqual([
      { type: "text", text: "Before" },
      {
        type: "interaction",
        request_id: "call-1:architecture",
        prompt: "Choose implementation order",
        options: [{ option_id: "backend", label: "Backend first" }],
        answer: "Backend first",
        selected_options: ["backend"],
        origin: "extension_ui",
      },
      { type: "text", text: "After" },
    ]);
  });

  it("keeps ACP elicitation interactions even when the raw AskUserQuestion tool is suppressed", () => {
    const assistantContent: ContentBlock[] = [
      { type: "text", text: "Before" },
      { type: "text", text: "After" },
    ];

    const insertions = buildInteractionInsertions({
      assistantContent,
      interactionSplits: [{
        requestId: "17_0",
        index: 1,
        text: "Backend first",
        prompt: "Choose implementation order",
        options: [{ option_id: "backend", label: "Backend first" }],
        selectedOptions: ["backend"],
        origin: "acp_elicitation",
      }],
    });

    expect(insertions).toEqual([{
      requestId: "17_0",
      index: 1,
      prompt: "Choose implementation order",
      options: [{ option_id: "backend", label: "Backend first" }],
      answer: "Backend first",
      selectedOptions: ["backend"],
      origin: "acp_elicitation",
    }]);
  });

  it("dedupes repeated interaction splits by question and answer", () => {
    const assistantContent: ContentBlock[] = [
      { type: "text", text: "Before" },
    ];

    const insertions = buildInteractionInsertions({
      assistantContent,
      interactionSplits: [
        {
          requestId: "0_0",
          index: 1,
          text: "Water",
          prompt: "What gets dirtier as it washes?",
          options: [],
          origin: "acp_elicitation",
        },
        {
          requestId: "0_1",
          index: 1,
          text: "Bald",
          prompt: "Why did the hair stay dry?",
          options: [],
          origin: "acp_elicitation",
        },
        {
          requestId: "duplicate_1",
          index: 1,
          text: "Bald",
          prompt: "Why did the hair stay dry?",
          options: [],
          origin: "acp_elicitation",
        },
      ],
    });

    expect(insertions.map((item) => item.prompt)).toEqual([
      "What gets dirtier as it washes?",
      "Why did the hair stay dry?",
    ]);
  });

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

  it("does not duplicate an interaction that shares a split index with a steer", () => {
    const assistantContent: ContentBlock[] = [
      { type: "text", text: "Before" },
      { type: "text", text: "After" },
    ];
    const result = commitAssistantWithInteractions({
      assistantContent,
      interactionInsertions: [
        {
          index: 1,
          prompt: "Choose one",
          options: [],
          answer: "A",
        },
      ],
      steerInsertions: [
        {
          index: 1,
          text: "Continue with A",
        },
      ],
      timestamp: 1000,
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "Before" },
      {
        type: "interaction",
        prompt: "Choose one",
        options: [],
        answer: "A",
        selected_options: undefined,
        origin: undefined,
      },
    ]);
    expect(result.messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Continue with A" }],
    });
    expect(result.messages[2].content).toEqual([
      { type: "text", text: "After" },
    ]);
  });

  it("filters raw AskUserQuestion tool blocks and dedupes repeated interaction insertions", () => {
    const assistantContent: ContentBlock[] = [
      { type: "text", text: "Intro" },
      {
        type: "tool_use",
        id: "call-quiz",
        name: "AskUserQuestion",
        input: {
          questions: [
            { question: "Question 1", options: [{ label: "A" }] },
            { question: "Question 2", options: [{ label: "B" }] },
          ],
        },
      },
      {
        type: "tool_result",
        tool_use_id: "call-quiz",
        content: "Question 1=A, Question 2=B",
      },
      { type: "text", text: "Summary" },
    ];

    const result = commitAssistantWithInteractions({
      assistantContent,
      interactionInsertions: [
        {
          requestId: "0_0",
          index: 0,
          prompt: "Question 1",
          options: [],
          answer: "A",
          origin: "acp_elicitation",
        },
        {
          requestId: "0_1",
          index: 0,
          prompt: "Question 2",
          options: [],
          answer: "B",
          origin: "acp_elicitation",
        },
        {
          requestId: "duplicate_1",
          index: 0,
          prompt: "Question 2",
          options: [],
          answer: "B",
          origin: "acp_elicitation",
        },
      ],
      timestamp: 1000,
    });

    expect(result.consumedInteractionCount).toBe(2);
    expect(result.messages[0].content).toEqual([
      {
        type: "interaction",
        request_id: "0_0",
        prompt: "Question 1",
        options: [],
        answer: "A",
        selected_options: undefined,
        origin: "acp_elicitation",
      },
      {
        type: "interaction",
        request_id: "0_1",
        prompt: "Question 2",
        options: [],
        answer: "B",
        selected_options: undefined,
        origin: "acp_elicitation",
      },
      { type: "text", text: "Intro" },
      { type: "text", text: "Summary" },
    ]);
  });
});
