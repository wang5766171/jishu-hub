import type {
  ConversationInteractionRequest,
  ConversationInteractionSubmission,
  NormalizedEvent,
} from "@/types";

interface InteractionSubmissionInput {
  selectedOptionIds: string[];
  customText?: string | null;
}

/**
 * v0.9.5 需求5 测试期：rpiv-ask RPC 问答器把每题选项烘焙成
 * "N. label — description" 单串（含自动追加的哨兵行已被 hub 剥离）。
 * 展示层净化（不改协议——提交仍回传原始 optionId/串）：
 * - 全员命中 "N. " 前缀 → 剥序号（卡片自带 A/B/C 徽标，双编号冗余）；
 * - 拆出 label/description，description 全部相同（模型被要求"别给提示"时的
 *   统一占位文案，如「就选这个？」）或为空 → 不展示；
 * - description 各不相同（真实权衡说明）→ label 主行 + description 次行。
 * 非 rpiv 形态（无序号前缀，如 conductor 的原生 select）原样返回。
 */
export function decorateInteractionOptions<
  T extends { optionId?: string; option_id?: string; label: string; description?: string | null },
>(options: T[]): Array<T & { label: string; description: string | null }> {
  const numbered = options.map((option) => option.label.match(/^(\d+)\.\s*(.*)$/s));
  const allNumbered = numbered.length > 0 && numbered.every((m) => m !== null);
  if (!allNumbered) {
    return options.map((option) => ({ ...option, description: option.description ?? null }));
  }
  const parsed = options.map((_option, index) => {
    const rest = numbered[index]![2];
    const sep = rest.indexOf(" — ");
    if (sep >= 0) {
      return { label: rest.slice(0, sep), description: rest.slice(sep + 3) };
    }
    return { label: rest, description: "" };
  });
  const descs = parsed.map((p) => p.description.trim());
  const allHaveDesc = descs.every((d) => d.length > 0);
  const uniform = allHaveDesc && new Set(descs).size === 1;
  return options.map((option, index) => ({
    ...option,
    label: parsed[index]!.label,
    description:
      allHaveDesc && !uniform ? parsed[index]!.description : option.description ?? null,
  }));
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
