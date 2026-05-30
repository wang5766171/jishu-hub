import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { ConfigForm } from "@/components/config/config-form";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Download, Upload } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAgent } from "@/agents";
import type { ClaudeConfig } from "@/types";

export function ConfigPage({ initialTab = "edit" }: { initialTab?: "edit" | "templates" | "backups" }) {
  const { t } = useTranslation();
  const { activeId } = useAgent();
  const agentRefreshKey = activeId ? Array.from(activeId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) : 0;
  const { data: config, loading, refetch } = useInvoke<ClaudeConfig>("load_config", undefined, agentRefreshKey);
  const [activeTab, setActiveTab] = useState<"edit" | "templates" | "backups">(initialTab);

  const handleConfigSaved = useCallback(() => {
    refetch();
  }, [refetch]);

  const handleExport = async () => {
    const path = await open({
      defaultPath: `${activeId || "agent"}-settings.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (path) {
      try {
        await invokeCommand("export_config", { path });
      } catch (err) {
        console.error("Export failed:", err);
      }
    }
  };

  const handleImport = async () => {
    const path = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });
    if (path) {
      try {
        await invokeCommand("import_config", { path });
        refetch();
      } catch (err) {
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

  const tabs = [
    { key: "edit" as const, label: t("config.editConfig") },
    { key: "templates" as const, label: t("config.templates") },
    { key: "backups" as const, label: t("config.backups") },
  ];

  return (
    <div className="flex flex-col h-full p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("config.title")}</h2>
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

      {/* Tab bar */}
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

      {/* Tab content — scrollable */}
      <div className="flex-1 min-h-0 overflow-y-auto pt-4">
        {activeTab === "edit" && (
          <ConfigForm config={config} onSaved={handleConfigSaved} />
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
