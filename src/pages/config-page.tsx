import { useAgent } from "@/agents";
import { AgentSwitcher } from "@/agents";
import { getAdapterConfigPage } from "@/agents/config-pages";

/**
 * Configuration page — thin shell that delegates to the management-scope
 * agent's adapter config page component based on ConfigSurface.kind.
 *
 * v0.7.0 需求一：管理作用域智能体切换。顶部嵌入 AgentSwitcher（manageAgentId 作用域），
 * 与会话页面互不影响。
 */
export function ConfigPage({
  initialTab = "edit",
}: {
  initialTab?: "edit" | "templates" | "backups";
}) {
  // v0.7.0：管理作用域状态（manageAgentId 替代全局 activeId）。
  const { manageAgentId, manageAgent, setManageAgent } = useAgent();
  const activeId = manageAgentId;
  const active = manageAgent;
  const agentRefreshKey = activeId
    ? Array.from(activeId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0)
    : 0;
  const configSurface = active?.config_surface ?? { kind: "unsupported" as const };

  const AdapterPage = getAdapterConfigPage(configSurface.kind);
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <AdapterPage
          configSurface={configSurface}
          activeAgent={active ?? null}
          agentRefreshKey={agentRefreshKey}
          initialTab={initialTab}
          switcherSlot={
            <AgentSwitcher value={activeId} onChange={setManageAgent}>
              {active && (
                <span className="text-[11px] font-medium text-muted-foreground">{active.display_name}</span>
              )}
            </AgentSwitcher>
          }
        />
      </div>
    </div>
  );
}
