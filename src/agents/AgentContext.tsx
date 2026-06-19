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

interface AgentContextValue {
  agents: AgentStatus[];
  activeId: string | null;
  active: AgentStatus | null;
  capabilities: CapabilitySet | null;
  setActive: (id: string) => Promise<void>;
  /**
   * Re-probe agent health and refresh the cached list.
   * Pass `silent: true` for local refreshes after a single-item install —
   * it skips the global `healthLoading` flag so the page doesn't flip back
   * into the full-screen loading view. The caller already shows a per-item
   * spinner (installingId / installingMcpId / installingBridgeId).
   */
  refreshHealth: (opts?: { silent?: boolean }) => Promise<void>;
  installHint: (id: string) => string | null;
  /** True while the initial health probe is in flight. */
  healthLoading: boolean;
}

export const AgentContext = createContext<AgentContextValue>(null!);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [list, active] = await Promise.all([
        safeInvoke<AgentStatus[]>("agent_list_statuses"),
        safeInvoke<string>("agent_get_active"),
      ]);
      if (list) setAgents(list);
      if (active) setActiveId(active);
      setHealthLoading(true);
      await safeInvoke("agent_refresh_health");
      const refreshed = await safeInvoke<AgentStatus[]>("agent_list_statuses");
      if (refreshed) setAgents(refreshed);
      setHealthLoading(false);
    })();
  }, []);

  const setActive = useCallback(async (id: string) => {
    await safeInvoke("agent_set_active", { id });
    setActiveId(id);
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

  const active = useMemo(
    () => agents.find((a) => a.id === activeId) ?? null,
    [agents, activeId],
  );

  const capabilities = useMemo(
    () => (active ? new CapabilitySet(active.capabilities) : null),
    [active],
  );

  const installHint = useCallback(
    (id: string) => agents.find((a) => a.id === id)?.install_hint ?? null,
    [agents],
  );

  return (
    <AgentContext.Provider
      value={{
        agents,
        activeId,
        active,
        capabilities,
        setActive,
        refreshHealth,
        installHint,
        healthLoading,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export const useAgent = () => useContext(AgentContext);
