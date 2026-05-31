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
import { Plus, Trash2, Sparkles, User, FileJson, Pencil, Eye } from "lucide-react";
import { useAgent } from "@/agents";
import type { Preset, ConfigTemplate, ClaudeConfig, SandboxConfig } from "@/types";

interface TemplateManagerProps {
  onApplied: () => void;
}

const MODE_LABELS: Record<string, string> = {
  default: "config.modeDefault",
  bypassPermissions: "config.modeBypass",
  plan: "config.modePlan",
};

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

function resolveLabel(map: Record<string, string>, key: string | null | undefined, t: (k: string) => string): string | null {
  if (!key) return null;
  const i18nKey = map[key];
  return i18nKey ? t(i18nKey) : key;
}

function extractConfigItems(config: ClaudeConfig, t: (k: string) => string): { label: string; value: string; highlight?: boolean }[] {
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
    items.push({ label: t("config.allowCount", { count: allow.length } as Record<string, unknown>), value: allow.join(", ") });
  }

  const deny = config.permissions?.deny;
  if (deny && deny.length > 0) {
    items.push({ label: t("config.denyCount", { count: deny.length } as Record<string, unknown>), value: deny.join(", ") });
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

function ConfigSummary({ config }: { config: ClaudeConfig }) {
  const { t } = useTranslation();
  const items = extractConfigItems(config, t);

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
  config: ClaudeConfig;
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
  template: { name: string; description?: string; config: ClaudeConfig; createdAt?: string } | null;
  editable: boolean;
  onSave?: (name: string, description: string, config: ClaudeConfig) => void;
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
      onSave(editName.trim(), editDesc.trim(), parsed as ClaudeConfig);
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

type CreateMode = "json" | "form";

function NewTemplateDialog({ open, onOpenChange, onSave }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, description: string, config: ClaudeConfig) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<CreateMode>("json");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);

  const [formConfig, setFormConfig] = useState<Partial<ClaudeConfig>>({});
  const selectClass = "flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  const reset = () => {
    setName("");
    setDesc("");
    setJsonText("");
    setJsonError("");
    setFormConfig({});
    setMode("json");
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      let config: ClaudeConfig;
      if (mode === "json") {
        config = JSON.parse(jsonText) as ClaudeConfig;
      } else {
        config = {
          model: formConfig.model || null,
          apiProvider: formConfig.apiProvider || null,
          smallModel: formConfig.smallModel || null,
          largeModel: formConfig.largeModel || null,
          permissions: formConfig.permissions ? { ...formConfig.permissions, additionalDirectories: null } : null,
          sandbox: formConfig.sandbox || null,
          skipDangerousModePermissionPrompt: formConfig.skipDangerousModePermissionPrompt || null,
          env: formConfig.env || null,
          enabledPlugins: formConfig.enabledPlugins || null,
          verbose: formConfig.verbose || null,
          maxTurns: formConfig.maxTurns || null,
          allowedTools: null,
          disallowedTools: null,
          hooks: null,
          mcpServers: null,
          contextCompaction: null,
        };
      }
      onSave(name.trim(), desc.trim(), config);
      onOpenChange(false);
      reset();
    } catch {
      if (mode === "json") setJsonError(t("config.invalidJson"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("config.newTemplate")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label htmlFor="new-tpl-name">{t("config.templateName")}</Label>
              <Input id="new-tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("config.templateNamePlaceholder")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-tpl-desc">{t("config.templateDescLabel")}</Label>
              <Input id="new-tpl-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("config.templateDescPlaceholder")} />
            </div>
          </div>

          <div className="flex gap-1 border-b border-border">
            {([
              { key: "json" as const, icon: FileJson, label: t("config.jsonMode") },
              { key: "form" as const, icon: Pencil, label: t("config.formMode") },
            ]).map((m) => (
              <button
                key={m.key}
                onClick={() => { setMode(m.key); setJsonError(""); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  mode === m.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <m.icon className="h-3.5 w-3.5" />
                {m.label}
              </button>
            ))}
          </div>

          {mode === "json" && (
            <div className="space-y-1">
              <textarea
                className="w-full h-48 rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={jsonText}
                onChange={(e) => { setJsonText(e.target.value); setJsonError(""); }}
                placeholder={t("config.jsonPlaceholder")}
                spellCheck={false}
              />
              {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
            </div>
          )}

          {mode === "form" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t("config.modelLabel")}</Label>
                  <select value={formConfig.model ?? ""} onChange={(e) => setFormConfig({ ...formConfig, model: e.target.value || undefined })} className={selectClass}>
                    <option value="">{t("common.default")}</option>
                    <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                    <option value="claude-opus-4-7">Opus 4.7</option>
                    <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("config.providerLabel")}</Label>
                  <select value={formConfig.apiProvider ?? ""} onChange={(e) => setFormConfig({ ...formConfig, apiProvider: e.target.value || undefined })} className={selectClass}>
                    <option value="">{t("common.default")}</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="bedrock">AWS Bedrock</option>
                    <option value="vertex">Google Vertex</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("config.modeLabel")}</Label>
                <select
                  value={formConfig.permissions?.defaultMode ?? ""}
                  onChange={(e) => setFormConfig({
                    ...formConfig,
                    permissions: { ...formConfig.permissions, defaultMode: e.target.value || null, allow: formConfig.permissions?.allow ?? null, deny: formConfig.permissions?.deny ?? null, additionalDirectories: null },
                  })}
                  className={selectClass}
                >
                  <option value="">{t("common.default")}</option>
                  <option value="default">{t("config.modeDefault")}</option>
                  <option value="bypassPermissions">{t("config.modeBypass")}</option>
                  <option value="plan">{t("config.modePlan")}</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t("config.sandboxLabel")}</Label>
                  <select
                    value={formConfig.sandbox?.enabled ? "true" : "false"}
                    onChange={(e) => setFormConfig({ ...formConfig, sandbox: { enabled: e.target.value === "true", allowCommand: null, denyCommand: null, allowPath: null, denyPath: null, network: null, profile: null } satisfies SandboxConfig })}
                    className={selectClass}
                  >
                    <option value="false">{t("common.default")}</option>
                    <option value="true">{t("config.enabled")}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("config.skipDangerousShort")}</Label>
                  <select
                    value={formConfig.skipDangerousModePermissionPrompt ? "true" : "false"}
                    onChange={(e) => setFormConfig({ ...formConfig, skipDangerousModePermissionPrompt: e.target.value === "true" ? true : undefined })}
                    className={selectClass}
                  >
                    <option value="false">{t("common.default")}</option>
                    <option value="true">{t("config.enabled")}</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("config.maxTurnsLabel")}</Label>
                <Input type="number" min={1} value={formConfig.maxTurns ?? ""} onChange={(e) => { const n = parseInt(e.target.value, 10); setFormConfig({ ...formConfig, maxTurns: isNaN(n) || n <= 0 ? undefined : n }); }} placeholder={t("common.default")} className="h-8" />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { onOpenChange(false); reset(); }}>{t("common.cancel")}</Button>
          <Button onClick={handleSave} disabled={!name.trim() || saving}>{saving ? t("common.saving") : t("config.saveTemplateTitle")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PROXY_PROVIDERS = [
  { label: "智谱 (Zhipu)", url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus" },
  { label: "阿里 (Aliyun)", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-max" },
  { label: "Minimax", url: "https://api.minimax.chat/v1", model: "abab6.5-chat" },
  { label: "DeepSeek", url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "自定义 (Custom)", url: "", model: "" }
];

/** Dialog to fill in empty env values and model before applying a system template */
function FillAndApplyDialog({ open, onOpenChange, template, onApply }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: ConfigTemplate | null;
  onApply: (config: ClaudeConfig) => void;
}) {
  const { t } = useTranslation();
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [modelValue, setModelValue] = useState("");

  const emptyEnvKeys = template
    ? Object.entries(template.config.env ?? {})
      .filter(([, v]) => !v)
      .map(([k]) => k)
    : [];
  const needModel = template ? !template.config.model : false;
  const hasEmpty = emptyEnvKeys.length > 0 || needModel;

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
  }, [template]);

  const handleApply = () => {
    if (!template) return;
    const config = { ...template.config };
    if (Object.keys(envValues).length > 0) {
      const env = { ...(config.env ?? {}) };
      for (const [k, v] of Object.entries(envValues)) {
        if (v) env[k] = v;
      }
      config.env = env;
    }
    if (needModel && modelValue) {
      config.model = modelValue;
    }
    onApply(config);
    onOpenChange(false);
    setEnvValues({});
    setModelValue("");
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
            {template.id === "proxy-config" && (
              <div className="space-y-2 mb-4 p-4 border rounded bg-muted/30">
                <Label>选择供应商 / Choose Provider</Label>
                <select 
                  className={selectClass} 
                  onChange={(e) => {
                    const p = PROXY_PROVIDERS.find(x => x.label === e.target.value);
                    if (p && p.url) {
                       setEnvValues(prev => ({ ...prev, "ANTHROPIC_BASE_URL": p.url, "ANTHROPIC_MODEL": p.model }));
                       if (needModel) setModelValue(p.model);
                    }
                  }}
                >
                  <option value="">-- 选择供应商 --</option>
                  {PROXY_PROVIDERS.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
                </select>
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

function cleanConfigForJson(config: ClaudeConfig): Record<string, unknown> {
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

export function TemplateManager({ onApplied }: TemplateManagerProps) {
  const { t } = useTranslation();
  const { activeId } = useAgent();
  const agentRefreshKey = activeId ? Array.from(activeId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) : 0;
  const { data: systemTemplates, loading: loadingSystem } = useInvoke<ConfigTemplate[]>("list_config_templates", undefined, agentRefreshKey);
  const { data: userTemplates, loading: loadingUser, refetch } = useInvoke<Preset[]>("list_presets");
  const { data: currentConfig } = useInvoke<ClaudeConfig>("load_config", undefined, agentRefreshKey);

  const [saveOpen, setSaveOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDesc, setSaveDesc] = useState("");
  const [saving, setSaving] = useState(false);

  // Detail / Edit dialog
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<{ name: string; description?: string; config: ClaudeConfig; createdAt?: string } | null>(null);
  const [detailEditable, setDetailEditable] = useState(false);
  const [detailPresetId, setDetailPresetId] = useState<string | null>(null);

  // Fill & Apply dialog
  const [fillOpen, setFillOpen] = useState(false);
  const [fillTemplate, setFillTemplate] = useState<ConfigTemplate | null>(null);

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
      await invokeCommand("save_preset", { preset });
      setSaveOpen(false);
      setSaveName("");
      setSaveDesc("");
      refetch();
    } catch (err) {
      console.error("Failed to create template:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleNewTemplate = async (name: string, description: string, config: ClaudeConfig) => {
    const preset: Preset = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      description: description || undefined,
      config,
      createdAt: new Date().toISOString(),
    };
    await invokeCommand("save_preset", { preset });
    refetch();
  };

  const handleApplySystem = (template: ConfigTemplate) => {
    const hasEmptyEnv = Object.values(template.config.env ?? {}).some((v) => !v);
    const needsModel = !template.config.model;
    if (hasEmptyEnv || needsModel) {
      setFillTemplate(template);
      setFillOpen(true);
    } else {
      doApplySystemConfig(template.config);
    }
  };

  const doApplySystemConfig = async (config: ClaudeConfig) => {
    try {
      await invokeCommand("save_config", { config });
      onApplied();
    } catch (err) {
      console.error("Failed to apply system template:", err);
    }
  };

  const handleApplyUser = async (id: string) => {
    try {
      await invokeCommand("apply_preset", { id });
      onApplied();
    } catch (err) {
      console.error("Failed to apply user template:", err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await invokeCommand("delete_preset", { id });
      refetch();
    } catch (err) {
      console.error("Failed to delete template:", err);
    }
  };

  const handleUpdateUserTemplate = async (name: string, description: string, config: ClaudeConfig) => {
    if (!detailPresetId) return;
    const preset: Preset = {
      id: detailPresetId,
      name,
      description: description || undefined,
      config,
      createdAt: detailTarget?.createdAt ?? new Date().toISOString(),
    };
    await invokeCommand("save_preset", { preset });
    refetch();
  };

  const openDetail = (tpl: { name: string; description?: string; config: ClaudeConfig; createdAt?: string }, editable: boolean, presetId?: string) => {
    setDetailTarget(tpl);
    setDetailEditable(editable);
    setDetailPresetId(presetId ?? null);
    setDetailOpen(true);
  };

  if (loadingSystem || loadingUser) {
    return <div className="text-muted-foreground">{t("config.loadingTemplates")}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t("config.templateDesc")}</p>
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

      {/* System Templates */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t("config.systemTemplates")}</h3>
        </div>
        <div className="grid grid-cols-2 gap-3 items-stretch">
          {(systemTemplates ?? []).map((tpl) => (
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
        </div>
      </section>

      {/* User Templates */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <User className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t("config.userTemplates")}</h3>
        </div>
        {!userTemplates || userTemplates.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-muted-foreground">
            <p className="text-sm">{t("config.noUserTemplates")}</p>
            <p className="text-xs mt-1">{t("config.noUserTemplatesDesc")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 items-stretch">
            {userTemplates.map((tpl) => (
              <TemplateCard
                key={tpl.id}
                name={tpl.name}
                description={tpl.description}
                config={tpl.config}
                createdAt={tpl.createdAt}
                onApply={() => handleApplyUser(tpl.id)}
                onEdit={() => openDetail(tpl, true, tpl.id)}
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
            <Button variant="outline" onClick={() => setSaveOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleSaveCurrent} disabled={!saveName.trim() || saving}>{saving ? t("common.saving") : t("config.saveTemplateTitle")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Template Dialog */}
      <NewTemplateDialog open={newOpen} onOpenChange={setNewOpen} onSave={handleNewTemplate} />

      {/* Detail / Edit Dialog */}
      <TemplateDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        template={detailTarget}
        editable={detailEditable}
        onSave={handleUpdateUserTemplate}
      />

      {/* Fill & Apply Dialog */}
      <FillAndApplyDialog
        open={fillOpen}
        onOpenChange={setFillOpen}
        template={fillTemplate}
        onApply={doApplySystemConfig}
      />
    </div>
  );
}
