import { describe, expect, it } from "vitest";

import {
  formatInteractionResponseValue,
  formatInteractionReply,
  interactionRequestFromEvent,
  validateInteractionSubmission,
} from "./conversation-interaction";
import type {
  ConversationInteractionRequest,
  ConversationInteractionSubmission,
  NormalizedEvent,
} from "@/types";

const request: ConversationInteractionRequest = {
  requestId: "req-1",
  prompt: "请选择优先实施方向",
  options: [
    { optionId: "frontend", label: "前端优先" },
    { optionId: "backend", label: "后端优先", description: "先完成接口和权限模型" },
    { optionId: "parallel", label: "前后端并行" },
  ],
  allowMultiple: false,
  allowCustomText: true,
  required: true,
};

describe("conversation interaction", () => {
  it("validates a selected option with custom text", () => {
    const submission = validateInteractionSubmission(request, {
      selectedOptionIds: ["backend"],
      customText: "优先完成组织数据权限",
    });

    expect(submission).toEqual({
      requestId: "req-1",
      selectedOptionIds: ["backend"],
      customText: "优先完成组织数据权限",
    });
  });

  it("formats a readable reply without exposing transport metadata", () => {
    const submission: ConversationInteractionSubmission = {
      requestId: "req-1",
      selectedOptionIds: ["backend"],
      customText: "先做接口",
    };

    const reply = formatInteractionReply(request, submission);

    expect(reply).toContain("后端优先");
    expect(reply).toContain("先做接口");
    expect(reply).not.toContain("req-1");
    expect(reply).not.toContain("optionId");
  });

  it("formats the transport response value expected by extension UI", () => {
    expect(
      formatInteractionResponseValue(request, {
        requestId: "req-1",
        selectedOptionIds: ["backend"],
        customText: "",
      }),
    ).toBe("后端优先");

    expect(
      formatInteractionResponseValue(
        { ...request, options: [] },
        {
          requestId: "req-1",
          selectedOptionIds: [],
          customText: "Use the existing cluster",
        },
      ),
    ).toBe("Use the existing cluster");
  });

  it("rejects an option that does not belong to the request", () => {
    expect(() =>
      validateInteractionSubmission(request, {
        selectedOptionIds: ["unknown"],
        customText: "",
      }),
    ).toThrow("interaction option is invalid");
  });

  it("requires a selection or custom text for required interactions", () => {
    expect(() =>
      validateInteractionSubmission(request, {
        selectedOptionIds: [],
        customText: "   ",
      }),
    ).toThrow("interaction response is required");
  });

  it("rejects multiple selections for a single-choice request", () => {
    expect(() =>
      validateInteractionSubmission(request, {
        selectedOptionIds: ["frontend", "backend"],
        customText: "",
      }),
    ).toThrow("interaction only allows one option");
  });

  it("maps a normalized agent event into the shared request model", () => {
    const event: NormalizedEvent = {
      kind: "interaction_request",
      request_id: "req-event-1",
      prompt: "Choose one",
      options: [
        {
          option_id: "a",
          label: "Option A",
          description: "First option",
        },
      ],
      allow_multiple: false,
      allow_custom_text: true,
      required: true,
    };

    expect(interactionRequestFromEvent(event)).toEqual({
      requestId: "req-event-1",
      prompt: "Choose one",
      options: [
        {
          optionId: "a",
          label: "Option A",
          description: "First option",
        },
      ],
      allowMultiple: false,
      allowCustomText: true,
      required: true,
    });
  });
});
