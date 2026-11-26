// 「哪些用户消息看得见」——回放正文与侧栏搜索共用的同一条规则。
//
// 放在 chat-core（不放在页面层）：搜索域（use-message-search.ts）与页面层都要读它，
// features/ 不能反过来引用页面层（二轮评审 R3 域 1 的 P2-7）。

import type { Message } from "@/types";

/**
 * 过滤界面上不该显示的用户消息：
 * 1. Conductor before_agent_start 注入的方法论消息（skill 全文，display:false
 *    但引擎仍写会话文件）——以 [JISHU-TASK: 开头；
 * 2. 文本内容为空的 user 消息（纯系统注入残留）。
 * v0.9.5 用户裁决：历史格式兼容剥离（[JISHU-PROMT] 配对块 / 旧
 * <jishu-task-*> 标签）整体移除，不保留兜底。
 */
export function filterInvisibleUserMessages(messages: Message[]): Message[] {
  return messages
    .filter((message) => {
      if (message.role !== "user") return true;
      const firstText = message.content.find((b) => b.type === "text");
      if (!firstText || firstText.type !== "text") return true;
      // Conductor 注入消息以 [JISHU-TASK: 开头
      if (firstText.text.trimStart().startsWith("[JISHU-TASK:")) return false;
      return true;
    })
    .filter((message) => {
      if (message.role !== "user") return true;
      const hasVisibleContent = message.content.some((block) => {
        if (block.type === "text") return block.text.trim().length > 0;
        return true; // 非文本块（interaction/tool 等）保留
      });
      return hasVisibleContent;
    });
}
