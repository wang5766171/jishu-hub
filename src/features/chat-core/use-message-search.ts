/**
 * 消息搜索域 hook（v0.9.0 需求7：chat-page 其余域拆分——D 域搜索子域）。
 *
 * 自 chat-page.tsx 纯移动（零逻辑变更）：会话列表搜索框的受控状态 +
 * useDeferredValue 惰性查询 + 消息内命中导航（状态/导航回调/清零 effect）。
 * 外部依赖仅两个只读值（sessions / selectedSession），符合「窄接口」边界问。
 * 写入点全部在域内（无跨域 setter 调用）——勘察报告评估为四域中最自包含。
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { ensureToolCatalog, getToolNames, subscribeToolCatalog } from "@/lib/tool-catalog";
import type { MessageSearchNavigation, MessageSearchStatus } from "@/components/sessions/message-view";
import { searchSessions } from "@/lib/session-search";
import { filterInvisibleUserMessages } from "@/features/chat-core/visible-user-messages";
import type { Session, SessionSearchResult } from "@/types";

export interface UseMessageSearchOptions {
  /** 会话列表（只读；null = 未加载）。 */
  sessions: Session[] | null;
  /** 当前选中会话（"new"/null 时不显示消息内搜索控件）。 */
  selectedSession: string | null;
}

export interface MessageSearchState {
  query: string;
  setQuery: (value: string) => void;
  deferredQuery: string;
  /** 列表搜索命中（deferred）。 */
  searchResults: SessionSearchResult[];
  hasSearchQuery: boolean;
  /** 是否显示消息内命中导航（有查询且选中真实会话）。 */
  showMessageSearchControls: boolean;
  status: MessageSearchStatus;
  handleStatusChange: (status: MessageSearchStatus) => void;
  navigation: MessageSearchNavigation | null;
  requestNavigation: (direction: 1 | -1) => void;
  total: number;
  label: string;
}

export function useMessageSearch({
  sessions,
  selectedSession,
}: UseMessageSearchOptions): MessageSearchState {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [status, setStatus] = useState<MessageSearchStatus>({ current: 0, total: 0 });
  const [navigation, setNavigation] = useState<MessageSearchNavigation | null>(null);

  // v0.9.8 评审修复轮 R2（S-18）：侧栏搜索读的消息与正文是同一份——正文
  // 显示前先过滤掉不可见的用户消息（注入的方法论消息、空消息），这里让
  // 列表里的消息过同一个过滤：搜得到的条目正文里都找得到，命中数也对得上。
  // 没有不可见消息的会话保留原对象（多数会话如此，不白建一份）。
  const searchableSessions = useMemo<Session[] | null>(() => (
    sessions?.map((session) => {
      const visible = filterInvisibleUserMessages(session.messages);
      return visible.length === session.messages.length ? session : { ...session, messages: visible };
    }) ?? null
  ), [sessions]);

  // 工具名映射（哪些标签跟在正文后面、它们的原始文本）：搜索文本要带上标签的
  // `@[显示名]`，映射取回前后算出的命中会不同——订阅它，取回时重算。
  // 工具名映射直接读工具目录（不绕组件目录——features/ 不反向依赖组件，二轮评审 R3 P2-13）：
  // 订阅它的变更，挂载时确保目录在取。
  const toolNames = useSyncExternalStore(subscribeToolCatalog, getToolNames, getToolNames);
  useEffect(() => {
    ensureToolCatalog(null);
  }, []);

  const searchResults = useMemo<SessionSearchResult[]>(() => {
    if (!searchableSessions || !deferredQuery.trim()) return [];
    return searchSessions(searchableSessions, deferredQuery, toolNames);
  }, [searchableSessions, deferredQuery, toolNames]);

  const hasSearchQuery = query.trim().length > 0;
  const showMessageSearchControls =
    hasSearchQuery && !!selectedSession && selectedSession !== "new";

  const total = showMessageSearchControls ? status.total : 0;
  const label = total > 0 ? `${status.current}/${total}` : "0/0";

  const requestNavigation = useCallback((direction: 1 | -1) => {
    setNavigation((prev) => ({
      direction,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, []);

  const handleStatusChange = useCallback((next: MessageSearchStatus) => {
    setStatus((prev) =>
      prev.current === next.current && prev.total === next.total ? prev : next,
    );
  }, []);

  // 控件隐藏（清空查询/离开会话）时清零命中计数。
  useEffect(() => {
    if (!showMessageSearchControls) {
      setStatus({ current: 0, total: 0 });
    }
  }, [showMessageSearchControls]);

  return {
    query,
    setQuery,
    deferredQuery,
    searchResults,
    hasSearchQuery,
    showMessageSearchControls,
    status,
    handleStatusChange,
    navigation,
    requestNavigation,
    total,
    label,
  };
}
