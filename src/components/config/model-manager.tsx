// Models page for v0.6.x — jishu no longer maintains its own preset
// store. The Models page reads and writes `~/.jishu-agent/models.json`
// directly, and the active selection lives in
// `~/.jishu-hub/settings.json`.
//
// Two-level UX:
//   - Top-level: provider cards. Each shows core fields (baseUrl,
//     api, apiKey, authHeader) and a list of models that belong to
//     the provider. Buttons: edit provider, delete provider, add
//     model, set active (per model), edit model, delete model.
//   - Forms are split: ProviderForm handles provider-level fields;
//     ModelForm handles per-model fields. The two never mix.

import { useEffect, useState, useCallback } from "react";
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
  Plus,
  Trash2,
  Check,
  Loader2,
  Pencil,
  Power,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ActiveModel {
  provider: string;
  model: string;
}

interface PiModelEntry {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
  [extra: string]: unknown;
}

interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  authHeader?: boolean;
  models?: PiModelEntry[];
  modelOverrides?: Record<string, Record<string, unknown>>;
  [extra: string]: unknown;
}

interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>;
}

interface HeaderRow {
  key: string;
  value: string;
}

interface ModelFormValue {
  id: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  inputText: boolean;
  inputImage: boolean;
  baseUrl: string;
  api: string;
}

function emptyModelValue(): ModelFormValue {
  return {
    id: "",
    contextWindow: "128000",
    maxTokens: "8192",
    reasoning: false,
    inputText: true,
    inputImage: false,
    baseUrl: "",
    api: "",
  };
}

function modelToValue(m: PiModelEntry): ModelFormValue {
  return {
    id: m.id,
    contextWindow: String(m.contextWindow ?? "128000"),
    maxTokens: String(m.maxTokens ?? "8192"),
    reasoning: m.reasoning ?? false,
    inputText: m.input?.includes("text") ?? true,
    inputImage: m.input?.includes("image") ?? false,
    baseUrl: m.baseUrl ?? "",
    api: m.api ?? "",
  };
}

function valueToModel(v: ModelFormValue): PiModelEntry {
  const input: string[] = [];
  if (v.inputText) input.push("text");
  if (v.inputImage) input.push("image");
  const entry: PiModelEntry = {
    id: v.id.trim(),
    name: v.id.trim(),
    input,
    reasoning: v.reasoning,
    // Pi's ModelDefinitionSchema requires `cost` to be present with
    // all four numeric fields. We default to 0s; the user can edit
    // individual values from the JSON editor if they care about
    // per-million-token pricing.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const cw = parseInt(v.contextWindow, 10);
  if (!Number.isNaN(cw)) entry.contextWindow = cw;
  const mt = parseInt(v.maxTokens, 10);
  if (!Number.isNaN(mt)) entry.maxTokens = mt;
  if (v.api.trim()) entry.api = v.api.trim();
  if (v.baseUrl.trim()) entry.baseUrl = v.baseUrl.trim();
  return entry;
}

export function ModelManager({
  onChanged,
  onActiveModelChange,
}: {
  onChanged?: () => void;
  onActiveModelChange?: (modelId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<PiModelsConfig>({ providers: {} });
  const [active, setActive] = useState<ActiveModel | null>(null);

  // At most one form open at a time; either an edit / add provider
  // form, or an edit / add model form scoped to a single provider.
  const [providerForm, setProviderForm] = useState<
    { mode: "add" } | { mode: "edit"; name: string } | null
  >(null);
  const [modelForm, setModelForm] = useState<
    { providerName: string; mode: "add" } | { providerName: string; mode: "edit"; modelId: string } | null
  >(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, act] = await Promise.all([
        invokeCommand<PiModelsConfig>("get_models_config"),
        invokeCommand<ActiveModel | null>("get_active"),
      ]);
      setConfig(cfg ?? { providers: {} });
      setActive(act);
      onActiveModelChange?.(act ? `${act.provider}/${act.model}` : null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [onActiveModelChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const providerNames = Object.keys(config.providers);

  const persistConfig = async (
    next: PiModelsConfig,
    clearActiveIfMissing?: { provider: string; model: string },
  ) => {
    await invokeCommand("set_models_config", { config: next });
    setConfig(next);
    if (
      clearActiveIfMissing &&
      !(
        next.providers[clearActiveIfMissing.provider]?.models ?? []
      ).some((m) => m.id === clearActiveIfMissing.model)
    ) {
      await invokeCommand("set_active", { active: null });
      setActive(null);
      onActiveModelChange?.(null);
    }
    onChanged?.();
  };

  // -------------------- Provider ops --------------------
  const startAddProvider = () => {
    setProviderForm({ mode: "add" });
    setModelForm(null);
    setError(null);
  };
  const startEditProvider = (name: string) => {
    setProviderForm({ mode: "edit", name });
    setModelForm(null);
    setError(null);
  };
  const submitProvider = async (payload: {
    name: string;
    provider: PiProviderConfig;
  }) => {
    setError(null);
    const { name, provider } = payload;
    if (!name) {
      setError(`${t("config.providerKey")} ${t("config.required")}`);
      return;
    }
    if (
      providerForm?.mode === "add" &&
      providerNames.includes(name)
    ) {
      setError(`${name} ${t("config.exists")}`);
      return;
    }
    if (
      providerForm?.mode === "edit" &&
      providerForm.name !== name &&
      providerNames.includes(name)
    ) {
      setError(`${name} ${t("config.exists")}`);
      return;
    }
    setSaving(true);
    try {
      const next: PiModelsConfig = { providers: { ...config.providers } };
      if (providerForm?.mode === "edit" && providerForm.name !== name) {
        delete next.providers[providerForm.name];
      }
      next.providers[name] = provider;
      await persistConfig(next);
      setProviderForm(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const deleteProvider = async (name: string) => {
    if (!window.confirm(t("config.deleteProviderConfirm", { name }))) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next: PiModelsConfig = { providers: { ...config.providers } };
      const removed = next.providers[name];
      delete next.providers[name];
      await persistConfig(
        next,
        active && removed?.models?.some((m) => m.id === active.model)
          ? { provider: name, model: active.model }
          : undefined,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // -------------------- Model ops --------------------
  const startAddModel = (providerName: string) => {
    setModelForm({ providerName, mode: "add" });
    setProviderForm(null);
    setError(null);
  };
  const startEditModel = (providerName: string, modelId: string) => {
    setModelForm({ providerName, mode: "edit", modelId });
    setProviderForm(null);
    setError(null);
  };
  const submitModel = async (payload: {
    providerName: string;
    model: PiModelEntry;
  }) => {
    setError(null);
    const { providerName, model } = payload;
    if (!providerName) {
      setError(`${t("config.providerKey")} ${t("config.required")}`);
      return;
    }
    if (!model.id.trim()) {
      setError(`${t("config.modelId")} ${t("config.required")}`);
      return;
    }
    const provider = config.providers[providerName];
    if (!provider) {
      setError(`${providerName} ${t("config.notFound")}`);
      return;
    }
    const models = provider.models ?? [];
    if (
      modelForm?.mode === "add" &&
      models.some((m) => m.id === model.id)
    ) {
      setError(`${model.id} ${t("config.exists")}`);
      return;
    }
    if (
      modelForm?.mode === "edit" &&
      modelForm.modelId !== model.id &&
      models.some((m) => m.id === model.id)
    ) {
      setError(`${model.id} ${t("config.exists")}`);
      return;
    }
    setSaving(true);
    try {
      const previousModelId = modelForm?.mode === "edit" ? modelForm.modelId : null;
      const nextModels =
        modelForm?.mode === "edit"
          ? models.map((m) => (m.id === modelForm.modelId ? model : m))
          : [...models, model];
      const nextProvider: PiProviderConfig = {
        ...provider,
        models: nextModels,
      };
      const next: PiModelsConfig = { providers: { ...config.providers } };
      next.providers[providerName] = nextProvider;
      await persistConfig(
        next,
        active?.provider === providerName && active.model === previousModelId
          ? { provider: providerName, model: model.id }
          : undefined,
      );
      setModelForm(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const deleteModel = async (providerName: string, modelId: string) => {
    if (!window.confirm(t("config.deleteModelConfirm", { provider: providerName, model: modelId }))) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const provider = config.providers[providerName];
      if (!provider) return;
      const nextModels = (provider.models ?? []).filter(
        (m) => m.id !== modelId,
      );
      const nextProvider: PiProviderConfig = {
        ...provider,
        models: nextModels.length > 0 ? nextModels : undefined,
      };
      const next: PiModelsConfig = { providers: { ...config.providers } };
      next.providers[providerName] = nextProvider;
      await persistConfig(
        next,
        active?.provider === providerName && active.model === modelId
          ? { provider: providerName, model: modelId }
          : undefined,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // -------------------- Active --------------------
  const setActiveFromPicker = async (provider: string, model: string) => {
    const next: ActiveModel = { provider, model };
    setActive(next);
    try {
      await invokeCommand("set_active", { active: next });
      onActiveModelChange?.(`${provider}/${model}`);
      onChanged?.();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex-1" />
        <Button size="sm" className="h-6 text-xs mr-3" onClick={startAddProvider} disabled={loading}>
          <Plus className="h-3 w-3 mr-1" />
          {t("config.addProvider")}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {providerForm && (
        <ProviderForm
          existingName={
            providerForm.mode === "edit" ? providerForm.name : null
          }
          existingProvider={
            providerForm.mode === "edit"
              ? config.providers[providerForm.name]
              : undefined
          }
          saving={saving}
          onCancel={() => setProviderForm(null)}
          onSubmit={submitProvider}
        />
      )}

      {modelForm && (
        <ModelForm
          providerName={modelForm.providerName}
          existingModel={
            modelForm.mode === "edit"
              ? config.providers[modelForm.providerName]?.models?.find(
                  (m) => m.id === modelForm.modelId,
                )
              : undefined
          }
          saving={saving}
          onCancel={() => setModelForm(null)}
          onSubmit={submitModel}
        />
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> {t("common.loading")}
        </div>
      ) : providerNames.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/40 p-6 text-center text-xs text-muted-foreground">
          {t("config.noProviders")}
        </div>
      ) : (
        <div className="space-y-3">
          {providerNames.map((name) => {
            const p = config.providers[name];
            const models = p?.models ?? [];
            return (
              <ProviderCard
                key={name}
                name={name}
                provider={p ?? {}}
                models={models}
                isActive={
                  active?.provider === name &&
                  models.some((m) => m.id === active?.model)
                }
                activeModelId={
                  active?.provider === name ? active.model : null
                }
                onEditProvider={() => startEditProvider(name)}
                onDeleteProvider={() => deleteProvider(name)}
                onAddModel={() => startAddModel(name)}
                onEditModel={(modelId) => startEditModel(name, modelId)}
                onDeleteModel={(modelId) => deleteModel(name, modelId)}
                onSetActive={(modelId) => setActiveFromPicker(name, modelId)}
              />
            );
          })}
        </div>
      )}


    </div>
  );
}

function ProviderCard({
  name,
  provider,
  models,
  isActive,
  activeModelId,
  onEditProvider,
  onDeleteProvider,
  onAddModel,
  onEditModel,
  onDeleteModel,
  onSetActive,
}: {
  name: string;
  provider: PiProviderConfig;
  models: PiModelEntry[];
  isActive: boolean;
  activeModelId: string | null;
  onEditProvider: () => void;
  onDeleteProvider: () => void;
  onAddModel: () => void;
  onEditModel: (modelId: string) => void;
  onDeleteModel: (modelId: string) => void;
  onSetActive: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "rounded-md border p-3 space-y-3",
        isActive ? "border-primary/60 bg-primary/5" : "border-border/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">
              {provider.name || name}
            </span>
            {provider.name && (
              <span className="text-[10px] text-muted-foreground font-mono">
                ({name})
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">
              {provider.api ?? "—"}
            </span>
            {provider.authHeader && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {t("config.authHeaderBadge")}
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
            {provider.baseUrl || `(${t("config.noBaseUrl")})`}
          </div>
          {provider.apiKey && (
            <div className="text-[10px] text-muted-foreground/70 mt-0.5">
              apiKey: {provider.apiKey.replace(/(.{4}).+(.{4})/, "$1•••$2")}
            </div>
          )}
          {provider.headers && Object.keys(provider.headers).length > 0 && (
            <div className="text-[10px] text-muted-foreground/70 mt-0.5">
              {Object.keys(provider.headers).length} {t("config.customHeaders")}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={onEditProvider}
            title={t("config.editProvider")}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-red-400 hover:text-red-300"
            onClick={onDeleteProvider}
            title={t("common.delete")}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[10px] text-muted-foreground/80">
            {t("config.models")} ({models.length})
          </Label>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs bg-primary/10 hover:bg-primary/20 text-primary border-transparent"
            onClick={onAddModel}
          >
            <Plus className="h-3 w-3 mr-1" />
            {t("config.addModel")}
          </Button>
        </div>

        {models.length === 0 ? (
          <p className="text-[10px] text-muted-foreground/70 px-1">
            {t("config.noModelsHint")}
          </p>
        ) : (
          <ul className="space-y-1">
            {models.map((m) => {
              const isCurrent = activeModelId === m.id;
              return (
                <li
                  key={m.id}
                  className={cn(
                    "flex items-center gap-2 rounded border px-2 py-1.5",
                    isCurrent
                      ? "border-primary/60 bg-primary/10"
                      : "border-border/30",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs truncate">
                        {m.id}
                      </span>
                      {m.contextWindow && (
                        <span className="text-[10px] text-muted-foreground/70">
                          {m.contextWindow >= 1000
                            ? `${Math.round(m.contextWindow / 1000)}K ctx`
                            : `${m.contextWindow} ctx`}
                        </span>
                      )}
                      {m.maxTokens && (
                        <span className="text-[10px] text-muted-foreground/70">
                          {m.maxTokens >= 1000
                            ? `${Math.round(m.maxTokens / 1000)}K out`
                            : `${m.maxTokens} out`}
                        </span>
                      )}
                      {m.reasoning && (
                        <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground">
                          {t("config.reasoning")}
                        </span>
                      )}
                    </div>
                    {m.baseUrl && (
                      <div className="text-[10px] text-muted-foreground/60 font-mono truncate">
                        {m.baseUrl}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={isCurrent ? "default" : "outline"}
                    className="h-6 text-xs"
                    onClick={() => onSetActive(m.id)}
                    title={t("config.setActive")}
                  >
                    {isCurrent ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Power className="h-3 w-3" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5"
                    onClick={() => onEditModel(m.id)}
                    title={t("config.editModel")}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-red-400 hover:text-red-300"
                    onClick={() => onDeleteModel(m.id)}
                    title={t("common.delete")}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProviderForm({
  existingName,
  existingProvider,
  saving,
  onCancel,
  onSubmit,
}: {
  existingName: string | null;
  existingProvider: PiProviderConfig | undefined;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (payload: { name: string; provider: PiProviderConfig }) => void;
}) {
  const { t } = useTranslation();

  const initial = (): {
    name: string;
    displayName: string;
    baseUrl: string;
    apiKey: string;
    api: string;
    authHeader: boolean;
    headers: HeaderRow[];
    compatJson: string;
    overridesJson: string;
  } => {
    if (existingProvider && existingName) {
      const headerEntries = Object.entries(existingProvider.headers ?? {});
      return {
        name: existingName,
        displayName: existingProvider.name ?? "",
        baseUrl: existingProvider.baseUrl ?? "",
        apiKey: existingProvider.apiKey ?? "",
        api: existingProvider.api ?? "anthropic-messages",
        authHeader: existingProvider.authHeader ?? false,
        headers: headerEntries.map(([k, v]) => ({ key: k, value: v })),
        compatJson: existingProvider.compat
          ? JSON.stringify(existingProvider.compat, null, 2)
          : "",
        overridesJson: existingProvider.modelOverrides
          ? JSON.stringify(existingProvider.modelOverrides, null, 2)
          : "",
      };
    }
    return {
      name: "",
      displayName: "",
      baseUrl: "",
      apiKey: "",
      api: "anthropic-messages",
      authHeader: false,
      headers: [],
      compatJson: "",
      overridesJson: "",
    };
  };

  const init = initial();
  const [name, setName] = useState(init.name);
  const [displayName, setDisplayName] = useState(init.displayName);
  const [baseUrl, setBaseUrl] = useState(init.baseUrl);
  const [apiKey, setApiKey] = useState(init.apiKey);
  const [api, setApi] = useState(init.api);
  const [authHeader, setAuthHeader] = useState(init.authHeader);
  const [headers, setHeaders] = useState<HeaderRow[]>(init.headers);
  const [compatJson, setCompatJson] = useState(init.compatJson);
  const [overridesJson, setOverridesJson] = useState(init.overridesJson);

  const addHeader = () =>
    setHeaders([...headers, { key: "", value: "" }]);
  const updateHeader = (i: number, patch: Partial<HeaderRow>) =>
    setHeaders(
      headers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)),
    );
  const removeHeader = (i: number) =>
    setHeaders(headers.filter((_, idx) => idx !== i));

  const submit = () => {
    const provider: PiProviderConfig = {};
    if (displayName.trim()) provider.name = displayName.trim();
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
          provider.modelOverrides = parsed as Record<
            string,
            Record<string, unknown>
          >;
        }
      } catch {
        return;
      }
    }

    // Carry over the existing model list when editing the provider's
    // other fields — the dedicated ModelForm handles model edits.
    if (existingProvider?.models) {
      provider.models = existingProvider.models;
    }

    onSubmit({ name: name.trim(), provider });
  };

  return (
    <div className="rounded-md border border-border/40 bg-muted/30 p-4 space-y-4">
      <div className="text-sm font-medium">
        {existingName
          ? `${t("config.editProvider")}: ${existingName}`
          : t("config.addProvider")}
      </div>

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
            placeholder="智谱 anthropic 兼容"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="provider-baseurl">{t("config.baseUrl")}</Label>
          <Input
            id="provider-baseurl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://open.bigmodel.cn/api/anthropic"
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
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="openai-completions">openai-completions</option>
            <option value="openai-responses">openai-responses</option>
            <option value="google-generative-ai">google-generative-ai</option>
            <option value="bedrock-converse-stream">bedrock-converse-stream</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="provider-apikey">{t("config.apiKey")}</Label>
          <Input
            id="provider-apikey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
          />
          <p className="text-[10px] text-muted-foreground/70">
            {t("config.apiKeyHint")}
          </p>
        </div>
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

      <div className="space-y-2">
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
                  onChange={(e) =>
                    updateHeader(i, { value: e.target.value })
                  }
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

      <Accordion type="multiple" className="w-full">
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

function ModelForm({
  providerName,
  existingModel,
  saving,
  onCancel,
  onSubmit,
}: {
  providerName: string;
  existingModel: PiModelEntry | undefined;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (payload: { providerName: string; model: PiModelEntry }) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<ModelFormValue>(
    existingModel ? modelToValue(existingModel) : emptyModelValue(),
  );

  const submit = () => {
    const model = valueToModel(value);
    onSubmit({ providerName, model });
  };

  return (
    <div className="rounded-md border border-border/40 bg-muted/30 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          {existingModel
            ? `${t("config.editModel")}: ${existingModel.id}`
            : t("config.addModel")}
          <span className="ml-2 text-[10px] text-muted-foreground font-mono">
            {providerName}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="model-id">{t("config.modelId")}</Label>
          <Input
            id="model-id"
            value={value.id}
            onChange={(e) => setValue({ ...value, id: e.target.value })}
            placeholder="glm-5.1"
            disabled={!!existingModel}
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="model-baseurl">{t("config.perModelBaseUrl")}</Label>
          <Input
            id="model-baseurl"
            value={value.baseUrl}
            onChange={(e) =>
              setValue({ ...value, baseUrl: e.target.value })
            }
            placeholder="https://…"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="model-api">{t("config.perModelApi")}</Label>
          <Input
            id="model-api"
            value={value.api}
            onChange={(e) => setValue({ ...value, api: e.target.value })}
            placeholder="anthropic-messages"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="model-ctx">{t("config.contextWindow")}</Label>
          <Input
            id="model-ctx"
            value={value.contextWindow}
            onChange={(e) =>
              setValue({ ...value, contextWindow: e.target.value })
            }
            placeholder="128000"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="model-mt">{t("config.maxTokens")}</Label>
          <Input
            id="model-mt"
            value={value.maxTokens}
            onChange={(e) =>
              setValue({ ...value, maxTokens: e.target.value })
            }
            placeholder="8192"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("config.capabilities")}</Label>
          <div className="h-9 flex items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={value.reasoning}
                onChange={(e) =>
                  setValue({ ...value, reasoning: e.target.checked })
                }
                className="h-3 w-3"
              />
              {t("config.reasoning")}
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={value.inputText}
                onChange={(e) =>
                  setValue({ ...value, inputText: e.target.checked })
                }
                className="h-3 w-3"
              />
              {t("config.inputText")}
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={value.inputImage}
                onChange={(e) =>
                  setValue({ ...value, inputImage: e.target.checked })
                }
                className="h-3 w-3"
              />
              {t("config.inputImage")}
            </label>
          </div>
        </div>
      </div>

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
