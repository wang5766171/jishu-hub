import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { ModelManager } from "@/components/config/model-manager";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import { SectionHelp } from "@/components/config/section-help";
import { McpEditor } from "@/components/config/mcp-editor";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Download, Upload, Save } from "lucide-react";
import type { AdapterConfigPageProps } from "./index";

/**
 * Config page for agents with ModelStore configuration surface.
 * Renders model provider management.
 * Used by: jishu-self.
 */
export function ModelStoreConfigPage({
  configSurface,
  activeAgent,
  agentRefreshKey,
  initialTab = "edit",
}: AdapterConfigPageProps) {
  const { t } = useTranslation();

  const { data: agentConfig, refetch: refetchAgentConfig } = useInvoke<Record<string, unknown>>(
    "load_config",
    undefined,
    agentRefreshKey,
  );

  const supportsMcp = configSurface.kind === "model_store" && configSurface.supports_mcp;

  const [activeTab, setActiveTab] = useState<"edit" | "templates" | "backups">(initialTab);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpSuccess, setMcpSuccess] = useState<string | null>(null);

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
            <Accordion type="multiple" defaultValue={["model"]}>
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
                    <span>{t("config.mcpServers")}</span>
                  </AccordionTrigger>
                  <AccordionContent>
                    {mcpError && (
                      <div className="mb-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                        {mcpError}
                      </div>
                    )}
                    <McpEditor 
                      value={(agentConfig?.mcpServers as any) || null} 
                      actions={({ value, hasError }) => (
                        <div className="flex items-center gap-3 mr-3">
                          {mcpSuccess && (
                            <span className="text-xs text-green-500">{mcpSuccess}</span>
                          )}
                          <Button 
                            size="sm" 
                            className="h-6 text-xs" 
                            disabled={hasError || mcpSaving}
                            onClick={async () => {
                              setMcpSaving(true);
                              setMcpError(null);
                              setMcpSuccess(null);
                              try {
                                await invokeCommand("save_config", { config: { mcpServers: value } });
                                refetchAgentConfig();
                                setMcpSuccess(t("config.saveSuccess"));
                                setTimeout(() => setMcpSuccess(null), 3000);
                              } catch (err) {
                                setMcpError(String(err));
                              } finally {
                                setMcpSaving(false);
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
