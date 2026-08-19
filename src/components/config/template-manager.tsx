import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Trash2, Sparkles, Pencil, Eye, User, Plus } from "lucide-react";
import { useAgent } from "@/agents";
import { CLAUDE_PROXY_PRESETS } from "@/agents/config/presets/claude-presets";
import { PROVIDER_PRESETS } from "@/agents/config/presets/provider-presets";
import { CODEX_PROXY_PRESETS } from "@/agents/config/presets/codex-presets";
import { PERMISSION_MODE_LABEL_KEYS } from "@/agents/permissions";
import type { ConfigTemplate, ClaudeConfig, Preset } from "@/types";

interface TemplateManagerProps {
  onApplied: () => void;
}

const MODE_LABELS: Record<string, string> = PERMISSION_MODE_LABEL_KEYS;

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "config.providerAnthropic",
  bedrock: "config.providerBedrock",
  vertex: "config.providerVertex",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-4-6": "config.modelSonnet46",
  "claude-opus-4-7": "config.modelOpus47",
  "claude-haiku-4-5-20251001": "config.modelHaiku45",
};

function resolveLabel(map: Record<string, string>, key: string | null | undefined, t: (k: string, opts?: Record<string, unknown>) => string): string | null {
  if (!key) return null;
  const i18nKey = map[key];
  return i18nKey ? t(i18nKey) : key;
}

function extractConfigItems(config: ClaudeConfig, t: (k: string, opts?: Record<string, unknown>) => string): { label: string; value: string; highlight?: boolean }[] {
  const items: { label: string; value: string; highlight?: boolean }[] = [];

  const model = resolveLabel(MODEL_LABELS, config.model, t);
  if (model) items.push({ label: t("config.modelLabel"), value: model });

  const mode = config.permissions?.defaultMode;
  if (mode) {
    const label = resolveLabel(MODE_LABELS, mode, t);
    items.push({ label: t("config.modeLabel"), value: label ?? mode, highlight: mode === "bypassPermissions" });
  }

  const allow = config.permissions?.allow;
  if (allow && allow.length > 0) {
    items.push({ label: t("config.allowCount", { count: allow.length }), value: allow.join(", ") });
  }

  const deny = config.permissions?.deny;
  if (deny && deny.length > 0) {
    items.push({ label: t("config.denyCount", { count: deny.length }), value: deny.join(", ") });
  }

  if (config.sandbox?.enabled) {
    items.push({ label: t("config.sandboxLabel"), value: t("config.enabled") });
  }

  if (config.skipDangerousModePermissionPrompt) {
    items.push({ label: t("config.skipDangerousShort"), value: t("config.enabled"), highlight: true });
  }

  const provider = resolveLabel(PROVIDER_LABELS, config.apiProvider, t);
  if (provider) items.push({ label: t("config.providerLabel"), value: provider });

  if (config.verbose) items.push({ label: t("config.verboseLabel"), value: t("config.enabled") });
  if (config.maxTurns) items.push({ label: t("config.maxTurnsLabel"), value: String(config.maxTurns) });

  // Show key env vars (non-empty values or known important keys)
  const env = config.env ?? {};
  const importantEnvKeys = [
    "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "AWS_REGION", "ANTHROPIC_VERTEX_PROJECT_ID",
  ];
  for (const key of importantEnvKeys) {
    if (key in env) {
      const val = env[key];
      if (val) {
        // Mask sensitive values
        const isSecret = /KEY|TOKEN|SECRET/i.test(key);
        items.push({ label: key, value: isSecret ? "••••••" : val });
      } else {
        items.push({ label: key, value: `(${t("config.fillRequiredInfo")})` });
      }
    }
  }
  // Also show non-empty env vars not in the important list
  for (const [key, val] of Object.entries(env)) {
    if (!importantEnvKeys.includes(key) && val) {
      const isSecret = /KEY|TOKEN|SECRET/i.test(key);
      items.push({ label: key, value: isSecret ? "••••••" : val });
    }
  }

  return items;
}

function ConfigSummary({ config }: { config: Record<string, unknown> }) {
  const { t } = useTranslation();
  // 摘要按数据形状识别：claude 形状走 extractConfigItems；jishu 行为形状
  //（defaultThinkingLevel/compaction/defaultTools/retry/model_store_patch）
  // v0.7.5 需求6 补充展示，未识别结构自然略过。
  const items = extractConfigItems(config as unknown as ClaudeConfig, t);

  const level = config.defaultThinkingLevel as string | undefined;
  if (level) {
    items.push({
      label: t("sessions.thinkingLevel.title"),
      value: t(`sessions.thinkingLevel.${level}`),
    });
  }
  const compaction = config.compaction as { enabled?: boolean } | undefined;
  if (compaction) {
    items.push({
      label: t("config.compactionTitle"),
      value: compaction.enabled === false ? t("common.disabled") : t("common.enabled"),
    });
  }
  const tools = config.defaultTools as string[] | undefined;
  if (tools) {
    items.push({
      label: t("config.defaultToolsTitle"),
      value: tools.map((x) => t(`config.tools.${x}`)).join("/"),
    });
  }
  const retry = config.retry as { enabled?: boolean } | undefined;
  if (retry) {
    items.push({
      label: t("config.retryTitle"),
      value: retry.enabled === false ? t("common.disabled") : t("common.enabled"),
    });
  }
  // customProviders 形状（opencode 模版）：渠道名列表。
  const providers = config.customProviders as Record<string, unknown> | undefined;
  if (providers) {
    const names = Object.values(providers)
      .map((p) => (typeof (p as { name?: unknown })?.name === "string"
        ? ((p as { name?: string }).name as string)
        : undefined))
      .filter(Boolean);
    if (names.length > 0) {
      items.push({ label: t("config.customProvidersLabel"), value: names.join(" / ") });
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="mt-2 space-y-0.5">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-1.5 text-xs leading-relaxed min-w-0">
          <span className="text-muted-foreground shrink-0">{item.label}:</span>
          {item.highlight ? (
            <Badge variant="secondary" className="text-xs font-normal px-1.5 py-0 truncate max-w-[200px]">
              {item.value}
            </Badge>
          ) : (
            <span className="truncate">{item.value}</span>
          )}
        </div>
      ))}
    </div>
  );
}

interface TemplateCardProps {
  name: string;
  description?: string;
  config: Record<string, unknown>;
  createdAt?: string;
  isSystem?: boolean;
  onApply: () => void;
  onView?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

function TemplateCard({ name, description, config, createdAt, isSystem, onApply, onView, onEdit, onDelete }: TemplateCardProps) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col h-full">
      <div className="flex items-start justify-between gap-2 min-h-[3rem]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-sm truncate">{name}</h4>
            {isSystem && (
              <Badge variant="outline" className="text-xs shrink-0">{t("config.systemTemplates")}</Badge>
            )}
          </div>
          {description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{description}</p>
          )}
        </div>
        {onDelete && (
          <Button variant="ghost" size="icon-xs" className="shrink-0" onClick={onDelete}>
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>

      <ConfigSummary config={config} />

      <div className="flex items-center justify-end gap-1 mt-auto pt-2 border-t border-border mt-3">
        {createdAt && (
          <span className="text-xs text-muted-foreground mr-auto">
            {t("config.created", { date: new Date(createdAt).toLocaleDateString() })}
          </span>
        )}
        {onView && (
          <Button variant="ghost" size="sm" onClick={onView}>
            <Eye className="h-3.5 w-3.5" />
            {t("config.viewDetail")}
          </Button>
        )}
        {onEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            {t("config.editTemplate")}
          </Button>
        )}
        {onDelete && (
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onApply}>
          {t("config.applyTemplate")}
        </Button>
      </div>
    </div>
  );
}

/** Detail / Edit dialog — readOnly for system, editable for user */
function TemplateDetailDialog({ open, onOpenChange, template, editable, onSave }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: { name: string; description?: string; config: Record<string, unknown>; createdAt?: string } | null;
  editable: boolean;
  onSave?: (name: string, description: string, config: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editJson, setEditJson] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (template) {
      setEditName(template.name);
      setEditDesc(template.description ?? "");
      const clean = cleanConfigForJson(template.config);
      setEditJson(JSON.stringify(clean, null, 2));
      setJsonError("");
    }
  }, [template]);

  const handleSave = async () => {
    if (!editable || !onSave) return;
    setSaving(true);
    try {
      const parsed = JSON.parse(editJson);
      onSave(editName.trim(), editDesc.trim(), parsed as Record<string, unknown>);
      onOpenChange(false);
    } catch {
      setJsonError(t("config.invalidJson"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editable ? t("config.editTemplate") : t("config.viewDetail")}</DialogTitle>
        </DialogHeader>
        {template && (
          <div className="space-y-3 py-2">
            {editable ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t("config.templateName")}</Label>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("config.templateDescLabel")}</Label>
                  <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="h-8" />
                </div>
              </div>
            ) : (
              <div>
                <h4 className="font-medium">{template.name}</h4>
                {template.description && <p className="text-sm text-muted-foreground mt-0.5">{template.description}</p>}
                {template.createdAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("config.created", { date: new Date(template.createdAt).toLocaleString() })}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs">{t("config.configJson")}</Label>
              <textarea
                className={`w-full h-64 rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${!editable ? "cursor-default" : ""}`}
                value={editJson}
                onChange={(e) => { setEditJson(e.target.value); setJsonError(""); }}
                readOnly={!editable}
                spellCheck={false}
              />
              {editable && <p className="text-xs text-muted-foreground">{t("config.editHint")}</p>}
              {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {editable && (
            <Button onClick={handleSave} disabled={!editName.trim() || saving}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// v0.7.4 需求2 R1：供应商清单改引自共享注册表（旧 PROXY_PROVIDERS 删除），
// 且端点统一为 Anthropic 兼容地址（旧表是 openai 兼容地址，对
// ANTHROPIC_BASE_URL 不生效）。

/** Dialog to fill in empty env values and model before applying a system template.
 *  v0.7.5 需求6：新增模型库补填区（模版声明 model_store_patch 时渲染）——
 *  服务商下拉复用模型设置页的 PROVIDER_PRESETS 注册表（单一来源），
 *  选定后勾选模型、填密钥，应用时组装 provider 合并写 models.json。 */
function FillAndApplyDialog({ open, onOpenChange, template, onApply }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: ConfigTemplateView | null;
  onApply: (config: Record<string, unknown>, modelProvider?: { id: string; provider: Record<string, unknown> }) => void;
}) {
  const { t } = useTranslation();
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [modelValue, setModelValue] = useState("");
  // 模型库补填态（v0.7.5 需求6）
  const [presetId, setPresetId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  // 自定义供应商补填态（v0.7.5 需求6 opencode）：providerId → 输入值
  const [providerInputs, setProviderInputs] = useState<
    Record<string, { apiKey: string; baseURL: string; modelId: string }>
  >({});
  // codex model_providers 补填态（v0.7.5 需求7）：base_url 空时填端点。
  const [proxyBaseUrl, setProxyBaseUrl] = useState("");
  // codex 中转预设选择（v0.7.5 需求7 迭代三：对齐 claude 的供应商下拉交互）
  const [proxyPresetId, setProxyPresetId] = useState("");
  const proxyPreset = CODEX_PROXY_PRESETS.find((p) => p.id === proxyPresetId);

  const templateEnv = (template?.config.env ?? {}) as Record<string, string>;
  const emptyEnvKeys = template
    ? Object.entries(templateEnv)
      .filter(([, v]) => !v)
      .map(([k]) => k)
    : [];
  const needModel = template ? !template.config.model : false;
  const needsModelStore = Boolean(template?.model_store_patch);
  // modelProviders 形状（codex 中转模版）：base_url 空 → 补填端点
  //（密钥经 env 空值机制补填；模型 ID 走 needModel 机制）。
  const modelProviders = (template?.config.modelProviders ?? null) as
    | Record<string, Record<string, unknown>>
    | null;
  const emptyProxyBaseUrl = modelProviders
    ? Object.values(modelProviders).some((p) => !p.base_url)
    : false;
  // customProviders 形状（opencode 模版）：渠道经 config 域写入，apiKey/
  // baseURL 空 → 补填；自定义渠道（带 npm）还需模型 ID。
  const customProviders = (template?.config.customProviders ?? null) as
    | Record<string, Record<string, unknown>>
    | null;
  const needsProviders = Boolean(customProviders);
  const hasEmpty =
    emptyEnvKeys.length > 0 || needModel || needsModelStore || needsProviders || emptyProxyBaseUrl;

  const selectedPreset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  const asObj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};

  // Initialize state when template changes
  useEffect(() => {
    if (template && emptyEnvKeys.length > 0) {
      const init: Record<string, string> = {};
      for (const k of emptyEnvKeys) init[k] = "";
      setEnvValues(init);
    }
    if (template && needModel) {
      setModelValue("");
    }
    setPresetId("");
    setApiKey("");
    setSelectedModels([]);
    setProviderInputs({});
    setProxyBaseUrl("");
    setProxyPresetId("");
  }, [template]);

  const handleApply = () => {
    if (!template) return;
    const config: Record<string, unknown> = { ...template.config };
    if (Object.keys(envValues).length > 0) {
      const env = { ...templateEnv };
      for (const [k, v] of Object.entries(envValues)) {
        if (v) env[k] = v;
      }
      config.env = env;
    }
    if (needModel && modelValue) {
      config.model = modelValue;
    }
    // codex 中转补填（迭代三：对齐 claude 供应商下拉）：选中预设时按预设
    // 完整组装——provider id/name/base_url/env_key 用预设值（覆盖模版占位），
    // 密钥从模版占位 env 键映射到预设 envKey；未选预设仅回填 base_url。
    if (modelProviders && proxyBaseUrl) {
      if (proxyPreset) {
        const filledKey = Object.values(envValues).find((v) => v) ?? "";
        config.modelProvider = proxyPreset.id;
        config.modelProviders = {
          [proxyPreset.id]: {
            name: t(proxyPreset.labelKey),
            base_url: proxyBaseUrl,
            wire_api: "responses",
            env_key: proxyPreset.envKey,
          },
        };
        config.env = { [proxyPreset.envKey]: filledKey };
        if (modelValue) config.model = modelValue;
        else if (proxyPreset.model) config.model = proxyPreset.model;
      } else {
        const merged: Record<string, unknown> = {};
        for (const [pid, raw] of Object.entries(modelProviders)) {
          merged[pid] = raw.base_url ? raw : { ...raw, base_url: proxyBaseUrl };
        }
        config.modelProviders = merged;
      }
    }
    // 模型库补填：按预设组装 provider（模型勾选为空时默认取预设全部）。
    let modelProvider: { id: string; provider: Record<string, unknown> } | undefined;
    if (needsModelStore && selectedPreset) {
      const chosen = selectedModels.length > 0
        ? selectedModels
        : selectedPreset.models.map((m) => m.id);
      modelProvider = {
        id: selectedPreset.id,
        provider: {
          name: t(selectedPreset.id_label),
          baseUrl: selectedPreset.baseUrl,
          api: selectedPreset.api,
          ...(apiKey ? { apiKey } : {}),
          models: selectedPreset.models
            .filter((m) => chosen.includes(m.id))
            .map((m) => ({
              id: m.id,
              name: m.displayName,
              reasoning: m.reasoning ?? false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: m.contextWindow ?? 128000,
              maxTokens: m.maxTokens ?? 8192,
              ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
              ...((m as { compat?: Record<string, unknown> }).compat
                ? { compat: (m as { compat?: Record<string, unknown> }).compat }
                : {}),
            })),
        },
      };
    }
    // customProviders 形状组装（opencode）：填入密钥/地址/模型；自定义渠道
    //（models 空 + 用户填了模型 ID）同时把主/小模型指向 provider/model。
    if (needsProviders && customProviders) {
      const merged: Record<string, unknown> = {};
      for (const [pid, raw] of Object.entries(customProviders)) {
        const input = providerInputs[pid];
        const options = { ...asObj(raw.options) };
        if (input?.apiKey) options.apiKey = input.apiKey;
        if (input?.baseURL) options.baseURL = input.baseURL;
        let entry: Record<string, unknown> = { ...raw, options };
        if (input?.modelId) {
          entry = {
            ...entry,
            models: { ...asObj(raw.models), [input.modelId]: { name: input.modelId } },
          };
          if (!config.model) config.model = `${pid}/${input.modelId}`;
          if (!config.smallModel) config.smallModel = `${pid}/${input.modelId}`;
        }
        merged[pid] = entry;
      }
      config.customProviders = merged;
    }
    onApply(config, modelProvider);
    onOpenChange(false);
    setEnvValues({});
    setModelValue("");
    setPresetId("");
    setApiKey("");
    setSelectedModels([]);
    setProviderInputs({});
    setProxyBaseUrl("");
    setProxyPresetId("");
  };

  if (!hasEmpty && template) {
    // No empty fields, apply directly
    return null;
  }

  const selectClass = "flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setEnvValues({}); setModelValue(""); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("config.fillRequiredInfo")}</DialogTitle>
        </DialogHeader>
        {template && (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">{t("config.fillRequiredDesc")}</p>
            {emptyEnvKeys.includes("ANTHROPIC_BASE_URL") && (
              <div className="space-y-2 mb-4 p-4 border rounded bg-muted/30">
                <Label>{t("config.presetStepChoose")}</Label>
                <select
                  className={selectClass}
                  onChange={(e) => {
                    const p = CLAUDE_PROXY_PRESETS.find(x => x.id === e.target.value);
                    if (p && p.baseUrl) {
                       setEnvValues(prev => ({ ...prev, "ANTHROPIC_BASE_URL": p.baseUrl, "ANTHROPIC_MODEL": p.model }));
                       if (needModel) setModelValue(p.model);
                    }
                  }}
                >
                  <option value="">{t("config.presetSelectPlaceholder")}</option>
                  {CLAUDE_PROXY_PRESETS.map(p => <option key={p.id} value={p.id}>{t(p.labelKey)}</option>)}
                </select>
              </div>
            )}
            {needsModelStore && (
              <div className="space-y-2 mb-4 p-4 border rounded bg-muted/30">
                <Label>{t("config.presetStepChoose")}</Label>
                <select
                  className={selectClass}
                  value={presetId}
                  onChange={(e) => {
                    setPresetId(e.target.value);
                    setSelectedModels([]);
                  }}
                >
                  <option value="">{t("config.presetSelectPlaceholder")}</option>
                  {PROVIDER_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{t(p.id_label)}</option>
                  ))}
                </select>
                {selectedPreset && (
                  <div className="space-y-2 pt-1">
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
                      {selectedPreset.models.map((m) => (
                        <label key={m.id} className="inline-flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            className="h-3 w-3"
                            checked={selectedModels.length === 0 || selectedModels.includes(m.id)}
                            onChange={(e) => {
                              setSelectedModels((prev) => {
                                const base = prev.length === 0
                                  ? selectedPreset.models.map((x) => x.id)
                                  : prev;
                                return e.target.checked
                                  ? selectedPreset.models.map((x) => x.id).filter((id) => base.includes(id) || id === m.id)
                                  : base.filter((id) => id !== m.id);
                              });
                            }}
                          />
                          {m.displayName}
                        </label>
                      ))}
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-mono">API Key</Label>
                      <Input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={selectedPreset.apiKeyUrl
                          ? t("config.presetKeyHint", { url: selectedPreset.apiKeyUrl })
                          : t("config.apiKeyPlaceholder")}
                        className="h-8"
                      />
                      {selectedPreset.apiKeyUrl && (
                        <button
                          type="button"
                          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                          onClick={() => invokeCommand("open_url", { url: selectedPreset.apiKeyUrl }).catch(console.error)}
                        >
                          {t("config.presetGetKey")}
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {t("config.templateModelStoreHint")}
                    </p>
                  </div>
                )}
              </div>
            )}
            {needsProviders && customProviders && (
              <div className="space-y-3 mb-4 p-4 border rounded bg-muted/30">
                {Object.entries(customProviders).map(([pid, raw]) => {
                  const options = asObj(raw.options);
                  const isCustom = typeof raw.npm === "string";
                  const input = providerInputs[pid] ?? { apiKey: "", baseURL: "", modelId: "" };
                  const setInput = (patch: Partial<typeof input>) =>
                    setProviderInputs((prev) => ({
                      ...prev,
                      [pid]: { ...input, ...patch },
                    }));
                  return (
                    <div key={pid} className="space-y-2">
                      <Label className="text-sm">
                        {typeof raw.name === "string" ? raw.name : pid}
                      </Label>
                      {isCustom && (
                        <div className="space-y-1">
                          <Label className="text-xs">Base URL</Label>
                          <Input
                            value={input.baseURL}
                            onChange={(e) => setInput({ baseURL: e.target.value })}
                            placeholder="https://api.example.com/v1"
                            className="h-8"
                          />
                        </div>
                      )}
                      {!options.apiKey && (
                        <div className="space-y-1">
                          <Label className="text-xs font-mono">API Key</Label>
                          <Input
                            type="password"
                            value={input.apiKey}
                            onChange={(e) => setInput({ apiKey: e.target.value })}
                            placeholder={t("config.apiKeyPlaceholder")}
                            className="h-8"
                          />
                        </div>
                      )}
                      {isCustom && Object.keys(asObj(raw.models)).length === 0 && (
                        <div className="space-y-1">
                          <Label className="text-xs">{t("config.modelId")}</Label>
                          <Input
                            value={input.modelId}
                            onChange={(e) => setInput({ modelId: e.target.value })}
                            placeholder={t("config.modelIdPlaceholder")}
                            className="h-8"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("config.templateProvidersHint")}
                </p>
              </div>
            )}
            {emptyProxyBaseUrl && (
              <div className="space-y-2 mb-4 p-4 border rounded bg-muted/30">
                <Label>{t("config.presetStepChoose")}</Label>
                <select
                  className={selectClass}
                  value={proxyPresetId}
                  onChange={(e) => {
                    const preset = CODEX_PROXY_PRESETS.find((p) => p.id === e.target.value);
                    setProxyPresetId(e.target.value);
                    if (preset) {
                      setProxyBaseUrl(preset.baseUrl);
                      if (preset.model) setModelValue(preset.model);
                    }
                  }}
                >
                  <option value="">{t("config.presetSelectPlaceholder")}</option>
                  {CODEX_PROXY_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{t(p.labelKey)}</option>
                  ))}
                </select>
                <div className="space-y-1">
                  <Label className="text-xs">Base URL</Label>
                  <Input
                    value={proxyBaseUrl}
                    onChange={(e) => setProxyBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="h-8"
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t("config.proxyResponsesHint")}
                  </p>
                </div>
              </div>
            )}
            {needModel && (
              <div className="space-y-1">
                <Label className="text-xs">{t("config.modelId")}</Label>
                <Input
                  value={modelValue}
                  onChange={(e) => setModelValue(e.target.value)}
                  placeholder={t("config.modelIdPlaceholder")}
                  className="h-8"
                />
              </div>
            )}
            {emptyEnvKeys.map((key) => (
              <div key={key} className="space-y-1">
                <Label className="text-xs font-mono">{key}</Label>
                <Input
                  type={key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") ? "password" : "text"}
                  value={envValues[key] ?? ""}
                  onChange={(e) => setEnvValues({ ...envValues, [key]: e.target.value })}
                  placeholder={t("config.envValueHint", { key })}
                  className="h-8"
                />
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => { onOpenChange(false); setEnvValues({}); setModelValue(""); }}>
            {t("common.cancel")}
          </Button>
          <Button variant="ghost" onClick={() => { if (template) { onApply(template.config); onOpenChange(false); } }}>
            {t("config.applyAnyway")}
          </Button>
          <Button onClick={handleApply}>
            {t("config.applyTemplate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function cleanConfigForJson(config: Record<string, unknown>): Record<string, unknown> {
  const val = JSON.parse(JSON.stringify(config));
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (obj[key] === null || obj[key] === undefined) {
        delete obj[key];
      }
    }
    if (obj.permissions && typeof obj.permissions === "object") {
      const perms = obj.permissions as Record<string, unknown>;
      for (const key of Object.keys(perms)) {
        if (perms[key] === null || perms[key] === undefined) {
          delete perms[key];
        }
      }
      if (Object.keys(perms).length === 0) delete obj.permissions;
    }
    if (obj.sandbox && typeof obj.sandbox === "object") {
      const sb = obj.sandbox as Record<string, unknown>;
      for (const key of Object.keys(sb)) {
        if (sb[key] === null || sb[key] === undefined) {
          delete sb[key];
        }
      }
      if (Object.keys(sb).length === 0) delete obj.sandbox;
    }
  }
  return val;
}

type ConfigTemplateView = Omit<ConfigTemplate, "config"> & { config: Record<string, unknown> };

// 适配层驱动：模版 config 原样透传——此前所有模版（含 jishu 用户模版）
// 都被 normalizeClaudeConfig 剥成 claude 形状，非 claude 字段在应用时
// 静默丢失。是否需要补填由 ConfigTemplate.requires_fill（各 adapter
// 在 config_templates() 中声明）决定，前端不嗅探字段猜 agent。
function toConfigTemplateView(template: ConfigTemplate): ConfigTemplateView {
  const raw = template.config;
  const config =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return { ...template, config };
}

export function TemplateManager({ onApplied }: TemplateManagerProps) {
  const { t } = useTranslation();
  // v0.7.0 需求一：管理作用域状态（manageAgentId 替代全局 activeId）。
  const { manageAgentId: activeId, manageAgent: active } = useAgent();
  const agentRefreshKey = activeId ? Array.from(activeId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) : 0;
  const { data: systemTemplates, loading: loadingSystem } = useInvoke<ConfigTemplate[]>(
    activeId ? "list_config_templates" : "",
    activeId ? { agentId: activeId } : undefined,
    agentRefreshKey,
  );
  const { data: userPresets, loading: loadingUser, refetch: refetchPresets } = useInvoke<Preset[]>(
    activeId ? "list_presets" : "",
    activeId ? { agentId: activeId } : undefined,
    agentRefreshKey,
  );
  const { data: currentConfig } = useInvoke<Record<string, unknown>>(
    activeId ? "load_config" : "",
    activeId ? { agentId: activeId } : undefined,
    agentRefreshKey,
  );
  const [applyError, setApplyError] = useState<string | null>(null);
  // v0.7.4：应用成功反馈（此前静默成功，用户无从确认模版已写入）。
  const [applySuccess, setApplySuccess] = useState<string | null>(null);
  const flashApplySuccess = () => {
    setApplySuccess(t("config.applyTemplateSuccess"));
    setTimeout(() => setApplySuccess(null), 3000);
  };

  // Save current as preset dialog
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDesc, setSaveDesc] = useState("");
  const [saving, setSaving] = useState(false);

  // New blank template dialog
  const [newOpen, setNewOpen] = useState(false);

  // Detail / Edit dialog
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<{ name: string; description?: string; config: Record<string, unknown>; createdAt?: string } | null>(null);
  const [detailEditable, setDetailEditable] = useState(false);
  const [detailPresetId, setDetailPresetId] = useState<string | null>(null);

  // Fill & Apply dialog
  const [fillOpen, setFillOpen] = useState(false);
  const [fillTemplate, setFillTemplate] = useState<ConfigTemplateView | null>(null);

  const handleApplySystem = (template: ConfigTemplateView) => {
    // 补填弹窗按 adapter 声明的 requires_fill 门控（claude 模版补填密钥/
    // 模型；jishu 推荐模版经 model_store_patch 补填服务商/密钥/模型）——
    // 适配层驱动，不嗅探配置字段。
    if (!template.requires_fill) {
      void doApplyConfig(template.config);
      return;
    }
    const env = (template.config.env ?? {}) as Record<string, string>;
    const hasEmptyEnv = Object.values(env).some((v) => !v);
    const needsModel = !template.config.model;
    const hasProviders = Boolean(template.config.customProviders);
    // codex 中转（modelProviders）：base_url 空也需补填。
    const rawModelProviders = template.config.modelProviders as
      | Record<string, { base_url?: unknown }>
      | undefined;
    const hasEmptyProxyUrl = Boolean(
      rawModelProviders && Object.values(rawModelProviders).some((p) => !p.base_url),
    );
    if (
      hasEmptyEnv ||
      needsModel ||
      template.model_store_patch ||
      hasProviders ||
      hasEmptyProxyUrl
    ) {
      setFillTemplate(template);
      setFillOpen(true);
    } else {
      void doApplyConfig(template.config);
    }
  };

  // v0.7.5 需求6：模版应用扩展——带 modelProvider（补填弹窗组装的服务商
  // 渠道）时，先读现有模型库 upsert 该渠道（其余渠道保留），再写 agent 配置。
  // 带 customProviders（opencode 渠道，config 域）时同样先合并现有渠道再
  // 提交——保存侧 provider 段是整段替换语义，全量组装保证不删用户渠道。
  const doApplyConfig = async (
    config: Record<string, unknown>,
    modelProvider?: { id: string; provider: Record<string, unknown> },
  ) => {
    setApplyError(null);
    try {
      let finalConfig = config;
      if (config.customProviders) {
        const current = await invokeCommand<Record<string, unknown>>("load_config", {
          agentId: activeId ?? "",
        });
        const existingProviders =
          (current?.customProviders as Record<string, unknown> | undefined) ?? {};
        finalConfig = {
          ...config,
          customProviders: { ...existingProviders, ...config.customProviders },
        };
      }
      // codex modelProviders 同理：保存侧整组替换，先合并现有渠道
      //（「官方直连」模版的显式 modelProvider:null 不受影响——它不携带该键）。
      if (config.modelProviders) {
        const current = await invokeCommand<Record<string, unknown>>("load_config", {
          agentId: activeId ?? "",
        });
        const existingProxy =
          (current?.modelProviders as Record<string, unknown> | undefined) ?? {};
        finalConfig = {
          ...finalConfig,
          modelProviders: { ...existingProxy, ...config.modelProviders },
        };
      }
      if (modelProvider) {
        const store = await invokeCommand<Record<string, unknown>>("get_models_config", {
          agentId: activeId ?? "",
        });
        const providers = {
          ...((store?.providers as Record<string, unknown>) ?? {}),
          [modelProvider.id]: modelProvider.provider,
        };
        await invokeCommand("set_models_config", {
          agentId: activeId ?? "",
          config: { ...store, providers },
        });
      }
      await invokeCommand("save_config", { agentId: activeId ?? "", config: finalConfig });
      onApplied();
      flashApplySuccess();
    } catch (err) {
      console.error("Failed to apply template:", err);
      setApplyError(String(err));
    }
  };

  const handleSaveCurrent = async () => {
    if (!saveName.trim() || !currentConfig) return;
    setSaving(true);
    try {
      const preset: Preset = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: saveName.trim(),
        description: saveDesc.trim() || undefined,
        config: currentConfig,
        createdAt: new Date().toISOString(),
      };
      await invokeCommand("save_preset", { agentId: activeId ?? "", preset });
      setSaveOpen(false);
      setSaveName("");
      setSaveDesc("");
      refetchPresets();
    } catch (err) {
      console.error("Failed to save preset:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleNewTemplate = async (name: string, description: string, config: Record<string, unknown>) => {
    const preset: Preset = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      description: description || undefined,
      config,
      createdAt: new Date().toISOString(),
    };
    await invokeCommand("save_preset", { agentId: activeId ?? "", preset });
    refetchPresets();
  };

  const handleApplyUser = async (id: string) => {
    try {
      await invokeCommand("apply_preset", { agentId: activeId ?? "", id });
      onApplied();
      flashApplySuccess();
    } catch (err) {
      console.error("Failed to apply user template:", err);
      setApplyError(String(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await invokeCommand("delete_preset", { agentId: activeId ?? "", id });
      refetchPresets();
    } catch (err) {
      console.error("Failed to delete template:", err);
    }
  };

  const handleUpdateUserTemplate = async (name: string, description: string, config: Record<string, unknown>) => {
    if (!detailPresetId) return;
    const preset: Preset = {
      id: detailPresetId,
      name,
      description: description || undefined,
      config,
      createdAt: detailTarget?.createdAt ?? new Date().toISOString(),
    };
    await invokeCommand("save_preset", { agentId: activeId ?? "", preset });
    refetchPresets();
  };

  const openDetail = (tpl: { name: string; description?: string; config: Record<string, unknown>; createdAt?: string }, editable: boolean, presetId?: string) => {
    setDetailTarget(tpl);
    setDetailEditable(editable);
    setDetailPresetId(presetId ?? null);
    setDetailOpen(true);
  };

  if (loadingSystem || loadingUser) {
    return <div className="text-muted-foreground">{t("config.loadingTemplates")}</div>;
  }

  const activeAgentName = active?.display_name ?? activeId ?? "";
  const visibleSystemTemplates = (systemTemplates ?? []).map(toConfigTemplateView);
  const visibleUserPresets = userPresets ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{t("config.templateDesc")}</p>
          <p className="text-xs text-muted-foreground">
            {t("config.templateAgentScope", { agent: activeAgentName })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("config.newTemplate")}
          </Button>
          <Button size="sm" onClick={() => setSaveOpen(true)}>
            {t("config.saveAsTemplate")}
          </Button>
        </div>
      </div>

      {applyError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {applyError}
        </div>
      )}
      {applySuccess && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
          {applySuccess}
        </div>
      )}

      {/* System Templates */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t("config.systemTemplates")}</h3>
        </div>
        <div className="grid grid-cols-2 gap-3 items-stretch">
          {visibleSystemTemplates.map((tpl) => (
            <TemplateCard
              key={tpl.id}
              name={tpl.name}
              description={tpl.description}
              config={tpl.config}
              isSystem
              onApply={() => handleApplySystem(tpl)}
              onView={() => openDetail(tpl, false)}
            />
          ))}
          {visibleSystemTemplates.length === 0 && (
            <div className="col-span-2 rounded-md border border-dashed p-6 text-center text-muted-foreground">
              <p className="text-sm">{t("config.noSystemTemplates")}</p>
            </div>
          )}
        </div>
      </section>

      {/* User Templates */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <User className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t("config.userTemplates")}</h3>
        </div>
        {visibleUserPresets.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-muted-foreground">
            <p className="text-sm">{t("config.noUserTemplates")}</p>
            <p className="text-xs mt-1">{t("config.noUserTemplatesDesc")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 items-stretch">
            {visibleUserPresets.map((tpl) => (
              <TemplateCard
                key={tpl.id}
                name={tpl.name}
                description={tpl.description}
                config={(tpl.config ?? {}) as Record<string, unknown>}
                createdAt={tpl.createdAt}
                onApply={() => handleApplyUser(tpl.id)}
                onEdit={() => openDetail(
                  { name: tpl.name, description: tpl.description, config: (tpl.config ?? {}) as Record<string, unknown>, createdAt: tpl.createdAt },
                  true,
                  tpl.id,
                )}
                onDelete={() => handleDelete(tpl.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Save Current Config Dialog */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("config.saveTemplateTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="save-tpl-name">{t("config.templateName")}</Label>
              <Input id="save-tpl-name" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={t("config.templateNamePlaceholder")} onKeyDown={(e) => e.key === "Enter" && handleSaveCurrent()} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="save-tpl-desc">{t("config.templateDescLabel")}</Label>
              <Input id="save-tpl-desc" value={saveDesc} onChange={(e) => setSaveDesc(e.target.value)} placeholder={t("config.templateDescPlaceholder")} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSaveOpen(false); setSaveName(""); setSaveDesc(""); }}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSaveCurrent} disabled={!saveName.trim() || saving}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Template Dialog (reuses TemplateDetailDialog) */}
      <TemplateDetailDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        template={{ name: "", description: "", config: {} as Record<string, unknown> }}
        editable
        onSave={handleNewTemplate}
      />

      {/* Detail / Edit Dialog */}
      <TemplateDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        template={detailTarget}
        editable={detailEditable}
        onSave={detailEditable ? handleUpdateUserTemplate : undefined}
      />

      {/* Fill & Apply Dialog */}
      <FillAndApplyDialog
        open={fillOpen}
        onOpenChange={setFillOpen}
        template={fillTemplate}
        onApply={doApplyConfig}
      />
    </div>
  );
}
