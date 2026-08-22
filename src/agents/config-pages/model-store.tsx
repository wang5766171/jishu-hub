import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { ModelManager } from "@/components/config/model-manager";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import { McpEditor } from "@/components/config/mcp-editor";
import { JishuAgentSettingsBlock } from "@/components/config/jishu-agent-settings";
import {
  ConfigPageShell,
  AgentStatusBadge,
  CONFIG_SECTION_META,
} from "@/components/config/config-page-shell";
import { Button } from "@/components/ui/button";
import { Download, Save, Upload } from "lucide-react";
import type { AdapterConfigPageProps } from "./index";

/**
 * Config page for agents with ModelStore configuration surface.
 * Used by: jishu-self.
 *
 * v0.7.4 需求2 R4/R5/R6：侧边栏子页导航——模型设置（当前模型大卡 +
 * 渠道/模型两栏，ModelManager）/ 行为与权限（工具模式两卡，即时保存）/
 * 配置模版 / 配置备份（备份 + 导出导入）/ 高级设置（MCP）。
 * 与 structured 页同一导航与骨架，操作逻辑对齐（DEVELOP_READ §5/§8）。
 */
export function ModelStoreConfigPage({
  configSurface,
  activeAgent,
  agentRefreshKey,
  configTab = "models",
  switcherSlot,
}: AdapterConfigPageProps) {
  const { t } = useTranslation();
  // v0.7.0 需求一：管理作用域 agent_id（load_config / export/import / save_config 必填）。
  const agentId = activeAgent?.id ?? "";

  const { data: agentConfig, refetch: refetchAgentConfig } = useInvoke<Record<string, unknown>>(
    agentId ? "load_config" : "",
    agentId ? { agentId } : undefined,
    agentRefreshKey,
  );

  const supportsMcp = configSurface.kind === "model_store" && configSurface.supports_mcp;

  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpSuccess, setMcpSuccess] = useState<string | null>(null);
  // v0.8.0 需求9 收尾：保存按钮上移至页头（与大标题同行）。行为块经
  // onSaveStateChange/registerSave 上报；MCP 编辑器经 onStateChange 上报。
  const [behaviorSaveState, setBehaviorSaveState] = useState({ dirty: false, saving: false });
  const behaviorSaveRef = useRef<() => void>(() => {});
  const registerBehaviorSave = useCallback((save: () => void) => {
    behaviorSaveRef.current = save;
  }, []);
  const [mcpEditorState, setMcpEditorState] = useState<{
    value: Record<string, unknown> | null;
    hasError: boolean;
  } | null>(null);

  const handleSaveMcp = async () => {
    if (mcpSaving || mcpEditorState?.hasError) return;
    setMcpSaving(true);
    setMcpError(null);
    setMcpSuccess(null);
    try {
      await invokeCommand("save_config", {
        agentId,
        config: { mcpServers: mcpEditorState?.value ?? null },
      });
      refetchAgentConfig();
      setMcpSuccess(t("config.saveSuccess"));
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(String(err));
    } finally {
      setMcpSaving(false);
    }
  };

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
      refetchAgentConfig();
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Import failed:", err);
      }
    }
  };

  const meta = CONFIG_SECTION_META[configTab];

  return (
    <ConfigPageShell
      switcherSlot={switcherSlot}
      statusSlot={
        activeAgent ? (
          <AgentStatusBadge
            installed={activeAgent.health.installed}
            version={activeAgent.health.version}
          />
        ) : undefined
      }
      title={t(meta.titleKey)}
      description={t(meta.descKey)}
      actionsSlot={
        configTab === "behavior" ? (
          <Button size="sm" disabled={!behaviorSaveState.dirty || behaviorSaveState.saving} onClick={() => behaviorSaveRef.current()}>
            <Save className="h-3.5 w-3.5" />
            {behaviorSaveState.saving ? t("common.saving") : t("common.save")}
          </Button>
        ) : configTab === "advanced" && supportsMcp ? (
          <div className="flex items-center gap-3">
            {mcpSuccess && (
              <span className="text-xs text-green-500">{mcpSuccess}</span>
            )}
            <Button
              size="sm"
              disabled={mcpSaving || (mcpEditorState?.hasError ?? true)}
              onClick={() => void handleSaveMcp()}
            >
              <Save className="h-3.5 w-3.5" />
              {t("common.save")}
            </Button>
          </div>
        ) : undefined
      }
    >
      {/* 模型设置：当前模型大卡 + 服务商管理（ModelManager，即时保存） */}
      {configTab === "models" && <ModelManager />}

      {/* 行为与权限：Pi Settings 真实行为字段（v0.7.5 补全：思考档位/压缩/
          初始工具/重试）。工具模式（完整/只读）是会话时选择的能力，已在会话页
          提供入口，不在配置页展示（2026-08-16 用户裁决）。说明文案合并为
          页描述一段（2026-08-22 用户裁决：去掉两个小标题）。 */}
      {configTab === "behavior" && (
        <JishuAgentSettingsBlock
          agentConfig={agentConfig ?? null}
          onSaved={refetchAgentConfig}
          onSaveStateChange={setBehaviorSaveState}
          registerSave={registerBehaviorSave}
        />
      )}

      {/* 配置模版 */}
      {configTab === "templates" && <TemplateManager onApplied={refetchAgentConfig} />}

      {/* R5/R6：备份独立子页；导入导出并入本页 */}
      {configTab === "backups" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="mr-2 h-3.5 w-3.5" />
              {t("config.export")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleImport}>
              <Upload className="mr-2 h-3.5 w-3.5" />
              {t("config.import")}
            </Button>
          </div>
          <BackupManager onRestored={refetchAgentConfig} />
        </div>
      )}

      {/* 高级设置：MCP（v0.8.0 需求9 收尾：去掉「MCP 服务」小标题行，
          保存按钮在页头；错误提示保留在编辑器上方）。 */}
      {configTab === "advanced" && (
        <div className="space-y-4">
          {supportsMcp && (
            <div className="space-y-2">
              {mcpError && (
                <div className="mb-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {mcpError}
                </div>
              )}
              <McpEditor
                value={(agentConfig?.mcpServers as never) || null}
                onStateChange={setMcpEditorState}
              />
            </div>
          )}
        </div>
      )}
    </ConfigPageShell>
  );
}
