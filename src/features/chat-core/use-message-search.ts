/**
 * 消息搜索域 hook（v0.9.0 需求7：chat-page 其余域拆分——D 域搜索子域）。
 *
 * 自 chat-page.tsx 纯移动（零逻辑变更）：会话列表搜索框的受控状态 +
 * useDeferredValue 惰性查询 + 消息内命中导航（状态/导航回调/清零 effect）。
 * 外部依赖仅两个只读值（sessions / selectedSession），符合「窄接口」边界问。
 * 写入点全部在域内（无跨域 setter 调用）——勘察报告评估为四域中最自包含。
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import type { MessageSearchNavigation, MessageSearchStatus } from "@/components/sessions/message-view";
import { searchSessions } from "@/lib/session-search";
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

  const searchResults = useMemo<SessionSearchResult[]>(() => {
    if (!sessions || !deferredQuery.trim()) return [];
    return searchSessions(sessions, deferredQuery);
  }, [sessions, deferredQuery]);

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
