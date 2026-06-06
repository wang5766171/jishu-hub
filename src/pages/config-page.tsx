import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { ConfigForm } from "@/components/config/config-form";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import { ModelManager } from "@/components/config/model-manager";
import { RawConfigEditor } from "@/components/config/raw-config-editor";
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
  const isJishuSelf = activeId === "jishu-self";
  const agentRefreshKey = activeId ? Array.from(activeId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) : 0;

  // jishu-self: configuration is `~/.jishu-agent/models.json` and is
  // edited via ModelManager. Codex uses a native TOML config (not a
  // typed JSON config), so it goes through the raw editor. Other
  // agents: load_config returns their own typed config (ClaudeConfig,
  // …) which ConfigForm renders as a structured form.
  const isCodex = activeId === "codex";
  const useRawEditor = isCodex && !isJishuSelf;
  const { data: config, loading, refetch } = useInvoke<ClaudeConfig>(
    "load_config",
    undefined,
    isJishuSelf || useRawEditor ? 0 : agentRefreshKey,
  );
  const { data: rawConfig, refetch: refetchRaw } = useInvoke<RawConfigInfo>(
    "load_raw_config",
    undefined,
    useRawEditor ? agentRefreshKey : 0,
  );
  const [activeTab, setActiveTab] = useState<
    "edit" | "templates" | "backups"
  >(initialTab);

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
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Import failed:", err);
      }
    }
  };

  // jishu-self path: render the unified Models editor directly (it
  // already exposes a JSON editor + active picker, which is the full
  // configuration surface for this agent).
  if (isJishuSelf) {
    return (
      <div className="flex flex-col h-full p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{t("config.title")}</h2>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto pt-4">
          <ModelManager onChanged={refreshAfterModelChange} />
        </div>
      </div>
    );
  }

  // Codex uses a native TOML config — show it in the raw editor
  // with a `set_raw_config` save path.
  if (useRawEditor) {
    if (!rawConfig) {
      return <Skeleton className="h-64" />;
    }
    return (
      <div className="flex flex-col h-full p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold">{t("config.title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
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

  // Other agents: load_config returns the agent's own typed config
  // (ClaudeConfig, etc.) which ConfigForm renders as a structured
  // form. If the load hasn't finished yet, show a skeleton.
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

function refreshAfterModelChange() {
  // Models are loaded by ModelManager from the Rust side directly via
  // get_models_config / set_models_config / get_active / set_active.
  // Nothing in this page needs to refetch — the change is local.
}
