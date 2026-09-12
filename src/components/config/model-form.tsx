import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  THINKING_LEVEL_ALL,
  type PiModelEntry,
  type ModelFormValue,
} from "./model-types";
import { thinkingLevelLabel } from "@/components/sessions/thinking-level-select";
import { MODEL_PARAM_TEMPLATES } from "./model-templates";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm";

export function ModelForm({
  providerName,
  existingModel,
  saving,
  onCancel,
  onSubmit,
  /** 需求16 续三：保存上抛页头（打开即注册提交函数，null=关闭）。 */
  registerSave,
  /** 需求16 续六：内嵌于 ProviderForm 时显示本地确认按钮（页头保存语义
   *  歧义——保存渠道还是添加模型？内嵌子表单自带确认更清晰）。 */
  showLocalSubmit,
  localSubmitLabel,
  /** 补丁六：标题行右侧本地保存钮（激活前内嵌场景）。 */
  localSave,
}: {
  providerName: string;
  existingModel: PiModelEntry | undefined;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (payload: { providerName: string; model: PiModelEntry }) => void;
  registerSave?: (fn: (() => void) | null) => void;
  showLocalSubmit?: boolean;
  localSubmitLabel?: string;
  localSave?: boolean;
}) {
  const { t } = useTranslation();
  void saving; // 保存按钮已上抛页头；保留 prop 兼容既有调用。
  // 补丁六：取消钮随 localSave 使用（无 localSave 场景仍无底部操作）。
  const [value, setValue] = useState<ModelFormValue>(
    existingModel ? modelToValue(existingModel) : emptyModelValue(),
  );
  // 补丁六修复：模板下拉受控——此前 value 恒为 ""（选择后仍显示占位符）。
  const [templateId, setTemplateId] = useState("");

  // v0.9.2 需求9 补丁五（用户裁决）：参数模板库独立成块、全渠道/全 agent
  // 通用（不再按 baseUrl 匹配渠道预设兜底模型）——选模板只带参数，id 由
  // 用户填。激活前后添加/编辑共用（同一 ModelForm）。
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = MODEL_PARAM_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setValue((prev) => ({
      ...prev,
      contextWindow: String(t.contextWindow),
      maxTokens: String(t.maxTokens),
      reasoning: true,
      inputText: true,
      inputImage: t.inputImage,
      thinkingLevels: [...t.thinkingLevels],
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
        {localSave && (
          /* 补丁六（用户裁决）：标题行最右端 [取消][保存] 按钮组——保存左侧
             取消（关表单不落库），不复用页头。 */
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground"
              onClick={onCancel}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={submit}
              disabled={saving || !value.id.trim()}
            >
              {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        )}
      </div>

      {/* v0.9.2 需求9 补丁五：参数模板下拉（通用模板库，添加/编辑均可带参）。 */}
      <div className="space-y-1.5">
        <Label htmlFor="model-template">{t("config.modelTemplateLabel")}</Label>
        <select
          id="model-template"
          className={selectClass}
          value={templateId}
          onChange={(e) => applyTemplate(e.target.value)}
        >
          <option value="">{t("config.modelTemplatePlaceholder")}</option>
          {MODEL_PARAM_TEMPLATES.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.displayName}
            </option>
          ))}
        </select>
        <p className="text-[10px] text-muted-foreground/70">
          {t("config.modelTemplateHint")}
        </p>
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

      {/* 需求16 续五：保存统一页头；底部操作行整体移除。续六：内嵌场景
          （ProviderForm 里的添加模型）显示本地确认按钮——页头保存语义
          歧义（保存渠道 vs 添加模型），子表单自带确认。 */}
      {showLocalSubmit && (
        <div className="flex justify-end gap-2 pt-2">
          <Button size="sm" onClick={submit} disabled={saving || !value.id.trim()}>
            {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            {localSubmitLabel || t("common.confirm")}
          </Button>
        </div>
      )}
    </div>
  );
}
