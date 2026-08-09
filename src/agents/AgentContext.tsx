import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { type AgentStatus, CapabilitySet } from "./types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

const CHAT_AGENT_KEY = "jishu-hub.chatAgentId";
const MANAGE_AGENT_KEY = "jishu-hub.manageAgentId";

interface AgentContextValue {
  /** 全部智能体列表（全局共享，无作用域） */
  agents: AgentStatus[];
  /** 会话作用域选中的智能体 id（驱动会话派发与左侧列表） */
  chatAgentId: string | null;
  /** 管理作用域选中的智能体 id（驱动配置/命令页） */
  manageAgentId: string | null;
  /** 派生：会话作用域的 AgentStatus 对象 */
  chatAgent: AgentStatus | null;
  /** 派生：管理作用域的 AgentStatus 对象 */
  manageAgent: AgentStatus | null;
  /** 派生：会话作用域能力集 */
  chatCapabilities: CapabilitySet | null;
  /** 设置会话作用域智能体（仅前端状态，不入参后端持久化） */
  setChatAgent: (id: string) => void;
  /** 设置管理作用域智能体（仅前端状态，不入参后端持久化） */
  setManageAgent: (id: string) => void;
  /**
   * Re-probe agent health and refresh the cached list.
   * Pass `silent: true` for local refreshes after a single-item install —
   * it skips the global `healthLoading` flag so the page doesn't flip back
   * into the full-screen loading view. The caller already shows a per-item
   * spinner (installingId / installingMcpId / installingBridgeId).
   */
  refreshHealth: (opts?: { silent?: boolean }) => Promise<void>;
  /** True while the initial health probe is in flight. */
  healthLoading: boolean;
}

export const AgentContext = createContext<AgentContextValue>(null!);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [chatAgentId, setChatAgentIdState] = useState<string | null>(null);
  const [manageAgentId, setManageAgentIdState] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  useEffect(() => {
    (async () => {
      // v0.7.0：全局 active agent 已移除。初始化只拉取 agents 列表，
      // 会话/管理作用域的选择从 localStorage 记忆恢复，兜底首个可用 agent。
      const list = await safeInvoke<AgentStatus[]>("agent_list_statuses");
      if (list && list.length > 0) {
        setAgents(list);
        // 恢复会话作用域记忆，兜底第一个 agent
        const savedChat = localStorage.getItem(CHAT_AGENT_KEY);
        const fallbackChat = list.find((a) => a.health.installed)?.id ?? list[0].id;
        setChatAgentIdState(savedChat && list.some((a) => a.id === savedChat) ? savedChat : fallbackChat);
        // 恢复管理作用域记忆
        const savedManage = localStorage.getItem(MANAGE_AGENT_KEY);
        const fallbackManage = list.find((a) => a.health.installed)?.id ?? list[0].id;
        setManageAgentIdState(savedManage && list.some((a) => a.id === savedManage) ? savedManage : fallbackManage);
      }
      setHealthLoading(true);
      await safeInvoke("agent_refresh_health");
      const refreshed = await safeInvoke<AgentStatus[]>("agent_list_statuses");
      if (refreshed) setAgents(refreshed);
      setHealthLoading(false);
    })();
  }, []);

  const setChatAgent = useCallback((id: string) => {
    localStorage.setItem(CHAT_AGENT_KEY, id);
    setChatAgentIdState(id);
  }, []);

  const setManageAgent = useCallback((id: string) => {
    localStorage.setItem(MANAGE_AGENT_KEY, id);
    setManageAgentIdState(id);
  }, []);

  const refreshHealth = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      if (!silent) setHealthLoading(true);
      try {
        await safeInvoke("agent_refresh_health");
        const list = await safeInvoke<AgentStatus[]>("agent_list_statuses");
        if (list) setAgents(list);
      } finally {
        if (!silent) setHealthLoading(false);
      }
    },
    []
  );

  const chatAgent = useMemo(
    () => agents.find((a) => a.id === chatAgentId) ?? null,
    [agents, chatAgentId],
  );

  const manageAgent = useMemo(
    () => agents.find((a) => a.id === manageAgentId) ?? null,
    [agents, manageAgentId],
  );

  const chatCapabilities = useMemo(
    () => (chatAgent ? new CapabilitySet(chatAgent.capabilities) : null),
    [chatAgent],
  );

  return (
    <AgentContext.Provider
      value={{
        agents,
        chatAgentId,
        manageAgentId,
        chatAgent,
        manageAgent,
        chatCapabilities,
        setChatAgent,
        setManageAgent,
        refreshHealth,
        healthLoading,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export const useAgent = () => useContext(AgentContext);
