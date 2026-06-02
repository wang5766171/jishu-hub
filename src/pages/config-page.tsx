import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { ConfigForm } from "@/components/config/config-form";
import { JishuConfigForm } from "@/components/config/jishu-config-form";
import { RawConfigEditor } from "@/components/config/raw-config-editor";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import { ModelManager } from "@/components/config/model-manager";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Download, Upload } from "lucide-react";
import { useAgent } from "@/agents";
import type { ClaudeConfig, JishuConfig } from "@/types";

interface RawConfigInfo {
  content: string;
  format: string;
}

export function ConfigPage({ initialTab = "edit" }: { initialTab?: "edit" | "templates" | "models" | "backups" }) {
  const { t } = useTranslation();
  const { activeId } = useAgent();
  const isJishuSelf = activeId === "jishu-self";
  const agentRefreshKey = activeId ? Array.from(activeId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) : 0;

  const { data: rawConfigValue, loading, error: configError, refetch } = useInvoke<unknown>(
    "load_config",
    undefined,
    agentRefreshKey,
  );
  const useRaw = !!configError;
  const { data: rawConfig, refetch: refetchRaw } = useInvoke<RawConfigInfo>("load_raw_config", undefined, useRaw ? agentRefreshKey : 0);
  const [activeTab, setActiveTab] = useState<"edit" | "templates" | "models" | "backups">(
    ["edit", "templates", "models", "backups"].includes(initialTab) ? initialTab : "edit"
  );

  // Coerce to a typed object based on the active agent. Frontend treats Value
  // as opaque; jishu-self uses its own JishuConfig schema, others use ClaudeConfig.
  const config: ClaudeConfig | null = isJishuSelf
    ? null
    : (rawConfigValue as ClaudeConfig | null | undefined) ?? null;
  const jishuConfig: JishuConfig | null = isJishuSelf
    ? ((rawConfigValue as JishuConfig | null | undefined) ?? null)
    : null;

  const handleConfigSaved = useCallback(() => {
    refetch();
  }, [refetch]);

  const handleRawSaved = useCallback(() => {
    refetchRaw();
  }, [refetchRaw]);

  const handleExport = async () => {
    try {
      if (!useRaw) {
        await invokeCommand("export_config_dialog");
      } else {
        await invokeCommand("export_raw_config_dialog");
      }
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Export failed:", err);
      }
    }
  };

  const handleImport = async () => {
    if (useRaw) return;
    try {
      await invokeCommand("import_config_dialog");
      refetch();
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Import failed:", err);
      }
    }
  };

  if (loading || (useRaw && !rawConfig)) {
    return <Skeleton className="h-64" />;
  }

  // Agents without structured config support: show native config editor
  if (useRaw && rawConfig) {
    return (
      <div className="flex flex-col h-full p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold">{t("config.title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t("config.nativeFormatHint")}</p>
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

  // Structured config (e.g. Claude Code, OpenCode): show form with templates & backups
  if (!isJishuSelf && !config) {
    return <div className="text-muted-foreground">{t("config.loadFailed")}</div>;
  }
  if (isJishuSelf && !jishuConfig) {
    return <div className="text-muted-foreground">{t("config.loadFailed")}</div>;
  }

  const tabs: Array<{ key: "edit" | "templates" | "models" | "backups"; label: string }> = [
    { key: "edit", label: t("config.editConfig") },
    { key: "templates", label: t("config.templates") },
  ];
  if (!isJishuSelf) {
    tabs.push({ key: "models", label: t("config.models") });
  }
  tabs.push({ key: "backups", label: t("config.backups") });

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
          isJishuSelf && jishuConfig ? (
            <JishuConfigForm config={jishuConfig} onSaved={handleConfigSaved} />
          ) : (
            config && <ConfigForm config={config} onSaved={handleConfigSaved} agentId={activeId} />
          )
        )}
        {activeTab === "templates" && (
          <TemplateManager onApplied={refetch} />
        )}
        {activeTab === "models" && (
          <ModelManager onChanged={refetch} />
        )}
        {activeTab === "backups" && (
          <BackupManager onRestored={refetch} />
        )}
      </div>
    </div>
  );
}
