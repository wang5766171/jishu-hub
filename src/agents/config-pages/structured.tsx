import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import {
  ConfigModelsZone,
  ConfigBehaviorZone,
  ConfigAdvancedZone,
} from "@/components/config/config-sections";
import { TemplateManager } from "@/components/config/template-manager";
import { BackupManager } from "@/components/config/backup-manager";
import {
  ConfigPageShell,
  AgentStatusBadge,
  CONFIG_SECTION_META,
} from "@/components/config/config-page-shell";
import { ConnectionTestBadge, type ConnectionTestResult } from "@/components/config/connection-test-badge";
import { Button } from "@/components/ui/button";
import { Download, Save, Upload, Zap, Loader2 } from "lucide-react";
import type { ClaudeConfig } from "@/types";
import type { AdapterConfigPageProps } from "./index";

/**
 * Config page for agents with structured (typed) configuration.
 * Used by: claude-code, codex, opencode.
 *
 * v0.7.4 需求2 R4/R5：侧边栏子页导航——模型设置 / 行为与权限 / 配置模版 /
 * 备份 / 高级设置五个独立页面。配置草稿提升到本组件持有，子页切换不丢未保存
 * 修改；保存/测试按钮常驻页头动作区。保存链路不变（save_config）。
 */
export function StructuredConfigPage({
  configSurface,
  activeAgent,
  agentRefreshKey,
  configTab = "models",
  switcherSlot,
  onNavigateSection,
}: AdapterConfigPageProps) {
  const { t } = useTranslation();
  const surface = configSurface.kind === "structured" ? configSurface : undefined;
  // v0.7.0 需求一：管理作用域 agent_id（load_config / export/import / save_config 必填）。
  const agentId = activeAgent?.id ?? "";

  const { data: config, loading, refetch } = useInvoke<ClaudeConfig>(
    agentId ? "load_config" : "",
    agentId ? { agentId } : undefined,
    agentRefreshKey,
  );

  // 草稿提升：子页切换时 ConfigXxxZone 卸载重挂，draft 留在本组件。
  // load_config 重取（保存/应用模板/导入后）时同步重置。
  const [draft, setDraft] = useState<ClaudeConfig | null>(null);
  useEffect(() => {
    setDraft(config ?? null);
  }, [config]);

  const update = useCallback((partial: Partial<ClaudeConfig>) => {
    setDraft((prev) => (prev ? { ...prev, ...partial } : prev));
  }, []);

  const [saving, setSaving] = useState(false);
  const hasChanges =
    !!draft && !!config && JSON.stringify(draft) !== JSON.stringify(config);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await invokeCommand("save_config", { agentId, config: draft });
      refetch();
    } catch (err) {
      console.error("Failed to save config:", err);
    } finally {
      setSaving(false);
    }
  };

  // v0.7.4 需求2 R2c：配置草稿连通性测试（supports_config_test 门控，模型子页页头）。
  const supportsConfigTest = surface?.supports_config_test ?? false;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const runConfigTest = async () => {
    if (testing || !draft) return;
    const env = draft.env ?? {};
    const key =
      env["ANTHROPIC_AUTH_TOKEN"]?.trim() || env["ANTHROPIC_API_KEY"]?.trim() || "";
    const model = draft.model || env["ANTHROPIC_MODEL"] || "";
    if (!key) {
      setTestResult({ ok: false, text: t("config.testNoKeyHint") });
      return;
    }
    if (!model) {
      setTestResult({ ok: false, text: t("config.testNoModelHint") });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invokeCommand<{ response?: string | null; latency_ms?: number }>(
        "test_llm_connection",
        {
          api: "anthropic-messages",
          baseUrl: env["ANTHROPIC_BASE_URL"]?.trim() || "https://api.anthropic.com",
          apiKey: key,
          model,
        },
      );
      const reply = (result?.response ?? "").toString().trim();
      setTestResult({
        ok: true,
        latencyMs: result?.latency_ms,
        text: reply ? reply.slice(0, 120) : "",
      });
    } catch (e) {
      setTestResult({ ok: false, text: String(e).slice(0, 200) });
    } finally {
      setTesting(false);
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
      refetch();
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) {
        console.error("Import failed:", err);
      }
    }
  };

  if (loading) {
    return (
      <ConfigPageShell switcherSlot={switcherSlot}>
        <div className="py-16 text-center text-sm text-muted-foreground">
          {t("common.loading")}
        </div>
      </ConfigPageShell>
    );
  }

  if (!config) {
    return (
      <ConfigPageShell switcherSlot={switcherSlot}>
        <div className="text-muted-foreground">{t("config.loadFailed")}</div>
      </ConfigPageShell>
    );
  }

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
      actionsSlot={
        <div className="flex items-center gap-2">
          {supportsConfigTest && configTab === "models" && (
            <Button
              variant="outline"
              size="sm"
              onClick={runConfigTest}
              disabled={testing}
              title={t("config.testConnectionHeaderHint")}
            >
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Zap className="h-4 w-4" />
              )}
              {t("config.testConnection")}
            </Button>
          )}
          <Button onClick={handleSave} disabled={!hasChanges || saving} size="sm">
            <Save className="h-4 w-4" />
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      }
      title={t(meta.titleKey)}
      description={t(meta.descKey)}
    >
      {configTab === "models" && (
        <>
          {testResult && (
            <div>
              <ConnectionTestBadge result={testResult} />
            </div>
          )}
          {draft && (
            <ConfigModelsZone
              config={draft}
              onChange={update}
              surface={surface}
              onNavigateSection={onNavigateSection}
              agentId={agentId || undefined}
            />
          )}
        </>
      )}

      {configTab === "behavior" &&
        (draft ? <ConfigBehaviorZone config={draft} onChange={update} /> : null)}

      {configTab === "templates" && <TemplateManager onApplied={refetch} />}

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
          <BackupManager onRestored={refetch} />
        </div>
      )}

      {configTab === "advanced" && (
        <>
          {draft && (
            <ConfigAdvancedZone config={draft} onChange={update} surface={surface} />
          )}
        </>
      )}
    </ConfigPageShell>
  );
}
