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
//
// v0.7.4 需求2 R1：ProviderForm/ModelForm 与共享类型已拆出至独立文件
// （provider-form.tsx / model-form.tsx / model-types.ts，§18 规模约束），
// 本文件只保留页面编排与 ProviderCard。

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { useAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Plus,
  Trash2,
  Check,
  Loader2,
  Pencil,
  Power,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import type {
  ActiveModel,
  PiModelEntry,
  PiProviderConfig,
  PiModelsConfig,
} from "./model-types";
import { ProviderForm } from "./provider-form";
import { ModelForm } from "./model-form";

export function ModelManager({
  onChanged,
  onActiveModelChange,
}: {
  onChanged?: () => void;
  onActiveModelChange?: (modelId: string | null) => void;
}) {
  const { t } = useTranslation();
  const { confirm: confirmDialog, dialogNode: confirmDialogNode } = useConfirmDialog();
  // v0.7.0 需求一：管理作用域 agent_id（模型库 IPC 必填）。
  const { manageAgentId } = useAgent();
  const agentId = manageAgentId ?? "";
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
        invokeCommand<PiModelsConfig>("get_models_config", { agentId }),
        invokeCommand<ActiveModel | null>("get_active", { agentId }),
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
    await invokeCommand("set_models_config", { agentId, config: next });
    setConfig(next);
    if (
      clearActiveIfMissing &&
      !(
        next.providers[clearActiveIfMissing.provider]?.models ?? []
      ).some((m) => m.id === clearActiveIfMissing.model)
    ) {
      await invokeCommand("set_active", { agentId, active: null });
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
    const confirmed = await confirmDialog({
      title: t("config.title"),
      description: t("config.deleteProviderConfirm", { name }),
      variant: "destructive",
    });
    if (!confirmed) {
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
    const confirmed = await confirmDialog({
      title: t("config.title"),
      description: t("config.deleteModelConfirm", { provider: providerName, model: modelId }),
      variant: "destructive",
    });
    if (!confirmed) {
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
      await invokeCommand("set_active", { agentId, active: next });
      onActiveModelChange?.(`${provider}/${model}`);
      onChanged?.();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      {confirmDialogNode}
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
          existingProviderKeys={providerNames}
          saving={saving}
          onCancel={() => setProviderForm(null)}
          onSubmit={submitProvider}
        />
      )}

      {modelForm && (
        <ModelForm
          providerName={modelForm.providerName}
          provider={config.providers[modelForm.providerName]}
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
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});

  const runTest = async (modelId: string) => {
    if (testingId) return;
    setTestingId(modelId);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    try {
      const result = await invokeCommand<{ response?: string | null; usage?: unknown }>("test_model", { id: modelId });
      const reply = (result?.response ?? "").toString().trim();
      setTestResults((prev) => ({
        ...prev,
        [modelId]: { ok: true, text: reply ? reply.slice(0, 120) : t("config.testModelOk") },
      }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [modelId]: { ok: false, text: String(e).slice(0, 200) },
      }));
    } finally {
      setTestingId(null);
    }
  };
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
                    "rounded border px-2 py-1.5 space-y-1",
                    isCurrent
                      ? "border-primary/60 bg-primary/10"
                      : "border-border/30",
                  )}
                >
                  <div className="flex items-center gap-2">
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
                    onClick={() => void runTest(m.id)}
                    disabled={testingId !== null}
                    title={t("config.testModel")}
                  >
                    {testingId === m.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Zap className="h-3 w-3" />
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
                  </div>
                  {testResults[m.id] && (
                    <div
                      className={cn(
                        "rounded px-2 py-1 text-[10px] font-mono break-all",
                        testResults[m.id].ok
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "bg-red-500/10 text-red-400",
                      )}
                      title={testResults[m.id].text}
                    >
                      {testResults[m.id].ok ? "✓ " : "✗ "}
                      {testResults[m.id].text}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
