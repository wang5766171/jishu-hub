import type { ContentBlock, Message } from "@/types";

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

interface InteractionInsertion {
  index: number;
  prompt: string;
  options: Array<{ option_id: string; label: string; description?: string | null }>;
  answer: string;
  selectedOptions?: string[];
  origin?: string;
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
  // Helper: detect interaction tool_use blocks
  const isInteractionTool = (name: string, input: any) => {
    const normalized = name.split('/').pop()?.split(':').pop()?.replace(/-/g, '_').toLowerCase() || "";
    const names = [
      "request_user_input", "ask_user", "ask_user_input",
      "askuserquestion", "ask_user_question",
      "ask_question", "ask_choice", "choice_question",
    ];
    if (names.includes(normalized)) return true;
    if (input && typeof input === "object") {
      if ("options" in input && ("question" in input || "prompt" in input)) return true;
    }
    return false;
  };

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

  // Sort interactions by insertion index
  const sortedInteractions = interactionInsertions
    .filter((item) => item.answer.trim().length > 0 || item.prompt.trim().length > 0)
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

  // Merge all insertion points (steers split messages, interactions embed blocks)
  const allIndices = new Set([
    ...sortedSteers.map((s) => s.index),
    ...sortedInteractions.map((i) => i.index),
  ]);
  const splitPoints = Array.from(allIndices).sort((a, b) => a - b);

  const messages: Message[] = [];
  let previousIndex = 0;

  for (const splitIdx of splitPoints) {
    // Build the assistant segment content with interactions embedded
    const segmentContent: ContentBlock[] = [];
    // Slice the content segment, filtering out tool_use+tool_result blocks
    // that belong to an embedded interaction (avoid double-rendering).
    const rawSeg = content.slice(previousIndex, splitIdx);
    const segBlocks: typeof rawSeg = [];
    for (let i = 0; i < rawSeg.length; i++) {
      const block = rawSeg[i];
      if (block.type === "tool_use" && interactionToolUseIds.has(block.id)) {
        // Skip this tool_use, and also skip the immediately-following
        // tool_result that references the same id.
        continue;
      }
      if (block.type === "tool_result" && interactionToolUseIds.has(block.tool_use_id || "")) {
        continue;
      }
      segBlocks.push(block);
    }
    segmentContent.push(...segBlocks);

    // Add any interaction blocks at this exact index
    for (const ins of sortedInteractions) {
      if (ins.index === splitIdx) {
        segmentContent.push({
          type: "interaction",
          prompt: ins.prompt,
          options: ins.options,
          answer: ins.answer,
          selected_options: ins.selectedOptions,
          origin: ins.origin,
        } as ContentBlock);
      }
    }

    // Push the assistant segment if it has content
    if (segmentContent.length > 0) {
      messages.push({ role: "assistant", content: segmentContent, timestamp });
    }

    // If a steer is at this index, add it as a user message
    for (const steer of sortedSteers) {
      if (steer.index === splitIdx) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: steer.text.trim() }],
          timestamp,
        });
      }
    }

    previousIndex = splitIdx;
  }

  // Tail segment: remaining content, also filter interaction tool blocks
  const rawTail = content.slice(previousIndex);
  const tailContent: ContentBlock[] = [];
  for (const block of rawTail) {
    if (block.type === "tool_use" && interactionToolUseIds.has(block.id)) continue;
    if (block.type === "tool_result" && interactionToolUseIds.has(block.tool_use_id || "")) continue;
    tailContent.push(block);
  }

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
