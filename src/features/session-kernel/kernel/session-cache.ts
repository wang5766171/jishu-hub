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
import { devLog } from "@/lib/dev-log";

const sessionMessagesCache = new Map<string, Message[]>();

/** 需求9 补充2（opencode 式直渲染）：缓存条目上限——跨项目常驻后防无界
 * 增长；超限删最旧的非流式条目（Map 迭代序=插入序；流式条目受不变量2
 * 保护不可删）。 */
const CACHE_MAX_ENTRIES = 200;

export function getCachedSessionMessages(key: string): Message[] | undefined {
  return sessionMessagesCache.get(key);
}

/** v0.9.8 需求13 复测取证：user 消息指纹（条数/去重数/前 12 字原序列表）。
 * 与后端读取层（commands/sessions.rs req13_user_fingerprints）同口径——
 * 两层对照即可锁定重复注入发生在哪一层。 */
export function userFingerprints(messages: Message[]): {
  total: number;
  uniq: number;
  fps: string[];
} {
  const fps = messages
    .filter((m) => m.role === "user")
    .map((m) => {
      const block = m.content.find((b) => b.type === "text") as { text?: string } | undefined;
      return (block?.text ?? "").slice(0, 12);
    });
  return { total: fps.length, uniq: new Set(fps).size, fps };
}

export function setCachedSessionMessages(key: string, messages: Message[]): void {
  sessionMessagesCache.set(key, messages);
  // v0.9.8 需求13 复测取证：缓存总闸指纹——所有消息写入路径（本地提交/
  // 回合收口/刷新拉取/编辑/清理）都过此函数。uniq<total = 列表内已有
  // 同文本多份（重复渲染直接信号）；streamPending 显示写入时刻流式
  // pendingUserMessage 是否在场——与 fp 同前缀 = 历史+流式叠加双渲染风险。
  const fp = userFingerprints(messages);
  const dup = fp.uniq < fp.total;
  const streamPending = streamStore.getState(key)?.pendingUserMessage?.slice(0, 12) ?? null;
  devLog(
    "session",
    `[req13] 缓存写入${dup ? "[!重复]" : ""} total=${messages.length} user=${fp.total} uniq=${fp.uniq}`,
    { key, fps: fp.fps, dup, streamPending },
  );
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
