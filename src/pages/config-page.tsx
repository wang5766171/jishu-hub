import { useAgent } from "@/agents";
import { getAdapterConfigPage } from "@/agents/config-pages";

/**
 * Configuration page — thin shell that delegates to the active agent's
 * adapter config page component based on ConfigSurface.kind.
 */
export function ConfigPage({
  initialTab = "edit",
}: {
  initialTab?: "edit" | "templates" | "backups";
}) {
  const { activeId, active } = useAgent();
  const agentRefreshKey = activeId
    ? Array.from(activeId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0)
    : 0;
  const configSurface = active?.config_surface ?? { kind: "unsupported" as const };

  const AdapterPage = getAdapterConfigPage(configSurface.kind);
  return (
    <AdapterPage
      configSurface={configSurface}
      activeAgent={active ?? null}
      agentRefreshKey={agentRefreshKey}
      initialTab={initialTab}
    />
  );
}
