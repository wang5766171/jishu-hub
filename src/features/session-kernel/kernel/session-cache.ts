/**
 * 会话消息缓存（v0.9.3 需求10 / M1②，自 chat-page.tsx 模块级缓存内核化迁出）。
 *
 * 两条不变量（违反即复现用户消息重复渲染）：
 * 1. **流式期间不重读 JSONL**：chat 页切管理页被整体卸载（app.tsx 条件渲染），
 *    组件级缓存随之销毁，而 streamStore（模块级）与后端回合仍在运行；重挂载
 *    后缓存必 miss → 重读 JSONL，CLI 已落盘的当前回合用户消息与流式气泡的
 *    pendingUserMessage 各渲染一次。模块级缓存让该不变量跨页面切换保持
 *    （v0.8.0 需求7）。
 * 2. **流式中的条目不可驱逐**：仍处流式中的缓存条目是流式气泡的消息基线，
 *    驱逐会复现重复渲染。
 *
 * v0.9.7 需求9 补充2（opencode 式直渲染）：缓存**跨项目常驻**（原「切换
 * 项目/agent 时驱逐空闲条目」退役——那是切标签必重读 JSONL 的主因），
 * 切回标签零 IO 直出；内存由 CACHE_MAX_ENTRIES 上限保护（超限删最旧
 * 非流式条目）。
 */
import type { Message } from "@/types";
import { streamStore } from "@/hooks/use-stream-store";

const sessionMessagesCache = new Map<string, Message[]>();

/** 需求9 补充2（opencode 式直渲染）：缓存条目上限——跨项目常驻后防无界
 * 增长；超限删最旧的非流式条目（Map 迭代序=插入序；流式条目受不变量2
 * 保护不可删）。 */
const CACHE_MAX_ENTRIES = 200;

export function getCachedSessionMessages(key: string): Message[] | undefined {
  return sessionMessagesCache.get(key);
}

export function setCachedSessionMessages(key: string, messages: Message[]): void {
  sessionMessagesCache.set(key, messages);
  if (sessionMessagesCache.size > CACHE_MAX_ENTRIES) {
    for (const k of Array.from(sessionMessagesCache.keys())) {
      if (sessionMessagesCache.size <= CACHE_MAX_ENTRIES) break;
      if (k !== key && !streamStore.hasState(k)) sessionMessagesCache.delete(k);
    }
  }
}

export function deleteCachedSessionMessages(key: string): void {
  sessionMessagesCache.delete(key);
}

export function hasCachedSessionMessages(key: string): boolean {
  return sessionMessagesCache.has(key);
}

/** 兼容保留（v0.9.7 需求9 补充2 起无调用方——切换驱逐语义退役，见文件头）。 */
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
