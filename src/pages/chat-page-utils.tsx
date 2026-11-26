// chat-page 的模块级助手：纯函数、类型与消息清洗逻辑（v0.7.3 需求1-M5 从 chat-page.tsx 机械提取，无逻辑变化）。
import type * as React from "react";

import type { SessionStreamState } from "@/hooks/use-stream-store";
import type {
  ContentBlock,
  ConversationInteractionRequest,
  Message,
  Session,
} from "@/types";

// 「哪些用户消息看得见」在下层（features/chat-core/visible-user-messages.ts）：
// 搜索域与页面层都读它，features/ 不能反过来引用页面层。这里再导出。
export { filterInvisibleUserMessages } from "@/features/chat-core/visible-user-messages";

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
      view: tool.view,
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

/**
 * v0.9.8 需求2 D2-1/D2-3：编辑重发失败回滚（纯函数，从
 * handleEditLastUserMessage 的 catch 抽出补回归锁）。
 *
 * 行为规格（用户视角）：
 * - cut >= 0（本地定位到原文）：恢复到截断点前缀 `msgs.slice(0, cut)`——
 *   乐观追加的编辑消息从缓存与视图移除；
 * - cut < 0（本地找不到原文，D2-3 收敛）：**不再全量恢复 msgs**（旧逻辑
 *   会把已被后端截断删除的旧消息复活闪现）——返回 reload 信号，调用方
 *   从后端拉权威态覆盖本地缓存；
 * - 回填文本恒为编辑后的外发文本（outgoing），用户可改后手动重发。
 */
export interface EditResendRollback {
  /** true = 本地列表不可信，调用方应从后端重载会话消息。 */
  reload: boolean;
  /** reload=false 时：恢复到截断点的前缀列表。 */
  messages?: Message[];
  /** 回填输入框的文本。 */
  restoreText: string;
}

export function applyEditResendRollback(
  msgs: Message[],
  cut: number,
  outgoing: string,
): EditResendRollback {
  if (cut < 0) {
    return { reload: true, restoreText: outgoing };
  }
  return { reload: false, messages: msgs.slice(0, cut), restoreText: outgoing };
}
