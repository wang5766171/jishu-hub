import type {
  ConversationInteractionRequest,
  ConversationInteractionSubmission,
  NormalizedEvent,
} from "@/types";

interface InteractionSubmissionInput {
  selectedOptionIds: string[];
  customText?: string;
}

export function validateInteractionSubmission(
  request: ConversationInteractionRequest,
  input: InteractionSubmissionInput,
): ConversationInteractionSubmission {
  const selectedOptionIds = [...new Set(input.selectedOptionIds)];
  const customText = input.customText?.trim() ?? "";
  const validOptionIds = new Set(request.options.map((option) => option.optionId));

  if (selectedOptionIds.some((optionId) => !validOptionIds.has(optionId))) {
    throw new Error("interaction option is invalid");
  }
  if (!request.allowMultiple && selectedOptionIds.length > 1) {
    throw new Error("interaction only allows one option");
  }
  if (!request.allowCustomText && customText) {
    throw new Error("interaction does not allow custom text");
  }
  if (request.required && selectedOptionIds.length === 0 && !customText) {
    throw new Error("interaction response is required");
  }

  return {
    requestId: request.requestId,
    selectedOptionIds,
    customText,
  };
}

export function formatInteractionReply(
  request: ConversationInteractionRequest,
  submission: ConversationInteractionSubmission,
): string {
  const optionLabels = new Map(
    request.options.map((option) => [option.optionId, option.label]),
  );
  const sections: string[] = [];

  if (submission.selectedOptionIds.length > 0) {
    sections.push(
      `我的选择：\n${submission.selectedOptionIds
        .map((optionId) => `- ${optionLabels.get(optionId) ?? optionId}`)
        .join("\n")}`,
    );
  }
  if (submission.customText.trim()) {
    sections.push(`补充说明：${submission.customText.trim()}`);
  }

  return sections.join("\n\n");
}

export function formatInteractionResponseValue(
  request: ConversationInteractionRequest,
  submission: ConversationInteractionSubmission,
): string {
  const optionLabels = new Map(
    request.options.map((option) => [option.optionId, option.label]),
  );
  const selectedLabels = submission.selectedOptionIds.map(
    (optionId) => optionLabels.get(optionId) ?? optionId,
  );
  const customText = submission.customText.trim();

  if (selectedLabels.length === 1 && !customText) {
    return selectedLabels[0];
  }
  if (selectedLabels.length === 0) {
    return customText;
  }
  if (!customText) {
    return selectedLabels.join("\n");
  }
  return `${selectedLabels.join("\n")}\n\n${customText}`;
}

export function interactionRequestFromEvent(
  event: Extract<NormalizedEvent, { kind: "interaction_request" }>,
): ConversationInteractionRequest {
  return {
    requestId: event.request_id,
    prompt: event.prompt,
    options: event.options.map((option) => ({
      optionId: option.option_id,
      label: option.label,
      description: option.description,
    })),
    allowMultiple: event.allow_multiple,
    allowCustomText: event.allow_custom_text,
    required: event.required,
    // New in v0.6.0 interaction generalization. All optional — legacy/persisted
    // events omit them and the backend falls back to follow-up delivery.
    transport: event.transport,
    origin: event.origin,
    deliveryHint: event.delivery_hint,
    correlation: event.correlation ?? null,
  };
}
