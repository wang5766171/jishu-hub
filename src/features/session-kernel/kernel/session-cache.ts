/**
 * 会话消息缓存（v0.9.3 需求10 / M1②，自 chat-page.tsx 模块级缓存内核化迁出）。
 *
 * 两条不变量（随迁自原注释，违反即复现用户消息重复渲染）：
 * 1. **流式期间不重读 JSONL**：chat 页切管理页被整体卸载（app.tsx 条件渲染），
 *    组件级缓存随之销毁，而 streamStore（模块级）与后端回合仍在运行；重挂载
 *    后缓存必 miss → 重读 JSONL，CLI 已落盘的当前回合用户消息与流式气泡的
 *    pendingUserMessage 各渲染一次。模块级缓存让该不变量跨页面切换保持
 *    （v0.8.0 需求7）。
 * 2. **流式中的条目不收缩**：仍处流式中的缓存条目是流式气泡的消息基线，
 *    驱逐会复现重复渲染；切换项目/agent 或组件重挂载时只驱逐空闲条目
 *    （点击时从 JSONL 重读，与组件级缓存行为一致，顺带内存回收）。
 */
import type { Message } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";

const sessionMessagesCache = new Map<string, Message[]>();

export function getCachedSessionMessages(key: string): Message[] | undefined {
  return sessionMessagesCache.get(key);
}

export function setCachedSessionMessages(key: string, messages: Message[]): void {
  sessionMessagesCache.set(key, messages);
}

export function deleteCachedSessionMessages(key: string): void {
  sessionMessagesCache.delete(key);
}

export function hasCachedSessionMessages(key: string): boolean {
  return sessionMessagesCache.has(key);
}

/** 切换项目/agent 或组件重挂载时收缩缓存（保留流式中条目，见文件头不变量2）。 */
export function evictIdleSessionMessagesCache(): void {
  for (const key of Array.from(sessionMessagesCache.keys())) {
    if (!streamStore.hasState(key)) sessionMessagesCache.delete(key);
  }
}

/** 会话 id 别名迁移（乐观 pendingId → 真实 id，双写保旧键查找兼容窗口）。 */
export function migrateCachedSessionMessages(from: string, to: string): void {
  const cached = sessionMessagesCache.get(from);
  if (cached) {
    sessionMessagesCache.set(to, cached);
    sessionMessagesCache.delete(from);
  }
}
