import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { ConfigForm } from "@/components/config/config-form";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Download, Upload } from "lucide-react";
import type { ClaudeConfig } from "@/types";
import type { AdapterConfigPageProps } from "./index";

/**
 * Config page for agents with structured (typed) configuration.
 * Renders ConfigForm with schema-driven fields, plus templates and backups tabs.
 * Used by: claude-code, codex, opencode.
 */
export function StructuredConfigPage({
  configSurface,
  activeAgent,
  agentRefreshKey,
  initialTab = "edit",
  switcherSlot,
}: AdapterConfigPageProps) {
  const { t } = useTranslation();
  const surface = configSurface.kind === "structured" ? configSurface : undefined;
  const schemaId = surface?.schema_id ?? "";
  // v0.7.0 需求一：管理作用域 agent_id（load_config / export/import 必填）。
  const agentId = activeAgent?.id ?? "";

  const { data: config, loading, refetch } = useInvoke<ClaudeConfig>(
    agentId ? "load_config" : "",
    agentId ? { agentId } : undefined,
    agentRefreshKey,
  );

  const [activeTab, setActiveTab] = useState<"edit" | "templates" | "backups">(initialTab);

  const handleConfigSaved = useCallback(() => {
    refetch();
  }, [refetch]);

  const handleExport = async () => {
    try {
      await invokeCommand("export_config_dialog", { agentId });
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Export failed:", err);
      }
    }
  };

  const handleImport = async () => {
    try {
      await invokeCommand("import_config_dialog", { agentId });
      refetch();
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Import failed:", err);
      }
    }
  };

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
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">{t("config.title")}</h2>
          {switcherSlot}
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
            schemaId={schemaId}
            surface={surface}
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
