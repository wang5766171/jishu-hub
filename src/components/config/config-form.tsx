import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { useAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Save, Plus, Trash2, Zap, Loader2 } from "lucide-react";
import type { ClaudeConfig } from "@/types";
import { SectionHelp } from "./section-help";
import { McpEditor } from "./mcp-editor";
import { QuickSetupSection } from "./quick-setup-section";
import { ModelCombobox } from "./model-combobox";
import { PermissionModeCards } from "./permission-cards";
import { RuleQuickAdd } from "./rule-quick-add";
import { ConnectionTestBadge, type ConnectionTestResult } from "./connection-test-badge";
import { CLAUDE_MODEL_CATALOG } from "@/agents/config/presets/claude-models";

const API_PROVIDERS = [
  { value: "anthropic", labelKey: "providerAnthropic" },
  { value: "bedrock", labelKey: "providerBedrock" },
  { value: "vertex", labelKey: "providerVertex" },
];

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function ConfigForm({
  config: initialConfig,
  onSaved,
  schemaId: _schemaId,
  surface,
}: {
  config: ClaudeConfig;
  onSaved: (config: ClaudeConfig) => void;
  schemaId?: string;
  surface?: {
    supports_model_picker: boolean;
    supports_small_model: boolean;
    supports_large_model: boolean;
    supports_api_provider: boolean;
    supports_proxy_setup?: boolean;
    supports_config_test?: boolean;
  };
}) {
  const { t } = useTranslation();
  // v0.7.0 需求一：管理作用域 agent_id（save_config 必填）。
  const { manageAgentId } = useAgent();
  const [config, setConfig] = useState<ClaudeConfig>(initialConfig);
  const [saving, setSaving] = useState(false);
  // v0.7.4 需求2 R2c：配置草稿连通性测试（supports_config_test 门控）。
  const supportsConfigTest = surface?.supports_config_test ?? false;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const runConfigTest = async () => {
    if (testing) return;
    const env = config.env ?? {};
    const key =
      env["ANTHROPIC_AUTH_TOKEN"]?.trim() || env["ANTHROPIC_API_KEY"]?.trim() || "";
    const model = config.model || env["ANTHROPIC_MODEL"] || "";
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

  // Use capability flags from surface, default to true for backward compatibility if undefined
  const supportsModelPicker = surface?.supports_model_picker ?? true;
  const supportsSmallModel = surface?.supports_small_model ?? true;
  const supportsLargeModel = surface?.supports_large_model ?? true;
  const supportsApiProvider = surface?.supports_api_provider ?? true;
  const supportsProxySetup = surface?.supports_proxy_setup ?? false;
  const showAdvancedModels = supportsSmallModel || supportsLargeModel || supportsApiProvider;

  // List pattern inputs
  const [newAllowPattern, setNewAllowPattern] = useState("");
  const [newDenyPattern, setNewDenyPattern] = useState("");

  // Env var input
  const [newEnvKey, setNewEnvKey] = useState("");

  useEffect(() => {
    setConfig(initialConfig);
  }, [initialConfig]);

  // --- Field handlers ---

  const updateConfig = (partial: Partial<ClaudeConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
  };

  const updatePermissions = (partial: Partial<ClaudeConfig["permissions"]>) => {
    setConfig((prev) => ({
      ...prev,
      permissions: { ...(prev.permissions || {}), ...partial } as ClaudeConfig["permissions"],
    }));
  };

  // Model
  const handleModelChange = (model: string) => updateConfig({ model: model || null });
  const handleSmallModelChange = (val: string) => updateConfig({ smallModel: val || null });
  const handleLargeModelChange = (val: string) => updateConfig({ largeModel: val || null });
  const handleApiProviderChange = (val: string) => updateConfig({ apiProvider: val || null });

  // Permissions
  const handlePermissionMode = (val: string) =>
    updatePermissions({ defaultMode: val || null });

  const handleAddAllowPattern = () => {
    if (!newAllowPattern.trim()) return;
    const allow = [...(config.permissions?.allow ?? []), newAllowPattern.trim()];
    updatePermissions({ allow });
    setNewAllowPattern("");
  };

  const handleRemoveAllowPattern = (idx: number) => {
    const allow = [...(config.permissions?.allow ?? [])];
    allow.splice(idx, 1);
    updatePermissions({ allow: allow.length > 0 ? allow : null });
  };

  const handleAddDenyPattern = () => {
    if (!newDenyPattern.trim()) return;
    const deny = [...(config.permissions?.deny ?? []), newDenyPattern.trim()];
    updatePermissions({ deny });
    setNewDenyPattern("");
  };

  const handleRemoveDenyPattern = (idx: number) => {
    const deny = [...(config.permissions?.deny ?? [])];
    deny.splice(idx, 1);
    updatePermissions({ deny: deny.length > 0 ? deny : null });
  };

  // Sandbox
  const handleSandboxEnabled = (checked: boolean) => {
    setConfig((prev) => ({
      ...prev,
      sandbox: { ...(prev.sandbox || {}), enabled: checked } as ClaudeConfig["sandbox"],
    }));
  };

  // Skip Dangerous
  const handleSkipDangerous = (checked: boolean) => {
    updateConfig({ skipDangerousModePermissionPrompt: checked || null });
  };

  // Env vars
  const handleEnvChange = (key: string, value: string) => {
    const env = { ...(config.env || {}) };
    env[key] = value;
    updateConfig({ env });
  };

  const handleEnvDelete = (key: string) => {
    const env = { ...(config.env || {}) };
    delete env[key];
    updateConfig({ env });
  };

  const handleAddEnv = () => {
    if (!newEnvKey.trim()) return;
    const env = { ...(config.env || {}) };
    env[newEnvKey.trim()] = "";
    updateConfig({ env });
    setNewEnvKey("");
  };

  // Plugins
  const handlePluginToggle = (plugin: string, enabled: boolean) => {
    const plugins = { ...(config.enabledPlugins || {}) };
    plugins[plugin] = enabled;
    updateConfig({ enabledPlugins: plugins });
  };

  const handlePluginDelete = (plugin: string) => {
    const plugins = { ...(config.enabledPlugins || {}) };
    delete plugins[plugin];
    updateConfig({ enabledPlugins: plugins });
  };

  // Advanced
  const handleVerbose = (checked: boolean) => updateConfig({ verbose: checked || null });
  const handleMaxTurns = (val: string) => {
    const n = parseInt(val, 10);
    updateConfig({ maxTurns: isNaN(n) || n <= 0 ? null : n });
  };

  // Save
  const handleSave = async () => {
    setSaving(true);
    try {
      await invokeCommand("save_config", { agentId: manageAgentId ?? "", config });
      onSaved(config);
    } catch (err) {
      console.error("Failed to save config:", err);
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = JSON.stringify(config) !== JSON.stringify(initialConfig);
  const modelOptions = CLAUDE_MODEL_CATALOG.map((m) => ({
    value: m.value,
    label: t(`config.${m.labelKey.replace("config.", "")}`),
  }));

  // Sections with content come first, empty ones last
  type SectionId = "env" | "plugins" | "mcp" | "permissions" | "model" | "advanced";
  const sectionHasContent: Record<SectionId, boolean> = {
    env: !!config.env && Object.keys(config.env).length > 0,
    plugins: !!config.enabledPlugins && Object.keys(config.enabledPlugins).length > 0,
    permissions: !!(config.permissions?.defaultMode || (config.permissions?.allow?.length) || (config.permissions?.deny?.length) || config.sandbox?.enabled || config.skipDangerousModePermissionPrompt),
    model: !!(config.model || config.smallModel || config.largeModel || config.apiProvider),
    mcp: !!config.mcpServers && Object.keys(config.mcpServers).length > 0,
    advanced: !!(config.verbose || config.maxTurns),
  };
  const sectionOrder: SectionId[] = (["env", "plugins", "mcp", "permissions", "model", "advanced"] as SectionId[]).sort((a, b) => {
    if (sectionHasContent[a] && !sectionHasContent[b]) return -1;
    if (!sectionHasContent[a] && sectionHasContent[b]) return 1;
    return 0;
  });
  const expandedDefaults = (Object.entries(sectionHasContent) as [SectionId, boolean][])
    .filter(([, has]) => has).map(([id]) => id);

  return (
    <div className="flex flex-col h-full">
      {/* Sticky header: title + test + save */}
      <div className="sticky top-0 z-10 bg-background pb-3 border-b border-border mb-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{t("config.configuration")}</h3>
          <div className="flex items-center gap-2">
            {supportsConfigTest && (
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
        </div>
        {testResult && (
          <div className="mt-2">
            <ConnectionTestBadge result={testResult} />
          </div>
        )}
      </div>

      {/* Scrollable accordion area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
      <Accordion type="multiple" defaultValue={expandedDefaults}>
        {sectionOrder.map((sid) => {
          if (sid === "model") return (
            <AccordionItem key="model" value="model">
              <AccordionTrigger className="group"><span>{t("config.modelSettings")}<SectionHelp content={t("config.fieldMapModel")} /></span></AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4 pt-2">
                  {supportsProxySetup && (
                    <QuickSetupSection
                      env={config.env ?? {}}
                      model={config.model ?? ""}
                      onEnvChange={(env) => updateConfig({ env })}
                      onModelChange={(model) => updateConfig({ model: model || null })}
                    />
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="model">{t("config.model")}</Label>
                    {supportsModelPicker ? (
                      <ModelCombobox
                        id="model"
                        value={config.model || ""}
                        onChange={handleModelChange}
                        options={modelOptions}
                        placeholder={t("config.modelComboboxPlaceholder")}
                      />
                    ) : (
                      <Input
                        id="model"
                        value={config.model || ""}
                        onChange={(e) => handleModelChange(e.target.value)}
                        placeholder="provider/model"
                      />
                    )}
                  </div>

                  {showAdvancedModels && (
                    <>
                      {supportsSmallModel && (
                        <div className="space-y-2">
                          <Label htmlFor="smallModel">{t("config.smallModel")}</Label>
                          <ModelCombobox
                            id="smallModel"
                            value={config.smallModel || ""}
                            onChange={handleSmallModelChange}
                            options={modelOptions}
                            placeholder={t("config.modelComboboxOptional")}
                          />
                        </div>
                      )}

                      {supportsLargeModel && (
                        <div className="space-y-2">
                          <Label htmlFor="largeModel">{t("config.largeModel")}</Label>
                          <ModelCombobox
                            id="largeModel"
                            value={config.largeModel || ""}
                            onChange={handleLargeModelChange}
                            options={modelOptions}
                            placeholder={t("config.modelComboboxOptional")}
                          />
                        </div>
                      )}

                      {supportsApiProvider && (
                        <div className="space-y-2">
                          <Label htmlFor="apiProvider">{t("config.apiProvider")}</Label>
                          <select
                            id="apiProvider"
                            value={config.apiProvider || ""}
                            onChange={(e) => handleApiProviderChange(e.target.value)}
                            className={selectClass}
                          >
                            <option value="">{t("common.default")}</option>
                            {API_PROVIDERS.map((p) => (
                              <option key={p.value} value={p.value}>
                                {t(`config.${p.labelKey}`)}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          );

          if (sid === "permissions") return (
            <AccordionItem key="permissions" value="permissions">
              <AccordionTrigger className="group"><span>{t("config.permissionsSecurity")}<SectionHelp content={t("config.fieldMapPermissions")} /></span></AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <Label htmlFor="permMode">{t("config.permissionMode")}</Label>
                    <PermissionModeCards
                      value={config.permissions?.defaultMode || ""}
                      onChange={handlePermissionMode}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>{t("config.allowList")}</Label>
                    <RuleQuickAdd
                      patterns={config.permissions?.allow ?? []}
                      onAdd={(pattern) => {
                        const allow = [...(config.permissions?.allow ?? []), pattern];
                        updatePermissions({ allow });
                      }}
                    />
                    <div className="space-y-2">
                      {(config.permissions?.allow ?? []).map((pattern, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono">{pattern}</code>
                          <Button variant="ghost" size="icon-xs" onClick={() => handleRemoveAllowPattern(idx)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                      <div className="flex items-center gap-2">
                        <Input
                          value={newAllowPattern}
                          onChange={(e) => setNewAllowPattern(e.target.value)}
                          placeholder={t("config.patternPlaceholder")}
                          className="flex-1"
                          onKeyDown={(e) => e.key === "Enter" && handleAddAllowPattern()}
                        />
                        <Button variant="outline" size="sm" onClick={handleAddAllowPattern} disabled={!newAllowPattern.trim()}>
                          <Plus className="mr-1 h-3 w-3" />
                          {t("config.addPattern")}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>{t("config.denyList")}</Label>
                    <RuleQuickAdd
                      patterns={config.permissions?.deny ?? []}
                      onAdd={(pattern) => {
                        const deny = [...(config.permissions?.deny ?? []), pattern];
                        updatePermissions({ deny });
                      }}
                    />
                    <div className="space-y-2">
                      {(config.permissions?.deny ?? []).map((pattern, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono">{pattern}</code>
                          <Button variant="ghost" size="icon-xs" onClick={() => handleRemoveDenyPattern(idx)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                      <div className="flex items-center gap-2">
                        <Input
                          value={newDenyPattern}
                          onChange={(e) => setNewDenyPattern(e.target.value)}
                          placeholder={t("config.patternPlaceholder")}
                          className="flex-1"
                          onKeyDown={(e) => e.key === "Enter" && handleAddDenyPattern()}
                        />
                        <Button variant="outline" size="sm" onClick={handleAddDenyPattern} disabled={!newDenyPattern.trim()}>
                          <Plus className="mr-1 h-3 w-3" />
                          {t("config.addPattern")}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between rounded-md border px-3 py-3">
                    <div className="space-y-0.5">
                      <Label>{t("config.sandbox")}</Label>
                      <p className="text-xs text-muted-foreground">
                        {config.sandbox?.enabled ? t("config.enabled") : t("config.disabled")}
                      </p>
                    </div>
                    <Switch
                      checked={config.sandbox?.enabled === true}
                      onCheckedChange={handleSandboxEnabled}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border px-3 py-3">
                    <div className="space-y-0.5">
                      <Label>{t("config.skipDangerous")}</Label>
                      <p className="text-xs text-muted-foreground">{t("config.skipDangerousDesc")}</p>
                    </div>
                    <Switch
                      checked={config.skipDangerousModePermissionPrompt === true}
                      onCheckedChange={handleSkipDangerous}
                    />
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          );

          if (sid === "env") return (
            <AccordionItem key="env" value="env">
              <AccordionTrigger className="group"><span>{t("config.envVars")}<SectionHelp content={t("config.fieldMapEnv")} /></span></AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2 pt-2">
                  {Object.entries(config.env || {}).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2">
                      <code className="min-w-[140px] rounded bg-muted px-2 py-1 text-xs font-mono">{key}</code>
                      <Input
                        value={value}
                        onChange={(e) => handleEnvChange(key, e.target.value)}
                        className="flex-1"
                        placeholder={t("config.value")}
                      />
                      <Button variant="ghost" size="icon-xs" onClick={() => handleEnvDelete(key)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Input
                      value={newEnvKey}
                      onChange={(e) => setNewEnvKey(e.target.value)}
                      className="min-w-[140px]"
                      placeholder={t("config.key")}
                      onKeyDown={(e) => e.key === "Enter" && handleAddEnv()}
                    />
                    <Button variant="outline" size="sm" onClick={handleAddEnv} disabled={!newEnvKey.trim()}>
                      <Plus className="mr-1 h-3 w-3" />
                      {t("common.add")}
                    </Button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          );

          if (sid === "plugins") return (
            <AccordionItem key="plugins" value="plugins">
              <AccordionTrigger className="group"><span>{t("config.enabledPlugins")}<SectionHelp content={t("config.fieldMapPlugins")} /></span></AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2 pt-2">
                  {Object.entries(config.enabledPlugins || {}).map(([plugin, enabled]) => (
                    <div key={plugin} className="flex items-center justify-between rounded-md border px-3 py-2">
                      <code className="text-xs font-mono">{plugin}</code>
                      <div className="flex items-center gap-2">
                        <Switch checked={enabled} onCheckedChange={(checked) => handlePluginToggle(plugin, checked)} />
                        <Button variant="ghost" size="icon-xs" onClick={() => handlePluginDelete(plugin)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {(!config.enabledPlugins || Object.keys(config.enabledPlugins).length === 0) && (
                    <p className="text-sm text-muted-foreground">{t("config.noPlugins")}</p>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          );

          if (sid === "mcp") return (
            <AccordionItem key="mcp" value="mcp">
              <AccordionTrigger className="group"><span>{t("config.mcpServers")}<SectionHelp content={t("config.fieldMapMcp")} /></span></AccordionTrigger>
              <AccordionContent>
                <McpEditor value={config.mcpServers} onChange={(v) => updateConfig({ mcpServers: v })} />
              </AccordionContent>
            </AccordionItem>
          );

          if (sid === "advanced") return (
            <AccordionItem key="advanced" value="advanced">
              <AccordionTrigger className="group"><span>{t("config.advanced")}<SectionHelp content={t("config.fieldMapAdvanced")} /></span></AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4 pt-2">
                  <div className="flex items-center justify-between rounded-md border px-3 py-3">
                    <Label>{t("config.verbose")}</Label>
                    <Switch
                      checked={config.verbose === true}
                      onCheckedChange={handleVerbose}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="maxTurns">{t("config.maxTurns")}</Label>
                    <Input
                      id="maxTurns"
                      type="number"
                      min={1}
                      value={config.maxTurns ?? ""}
                      onChange={(e) => handleMaxTurns(e.target.value)}
                      placeholder="e.g., 200"
                    />
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          );

          return null;
        })}
      </Accordion>
      </div>
    </div>
  );
}
