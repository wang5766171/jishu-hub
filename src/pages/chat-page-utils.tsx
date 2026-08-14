// chat-page 的模块级助手：纯函数、类型与消息清洗逻辑（v0.7.3 需求1-M5 从 chat-page.tsx 机械提取，无逻辑变化）。
import type * as React from "react";

import type { SessionStreamState } from "@/hooks/use-stream-store";
import type {
  ContentBlock,
  ConversationInteractionRequest,
  Message,
  Session,
} from "@/types";

export function TerminalIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="3" width="20" height="18" rx="3" />
      <polyline points="7 10 10 13 7 16" />
      <line x1="13" y1="16" x2="17" y2="16" />
    </svg>
  );
}

export function buildAssistantContentFromStreamState(state: SessionStreamState | null | undefined): ContentBlock[] {
  if (!state) return [];
  if (state.content.length > 0) return [...state.content];

  const assistantContent: ContentBlock[] = [];
  if (state.thinking) assistantContent.push({ type: "thinking", thinking: state.thinking });
  state.tools.forEach((tool, idx) => {
    const id = tool.id || `stream-${idx}-${tool.name}`;
    assistantContent.push({
      type: "tool_use",
      id,
      name: tool.name,
      input: tool.input,
    });
    if (tool.output !== undefined) {
      assistantContent.push({
        type: "tool_result",
        tool_use_id: id,
        content: tool.output,
      });
    }
  });
  if (state.text) assistantContent.push({ type: "text", text: state.text });
  return assistantContent;
}

export function formatRelativeTime(
  date: Date | string,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t("time.justNow");
  if (diffMin < 60) return t("time.minutesAgo", { count: String(diffMin) });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("time.hoursAgo", { count: String(diffHr) });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return t("time.daysAgo", { count: String(diffDay) });
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function uniqueSessionsById(items: Session[]): Session[] {
  const seen = new Set<string>();
  const unique: Session[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

export function extractRealSessionId(data: unknown): string | null {
  const obj = data as Record<string, unknown> | null;
  if (!obj) return null;
  if (obj.kind === "session_resolved") {
    const normalizedSid = obj.session_id;
    if (typeof normalizedSid === "string" && normalizedSid.length >= 8) {
      return normalizedSid;
    }
  }
  const sid = obj.session_id;
  if (typeof sid === "string" && !sid.startsWith("pending-") && !sid.startsWith("new_session_") && sid.length >= 8) {
    return sid;
  }
  return null;
}

export interface PendingChatApproval {
  sessionId: string;
  requestId: string;
  approvalKind: string;
  payload: unknown;
}

export interface PendingChatInteraction {
  agentId: string;
  sessionId: string;
  request: ConversationInteractionRequest;
}

export type TaskLaunchPhase = "requirements" | "planning";

// 三阶段顺序（graph 视同 execution 级），用于「阶段标签自动跟随」判定 current_phase
// 是否前进。conductor 在 turn 内调 conductor_sync_phase 推进 current_phase。
export const PHASE_LAUNCH_RANK: Record<string, number> = {
  requirements: 0,
  planning: 1,
  execution: 2,
  graph: 2,
};

export function stripTaskLaunchInstructionFromMessages(messages: Message[]): Message[] {
  return messages
    // 过滤 Conductor before_agent_start 注入消息（skill 方法论全文，display:false 但 Pi 仍写 JSONL）
    .filter((message) => {
      if (message.role !== "user") return true;
      const firstText = message.content.find((b) => b.type === "text");
      if (!firstText || firstText.type !== "text") return true;
      // Conductor 注入消息以 [JISHU-TASK: 开头
      if (firstText.text.trimStart().startsWith("[JISHU-TASK:")) return false;
      return true;
    })
    .map((message) => ({
      ...message,
      content: message.content.map((block) => {
        if (block.type !== "text") return block;
        // v0.7.0 需求二-问题4：先剥离 [JISHU-PROMT:] 配对块标记的系统内部提示词，
        // 再剥离旧版 <jishu-task-*> 标签指令。
        const promtStripped = stripJishuPromt(block.text);
        return {
          ...block,
          text: stripTaskLaunchInstruction(promtStripped),
        };
      }),
    }))
    // v0.7.0：剥离后内容为空的 user 消息（纯系统提示词）整条过滤掉，不向用户展示。
    .filter((message) => {
      if (message.role !== "user") return true;
      const hasVisibleContent = message.content.some((block) => {
        if (block.type === "text") return block.text.trim().length > 0;
        return true; // 非文本块（interaction/tool 等）保留
      });
      return hasVisibleContent;
    });
}

/**
 * v0.7.0 需求二-问题4：剥离 [JISHU-PROMT:开始]...[JISHU-PROMT:结束] 配对块标记
 * 及其包裹的系统内部提示词。标记外的用户真实指令保留。跨行匹配，非贪婪。
 */
const JISHU_PROMT_PATTERN = /\[JISHU-PROMT:开始\][\s\S]*?\[JISHU-PROMT:结束\]\s*/g;

export function stripJishuPromt(text: string): string {
  return text.replace(JISHU_PROMT_PATTERN, "").trim();
}

export function stripTaskLaunchInstruction(text: string): string {
  const launch = stripTaggedInstruction(
    text,
    "<jishu-task-launch-instruction>",
    "</jishu-task-launch-instruction>",
  );
  const planning = stripTaggedInstruction(
    launch,
    "<jishu-task-planning-stage>",
    "</jishu-task-planning-stage>",
  );
  return planning;
}

function stripTaggedInstruction(text: string, startTag: string, endTag: string): string {
  const start = text.indexOf(startTag);
  const end = text.indexOf(endTag);
  if (start < 0 || end < start) return text;
  const afterInstruction = text.slice(end + endTag.length);
  const chineseMarker = "用户消息：";
  const asciiMarker = "用户消息:";
  const chineseIndex = afterInstruction.indexOf(chineseMarker);
  if (chineseIndex >= 0) {
    return afterInstruction.slice(chineseIndex + chineseMarker.length).trimStart();
  }
  const asciiIndex = afterInstruction.indexOf(asciiMarker);
  if (asciiIndex >= 0) {
    return afterInstruction.slice(asciiIndex + asciiMarker.length).trimStart();
  }
  return afterInstruction.trimStart();
}
