// v0.7.4 需求2 R1：模型条目表单（自 model-manager.tsx 拆出）。
// 供应商命中预设时提供推荐模型下拉（自动预填 ctx/maxTokens/reasoning），
// 否则保持全手填（原行为）。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import {
  emptyModelValue,
  modelToValue,
  valueToModel,
  type PiModelEntry,
  type PiProviderConfig,
  type ModelFormValue,
} from "./model-types";
import { matchPresetByBaseUrl } from "@/agents/config/presets/provider-presets";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm";

export function ModelForm({
  providerName,
  provider,
  existingModel,
  saving,
  onCancel,
  onSubmit,
}: {
  providerName: string;
  provider: PiProviderConfig | undefined;
  existingModel: PiModelEntry | undefined;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (payload: { providerName: string; model: PiModelEntry }) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<ModelFormValue>(
    existingModel ? modelToValue(existingModel) : emptyModelValue(),
  );

  // 推荐模型：按供应商 baseUrl 命中预设时给出（排除已存在的模型 id）
  const preset = matchPresetByBaseUrl(provider?.baseUrl);
  const existingIds = new Set((provider?.models ?? []).map((m) => m.id));
  const suggestions =
    preset?.models.filter((m) => !existingIds.has(m.id)) ?? [];

  const applySuggestion = (id: string) => {
    const m = suggestions.find((s) => s.id === id);
    if (!m) return;
    setValue((prev) => ({
      ...prev,
      id: m.id,
      contextWindow: String(m.contextWindow ?? prev.contextWindow),
      maxTokens: String(m.maxTokens ?? prev.maxTokens),
      reasoning: m.reasoning ?? prev.reasoning,
    }));
  };

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

      {suggestions.length > 0 && !existingModel && (
        <div className="space-y-1.5">
          <Label htmlFor="model-suggest">{t("config.modelSuggestLabel")}</Label>
          <select
            id="model-suggest"
            className={selectClass}
            value=""
            onChange={(e) => applySuggestion(e.target.value)}
          >
            <option value="">{t("config.modelSuggestPlaceholder")}</option>
            {suggestions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-muted-foreground/70">
            {t("config.modelSuggestHint")}
          </p>
        </div>
      )}

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
            onChange={(e) => setValue({ ...value, baseUrl: e.target.value })}
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
            onChange={(e) => setValue({ ...value, contextWindow: e.target.value })}
            placeholder="128000"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="model-mt">{t("config.maxTokens")}</Label>
          <Input
            id="model-mt"
            value={value.maxTokens}
            onChange={(e) => setValue({ ...value, maxTokens: e.target.value })}
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
                onChange={(e) => setValue({ ...value, reasoning: e.target.checked })}
                className="h-3 w-3"
              />
              {t("config.reasoning")}
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={value.inputText}
                onChange={(e) => setValue({ ...value, inputText: e.target.checked })}
                className="h-3 w-3"
              />
              {t("config.inputText")}
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={value.inputImage}
                onChange={(e) => setValue({ ...value, inputImage: e.target.checked })}
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
