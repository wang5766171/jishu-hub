import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { ConfigForm } from "@/components/config/config-form";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import { ModelManager } from "@/components/config/model-manager";
import { RawConfigEditor } from "@/components/config/raw-config-editor";
import { McpEditor } from "@/components/config/mcp-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Download, Upload } from "lucide-react";
import { useAgent } from "@/agents";
import type { ClaudeConfig } from "@/types";

interface RawConfigInfo {
  content: string;
  format: string;
}

export function ConfigPage({
  initialTab = "edit",
}: {
  initialTab?: "edit" | "templates" | "backups";
}) {
  const { t } = useTranslation();
  const { activeId, active } = useAgent();
  const agentRefreshKey = activeId ? Array.from(activeId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) : 0;
  const configSurface = active?.config_surface ?? { kind: "unsupported" as const };
  const surfaceKind = configSurface.kind;

  const { data: config, loading, refetch } = useInvoke<ClaudeConfig>(
    surfaceKind === "structured" ? "load_config" : "",
    undefined,
    surfaceKind === "structured" ? agentRefreshKey : 0,
  );
  const { data: rawConfig, loading: rawLoading, refetch: refetchRaw } = useInvoke<RawConfigInfo>(
    surfaceKind === "raw" ? "load_raw_config" : "",
    undefined,
    surfaceKind === "raw" ? agentRefreshKey : 0,
  );
  const supportsMcp = surfaceKind === "model_store" && (configSurface as { kind: "model_store"; supports_mcp: boolean }).supports_mcp;
  const { data: agentConfig, refetch: refetchAgentConfig } = useInvoke<Record<string, unknown>>(
    supportsMcp ? "load_config" : "",
    undefined,
    supportsMcp ? agentRefreshKey : 0,
  );
  const [activeTab, setActiveTab] = useState<"edit" | "templates" | "backups">(initialTab);

  const handleConfigSaved = useCallback(() => {
    refetch();
  }, [refetch]);

  const handleRawSaved = useCallback(() => {
    refetchRaw();
  }, [refetchRaw]);

  const handleExport = async () => {
    try {
      await invokeCommand("export_config_dialog");
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Export failed:", err);
      }
    }
  };

  const handleImport = async () => {
    try {
      await invokeCommand("import_config_dialog");
      refetch();
      refetchAgentConfig();
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Import failed:", err);
      }
    }
  };

  if (surfaceKind === "model_store") {
    const tabs: Array<{ key: "edit" | "templates" | "backups"; label: string }> = [
      { key: "edit", label: t("config.modelManager") },
      { key: "templates", label: t("config.templates") },
      { key: "backups", label: t("config.backups") },
    ];

    const handleMcpChange = async (mcpServers: Record<string, unknown> | null) => {
      if (!agentConfig) return;
      const merged = { ...agentConfig, mcpServers };
      await invokeCommand("save_config", { config: merged });
      refetchAgentConfig();
    };

    return (
      <div className="flex flex-col h-full p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">{t("config.title")}</h2>
            {active && (
              <p className="mt-1 text-xs text-muted-foreground">
                {active.display_name}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="mr-2 h-4 w-4" />
              {t("config.export")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleImport}>
              <Upload className="mr-2 h-4 w-4" />
              {t("config.import")}
            </Button>
          </div>
        </div>

        <div className="flex gap-1 border-b border-border pb-0">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto pt-4">
          {activeTab === "edit" && (
            <>
              <ModelManager />
              {supportsMcp && agentConfig && (
                <div className="mt-6">
                  <McpEditor
                    value={(agentConfig as Record<string, unknown> & { mcpServers?: Record<string, unknown> | null }).mcpServers ?? null}
                    onChange={handleMcpChange}
                    standalone
                  />
                </div>
              )}
            </>
          )}
          {activeTab === "templates" && (
            <TemplateManager onApplied={refetch} />
          )}
          {activeTab === "backups" && (
            <BackupManager onRestored={refetch} />
          )}
        </div>
      </div>
    );
  }

  if (surfaceKind === "raw") {
    if (rawLoading || !rawConfig) {
      return <Skeleton className="h-64" />;
    }
    return (
      <div className="flex flex-col h-full p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">{t("config.title")}</h2>
            {active && (
              <p className="mt-1 text-xs text-muted-foreground">
                {active.display_name}
              </p>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t("config.nativeFormatHint")}
          </p>
        </div>
        <div className="flex-1 min-h-0">
          <RawConfigEditor
            initialContent={rawConfig.content}
            format={rawConfig.format}
            onSaved={handleRawSaved}
          />
        </div>
      </div>
    );
  }

  if (surfaceKind === "unsupported") {
    return <div className="text-muted-foreground">{t("config.loadFailed")}</div>;
  }

  if (loading) {
    return <Skeleton className="h-64" />;
  }

  if (!config) {
    return <div className="text-muted-foreground">{t("config.loadFailed")}</div>;
  }

  const tabs: Array<{ key: "edit" | "templates" | "backups"; label: string }> = [
    { key: "edit", label: t("config.editConfig") },
    { key: "templates", label: t("config.templates") },
    { key: "backups", label: t("config.backups") },
  ];

  return (
    <div className="flex flex-col h-full p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("config.title")}</h2>
          {active && (
            <p className="mt-1 text-xs text-muted-foreground">
              {active.display_name}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="mr-2 h-4 w-4" />
            {t("config.export")}
          </Button>
          <Button variant="outline" size="sm" onClick={handleImport}>
            <Upload className="mr-2 h-4 w-4" />
            {t("config.import")}
          </Button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border pb-0">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pt-4">
        {activeTab === "edit" && (
          <ConfigForm
            config={config}
            onSaved={handleConfigSaved}
            schemaId={configSurface.kind === "structured" ? configSurface.schema_id : ""}
            surface={configSurface.kind === "structured" ? configSurface : undefined}
          />
        )}
        {activeTab === "templates" && (
          <TemplateManager onApplied={refetch} />
        )}
        {activeTab === "backups" && (
          <BackupManager onRestored={refetch} />
        )}
      </div>
    </div>
  );
}
