import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInvoke, invokeCommand } from "@/hooks/use-invoke";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus,
  Trash2,
  Check,
  Loader2,
  Zap,
  Eye,
  EyeOff,
  Key,
  Pencil,
  Power,
  PowerOff,
} from "lucide-react";
import type { ModelPreset, ModelStore } from "@/types";

const ICON_BTN =
  "inline-flex items-center justify-center h-8 w-8 rounded-md transition-colors hover:bg-accent";

interface ModelManagerProps {
  onChanged: () => void;
  /** Fires with the new active preset's `model` (provider/model-id) when the user activates a preset. */
  onActiveModelChange?: (modelId: string | null) => void;
}

interface ModelFormValue {
  id: string;
  protocol: string;
  baseUrl: string;
  model: string;
  displayName: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  supportsTools: boolean;
  supportsThinking: boolean;
}

const DEFAULT_FORM_VALUE: ModelFormValue = {
  id: "",
  protocol: "openai",
  baseUrl: "",
  model: "",
  displayName: "",
  apiKey: "",
  maxTokens: 4096,
  temperature: 0.7,
  supportsTools: true,
  supportsThinking: false,
};

function presetToForm(preset: ModelPreset): ModelFormValue {
  return {
    id: preset.id,
    protocol: preset.protocol,
    baseUrl: preset.base_url,
    model: preset.model,
    displayName: preset.display_name,
    apiKey: preset.api_key ?? "",
    maxTokens: preset.max_tokens,
    temperature: preset.temperature,
    supportsTools: preset.supports_tools,
    supportsThinking: preset.supports_thinking,
  };
}

function formToPreset(form: ModelFormValue, existing: ModelPreset | null): ModelPreset {
  const resolvedBase =
    form.baseUrl.trim() ||
    (form.protocol === "openai"
      ? "https://api.openai.com/v1"
      : "https://api.anthropic.com");
  return {
    id: form.id.trim(),
    display_name: form.displayName.trim() || form.id.trim(),
    protocol: form.protocol,
    base_url: resolvedBase,
    model: form.model.trim(),
    api_key: form.apiKey.trim() || null,
    api_key_env: existing?.api_key_env ?? null,
    max_tokens: form.maxTokens,
    temperature: form.temperature,
    supports_tools: form.supportsTools,
    supports_thinking: form.supportsThinking,
  };
}

export function ModelManager({ onChanged, onActiveModelChange }: ModelManagerProps) {
  const { t } = useTranslation();
  const { data: store, loading, refetch } = useInvoke<ModelStore>("list_models");
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; msg: string } | null>(
    null,
  );
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingKeyValue, setEditingKeyValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async (id: string) => {
    if (!window.confirm(t("config.removeModel") + "?")) return;
    try {
      await invokeCommand("remove_model", { id });
      refetch();
      onChanged();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleSetActive = async (id: string) => {
    try {
      await invokeCommand("set_active_model", { id });
      refetch();
      onChanged();
      // Notify parent of the new active model name (provider/model-id).
      const preset = store?.presets.find((p) => p.id === id);
      onActiveModelChange?.(preset?.model ?? null);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDeactivate = async () => {
    try {
      // Reuse set_active_model with the empty-string id semantics? No — we
      // need a dedicated path. Add an IPC command below if missing. For now,
      // we can clear active by calling a dedicated deactivate command.
      await invokeCommand("deactivate_model");
      refetch();
      onChanged();
      onActiveModelChange?.(null);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleTest = async (preset: ModelPreset) => {
    setTesting(preset.id);
    setTestResult(null);
    try {
      const result = await invokeCommand<{
        response: string;
        stop_reason: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      }>("test_model", { id: preset.id });
      setTestResult({
        id: preset.id,
        ok: true,
        msg: `${result.response || "OK"}${result.usage ? ` (${result.usage.input_tokens ?? "?"}→${result.usage.output_tokens ?? "?"} tokens)` : ""}`,
      });
    } catch (err) {
      setTestResult({ id: preset.id, ok: false, msg: String(err) });
    } finally {
      setTesting(null);
    }
  };

  const handleSaveKey = async (id: string) => {
    try {
      await invokeCommand("set_model_key", { id, key: editingKeyValue });
      setEditingKey(null);
      setEditingKeyValue("");
      refetch();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleEdit = (preset: ModelPreset) => {
    setEditingId(preset.id);
    setShowAdd(false);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("env.checking")}
      </div>
    );
  }

  const presets = store?.presets ?? [];
  const activeId = store?.active ?? null;
  const editingPreset = editingId ? presets.find((p) => p.id === editingId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t("config.modelManagerDesc")}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setShowAdd(!showAdd);
            setEditingId(null);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t("config.addModel")}
        </Button>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {showAdd && (
        <ModelForm
          mode="add"
          onCancel={() => setShowAdd(false)}
          onSaved={() => {
            refetch();
            onChanged();
            setShowAdd(false);
          }}
          onError={setError}
          onSetActive={handleSetActive}
        />
      )}

      {presets.length === 0 && !showAdd ? (
        <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
          <p>{t("config.noModels")}</p>
          <p className="text-sm mt-1">{t("config.noModelsDesc")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {presets.map((preset) => {
            const isActive = activeId === preset.id;
            const isEditing = editingId === preset.id;

            if (isEditing) {
              return (
                <ModelForm
                  key={preset.id}
                  mode="edit"
                  initial={preset}
                  onCancel={handleCancelEdit}
                  onSaved={() => {
                    refetch();
                    onChanged();
                    setEditingId(null);
                  }}
                  onError={setError}
                />
              );
            }

            return (
              <div
                key={preset.id}
                className={`rounded-md border px-4 py-3 space-y-2 transition-colors ${
                  isActive ? "border-primary/50 bg-primary/5" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  {isActive && (
                    <span
                      className="flex-shrink-0 h-2 w-2 rounded-full bg-[var(--icon-success)]"
                      title={t("config.activeModel")}
                      aria-label={t("config.activeModel")}
                    />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">
                        {preset.display_name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({preset.protocol})
                      </span>
                      {isActive && (
                        <span className="text-xs bg-primary text-primary-foreground px-1.5 py-0.5 rounded font-medium">
                          {t("config.active")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {preset.model} · {preset.base_url}
                    </div>
                  </div>

                  <div className="flex gap-1 flex-shrink-0">
                    {isActive ? (
                      <button
                        type="button"
                        onClick={handleDeactivate}
                        className={`${ICON_BTN} text-[var(--icon-folder)]`}
                        title={t("config.deactivateModel")}
                        aria-label={t("config.deactivateModel")}
                      >
                        <PowerOff className="h-4 w-4" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSetActive(preset.id)}
                        className={`${ICON_BTN} text-[var(--icon-success)]`}
                        title={t("config.setActiveModel")}
                        aria-label={t("config.setActiveModel")}
                      >
                        <Power className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleTest(preset)}
                      disabled={testing === preset.id}
                      className={`${ICON_BTN} text-[var(--icon-action)] disabled:opacity-50`}
                      title={t("config.testModel")}
                      aria-label={t("config.testModel")}
                    >
                      {testing === preset.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Zap className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEdit(preset)}
                      className={`${ICON_BTN} text-[var(--icon-theme)]`}
                      title={t("config.editModel")}
                      aria-label={t("config.editModel")}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(preset.id)}
                      className={`${ICON_BTN} text-[var(--color-destructive)]`}
                      title={t("config.removeModel")}
                      aria-label={t("config.removeModel")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* API Key row */}
                <div className="flex items-center gap-2 pl-7">
                  <Key className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  {editingKey === preset.id ? (
                    <div className="flex items-center gap-2 flex-1">
                      <Input
                        type="password"
                        value={editingKeyValue}
                        onChange={(e) => setEditingKeyValue(e.target.value)}
                        placeholder={t("config.apiKeyPlaceholder")}
                        className="h-7 text-xs flex-1"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveKey(preset.id);
                          if (e.key === "Escape") {
                            setEditingKey(null);
                            setEditingKeyValue("");
                          }
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleSaveKey(preset.id)}
                        title={t("config.save")}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          setEditingKey(null);
                          setEditingKeyValue("");
                        }}
                        title={t("common.cancel")}
                      >
                        ×
                      </Button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setEditingKey(preset.id);
                        setEditingKeyValue("");
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-fast"
                    >
                      {preset.api_key
                        ? `${t("config.apiKeySet")}: ${preset.api_key}`
                        : preset.api_key_env
                          ? `${t("config.apiKeyFromEnv")}: ${preset.api_key_env}`
                          : t("config.apiKeyNotSet")}
                    </button>
                  )}
                </div>

                {/* Test result */}
                {testResult && testResult.id === preset.id && (
                  <div
                    className={`text-xs pl-7 ${testResult.ok ? "text-green-500" : "text-red-500"}`}
                  >
                    {testResult.msg}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editingPreset && (
        <ModelForm
          mode="edit"
          initial={editingPreset}
          onCancel={handleCancelEdit}
          onSaved={() => {
            refetch();
            onChanged();
            setEditingId(null);
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

interface ModelFormProps {
  mode: "add" | "edit";
  initial?: ModelPreset;
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
  onSetActive?: (id: string) => Promise<void>;
}

function ModelForm({ mode, initial, onCancel, onSaved, onError, onSetActive }: ModelFormProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState<ModelFormValue>(() => {
    if (initial) return presetToForm(initial);
    return { ...DEFAULT_FORM_VALUE };
  });
  const [showKey, setShowKey] = useState(false);
  const [activateAfterAdd, setActivateAfterAdd] = useState(false);
  const [saving, setSaving] = useState(false);

  const update = <K extends keyof ModelFormValue>(key: K, v: ModelFormValue[K]) => {
    setValue((prev) => ({ ...prev, [key]: v }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.id.trim() || !value.model.trim()) return;

    setSaving(true);

    const isIdChanging = initial && initial.id !== value.id.trim();
    if (isIdChanging) {
      onError(t("config.modelIdNotEditable"));
      setSaving(false);
      return;
    }

    const preset = formToPreset(value, initial ?? null);

    try {
      if (mode === "edit" && initial) {
        await invokeCommand("update_model", { id: initial.id, preset });
        if (activateAfterAdd && onSetActive) {
          await onSetActive(initial.id);
        }
      } else {
        await invokeCommand("add_model", { preset });
        if (activateAfterAdd && onSetActive) {
          await onSetActive(preset.id);
        }
      }
      onSaved();
    } catch (err) {
      onError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const isEdit = mode === "edit";

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-md border p-4 space-y-3 bg-accent/20"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">
          {isEdit ? t("config.editModel") : t("config.addModel")}
        </h4>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.modelId")}</label>
          <Input
            value={value.id}
            onChange={(e) => update("id", e.target.value)}
            placeholder="my-model"
            required
            disabled={isEdit}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.protocol")}</label>
          <select
            value={value.protocol}
            onChange={(e) => {
              update("protocol", e.target.value);
              update("supportsThinking", e.target.value === "anthropic");
            }}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.displayName")}</label>
          <Input
            value={value.displayName}
            onChange={(e) => update("displayName", e.target.value)}
            placeholder={t("config.displayNamePlaceholder")}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.modelName")}</label>
          <Input
            value={value.model}
            onChange={(e) => update("model", e.target.value)}
            placeholder="gpt-4o / claude-sonnet-4-6"
            required
          />
        </div>
        <div className="space-y-1 col-span-2">
          <label className="text-xs text-muted-foreground">{t("config.baseUrl")}</label>
          <Input
            value={value.baseUrl}
            onChange={(e) => update("baseUrl", e.target.value)}
            placeholder={
              value.protocol === "openai"
                ? "https://api.openai.com/v1"
                : "https://api.anthropic.com"
            }
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.maxTokens")}</label>
          <Input
            type="number"
            min={1}
            value={value.maxTokens}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              update("maxTokens", isNaN(n) || n <= 0 ? 4096 : n);
            }}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.temperature")}</label>
          <Input
            type="number"
            step="0.1"
            min={0}
            max={2}
            value={value.temperature}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              update("temperature", isNaN(n) ? 0.7 : n);
            }}
          />
        </div>
      </div>

      {/* API Key input */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          {t("config.apiKeyLabel")}
          {isEdit && initial?.api_key ? ` (${t("config.apiKeyLeaveBlank")})` : ""}
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type={showKey ? "text" : "password"}
              value={value.apiKey}
              onChange={(e) => update("apiKey", e.target.value)}
              placeholder={t("config.apiKeyPlaceholder")}
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("config.apiKeyStorageHint")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={value.supportsTools}
            onChange={(e) => update("supportsTools", e.target.checked)}
            className="rounded"
          />
          {t("config.supportsTools")}
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={value.supportsThinking}
            onChange={(e) => update("supportsThinking", e.target.checked)}
            className="rounded"
          />
          {t("config.supportsThinking")}
        </label>
        {onSetActive && (
          <label className="flex items-center gap-1.5 cursor-pointer ml-auto">
            <input
              type="checkbox"
              checked={activateAfterAdd}
              onChange={(e) => setActivateAfterAdd(e.target.checked)}
              className="rounded"
            />
            {t("config.activateAfterSave")}
          </label>
        )}
      </div>

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={saving || !value.id.trim() || !value.model.trim()}>
          {saving ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Check className="mr-1 h-4 w-4" />
          )}
          {isEdit ? t("common.save") : t("config.addModel")}
        </Button>
      </div>
    </form>
  );
}
