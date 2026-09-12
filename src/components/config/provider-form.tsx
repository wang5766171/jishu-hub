// v0.7.4 需求2 R1：卡片预设式「添加/编辑模型供应商」面板（自 model-manager.tsx
// 拆出并重构）。三步单屏：①选服务商卡片 → ②填 API Key → ③测试连接；
// 高级字段（地址/协议/请求头/compat/overrides）折叠收纳，熟练用户零损失。
// 选中预设即自动回填 baseUrl/api/推荐模型 chips；「自定义」退化为全手填。

import { useEffect, useRef, useState } from "react";
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
  RefreshCw,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { HeaderRow, PiModelEntry, PiProviderConfig } from "./model-types";
import { ModelForm } from "./model-form";
import {
  PROVIDER_PRESETS,
  matchPresetByBaseUrl,
  presetModelToEntry,
  suggestProviderKey,
  type ProviderPreset,
} from "@/agents/config/presets/provider-presets";
import { ConnectionTestBadge, type ConnectionTestResult } from "./connection-test-badge";
// v0.9.2 需求9：探测落库返回形状（与 Rust channel_models_store 对齐）。
interface ChannelModelsProbe {
  supported: boolean;
  models: string[];
  endpoint: string;
  error: string | null;
}
interface StoredChannelModels {
  models: string[];
  endpoint: string;
  fetched_at: number;
}

const PROTOCOL_OPTIONS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
  "bedrock-converse-stream",
];

export function ProviderForm({
  agentId,
  existingName,
  existingProvider,
  existingProviderKeys,
  /** v0.7.6 需求3：新增模式下预选的预设 id（左栏点击未添加预置渠道 /
   *  底部「添加自定义渠道」= "custom"）。 */
  initialPresetId,
  saving,
  onCancel,
  onSubmit,
  /** 需求16 续三：保存上抛页头——打开即注册提交函数（父级页头保存按钮触发）。
   *  注册 null = 表单已关闭（页头按钮随之禁用）。 */
  registerSave,
}: {
  /** v0.9.2 需求9：探测落库作用域（管理作用域 agent）。 */
  agentId: string;

  existingName: string | null;
  existingProvider: PiProviderConfig | undefined;
  /** 当前已有 provider key 列表（新增时用于推荐 key 去重） */
  existingProviderKeys: string[];
  initialPresetId?: string;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (payload: { name: string; provider: PiProviderConfig }) => void;
  registerSave?: (fn: (() => void) | null) => void;
}) {
  const { t } = useTranslation();
  void saving; // 保存按钮已上抛页头；保留 prop 兼容既有调用（页头 saving 态由父级管理）。
  void onCancel; // 需求16 续五：底部取消移除，保留 prop 兼容。

  const initialPreset =
    existingProvider && existingName
      ? (matchPresetByBaseUrl(existingProvider.baseUrl) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1])
      : initialPresetId
        ? (PROVIDER_PRESETS.find((p) => p.id === initialPresetId) ?? null)
        : null;

  // v0.7.6 需需求3 迭代：左栏点击预置渠道进入时预设已确定（非 custom），
  // 隐藏「选择服务商」卡片网格——右栏直接是渠道配置（密钥 + 预置模型
  // chips + 自定义模型添加 + 高级选项）。custom（底部添加按钮入口）经
  // 需求16 续五同样锁定为「自定义」：渠道选择统一由左栏承担，右栏不再
  // 重复出现预置网格（与左栏六渠道重复、交互混乱）。
  const presetLocked = initialPreset !== null;

  // 预选预设时同步回填（与 selectPreset 一致的初始态：推荐 key / 地址 / 协议 / 模型）。
  const [preset, setPreset] = useState<ProviderPreset | null>(initialPreset);
  const [name, setName] = useState(
    existingName ??
      (initialPreset && initialPreset.id !== "custom"
        ? suggestProviderKey(initialPreset, existingProviderKeys)
        : ""),
  );
  const [displayName, setDisplayName] = useState(existingProvider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(
    existingProvider?.baseUrl ?? (initialPreset && initialPreset.id !== "custom" ? initialPreset.baseUrl : ""),
  );
  const [apiKey, setApiKey] = useState(existingProvider?.apiKey ?? "");
  const [api, setApi] = useState(existingProvider?.api ?? initialPreset?.api ?? "anthropic-messages");
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
    existingProvider?.models?.map((m) => m.id) ??
      (initialPreset && initialPreset.id !== "custom" ? initialPreset.models.map((m) => m.id) : []),
  );
  // 需求16 续：自定义模型经完整 ModelForm 添加（图3 表单：ID/baseUrl/协议/
  // 上下文/最大输出/能力）——修前的自由输入只录 ID，落盘缺 contextWindow
  // 等必填字段（保存报 Invalid models config payload）。内嵌展开、保存后
  // 收回（回到本表单）；渠道详情面板的「添加模型」入口保留不变。
  const [inlineModels, setInlineModels] = useState<PiModelEntry[]>([]);
  const [inlineFormOpen, setInlineFormOpen] = useState(false);
  // v0.9.2 需求9 补丁四：inlineModels 的同步镜像（ref）——页头保存链里
  // ModelForm.onSubmit 经 setState 暂存后本表单 submit 立即读取的是旧
  // state；submit 改读 ref，模型不丢。
  const inlineModelsRef = useRef<PiModelEntry[]>([]);
  const syncInline = (next: PiModelEntry[]) => {
    inlineModelsRef.current = next;
    setInlineModels(next);
  };
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  // v0.9.2 需求9（用户裁决）：未填 API 密钥前**模型列表先空**（预设推荐
  // chips 不再无条件展示），提示填写后自动获取；填 key 后优先展示**探测
  // 落库列表**（channel-models.db），无落库时回退预设推荐。
  const hasKey = apiKey.trim().length > 0;
  const [probedModels, setProbedModels] = useState<string[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeAttempted, setProbeAttempted] = useState(false);
  const channelKey = `${agentId}::${baseUrl.trim() || (preset?.baseUrl ?? "")}`;

  // 读已落库列表（baseUrl 定形后即读——编辑态/预置切换都会到达）。
  useEffect(() => {
    if (!hasKey || !channelKey || channelKey.endsWith("::")) return;
    let cancelled = false;
    invokeCommand<StoredChannelModels | null>("channel_models_stored", {
      agentId,
      channelKey,
    })
      .then((stored) => {
        if (!cancelled && stored?.models?.length) {
          setProbedModels(stored.models);
          setProbeAttempted(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentId, channelKey, hasKey]);

  // 首次探测：key 非空且无落库记录 → 自动探测一次（落库）。
  // baseUrl 未就绪时**不消耗** probeAttempted（key 先填/baseUrl 后填的顺序
  // 下，此前会提前置 true 导致 baseUrl 到位后永远不再探——用户实测
  // 「只有刷新才展示」的根因之一）。
  useEffect(() => {
    if (!hasKey || probing || probeAttempted) return;
    const base = baseUrl.trim() || preset?.baseUrl || "";
    if (!base) return;
    setProbing(true);
    invokeCommand<ChannelModelsProbe>("channel_models_probe_and_store", {
      agentId,
      channelKey,
      baseUrl: base,
      apiKey: apiKey.trim(),
    })
      .then((probe) => {
        // v0.9.2 需求9 补丁五（用户裁决）：探测**成功**才写库+标记已查——
        // 错误 key 探测失败不消耗首查标记，换正确 key 保存后自动重探。
        if (probe.supported) {
          setProbedModels(probe.models);
          setProbeAttempted(true);
        }
      })
      .catch(() => {})
      .finally(() => setProbing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey, baseUrl, apiKey, agentId, channelKey]);

  const refreshProbe = async () => {
    const base = baseUrl.trim();
    if (!base || !hasKey) return;
    setProbing(true);
    try {
      const probe = await invokeCommand<ChannelModelsProbe>("channel_models_probe_and_store", {
        agentId,
        channelKey,
        baseUrl: base,
        apiKey: apiKey.trim(),
      });
      if (probe.supported) setProbedModels(probe.models);
    } finally {
      setProbing(false);
    }
  };



  const isCustom = preset?.id === "custom";
  const isEdit = !!existingName;
  const canTest =
    baseUrl.trim().length > 0 &&
    (selectedModelIds.length > 0 || inlineModels.length > 0) &&
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
        { api, baseUrl, apiKey, model: selectedModelIds[0] ?? inlineModels[0]?.id },
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
      // 预设模型 chips：按勾选生成条目；自定义添加的模型生成基础条目；
      // 编辑模式下保留用户自定义过的既有条目（不在预设清单里的不丢）。
      // v0.9.2 需求9：探测列表勾选的模型（id 不在静态预设表）同样落条目
      //（基础条目，探测富信息在 channel-models.db；后续可编辑补参数）。
      const presetEntries = preset.models
        .filter((m) => selectedModelIds.includes(m.id))
        .map(presetModelToEntry);
      const probedOnlyEntries = selectedModelIds
        .filter((id) => !preset.models.some((pm) => pm.id === id))
        .filter((id) => probedModels?.includes(id) ?? false)
        // v0.9.2 需求9 补丁六：同 id 已手动添加（inline 完整条目）时不重复
        // 生成探测基础条目——手动参数优先，防同 id 双条目（双激活态源头）。
        .filter((id) => !inlineModelsRef.current.some((x) => x.id === id))
        .map((id) => probedModelToEntry(id));
      // 需求16 续：内嵌 ModelForm 产出的完整条目（contextWindow 等必填
      // 字段齐备），不再是缺字段的基础条目。
      const extraExisting = (existingProvider?.models ?? []).filter(
        (m) =>
          !preset.models.some((pm) => pm.id === m.id) &&
          !probedOnlyEntries.some((pm) => pm.id === m.id),
      );
      const customEntries = [
        ...inlineModelsRef.current,
        ...probedOnlyEntries,
        ...extraExisting,
      ].filter(
        (m) => !preset.models.some((pm) => pm.id === m.id) &&
          !presetEntries.some((pm) => pm.id === m.id),
      );
      const models = [...presetEntries, ...customEntries];
      if (models.length > 0) provider.models = models;
    } else if (existingProvider?.models) {
      provider.models = existingProvider.models;
    }

    onSubmit({ name: name.trim(), provider });
  };
  // 需求16 续三：提交函数上抛页头（表单打开期间有效）。
  // 需求9 补丁四：内嵌 ModelForm 打开期间本表单不注册（ModelForm 独占）。
  useEffect(() => {
    if (inlineFormOpen) return;
    registerSave?.(submit);
    return () => registerSave?.(null);
  });

  return (
    <div className="rounded-md border border-border/40 bg-muted/30 p-4 space-y-4">
      <div className="text-sm font-medium">
        {isEdit
          ? `${t("config.editProvider")}: ${existingName}`
          : presetLocked && preset
            ? `${t("config.addProvider")}: ${t(preset.id_label)}`
            : t("config.addProvider")}
      </div>

      {/* ① 选择服务商（预设已由左栏锁定时隐藏——右栏即渠道配置） */}
      {!presetLocked && (
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
      )}

      {/* ② API Key（预设已定时唯一必填项） */}
      {preset && preset.id !== "custom" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="provider-apikey">{t("config.apiKey")}</Label>
            {preset.apiKeyUrl && (
              <button
                type="button"
                onClick={() => void invokeCommand("open_url", { url: preset.apiKeyUrl })}
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                {t("config.presetGetKey")}
                <ExternalLink className="h-3 w-3" />
              </button>
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

      {/* ③ 模型 + 验证。v0.9.2 需求9：未填 key = 列表空 + 引导文案；填 key
          后优先展示探测落库列表（可刷新），无探测结果回退预设推荐 chips。 */}
      {preset && preset.id !== "custom" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">
              {t("config.presetStepModels")}
            </Label>
            {hasKey && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={probing}
                onClick={() => void refreshProbe()}
                title={t("config.refreshModels")}
              >
                {probing ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                {t("config.refreshModels")}
              </Button>
            )}
          </div>
          {!hasKey ? (
            <p className="rounded-md border border-dashed border-border/50 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground/70">
              {t("config.probeNoKey")}
            </p>
          ) : probing && probedModels === null ? (
            <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("common.loading")}
            </div>
          ) : probedModels !== null ? (
            <div className="flex flex-wrap gap-1.5">
              {probedModels.map((id) => {
                const active = selectedModelIds.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggleModel(id)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                      active
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border/40 text-muted-foreground hover:border-border",
                    )}
                  >
                    {active && <Check className="h-3 w-3" />}
                    {id}
                  </button>
                );
              })}
            </div>
          ) : (
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
            {/* 内嵌表单添加的自定义模型（完整条目，可删除） */}
            {inlineModels.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1 rounded-full border border-primary/60 bg-primary/10 px-2.5 py-1 font-mono text-[11px] text-primary"
              >
                {m.id}
                <button
                  type="button"
                  onClick={() =>
                    syncInline(inlineModelsRef.current.filter((x) => x.id !== m.id))
                  }
                  className="hover:text-foreground"
                  title={t("common.delete")}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          )}
          {/* 需求16 续：添加模型 = 打开完整表单（模型 ID/baseUrl/协议/上下文
              窗口/最大输出/能力），保存后收回——不再接受仅输入 ID 的裸添加。
              续四：与测试连接同行（按钮不换行堆叠）。 */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setInlineFormOpen((v) => !v)}
            >
              <Plus className="mr-1 h-3 w-3" />
              {t("config.addModel")}
            </Button>
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
          {inlineFormOpen && (
            <ModelForm
              providerName={name || "provider"}
              existingModel={undefined}
              saving={false}
              // v0.9.2 需求9 补丁六（用户裁决回退）：标题行右侧本地保存钮，
              // 不复用页头（页头在表单打开期间回归渠道保存语义）。
              localSave
              registerSave={undefined}
              onCancel={() => setInlineFormOpen(false)}
              onSubmit={({ model}) => {
                // 补丁六（用户裁决）：同 id 已存在 = 更新参数（替换），不再跳过。
                const prev = inlineModelsRef.current;
                syncInline(
                  prev.some((x) => x.id === model.id)
                    ? prev.map((x) => (x.id === model.id ? model : x))
                    : [...prev, model],
                );
                setInlineFormOpen(false);
                setTestResult(null);
              }}
            />
          )}
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
                      <button
                        type="button"
                        onClick={() => void invokeCommand("open_url", { url: preset.apiKeyUrl })}
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                      >
                        {t("config.presetGetKey")}
                        <ExternalLink className="h-3 w-3" />
                      </button>
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

      {/* 需求16 续五：保存统一页头；底部操作行整体移除（关闭表单 = 左栏
          切换渠道或重新点击当前渠道）。 */}
    </div>
  );
}


/** v0.9.2 需求9：探测模型 id → 完整合法 PiModelEntry（后端 TypeBox 必填集
 *  id/name/reasoning/input/cost{4}/contextWindow/maxTokens）。价格未知置 0
 *  （用户可后续在编辑里补），contextWindow 有探测元数据则用之，否则保守
 *  256000（用户裁决）；input 默认 ["text"]。 */
export function probedModelToEntry(
  id: string,
  meta?: { context_length?: number; max_tokens?: number; supports_reasoning?: boolean },
): PiModelEntry {
  const entry: PiModelEntry = {
    id,
    name: id,
    input: ["text"],
    reasoning: meta?.supports_reasoning ?? false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(meta?.context_length ? { contextWindow: meta.context_length } : { contextWindow: 256000 }),
    ...(meta?.max_tokens ? { maxTokens: meta.max_tokens } : { maxTokens: 8192 }),
  };
  return entry;
}
