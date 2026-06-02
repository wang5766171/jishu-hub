import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand, useInvoke } from "@/hooks/use-invoke";
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
import { Save, Plus, Trash2, Brain, Sparkles } from "lucide-react";
import type { JishuConfig } from "@/types";
import { ModelManager } from "./model-manager";

const textareaClass =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[160px] font-mono text-xs";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const PERMISSION_MODES = [
  { value: "default", labelKey: "modeDefault" },
  { value: "bypassPermissions", labelKey: "modeBypass" },
  { value: "plan", labelKey: "modePlan" },
  { value: "acceptEdits", labelKey: "modeAcceptEdits" },
];

const COMPACTION_METHODS = [
  { value: "summary", label: "summary" },
  { value: "truncate", label: "truncate" },
  { value: "sliding", label: "sliding" },
];

interface JishuConfigFormProps {
  config: JishuConfig;
  onSaved: (config: JishuConfig) => void;
}

export function JishuConfigForm({ config: initialConfig, onSaved }: JishuConfigFormProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<JishuConfig>(initialConfig);
  const [saving, setSaving] = useState(false);
  const [mcpJson, setMcpJson] = useState(() => JSON.stringify(initialConfig.mcpServers ?? {}, null, 2));
  const [mcpJsonError, setMcpJsonError] = useState("");

  const [newAllowPattern, setNewAllowPattern] = useState("");
  const [newDenyPattern, setNewDenyPattern] = useState("");
  const [newEnvKey, setNewEnvKey] = useState("");

  useEffect(() => {
    setConfig(initialConfig);
    setMcpJson(JSON.stringify(initialConfig.mcpServers ?? {}, null, 2));
    setMcpJsonError("");
  }, [initialConfig]);

  // Sync activeModel from ModelStore on mount and whenever the store changes.
  // Keeps the chip display in lockstep with the actual active preset.
  const { data: modelStore } = useInvoke<{ presets: { id: string; model: string }[]; active: string | null }>(
    "list_models",
  );
  useEffect(() => {
    if (!modelStore) return;
    const activePreset = modelStore.presets.find((p) => p.id === modelStore.active);
    const activeModel = activePreset?.model ?? null;
    if (activeModel !== config.activeModel) {
      updateConfig({ activeModel });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelStore]);

  const updateConfig = (partial: Partial<JishuConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
  };

  const updatePermissions = (partial: Partial<NonNullable<JishuConfig["permissions"]>>) => {
    setConfig((prev) => ({
      ...prev,
      permissions: { ...(prev.permissions || {}), ...partial } as JishuConfig["permissions"],
    }));
  };

  const updateContextCompaction = (
    partial: Partial<NonNullable<JishuConfig["contextCompaction"]>>,
  ) => {
    setConfig((prev) => ({
      ...prev,
      contextCompaction: { ...(prev.contextCompaction || {}), ...partial } as JishuConfig["contextCompaction"],
    }));
  };

  const handleTemperatureChange = (val: string) => {
    const n = parseFloat(val);
    updateConfig({ temperature: isNaN(n) ? null : n });
  };
  const handleMaxTokensChange = (val: string) => {
    const n = parseInt(val, 10);
    updateConfig({ maxTokens: isNaN(n) || n <= 0 ? null : n });
  };
  const handleThinkingEnabled = (checked: boolean) =>
    updateConfig({ thinkingEnabled: checked || null });
  const handleSkipDangerous = (checked: boolean) =>
    updateConfig({ skipDangerous: checked || null });
  const handleVerbose = (checked: boolean) => updateConfig({ verbose: checked || null });
  const handleMaxTurns = (val: string) => {
    const n = parseInt(val, 10);
    updateConfig({ maxTurns: isNaN(n) || n <= 0 ? null : n });
  };
  const handleThemeChange = (val: string) => updateConfig({ theme: val || null });

  // Permissions
  const handlePermissionMode = (val: string) => updatePermissions({ defaultMode: val || null });

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

  const handleMcpJsonChange = (value: string) => {
    setMcpJson(value);
    if (!value.trim()) {
      setMcpJsonError("");
      updateConfig({ mcpServers: null });
      return;
    }
    try {
      const parsed = JSON.parse(value);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        setMcpJsonError(t("config.invalidJson"));
        return;
      }
      setMcpJsonError("");
      updateConfig({ mcpServers: parsed as JishuConfig["mcpServers"] });
    } catch {
      setMcpJsonError(t("config.invalidJson"));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await invokeCommand("save_config", { config });
      onSaved(config);
    } catch (err) {
      console.error("Failed to save jishu config:", err);
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = JSON.stringify(config) !== JSON.stringify(initialConfig);

  type SectionId = "model" | "env" | "permissions" | "mcp" | "system" | "memory" | "advanced";
  const sectionHasContent: Record<SectionId, boolean> = {
    model: !!(
      config.activeModel ||
      config.temperature !== null ||
      config.maxTokens !== null ||
      config.thinkingEnabled
    ),
    env: !!config.env && Object.keys(config.env).length > 0,
    permissions: !!(
      config.permissions?.defaultMode ||
      (config.permissions?.allow?.length ?? 0) > 0 ||
      (config.permissions?.deny?.length ?? 0) > 0 ||
      config.skipDangerous
    ),
    mcp: !!config.mcpServers && Object.keys(config.mcpServers).length > 0,
    system: !!config.systemInstructions,
    memory: !!config.globalMemory,
    advanced: !!(config.verbose || config.maxTurns || config.theme || config.contextCompaction),
  };
  const sectionOrder: SectionId[] = (
    ["model", "env", "permissions", "mcp", "system", "memory", "advanced"] as SectionId[]
  ).sort((a, b) => {
    if (sectionHasContent[a] && !sectionHasContent[b]) return -1;
    if (!sectionHasContent[a] && sectionHasContent[b]) return 1;
    return 0;
  });
  const expandedDefaults = (Object.entries(sectionHasContent) as [SectionId, boolean][])
    .filter(([, has]) => has)
    .map(([id]) => id);

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-10 bg-background pb-3 border-b border-border mb-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            {t("config.configuration")}
          </h3>
          <Button onClick={handleSave} disabled={!hasChanges || saving || !!mcpJsonError} size="sm">
            <Save className="h-4 w-4" />
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <Accordion type="multiple" defaultValue={expandedDefaults}>
          {sectionOrder.map((sid) => {
            if (sid === "model") {
              return (
                <AccordionItem key="model" value="model">
                  <AccordionTrigger className="group">
                    <span>{t("config.modelSettings")}</span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-4 pt-2">
                      <ModelManager
                        onChanged={() => {}}
                        onActiveModelChange={(modelId) => {
                          updateConfig({ activeModel: modelId });
                        }}
                      />

                      <div className="space-y-2">
                        <Label>{t("config.currentActiveModel")}</Label>
                        <div className="flex items-center gap-2 rounded-md border border-input bg-muted/30 px-3 py-2">
                          <span className="h-2 w-2 rounded-full bg-[var(--icon-success)]" />
                          {config.activeModel ? (
                            <code className="text-xs font-mono">{config.activeModel}</code>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {t("config.noActiveModel")}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("config.activeModelSyncHint")}
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label htmlFor="temperature">{t("config.temperature")}</Label>
                          <Input
                            id="temperature"
                            type="number"
                            step="0.1"
                            min={0}
                            max={2}
                            value={config.temperature ?? ""}
                            onChange={(e) => handleTemperatureChange(e.target.value)}
                            placeholder="0.7"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="maxTokens">{t("config.maxTokens")}</Label>
                          <Input
                            id="maxTokens"
                            type="number"
                            min={1}
                            value={config.maxTokens ?? ""}
                            onChange={(e) => handleMaxTokensChange(e.target.value)}
                            placeholder="8192"
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between rounded-md border px-3 py-3">
                        <div className="space-y-0.5">
                          <Label>{t("config.thinkingEnabled")}</Label>
                          <p className="text-xs text-muted-foreground">
                            {t("config.thinkingEnabledDesc")}
                          </p>
                        </div>
                        <Switch
                          checked={config.thinkingEnabled === true}
                          onCheckedChange={handleThinkingEnabled}
                        />
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            }

            if (sid === "env") {
              return (
                <AccordionItem key="env" value="env">
                  <AccordionTrigger className="group">
                    <span>{t("config.envVars")}</span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 pt-2">
                      {Object.entries(config.env || {}).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-2">
                          <code className="min-w-[140px] rounded bg-muted px-2 py-1 text-xs font-mono">
                            {key}
                          </code>
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
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleAddEnv}
                          disabled={!newEnvKey.trim()}
                        >
                          <Plus className="mr-1 h-3 w-3" />
                          {t("common.add")}
                        </Button>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            }

            if (sid === "permissions") {
              return (
                <AccordionItem key="permissions" value="permissions">
                  <AccordionTrigger className="group">
                    <span>{t("config.permissionsSecurity")}</span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-4 pt-2">
                      <div className="space-y-2">
                        <Label htmlFor="permMode">{t("config.permissionMode")}</Label>
                        <select
                          id="permMode"
                          value={config.permissions?.defaultMode || ""}
                          onChange={(e) => handlePermissionMode(e.target.value)}
                          className={selectClass}
                        >
                          <option value="">{t("common.default")}</option>
                          {PERMISSION_MODES.map((p) => (
                            <option key={p.value} value={p.value}>
                              {t(`config.${p.labelKey}`)}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-2">
                        <Label>{t("config.allowList")}</Label>
                        <div className="space-y-2">
                          {(config.permissions?.allow ?? []).map((pattern, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono">
                                {pattern}
                              </code>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={() => handleRemoveAllowPattern(idx)}
                              >
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
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleAddAllowPattern}
                              disabled={!newAllowPattern.trim()}
                            >
                              <Plus className="mr-1 h-3 w-3" />
                              {t("config.addPattern")}
                            </Button>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>{t("config.denyList")}</Label>
                        <div className="space-y-2">
                          {(config.permissions?.deny ?? []).map((pattern, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono">
                                {pattern}
                              </code>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={() => handleRemoveDenyPattern(idx)}
                              >
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
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleAddDenyPattern}
                              disabled={!newDenyPattern.trim()}
                            >
                              <Plus className="mr-1 h-3 w-3" />
                              {t("config.addPattern")}
                            </Button>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between rounded-md border px-3 py-3">
                        <div className="space-y-0.5">
                          <Label>{t("config.skipDangerous")}</Label>
                          <p className="text-xs text-muted-foreground">
                            {t("config.skipDangerousDesc")}
                          </p>
                        </div>
                        <Switch
                          checked={config.skipDangerous === true}
                          onCheckedChange={handleSkipDangerous}
                        />
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            }

            if (sid === "mcp") {
              return (
                <AccordionItem key="mcp" value="mcp">
                  <AccordionTrigger className="group">
                    <span>{t("config.mcpServers")}</span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 pt-2">
                      <textarea
                        className="h-56 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={mcpJson}
                        onChange={(e) => handleMcpJsonChange(e.target.value)}
                        spellCheck={false}
                        placeholder='{"server-name":{"type":"local","command":["npx","-y","@example/mcp"]}}'
                      />
                      {mcpJsonError ? (
                        <p className="text-xs text-destructive">{mcpJsonError}</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t("config.mcpJsonHint")}</p>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            }

            if (sid === "system") {
              return (
                <AccordionItem key="system" value="system">
                  <AccordionTrigger className="group">
                    <span>{t("config.systemInstructions")}</span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 pt-2">
                      <textarea
                        value={config.systemInstructions || ""}
                        onChange={(e) =>
                          updateConfig({ systemInstructions: e.target.value || null })
                        }
                        placeholder={t("config.systemInstructionsPlaceholder")}
                        className={textareaClass}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("config.systemInstructionsHint")}
                      </p>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            }

            if (sid === "memory") {
              return (
                <AccordionItem key="memory" value="memory">
                  <AccordionTrigger className="group">
                    <span className="flex items-center gap-2">
                      <Brain className="h-4 w-4" />
                      {t("config.globalMemory")}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 pt-2">
                      <textarea
                        value={config.globalMemory || ""}
                        onChange={(e) => updateConfig({ globalMemory: e.target.value || null })}
                        placeholder={t("config.globalMemoryPlaceholder")}
                        className={textareaClass.replace("min-h-[160px]", "min-h-[140px]")}
                        disabled
                      />
                      <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                        {t("config.globalMemoryComingSoon")}
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            }

            if (sid === "advanced") {
              return (
                <AccordionItem key="advanced" value="advanced">
                  <AccordionTrigger className="group">
                    <span>{t("config.advanced")}</span>
                  </AccordionTrigger>
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
                        <Label htmlFor="maxTurnsAdv">{t("config.maxTurns")}</Label>
                        <Input
                          id="maxTurnsAdv"
                          type="number"
                          min={1}
                          value={config.maxTurns ?? ""}
                          onChange={(e) => handleMaxTurns(e.target.value)}
                          placeholder="e.g., 200"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="theme">{t("config.theme")}</Label>
                        <select
                          id="theme"
                          value={config.theme || ""}
                          onChange={(e) => handleThemeChange(e.target.value)}
                          className={selectClass}
                        >
                          <option value="">{t("common.default")}</option>
                          <option value="dark">dark</option>
                          <option value="light">light</option>
                          <option value="auto">auto</option>
                        </select>
                      </div>

                      <div className="space-y-2 rounded-md border p-3">
                        <Label>{t("config.contextCompaction")}</Label>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label htmlFor="ctxThreshold" className="text-xs text-muted-foreground">
                              {t("config.threshold")}
                            </Label>
                            <Input
                              id="ctxThreshold"
                              type="number"
                              step="0.05"
                              min={0}
                              max={1}
                              value={config.contextCompaction?.threshold ?? ""}
                              onChange={(e) => {
                                const n = parseFloat(e.target.value);
                                updateContextCompaction({ threshold: isNaN(n) ? null : n });
                              }}
                              placeholder="0.85"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="ctxMethod" className="text-xs text-muted-foreground">
                              {t("config.method")}
                            </Label>
                            <select
                              id="ctxMethod"
                              value={config.contextCompaction?.method || ""}
                              onChange={(e) =>
                                updateContextCompaction({ method: e.target.value || null })
                              }
                              className={selectClass}
                            >
                              <option value="">{t("common.default")}</option>
                              {COMPACTION_METHODS.map((m) => (
                                <option key={m.value} value={m.value}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            }

            return null;
          })}
        </Accordion>
      </div>
    </div>
  );
}
