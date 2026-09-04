// v0.7.4 需求2 R1：模型条目表单（自 model-manager.tsx 拆出）。
// 供应商命中预设时提供推荐模型下拉（自动预填 ctx/maxTokens/reasoning），
// 否则保持全手填（原行为）。

import { useState , useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  emptyModelValue,
  modelToValue,
  valueToModel,
  supportedThinkingLevels,
  THINKING_LEVEL_ALL,
  type PiModelEntry,
  type PiProviderConfig,
  type ModelFormValue,
} from "./model-types";
import { thinkingLevelLabel } from "@/components/sessions/thinking-level-select";
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
  /** 需求16 续三：保存上抛页头（打开即注册提交函数，null=关闭）。 */
  registerSave,
}: {
  providerName: string;
  provider: PiProviderConfig | undefined;
  existingModel: PiModelEntry | undefined;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (payload: { providerName: string; model: PiModelEntry }) => void;
  registerSave?: (fn: (() => void) | null) => void;
}) {
  const { t } = useTranslation();
  void saving; // 保存按钮已上抛页头；保留 prop 兼容既有调用。
  void onCancel; // 需求16 续五：底部取消移除，保留 prop 兼容。
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
      // 预设模型的档位声明一并带入（如 glm-5.3 不支持关闭）。
      thinkingLevels: m.reasoning
        ? supportedThinkingLevels(m.thinkingLevelMap as Record<string, unknown> | undefined)
        : prev.thinkingLevels,
    }));
  };

  const submit = () => {
    const model = valueToModel(value);
    // 编辑时保留表单未暴露的预设声明（如智谱的 forceAdaptiveThinking）。
    if (existingModel?.compat) model.compat = existingModel.compat;
    onSubmit({ providerName, model });
  };
  // 需求16 续三：提交函数上抛页头（表单打开期间有效）。
  useEffect(() => {
    registerSave?.(submit);
    return () => registerSave?.(null);
  });

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

      {/* A7：模型档位声明——预设自动带入；自定义模型由用户勾选。
          会话页选择器按此列表渲染，选到不支持的档位时 Pi 就近收敛回传。 */}
      {value.reasoning && (
        <div className="space-y-1.5 rounded-md border border-border/40 bg-muted/20 p-3">
          <Label>{t("config.thinkingLevelsLabel")}</Label>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            {THINKING_LEVEL_ALL.map((lvl) => (
              <label key={lvl} className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={value.thinkingLevels.includes(lvl)}
                  onChange={(e) =>
                    setValue((prev) => ({
                      ...prev,
                      thinkingLevels: e.target.checked
                        ? [...THINKING_LEVEL_ALL].filter(
                            (l) => prev.thinkingLevels.includes(l) || l === lvl,
                          )
                        : prev.thinkingLevels.filter((l) => l !== lvl),
                    }))
                  }
                  className="h-3 w-3"
                />
                {thinkingLevelLabel(t, lvl)}
              </label>
            ))}
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            {t("config.thinkingLevelsHint")}
          </p>
        </div>
      )}

      {/* 需求16 续五：保存统一页头；底部操作行整体移除。 */}
    </div>
  );
}
