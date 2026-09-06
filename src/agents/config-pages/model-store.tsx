import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { useAgent } from "@/agents";
import { ModelManager } from "@/components/config/model-manager";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import { JishuAgentSettingsBlock } from "@/components/config/jishu-agent-settings";
import {
  ConfigPageShell,
  AgentStatusBadge,
  CONFIG_SECTION_META,
} from "@/components/config/config-page-shell";
import { Button } from "@/components/ui/button";
import { RawConfigEditor } from "@/components/config/raw-config-editor";
import { Download, Save, Upload } from "lucide-react";
import type { AdapterConfigPageProps } from "./index";

/**
 * Config page for agents with ModelStore configuration surface.
 * Used by: jishu-self.
 *
 * v0.7.4 需求2 R4/R5/R6：侧边栏子页导航——模型设置（当前模型大卡 +
 * 渠道/模型两栏，ModelManager）/ 行为与权限（工具模式两卡，即时保存）/
 * 配置模版 / 配置备份（备份 + 导出导入）/ 高级设置（MCP）。
 * 与 structured 页同一导航与骨架，操作逻辑对齐（DEVELOP_READ §7）。
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
  // v0.8.0 需求9 收尾：保存按钮上移至页头（与大标题同行）。行为块经
  // onSaveStateChange/registerSave 上报；MCP 编辑器经 onStateChange 上报。
  const [behaviorSaveState, setBehaviorSaveState] = useState({ dirty: false, saving: false });
  const behaviorSaveRef = useRef<() => void>(() => {});
  const registerBehaviorSave = useCallback((save: () => void) => {
    behaviorSaveRef.current = save;
  }, []);
  // 需求16 续三：模型设置保存统一页头（ModelManager 上抛，与 behavior/MCP
  // 同一 registerSave 模式）。
  const [modelsSaveState, setModelsSaveState] = useState({ dirty: false, saving: false });
  const modelsSaveRef = useRef<() => void>(() => {});
  const registerModelsSave = useCallback((save: (() => void) | null) => {
    modelsSaveRef.current = save ?? (() => {});
  }, []);
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
        configTab === "models" ? (
          <Button size="sm" disabled={!modelsSaveState.dirty || modelsSaveState.saving} onClick={() => modelsSaveRef.current()}>
            <Save className="h-3.5 w-3.5" />
            {modelsSaveState.saving ? t("common.saving") : t("common.save")}
          </Button>
        ) : configTab === "behavior" ? (
          <Button size="sm" disabled={!behaviorSaveState.dirty || behaviorSaveState.saving} onClick={() => behaviorSaveRef.current()}>
            <Save className="h-3.5 w-3.5" />
            {behaviorSaveState.saving ? t("common.saving") : t("common.save")}
          </Button>
        ) : undefined
      }
    >
      {/* 模型设置：当前模型大卡 + 服务商管理（ModelManager，即时保存） */}
      {configTab === "models" && (
        <ModelManager
          onSaveStateChange={setModelsSaveState}
          registerSave={registerModelsSave}
        />
      )}

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

      {/* 高级设置（v0.9.1 需求12 补充，用户裁决充实）：会话环境变量 +
          原始配置编辑（MCP 服务统一在「插件管理」经 MCP 插件管理）。 */}
      {configTab === "advanced" && supportsMcp && <AdvancedSettingsBlock agentConfig={agentConfig ?? null} onSaved={refetchAgentConfig} />}
    </ConfigPageShell>
  );
}

/** v0.9.1 需求12 补充（用户裁决充实高级设置）：
 *  1. 会话环境变量——settings.json 的 hubSpawnEnv（每行 KEY=VALUE，保存经
 *     save_config 键级覆盖；空清单 = 删除键恢复默认）。spawn 侧在内置默认
 *     之后注入，可覆盖 PI_OFFLINE 等内置项。
 *  2. 原始配置编辑——直接编辑 settings.json（load/save_raw_config，jishu
 *     的 RawConfigStore 角色）。 */
function AdvancedSettingsBlock({
  agentConfig,
  onSaved,
}: {
  agentConfig: Record<string, unknown> | null;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { manageAgentId } = useAgent();
  const agentId = manageAgentId ?? "";
  const { data: rawConfig, refetch: refetchRaw } = useInvoke<{
    content: string;
    format: string;
  }>("load_raw_config");

  const savedEnv = (agentConfig?.hubSpawnEnv ?? null) as Record<string, string> | null;
  const envText = savedEnv
    ? Object.entries(savedEnv)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")
    : "";
  const [envDraft, setEnvDraft] = useState<string | null>(null);
  const text = envDraft ?? envText;

  // 逐行 KEY=VALUE 解析：空行跳过；无 = 或空键 → 报错行号。
  const invalidLine = (() => {
    for (let i = 0; i < text.split("\n").length; i++) {
      const line = text.split("\n")[i];
      if (!line.trim()) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) return i + 1;
    }
    return null;
  })();
  const parseEnvMap = (): Record<string, string> | null => {
    const map: Record<string, string> = {};
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) return null;
      map[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    return map;
  };
  const envDirty = text !== envText;

  const [envSaving, setEnvSaving] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const handleSaveEnv = async () => {
    if (envSaving || invalidLine !== null) return;
    const map = parseEnvMap();
    if (map === null) return;
    setEnvSaving(true);
    setEnvError(null);
    try {
      // 键级覆盖：空清单写 null = 删除键恢复默认（不注入任何覆盖）。
      await invokeCommand("save_config", {
        agentId,
        config: { hubSpawnEnv: Object.keys(map).length > 0 ? map : null },
      });
      setEnvDraft(null);
      onSaved();
    } catch (err) {
      setEnvError(String(err));
    } finally {
      setEnvSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2.5 rounded-md border border-border/40 bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{t("config.envVarsTitle")}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            disabled={!envDirty || envSaving || invalidLine !== null}
            onClick={() => void handleSaveEnv()}
          >
            <Save className="mr-1 h-3 w-3" />
            {envSaving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
        <textarea
          value={text}
          onChange={(e) => setEnvDraft(e.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={"HTTP_PROXY=http://127.0.0.1:7890\nPI_OFFLINE="}
          className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs"
        />
        {invalidLine !== null ? (
          <p className="text-[11px] text-destructive">
            {t("config.envVarsInvalidLine", { line: invalidLine })}
          </p>
        ) : (
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            {t("config.envVarsHelp")}
          </p>
        )}
        {envError && <p className="text-[11px] text-destructive">{envError}</p>}
      </div>

      <div className="space-y-2.5">
        <p className="text-sm font-medium">{t("config.rawSectionTitle")}</p>
        {rawConfig ? (
          <RawConfigEditor
            initialContent={rawConfig.content}
            format={rawConfig.format}
            onSaved={refetchRaw}
          />
        ) : null}
      </div>
    </div>
  );
}
