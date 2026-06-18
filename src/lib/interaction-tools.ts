import type { ContentBlock } from "@/types";

const INTERACTION_TOOL_NAMES = new Set([
  "request_user_input",
  "ask_user",
  "ask_user_input",
  "askuserquestion",
  "ask_user_question",
  "ask_question",
  "ask_choice",
  "choice_question",
]);

export function normalizedToolName(name: string): string {
  return name.split("/").pop()?.split(":").pop()?.replace(/-/g, "_").toLowerCase() || "";
}

export function isInteractionToolName(name: string): boolean {
  return INTERACTION_TOOL_NAMES.has(normalizedToolName(name));
}

export function looksLikeInteractionToolInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  if (Array.isArray(record.questions)) return true;
  if (!Array.isArray(record.options)) return false;
  return typeof record.question === "string"
    || typeof record.prompt === "string"
    || typeof record.header === "string";
}

export function isInteractionToolUseBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "tool_use" }> {
  return block.type === "tool_use"
    && (isInteractionToolName(block.name) || looksLikeInteractionToolInput(block.input));
}

export interface InteractionLike {
  prompt?: string | null;
  answer?: string | null;
  text?: string | null;
  origin?: string | null;
}

function normalizeInteractionText(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function interactionSemanticKey(item: InteractionLike): string {
  const prompt = normalizeInteractionText(item.prompt);
  const answer = normalizeInteractionText(item.answer ?? item.text);
  const origin = normalizeInteractionText(item.origin);
  if (prompt || answer) return `${origin}\n${prompt}\n${answer}`;
  return JSON.stringify(item);
}

export function dedupeInteractionItems<T extends InteractionLike>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = interactionSemanticKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
