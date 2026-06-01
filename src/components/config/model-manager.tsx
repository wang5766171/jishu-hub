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
              className="flex items-center gap-3 rounded-md border px-4 py-3"
            >
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
                {testResult && testResult.id === preset.id && (
                  <div
                    className={`text-xs mt-1 ${testResult.ok ? "text-green-500" : "text-red-500"}`}
                  >
                    {testResult.msg}
                  </div>
                )}
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !model.trim()) return;

    setSaving(true);
    setError(null);

    const apiKeyEnv = `JISHU_MODEL_${id.toUpperCase().replace(/-/g, "_")}_KEY`;
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
          api_key_env: apiKeyEnv,
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

      <p className="text-xs text-muted-foreground">
        {t("config.apiKeyHint", { env: `JISHU_MODEL_${id.toUpperCase().replace(/-/g, "_") || "..."}.KEY` })}
      </p>

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
