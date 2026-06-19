export interface PlanningChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export function buildPlanningInstruction(messages: PlanningChatMessage[]): string {
  const lines = messages
    .map((message) => ({
      ...message,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0)
    .map((message) =>
      `${message.role === "user" ? "用户" : "Jishu Agent"}: ${message.content}`,
    );

  if (lines.length === 0) return "";

  return [
    "请根据以下任务规划对话生成可审阅的任务流程图。",
    "",
    ...lines,
  ].join("\n");
}

export function derivePlanningTitle(
  explicitTitle: string,
  messages: PlanningChatMessage[],
): string {
  const title = explicitTitle.trim();
  if (title) return title;
  const firstUserMessage = messages.find((message) => message.role === "user");
  return firstUserMessage?.content.trim().replace(/\s+/g, " ") ?? "";
}

export function hasPlanningInput(
  messages: PlanningChatMessage[],
  draft = "",
): boolean {
  return messages.some((message) => message.content.trim().length > 0) ||
    draft.trim().length > 0;
}

export function createPlanningMessage(
  content: string,
  role: PlanningChatMessage["role"] = "user",
): PlanningChatMessage {
  return {
    id: makePlanningMessageId(),
    role,
    content: content.trim(),
  };
}

function makePlanningMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `planning_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
