/**
 * v0.9.8 评审修复轮 R2（S-17）：按会话提交消息与「删除未送达」。
 *
 * 问题：「删除未送达」与编辑重发的回滚重载都以**当前正文**为数据源、在
 * await 之后无条件写回正文——而正文是跟着「选中的会话」走的。一次 IPC 往返
 * 期间用户切走再切回：别的会话的消息被当成这个会话的过滤后写进它的缓存
 * （缓存常驻，污染留到重启），正文的 setter 又把它盖到另一个会话上。
 *
 * 规则：
 *  - 某个会话的数据只从**该会话的缓存**取、只写该会话的缓存（按会话键，
 *    与界面停在哪个会话无关）；
 *  - 正文是选中会话的视图：回执到达时仍选中该会话才同步正文。
 */
import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import {
  getCachedSessionMessages,
  setCachedSessionMessages,
} from "@/features/session-kernel/kernel/session-cache";
import type { Message } from "@/types";
import { isNoSessionSelected } from "@/features/session-kernel/session-placeholder";

export interface SessionViewDeps {
  /** 此刻选中的会话（读 .current——回执到达时的值，不是发起时的值）。 */
  selectedSessionRef: MutableRefObject<string | null>;
  setSessionMessages: Dispatch<SetStateAction<Message[]>>;
}

/** 写该会话的缓存；仍选中该会话时同步正文。 */
export function commitSessionMessages(
  sessionId: string,
  messages: Message[],
  deps: Pick<SessionViewDeps, "selectedSessionRef" | "setSessionMessages">,
): void {
  setCachedSessionMessages(sessionId, messages);
  if (deps.selectedSessionRef.current === sessionId) {
    deps.setSessionMessages(messages);
  }
}

/** 去掉指定发送时刻的那条「未送达」消息。 */
export function removeUnsentMessage(messages: Message[], sentAt: number): Message[] {
  return messages.filter((message) => !(message.unsent && message.timestamp === sentAt));
}

/**
 * 删除一条「未送达」消息：后端按（会话，发送时刻）删除；本地从该会话的
 * 缓存里移除这一条。后端删除失败时本地不动。
 */
export function useUnsentMessageDismiss(deps: SessionViewDeps) {
  const { selectedSessionRef, setSessionMessages } = deps;
  return useCallback(
    async (msg: Message) => {
      const sid = selectedSessionRef.current;
      if (!sid || isNoSessionSelected(sid) || msg.timestamp == null) return;
      try {
        await invokeCommand("dismiss_pending_message", {
          sessionId: sid,
          sentAt: msg.timestamp,
        });
      } catch (err) {
        console.error("dismiss_pending_message failed:", err);
        return;
      }
      const cached = getCachedSessionMessages(sid);
      if (!cached) return;
      commitSessionMessages(sid, removeUnsentMessage(cached, msg.timestamp), { selectedSessionRef, setSessionMessages });
    },
    [selectedSessionRef, setSessionMessages],
  );
}
