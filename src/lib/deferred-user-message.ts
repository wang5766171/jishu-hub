import type { ContentBlock, Message } from "@/types";
import { dedupeInteractionItems, isInteractionToolUseBlock } from "./interaction-tools";

interface CommitAssistantThenDeferredUserInput {
  assistantContent: ContentBlock[];
  queuedUserMessages: string[];
  error?: string | null;
  timestamp?: number;
}

interface CommitAssistantThenDeferredUserResult {
  messages: Message[];
  consumedUserMessageCount: number;
  followUpExpected: boolean;
}

interface UserInsertion {
  index: number;
  text: string;
}

interface CommitAssistantWithUserInsertionsInput {
  assistantContent: ContentBlock[];
  userInsertions: UserInsertion[];
  error?: string | null;
  timestamp?: number;
}

interface CommitAssistantWithUserInsertionsResult {
  messages: Message[];
  consumedUserMessageCount: number;
}

export function commitAssistantThenDeferredUser({
  assistantContent,
  queuedUserMessages,
  error,
  timestamp = Date.now(),
}: CommitAssistantThenDeferredUserInput): CommitAssistantThenDeferredUserResult {
  const messages: Message[] = [];
  const content = [...assistantContent];
  if (error) {
    content.push({ type: "text", text: error });
  }
  if (content.length > 0) {
    messages.push({ role: "assistant", content, timestamp });
  }
  const userText = queuedUserMessages[0];
  if (userText) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp,
    });
  }
  return {
    messages,
    consumedUserMessageCount: userText ? 1 : 0,
    followUpExpected: Boolean(userText),
  };
}

export function commitAssistantWithUserInsertions({
  assistantContent,
  userInsertions,
  error,
  timestamp = Date.now(),
}: CommitAssistantWithUserInsertionsInput): CommitAssistantWithUserInsertionsResult {
  const messages: Message[] = [];
  const content = [...assistantContent];
  const insertions = userInsertions
    .map((item, order) => ({
      index: Math.max(0, Math.min(item.index, content.length)),
      text: item.text.trim(),
      order,
    }))
    .filter((item) => item.text.length > 0)
    .sort((a, b) => a.index - b.index || a.order - b.order);

  let previousIndex = 0;
  for (const insertion of insertions) {
    const segment = content.slice(previousIndex, insertion.index);
    if (segment.length > 0) {
      messages.push({ role: "assistant", content: segment, timestamp });
    }
    messages.push({
      role: "user",
      content: [{ type: "text", text: insertion.text }],
      timestamp,
    });
    previousIndex = insertion.index;
  }

  const tail = content.slice(previousIndex);
  if (error) {
    tail.push({ type: "text", text: error });
  }
  if (tail.length > 0) {
    messages.push({ role: "assistant", content: tail, timestamp });
  }

  return {
    messages,
    consumedUserMessageCount: insertions.length,
  };
}

// ── Interaction block commit ────────────────────────────────────────────
// Embeds answered interactions as `Interaction` ContentBlocks within the
// assistant message (instead of splitting into user messages). This ensures
// both the question (prompt/options) and the answer are persisted together.

export interface InteractionInsertion {
  requestId?: string;
  index: number;
  prompt: string;
  options: Array<{ option_id: string; label: string; description?: string | null }>;
  answer: string;
  selectedOptions?: string[];
  origin?: string;
}

export interface InteractionSplitForCommit {
  requestId: string;
  index: number;
  text: string | null;
  prompt: string;
  options: Array<{ option_id: string; label: string; description?: string | null }>;
  selectedOptions?: string[];
  origin?: string;
}

interface BuildInteractionInsertionsInput {
  assistantContent: ContentBlock[];
  interactionSplits: InteractionSplitForCommit[];
  includePending?: boolean;
}

interface SteerInsertion {
  index: number;
  text: string;
}

interface CommitAssistantWithInteractionsInput {
  assistantContent: ContentBlock[];
  /** Interaction Q&A pairs to embed as Interaction blocks within assistant content. */
  interactionInsertions: InteractionInsertion[];
  /** Steer (guide) messages that remain as separate user messages between segments. */
  steerInsertions?: SteerInsertion[];
  error?: string | null;
  timestamp?: number;
}

interface CommitAssistantWithInteractionsResult {
  messages: Message[];
  consumedInteractionCount: number;
  consumedSteerCount: number;
}

export function interactionToolIdFromRequestId(requestId: string, origin?: string): string {
  const colonIndex = requestId.indexOf(":");
  if (colonIndex > 0) return requestId.slice(0, colonIndex);

  const acpSubRequest = origin === "acp_elicitation" ? requestId.match(/^(.+)_(\d+)$/) : null;
  if (acpSubRequest) return acpSubRequest[1];

  return requestId;
}

export function buildInteractionInsertions({
  assistantContent,
  interactionSplits,
  includePending = false,
}: BuildInteractionInsertionsInput): InteractionInsertion[] {
  const insertions: Array<InteractionInsertion & { order: number }> = [];

  interactionSplits.forEach((item, order) => {
    const answer = item.text ?? "";
    if (!includePending && answer.trim().length === 0) return;

    const toolUseId = interactionToolIdFromRequestId(item.requestId, item.origin);
    const toolIndex = assistantContent.findIndex(
      (block) => block.type === "tool_use" && block.id === toolUseId,
    );
    const toolBlock = toolIndex >= 0 && assistantContent[toolIndex]?.type === "tool_use"
      ? assistantContent[toolIndex]
      : null;
    const toolInput = toolBlock && typeof toolBlock.input === "object" && toolBlock.input !== null
      ? toolBlock.input as Record<string, unknown>
      : {};

    const prompt = item.prompt.trim()
      || stringFromUnknown(toolInput.question)
      || stringFromUnknown(toolInput.prompt);
    if (!prompt) return;

    const options = item.options.length > 0
      ? item.options
      : parseInteractionOptions(toolInput.options);

    insertions.push({
      requestId: item.requestId,
      index: Math.max(0, Math.min(toolIndex >= 0 ? toolIndex : item.index, assistantContent.length)),
      prompt,
      options,
      answer,
      selectedOptions: item.selectedOptions,
      origin: item.origin,
      order,
    });
  });

  return dedupeInteractionItems(insertions)
    .sort((a, b) => a.index - b.index || a.order - b.order)
    .map(({ order: _order, ...item }) => item);
}

function stringFromUnknown(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseInteractionOptions(value: unknown): InteractionInsertion["options"] {
  if (!Array.isArray(value)) return [];
  const options: InteractionInsertion["options"] = [];
  value.forEach((option, index) => {
    if (typeof option === "string") {
      options.push({ option_id: option, label: option });
      return;
    }
    if (!option || typeof option !== "object") return;
    const record = option as Record<string, unknown>;
    const label = stringFromUnknown(record.label) || stringFromUnknown(record.text);
    if (!label) return;
    const description = stringFromUnknown(record.description);
    options.push({
      option_id: stringFromUnknown(record.option_id)
        || stringFromUnknown(record.id)
        || stringFromUnknown(record.value)
        || `option_${index + 1}`,
      label,
      description: description || undefined,
    });
  });
  return options;
}

/**
 * Commit assistant content with interactions embedded as `Interaction` blocks
 * (not as user messages). Steers are interleaved as user messages between
 * assistant segments, and within each segment, interactions are placed at
 * their content-array index.
 */
export function commitAssistantWithInteractions({
  assistantContent,
  interactionInsertions,
  steerInsertions = [],
  error,
  timestamp = Date.now(),
}: CommitAssistantWithInteractionsInput): CommitAssistantWithInteractionsResult {
  const content = [...assistantContent];

  // Build a set of tool_use ids that have a corresponding interaction insertion.
  // These tool_use+tool_result blocks must be removed from segmentContent
  // to avoid double-rendering alongside the embedded interaction block.
  const interactionToolUseIds = new Set<string>();
  for (const ins of interactionInsertions) {
    const block = content[ins.index];
    if (block && block.type === "tool_use") {
      interactionToolUseIds.add(block.id);
    }
  }
  const rawInteractionToolUseIds = new Set(
    content
      .filter(isInteractionToolUseBlock)
      .map((block) => block.id),
  );

  // Sort interactions by insertion index
  const sortedInteractions = dedupeInteractionItems(
    interactionInsertions
      .filter((item) => item.answer.trim().length > 0 || item.prompt.trim().length > 0),
  )
    .map((item, order) => ({
      ...item,
      index: Math.max(0, Math.min(item.index, content.length)),
      order,
    }))
    .sort((a, b) => a.index - b.index || a.order - b.order);

  // Sort steers by insertion index
  const sortedSteers = steerInsertions
    .filter((item) => item.text.trim().length > 0)
    .map((item, order) => ({
      ...item,
      index: Math.max(0, Math.min(item.index, content.length)),
      order,
    }))
    .sort((a, b) => a.index - b.index || a.order - b.order);

  const messages: Message[] = [];

  const consumedInteractionOrders = new Set<number>();
  const appendInteraction = (
    segmentContent: ContentBlock[],
    ins: InteractionInsertion & { order: number },
  ) => {
    if (consumedInteractionOrders.has(ins.order)) return;
    consumedInteractionOrders.add(ins.order);
    const block: ContentBlock = {
      type: "interaction",
      prompt: ins.prompt,
      options: ins.options,
      answer: ins.answer,
      selected_options: ins.selectedOptions,
      origin: ins.origin,
    };
    if (ins.requestId) {
      block.request_id = ins.requestId;
    }
    segmentContent.push(block);
  };

  const buildAssistantSegment = (startIndex: number, endIndex: number): ContentBlock[] => {
    const segmentContent: ContentBlock[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      for (const ins of sortedInteractions) {
        if (ins.index === i) {
          appendInteraction(segmentContent, ins);
        }
      }

      const block = content[i];
      if (
        block.type === "tool_use"
        && (interactionToolUseIds.has(block.id) || rawInteractionToolUseIds.has(block.id))
      ) {
        continue;
      }
      if (
        block.type === "tool_result"
        && (
          interactionToolUseIds.has(block.tool_use_id || "")
          || rawInteractionToolUseIds.has(block.tool_use_id || "")
        )
      ) {
        continue;
      }
      segmentContent.push(block);
    }

    for (const ins of sortedInteractions) {
      if (ins.index === endIndex) {
        appendInteraction(segmentContent, ins);
      }
    }
    return segmentContent;
  };

  let previousIndex = 0;
  for (const steer of sortedSteers) {
    const segmentContent = buildAssistantSegment(previousIndex, steer.index);
    if (segmentContent.length > 0) {
      messages.push({ role: "assistant", content: segmentContent, timestamp });
    }
    messages.push({
      role: "user",
      content: [{ type: "text", text: steer.text.trim() }],
      timestamp,
    });
    previousIndex = steer.index;
  }

  const tailContent = buildAssistantSegment(previousIndex, content.length);
  if (error) {
    tailContent.push({ type: "text", text: error });
  }
  if (tailContent.length > 0) {
    messages.push({ role: "assistant", content: tailContent, timestamp });
  }

  return {
    messages,
    consumedInteractionCount: sortedInteractions.length,
    consumedSteerCount: sortedSteers.length,
  };
}
