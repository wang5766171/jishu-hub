import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { ModelManager } from "@/components/config/model-manager";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import { McpEditor } from "@/components/config/mcp-editor";
import { SectionHelp } from "@/components/config/section-help";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Download, Upload, Save, Check, X, Loader2 } from "lucide-react";
import type { AdapterConfigPageProps } from "./index";

/**
 * Config page for agents with ModelStore configuration surface.
 * Renders model provider management + optional MCP server editor.
 * Used by: jishu-self.
 */
export function ModelStoreConfigPage({
  configSurface,
  activeAgent,
  agentRefreshKey,
  initialTab = "edit",
}: AdapterConfigPageProps) {
  const { t } = useTranslation();
  const supportsMcp =
    configSurface.kind === "model_store" && configSurface.supports_mcp;

  const { data: agentConfig, refetch: refetchAgentConfig } = useInvoke<Record<string, unknown>>(
    supportsMcp ? "load_config" : "",
    undefined,
    supportsMcp ? agentRefreshKey : 0,
  );

  const [activeTab, setActiveTab] = useState<"edit" | "templates" | "backups">(initialTab);
  const [mcpSaveStatus, setMcpSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [mcpSaveError, setMcpSaveError] = useState<string>("");

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
      refetchAgentConfig();
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Import failed:", err);
      }
    }
  };

  const mcpServers =
    (agentConfig as (Record<string, unknown> & { mcpServers?: Record<string, unknown> | null }) | null)
      ?.mcpServers ?? null;

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
          {activeAgent && (
            <p className="mt-1 text-xs text-muted-foreground">
              {activeAgent.display_name}
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
            {/* Configuration header */}
            <div className="flex items-center gap-2 mb-4">
              <h3 className="text-lg font-semibold">{t("config.configuration")}</h3>
              <SectionHelp content={t("config.fieldMapJishuConfig")} />
            </div>
            <Accordion type="multiple" defaultValue={["model", ...(supportsMcp ? ["mcp"] : [])]}>
              <AccordionItem value="model">
                <AccordionTrigger className="group">
                  <span>{t("config.modelAccess")}</span>
                </AccordionTrigger>
                <AccordionContent>
                  <ModelManager />
                </AccordionContent>
              </AccordionItem>
              {supportsMcp && (
                <AccordionItem value="mcp">
                  <AccordionTrigger className="group">
                    <span>{t("config.mcpServers")}<SectionHelp content={t("config.fieldMapMcp")} /></span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <McpEditor
                      key={agentConfig ? "loaded" : "empty"}
                      value={mcpServers}
                      actions={({ value, hasError }) => (
                        <div className="flex items-center gap-2">
                          {mcpSaveStatus === "success" && <span className="text-xs text-green-500 flex items-center"><Check className="h-3 w-3 mr-1"/>{t("config.saveSuccess", "保存成功")}</span>}
                          {mcpSaveStatus === "error" && <span className="text-xs text-red-500 flex items-center"><X className="h-3 w-3 mr-1"/>{mcpSaveError || t("config.saveFailed", "保存失败")}</span>}
                          {mcpSaveStatus === "saving" && <span className="text-xs text-muted-foreground flex items-center"><Loader2 className="h-3 w-3 mr-1 animate-spin"/>{t("common.saving", "保存中...")}</span>}
                          <Button
                            size="sm"
                            className="h-6 text-xs mr-3"
                            disabled={hasError || !agentConfig || mcpSaveStatus === "saving"}
                            onClick={async () => {
                              if (!agentConfig) return;
                              setMcpSaveStatus("saving");
                              try {
                                const merged = { ...agentConfig, mcpServers: value };
                                await invokeCommand("save_config", { config: merged });
                                await refetchAgentConfig();
                                setMcpSaveStatus("success");
                                setTimeout(() => setMcpSaveStatus("idle"), 2000);
                              } catch (e) {
                                setMcpSaveError(String(e));
                                setMcpSaveStatus("error");
                                setTimeout(() => setMcpSaveStatus("idle"), 4000);
                              }
                            }}
                          >
                            <Save className="mr-1 h-3 w-3" />
                            {t("common.save")}
                          </Button>
                        </div>
                      )}
                    />
                  </AccordionContent>
                </AccordionItem>
              )}
            </Accordion>
          </>
        )}
        {activeTab === "templates" && (
          <TemplateManager onApplied={refetchAgentConfig} />
        )}
        {activeTab === "backups" && (
          <BackupManager onRestored={refetchAgentConfig} />
        )}
      </div>
    </div>
  );
}
