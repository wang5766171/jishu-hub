// v0.7.4 需求2 R1：卡片预设式「添加/编辑模型供应商」面板（自 model-manager.tsx
// 拆出并重构）。三步单屏：①选服务商卡片 → ②填 API Key → ③测试连接；
// 高级字段（地址/协议/请求头/compat/overrides）折叠收纳，熟练用户零损失。
// 选中预设即自动回填 baseUrl/api/推荐模型 chips；「自定义」退化为全手填。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
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
import {
  Check,
  ExternalLink,
  Loader2,
  Plus,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { HeaderRow, PiProviderConfig } from "./model-types";
import {
  PROVIDER_PRESETS,
  matchPresetByBaseUrl,
  presetModelToEntry,
  suggestProviderKey,
  type ProviderPreset,
} from "@/agents/config/presets/provider-presets";
import { ConnectionTestBadge, type ConnectionTestResult } from "./connection-test-badge";

const PROTOCOL_OPTIONS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
  "bedrock-converse-stream",
];

export function ProviderForm({
  existingName,
  existingProvider,
  existingProviderKeys,
  saving,
  onCancel,
  onSubmit,
}: {
  existingName: string | null;
  existingProvider: PiProviderConfig | undefined;
  /** 当前已有 provider key 列表（新增时用于推荐 key 去重） */
  existingProviderKeys: string[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: (payload: { name: string; provider: PiProviderConfig }) => void;
}) {
  const { t } = useTranslation();

  const initialPreset =
    existingProvider && existingName
      ? (matchPresetByBaseUrl(existingProvider.baseUrl) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1])
      : null;

  const [preset, setPreset] = useState<ProviderPreset | null>(initialPreset);
  const [name, setName] = useState(existingName ?? "");
  const [displayName, setDisplayName] = useState(existingProvider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(existingProvider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(existingProvider?.apiKey ?? "");
  const [api, setApi] = useState(existingProvider?.api ?? "anthropic-messages");
  const [authHeader, setAuthHeader] = useState(existingProvider?.authHeader ?? false);
  const [headers, setHeaders] = useState<HeaderRow[]>(
    Object.entries(existingProvider?.headers ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [compatJson, setCompatJson] = useState(
    existingProvider?.compat ? JSON.stringify(existingProvider.compat, null, 2) : "",
  );
  const [overridesJson, setOverridesJson] = useState(
    existingProvider?.modelOverrides ? JSON.stringify(existingProvider.modelOverrides, null, 2) : "",
  );
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(
    existingProvider?.models?.map((m) => m.id) ?? [],
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const isCustom = preset?.id === "custom";
  const isEdit = !!existingName;
  const canTest =
    baseUrl.trim().length > 0 &&
    selectedModelIds.length > 0 &&
    PROTOCOL_OPTIONS.includes(api);

  const selectPreset = (p: ProviderPreset) => {
    setPreset(p);
    setTestResult(null);
    setSelectedModelIds(p.models.map((m) => m.id));
    if (p.id !== "custom") {
      if (!isEdit) {
        setName(suggestProviderKey(p, existingProviderKeys));
        setDisplayName(p.id_label ? "" : "");
      }
      setBaseUrl(p.baseUrl);
      setApi(p.api);
    }
  };

  const toggleModel = (modelId: string) => {
    setSelectedModelIds((prev) =>
      prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId],
    );
    setTestResult(null);
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invokeCommand<{ response?: string | null; latency_ms?: number }>(
        "test_llm_connection",
        { api, baseUrl, apiKey, model: selectedModelIds[0] },
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

  const addHeader = () => setHeaders([...headers, { key: "", value: "" }]);
  const updateHeader = (i: number, patch: Partial<HeaderRow>) =>
    setHeaders(headers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  const removeHeader = (i: number) =>
    setHeaders(headers.filter((_, idx) => idx !== i));

  const submit = () => {
    const provider: PiProviderConfig = {};
    if (displayName.trim()) provider.name = displayName.trim();
    else if (preset && preset.id !== "custom") provider.name = t(preset.id_label);
    if (baseUrl.trim()) provider.baseUrl = baseUrl.trim();
    if (apiKey.trim()) provider.apiKey = apiKey.trim();
    if (api.trim()) provider.api = api.trim();
    provider.authHeader = authHeader;

    const headerObj: Record<string, string> = {};
    for (const h of headers) {
      const k = h.key.trim();
      if (k) headerObj[k] = h.value;
    }
    if (Object.keys(headerObj).length > 0) provider.headers = headerObj;

    if (compatJson.trim()) {
      try {
        const parsed = JSON.parse(compatJson);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          provider.compat = parsed as Record<string, unknown>;
        }
      } catch {
        return;
      }
    }

    if (overridesJson.trim()) {
      try {
        const parsed = JSON.parse(overridesJson);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          provider.modelOverrides = parsed as Record<string, Record<string, unknown>>;
        }
      } catch {
        return;
      }
    }

    if (preset && preset.id !== "custom") {
      // 预设模型 chips：按勾选生成条目；编辑模式下保留用户自定义过的
      // 既有条目（不在预设清单里的不丢）。
      const presetEntries = preset.models
        .filter((m) => selectedModelIds.includes(m.id))
        .map(presetModelToEntry);
      const extraExisting = (existingProvider?.models ?? []).filter(
        (m) => !preset.models.some((pm) => pm.id === m.id),
      );
      const models = [...presetEntries, ...extraExisting];
      if (models.length > 0) provider.models = models;
    } else if (existingProvider?.models) {
      provider.models = existingProvider.models;
    }

    onSubmit({ name: name.trim(), provider });
  };

  return (
    <div className="rounded-md border border-border/40 bg-muted/30 p-4 space-y-4">
      <div className="text-sm font-medium">
        {isEdit ? `${t("config.editProvider")}: ${existingName}` : t("config.addProvider")}
      </div>

      {/* ① 选择服务商 */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">
          {t("config.presetStepChoose")}
        </Label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {PROVIDER_PRESETS.map((p) => {
            const active = preset?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p)}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-left transition-colors",
                  active
                    ? "border-primary/60 bg-primary/10"
                    : "border-border/40 hover:border-border bg-background/40",
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-medium truncate">{t(p.id_label)}</span>
                  {active && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                </div>
                {p.models.length > 0 && (
                  <div className="mt-0.5 text-[10px] text-muted-foreground truncate">
                    {p.models.map((m) => m.displayName).join(" · ")}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ② API Key（预设已定时唯一必填项） */}
      {preset && preset.id !== "custom" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="provider-apikey">{t("config.apiKey")}</Label>
            {preset.apiKeyUrl && (
              <a
                href={preset.apiKeyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                {t("config.presetGetKey")}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <Input
            id="provider-apikey"
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setTestResult(null);
            }}
            placeholder="sk-…"
            autoComplete="off"
          />
          <p className="text-[10px] text-muted-foreground/70">{t("config.apiKeyHint")}</p>
        </div>
      )}

      {/* ③ 模型 + 验证（预设） */}
      {preset && preset.id !== "custom" && preset.models.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">
            {t("config.presetStepModels")}
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {preset.models.map((m) => {
              const active = selectedModelIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleModel(m.id)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    active
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/40 text-muted-foreground hover:border-border",
                  )}
                >
                  {active && <Check className="h-3 w-3" />}
                  {m.displayName}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={runTest}
              disabled={!canTest || testing}
            >
              {testing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Zap className="h-3 w-3 mr-1" />
              )}
              {t("config.testConnection")}
            </Button>
            <span className="text-[10px] text-muted-foreground/70">
              {t("config.testConnectionHint")}
            </span>
          </div>
          {testResult && <ConnectionTestBadge result={testResult} />}
        </div>
      )}

      {/* 高级折叠区：全部既有字段（自定义供应商的主表单也在此） */}
      <Accordion
        type="multiple"
        defaultValue={isCustom ? ["fields"] : []}
        className="w-full"
      >
        <AccordionItem value="fields">
          <AccordionTrigger className="text-xs">
            {isCustom ? t("config.presetCustomFields") : t("config.presetAdvanced")}
          </AccordionTrigger>
          <AccordionContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="provider-name">{t("config.providerKey")}</Label>
                <Input
                  id="provider-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="zhipu"
                  disabled={!!existingName}
                />
                <p className="text-[10px] text-muted-foreground/70">
                  {t("config.providerKeyHint")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="provider-display">{t("config.displayName")}</Label>
                <Input
                  id="provider-display"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t("config.presetDisplayNamePlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="provider-baseurl">{t("config.baseUrl")}</Label>
                <Input
                  id="provider-baseurl"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="https://…"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="provider-api">{t("config.apiProtocol")}</Label>
                <select
                  id="provider-api"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={api}
                  onChange={(e) => setApi(e.target.value)}
                >
                  {PROTOCOL_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-muted-foreground/70">
                  {t("config.presetApiHint")}
                </p>
              </div>
              {preset?.id === "custom" && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="provider-apikey-custom">{t("config.apiKey")}</Label>
                    {preset.apiKeyUrl && (
                      <a
                        href={preset.apiKeyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                      >
                        {t("config.presetGetKey")}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <Input
                    id="provider-apikey-custom"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                  <p className="text-[10px] text-muted-foreground/70">
                    {t("config.apiKeyHint")}
                  </p>
                </div>
              )}
              <div className="space-y-1.5">
                <Label>{t("config.authHeader")}</Label>
                <div className="h-9 flex items-center">
                  <Switch checked={authHeader} onCheckedChange={setAuthHeader} />
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t("config.authHeaderHint")}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("config.customHeaders")}</Label>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={addHeader}
                >
                  <Plus className="h-3 w-3 mr-1" /> {t("common.add")}
                </Button>
              </div>
              {headers.length === 0 ? (
                <p className="text-[10px] text-muted-foreground/70">
                  {t("config.noCustomHeaders")}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {headers.map((h, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        className="flex-1 font-mono text-xs"
                        placeholder="Header-Name"
                        value={h.key}
                        onChange={(e) => updateHeader(i, { key: e.target.value })}
                      />
                      <Input
                        className="flex-1 font-mono text-xs"
                        placeholder="value"
                        value={h.value}
                        onChange={(e) => updateHeader(i, { value: e.target.value })}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-red-400"
                        onClick={() => removeHeader(i)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Accordion type="multiple" className="mt-3 w-full">
              <AccordionItem value="compat">
                <AccordionTrigger className="text-xs">
                  {t("config.compatAdvanced")}
                </AccordionTrigger>
                <AccordionContent>
                  <textarea
                    className="w-full min-h-[140px] rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
                    value={compatJson}
                    onChange={(e) => setCompatJson(e.target.value)}
                    placeholder='{ "supportsDeveloperRole": true }'
                    spellCheck={false}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground/70">
                    {t("config.compatHint")}
                  </p>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="overrides">
                <AccordionTrigger className="text-xs">
                  {t("config.modelOverrides")}
                </AccordionTrigger>
                <AccordionContent>
                  <textarea
                    className="w-full min-h-[140px] rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
                    value={overridesJson}
                    onChange={(e) => setOverridesJson(e.target.value)}
                    placeholder='{ "glm-5.1": { "maxTokens": 16384 } }'
                    spellCheck={false}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground/70">
                    {t("config.modelOverridesHint")}
                  </p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
