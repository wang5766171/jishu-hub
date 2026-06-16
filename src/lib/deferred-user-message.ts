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
