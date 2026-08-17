import { useAgent } from "@/agents";
import { AgentSwitcher } from "@/agents";
import { getAdapterConfigPage } from "@/agents/config-pages";
import type { AgentConfigSection } from "@/types";

/**
 * Configuration page — thin shell that delegates to the management-scope
 * agent's adapter config page component based on ConfigSurface.kind.
 *
 * v0.7.0 需求一：管理作用域智能体切换。顶部嵌入 AgentSwitcher（manageAgentId 作用域），
 * 与会话页面互不影响。
 *
 * v0.7.4 需求2 R4：管理页侧边栏「智能体设置」分组提供四个子页
 * （模型设置/行为与权限/配置模版/高级设置），由 configTab 指定。
 */
export function ConfigPage({
  configTab = "models",
}: {
  configTab?: AgentConfigSection;
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
          configTab={configTab}
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
