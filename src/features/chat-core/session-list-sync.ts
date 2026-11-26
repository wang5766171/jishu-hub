/**
 * v0.9.8 需求23 / 评审修复轮 R2（S-11）：把会话列表里某一个会话的消息换成
 * 给定的一份。
 *
 * 侧栏搜索与摘要读的是列表；列表只在读取时从磁盘读一次（此后只有新会话
 * 第一轮结束才重读）。回合结束时把列表里这一项换成正文那一份，列表里的
 * 消息才跟得上对话。
 *
 * 从 chat-page 内联的更新函数里抽出（此前埋在页面里没有单测）：
 *  - 列表里没有这个会话（新会话的第一轮：重读列表后才加进来）→ 不动，
 *    返回原列表；
 *  - 有 → 只换这一项，其余项保持原引用。
 */
import type { Message, Session } from "@/types";

export function replaceSessionMessages(
  sessions: Session[] | null,
  sessionId: string,
  messages: Message[],
): Session[] | null {
  if (!sessions?.some((session) => session.id === sessionId)) return sessions;
  return sessions.map((session) => (session.id === sessionId ? { ...session, messages } : session));
}
