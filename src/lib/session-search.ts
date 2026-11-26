/**
 * 侧栏会话搜索（v0.9.8 需求23：计数与摘要改用「用户看得见的文字」）。
 *
 * 范围是当前项目的会话列表。文本取自 blockSearchText——与气泡显示、正文区
 * 搜索同一出处：摘要不再露出内部注入标记，命中数与正文里的黄底数一致。
 *
 * v0.9.8 评审修复轮 R2：用户消息里跟在正文后面的工具标签按原始文本 `@[显示名]`
 * 计入。显示名取自工具目录（全局一份，与气泡里的标签同源）——会话没打开过也认得
 * 出标签。调用方传了映射就用传进来的（随映射更新重新计算）。
 */
import type { Session, Message, SessionSearchResult } from "@/types";
import { blockSearchText, countMatches, searchRegExp } from "./session-search-text";
import { getToolNames } from "./tool-catalog";

function extractPreviewText(message: Message, q: string, toolNames: Readonly<Record<string, string>>): string {
  for (const block of message.content) {
    if (block.type !== "text") continue;
    const text = blockSearchText(block, message.role, toolNames);
    const idx = text.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 20);
      const end = Math.min(text.length, idx + q.length + 40);
      const snippet = text.slice(start, end).replace(/\s+/g, " ");
      return (start > 0 ? "..." : "") + snippet + (end < text.length ? "..." : "");
    }
  }
  return "";
}

export function searchSessions(
  sessions: Session[],
  query: string,
  toolNames: Readonly<Record<string, string>> = getToolNames(),
): SessionSearchResult[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const regex = searchRegExp(query);
  const results: SessionSearchResult[] = [];

  for (const session of sessions) {
    let matchCount = 0;
    let firstMatchIndex = -1;
    let previewText = "";

    for (let i = 0; i < session.messages.length; i++) {
      const message = session.messages[i];
      let messageHasMatch = false;

      // 只数文字块里的命中——与正文区的搜索口径一致（正文里只有文字块参与
      // 命中导航），侧栏徽标数才会和正文里的计数对得上。
      for (const block of message.content) {
        if (block.type !== "text") continue;
        const count = countMatches(blockSearchText(block, message.role, toolNames), regex);
        if (count > 0) {
          matchCount += count;
          messageHasMatch = true;
        }
      }

      if (messageHasMatch && firstMatchIndex === -1) {
        firstMatchIndex = i;
        previewText = extractPreviewText(message, q, toolNames);
      }
    }

    if (matchCount > 0) {
      results.push({
        sessionId: session.id,
        matchCount,
        previewText: previewText.slice(0, 120),
        firstMatchIndex,
      });
    }
  }

  return results.sort((a, b) => b.matchCount - a.matchCount);
}
