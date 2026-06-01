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
  Star,
  Eye,
  EyeOff,
  Key,
} from "lucide-react";
import type { ModelPreset, ModelStore } from "@/types";

interface ModelManagerProps {
  onChanged: () => void;
}

export function ModelManager({ onChanged }: ModelManagerProps) {
  const { t } = useTranslation();
  const { data: store, loading, refetch } = useInvoke<ModelStore>("list_models");
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingKeyValue, setEditingKeyValue] = useState("");

  const handleRemove = async (id: string) => {
    try {
      await invokeCommand("remove_model", { id });
      refetch();
      onChanged();
    } catch (err) {
      console.error("Failed to remove model:", err);
    }
  };

  const handleSetActive = async (id: string) => {
    try {
      await invokeCommand("set_active_model", { id });
      refetch();
      onChanged();
    } catch (err) {
      console.error("Failed to set active model:", err);
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
    } catch (err) {
      console.error("Failed to save key:", err);
    }
  };

  const maskKey = (key: string | null | undefined): string => {
    if (!key) return "";
    if (key.length <= 12) return "*".repeat(key.length);
    return key.slice(0, 4) + "*".repeat(key.length - 8) + key.slice(-4);
  };

  if (loading) {
    return <div className="text-muted-foreground text-sm">...</div>;
  }

  const presets = store?.presets ?? [];
  const activeId = store?.active ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t("config.modelManagerDesc")}</p>
        <Button variant="outline" size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="mr-1 h-4 w-4" />
          {t("config.addModel")}
        </Button>
      </div>

      {showAdd && (
        <AddModelForm
          onAdded={() => {
            refetch();
            onChanged();
            setShowAdd(false);
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {presets.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
          <p>{t("config.noModels")}</p>
          <p className="text-sm mt-1">{t("config.noModelsDesc")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {presets.map((preset) => (
            <div
              key={preset.id}
              className="rounded-md border px-4 py-3 space-y-2"
            >
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleSetActive(preset.id)}
                  className="flex-shrink-0"
                  title={activeId === preset.id ? t("config.activeModel") : t("config.setActiveModel")}
                >
                  <Star
                    className={`h-4 w-4 ${
                      activeId === preset.id
                        ? "fill-yellow-400 text-yellow-400"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  />
                </button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{preset.display_name}</span>
                    <span className="text-xs text-muted-foreground">({preset.protocol})</span>
                    {activeId === preset.id && (
                      <span className="text-xs bg-accent text-accent-foreground px-1.5 py-0.5 rounded">
                        {t("config.active")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {preset.model} · {preset.base_url}
                  </div>
                </div>

                <div className="flex gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleTest(preset)}
                    disabled={testing === preset.id}
                    title={t("config.testModel")}
                  >
                    {testing === preset.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Zap className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleRemove(preset.id)}
                    title={t("config.removeModel")}
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground hover:text-red-500" />
                  </Button>
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
                        if (e.key === "Escape") { setEditingKey(null); setEditingKeyValue(""); }
                      }}
                    />
                    <Button variant="ghost" size="icon-sm" onClick={() => handleSaveKey(preset.id)} title={t("config.save")}>
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => { setEditingKey(null); setEditingKeyValue(""); }} title={t("common.cancel")}>
                      ×
                    </Button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setEditingKey(preset.id); setEditingKeyValue(""); }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-fast"
                  >
                    {preset.api_key
                      ? `${t("config.apiKeySet")}: ${maskKey(preset.api_key)}`
                      : preset.api_key_env
                        ? `${t("config.apiKeyFromEnv")}: ${preset.api_key_env}`
                        : t("config.apiKeyNotSet")}
                  </button>
                )}
              </div>

              {/* Test result */}
              {testResult && testResult.id === preset.id && (
                <div className={`text-xs pl-7 ${testResult.ok ? "text-green-500" : "text-red-500"}`}>
                  {testResult.msg}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddModelForm({
  onAdded,
  onCancel,
}: {
  onAdded: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  const [protocol, setProtocol] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !model.trim()) return;

    setSaving(true);
    setError(null);

    const resolvedBase =
      baseUrl.trim() ||
      (protocol === "openai"
        ? "https://api.openai.com/v1"
        : "https://api.anthropic.com");

    try {
      await invokeCommand("add_model", {
        preset: {
          id: id.trim(),
          display_name: id.trim(),
          protocol,
          base_url: resolvedBase,
          model: model.trim(),
          api_key: apiKey.trim() || null,
          api_key_env: `JISHU_MODEL_${id.trim().toUpperCase().replace(/-/g, "_")}_KEY`,
          max_tokens: 4096,
          temperature: 0.7,
          supports_tools: true,
          supports_thinking: protocol === "anthropic",
        },
      });
      onAdded();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-md border p-4 space-y-3 bg-accent/20"
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.modelId")}</label>
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="my-model"
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.protocol")}</label>
          <select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.baseUrl")}</label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              protocol === "openai"
                ? "https://api.openai.com/v1"
                : "https://api.anthropic.com"
            }
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("config.modelName")}</label>
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o / claude-sonnet-4-6"
            required
          />
        </div>
      </div>

      {/* API Key input */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t("config.apiKeyLabel")}</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
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

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={saving || !id.trim() || !model.trim()}>
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
          {t("config.addModel")}
        </Button>
      </div>
    </form>
  );
}
