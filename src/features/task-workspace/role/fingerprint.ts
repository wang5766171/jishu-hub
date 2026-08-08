/**
 * 三角色派发指纹工具（需求五 · 方案 A）。
 *
 * 设计依据：docs/task-exec-dev/02-总体设计.md §7.1。
 *
 * 思路：后端 `orchestrator_list_attempt_dispatches` 返回该节点所有 attempt 的派发 prompt，
 * 归一化 + hash 后放入指纹集合；渲染 user 消息时，若其文本命中指纹集合，则判定为
 * 「主进程派发」（任务助手），否则为「真人」（默认）。
 *
 * 命中失败安全降级为普通 user 消息（= 现状），不会出错、不丢消息。
 */
import type { Message, ContentBlock } from "@/types";
import type { MessageRoleView } from "@/components/sessions/message-view";

/** 归一化：trim + 折叠连续空白为单空格。 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * 确定性字符串 hash（djb2）。仅用于内容指纹比对，无需加密强度。
 * 同输入恒同输出，跨会话/刷新稳定。
 */
export function hashString(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** 从消息中提取 user 纯文本（拼接所有 text block）。 */
export function extractUserText(msg: Message): string {
  if (msg.role !== "user") return "";
  return msg.content
    .filter((b: ContentBlock): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** 由派发 prompt 列表构建指纹集合。 */
export function buildDispatchFingerprints(prompts: string[]): Set<string> {
  return new Set(prompts.map((p) => hashString(normalizeText(p))));
}

/**
 * 构造角色解析器。用于 `MessageView` 的 `roleResolver`。
 * - user 消息命中派发指纹 → 返回 orchestrator 视图（任务助手）
 * - 否则返回 null（走默认 user 渲染）
 * - 非 user 消息 → null（assistant 走默认）
 */
export function makeDispatchRoleResolver(
  fingerprints: Set<string>,
  label: string,
): (msg: Message) => MessageRoleView | null {
  return (msg: Message) => {
    if (msg.role !== "user") return null;
    const text = extractUserText(msg);
    if (!text) return null;
    return fingerprints.has(hashString(normalizeText(text)))
      ? { role: "orchestrator", label, align: "right", tone: "primary" }
      : null;
  };
}

/**
 * 指纹未命中时的备选锚点：派发时间 `dispatchedAt` 与消息落盘时间 ±容差匹配。
 * 设计 §7.1：指纹为主、时间戳为辅。两者都未命中仍降级为现状两角色。
 *
 * 仅当后端能给出消息的 created_at 时使用；当前前端 Message 无 created_at 字段，
 * 故本函数预留接口，调用方需自行提供消息时间映射。
 */
export function makeTimestampRoleResolver(
  dispatchedAtMs: number[],
  toleranceMs: number,
  label: string,
): (msg: Message) => MessageRoleView | null {
  return (msg: Message) => {
    if (msg.role !== "user") return null;
    // 当前 Message 类型无 created_at，无法直接比对；调用方应在能拿到时间时替换此实现。
    void msg;
    for (const ts of dispatchedAtMs) {
      if (Math.abs(ts - 0) <= toleranceMs) {
        return { role: "orchestrator", label, align: "right", tone: "primary" };
      }
    }
    return null;
  };
}
