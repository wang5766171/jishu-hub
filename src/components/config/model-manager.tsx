// Models page for v0.6.x — jishu no longer maintains its own preset
// store. The Models page reads and writes `~/.jishu-agent/models.json`
// directly, and the active selection lives in
// `~/.jishu-hub/settings.json`.
//
// Two-column UX (v0.7.4 需求2 R6/R8，参考用户截图，与 claude 页同构):
//   - 左列「渠道设置」：provider 列表（当前激活渠道带绿点），可添加。
//   - 右列「模型设置」：当前模型大卡（跨渠道扁平单选）+ 选中渠道的
//     配置卡（字段行内直接编辑并保存，密钥眼睛切换——R8 对齐 claude
//     交互，不再经 ProviderForm 编辑）+ 模型列表（设为激活/测试/编辑/
//     删除）。添加渠道走 ProviderForm，模型增改走 ModelForm，在右列展开。
//
// v0.7.4 需求2 R1：ProviderForm/ModelForm 与共享类型已拆出至独立文件
// （provider-form.tsx / model-form.tsx / model-types.ts，§18 规模约束），
// 本文件只保留页面编排与渠道详情面板。

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { useAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Plus,
  Trash2,
  Check,
  Loader2,
  Pencil,
  Power,
  Zap,
  Eye,
  EyeOff,
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
import { ActiveModelCard, type ActiveModelOption } from "./active-model-card";
import { ChannelSidebar, type ChannelSidebarItem } from "./channel-sidebar";
import {
  PROVIDER_PRESETS,
  matchPresetByBaseUrl,
} from "@/agents/config/presets/provider-presets";

export function ModelManager({
  onChanged,
  onActiveModelChange,
  /** 需求16 续三：保存统一页头——dirty/saving 状态上抛（页头按钮启停）。 */
  onSaveStateChange,
  /** 需求16 续三：当前活动表单/详情的提交函数注册（页头保存按钮触发）。 */
  registerSave,
}: {
  onChanged?: () => void;
  onActiveModelChange?: (modelId: string | null) => void;
  onSaveStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
  registerSave?: (fn: (() => void) | null) => void;
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
  // v0.7.6 需求3：add 模式携带 presetId（左栏点击未添加预置渠道 /
  // 底部「添加自定义渠道」= "custom" 时预选）。
  const [providerForm, setProviderForm] = useState<
    { mode: "add"; presetId?: string } | { mode: "edit"; name: string } | null
  >(null);
  const [modelForm, setModelForm] = useState<
    { providerName: string; mode: "add" } | { providerName: string; mode: "edit"; modelId: string } | null
  >(null);

  // R6 两栏结构：左渠道列表，右选中渠道详情。
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  // 需求16 续三：保存统一页头——当前活动保存入口（ProviderForm/ModelForm
  // 经各自 registerSave 上抛；渠道详情经 detailSaveRef）。聚合后转抛页头。
  const formSaveRef = useRef<(() => void) | null>(null);
  const detailSaveRef = useRef<(() => void) | null>(null);
  const [detailDirty, setDetailDirty] = useState(false);
  const formActive = providerForm !== null || modelForm !== null;
  const registerFormSave = useCallback(
    (fn: (() => void) | null) => {
      formSaveRef.current = fn;
      registerSave?.(fn ?? (detailDirty ? () => detailSaveRef.current?.() : null));
    },
    [registerSave, detailDirty],
  );
  const registerDetailSave = useCallback(
    (fn: (() => void) | null) => {
      detailSaveRef.current = fn;
      registerSave?.(fn ?? (formActive ? () => formSaveRef.current?.() : null));
    },
    [registerSave, formActive],
  );
  useEffect(() => {
    onSaveStateChange?.({
      dirty: formActive || detailDirty,
      saving,
    });
  }, [formActive, detailDirty, saving, onSaveStateChange]);
  useEffect(() => {
    if (!formActive) return;
    registerSave?.(() => formSaveRef.current?.());
    return () => registerSave?.(detailDirty ? () => detailSaveRef.current?.() : null);
  }, [formActive, detailDirty, registerSave]);

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
      setSelectedProvider(name);
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
  // R8：渠道字段行内保存（claude 同构交互）。
  const saveProviderFields = async (name: string, next: PiProviderConfig) => {
    setError(null);
    try {
      const cfg: PiModelsConfig = { providers: { ...config.providers } };
      cfg.providers[name] = next;
      await persistConfig(cfg);
    } catch (e) {
      setError(String(e));
    }
  };

  const startAddModel = (providerName: string) => {
    setSelectedProvider(providerName);
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

  // R3/R9：扁平 provider/model 单选（与聊天页模型选择器同一心智）；
  // hint 显示渠道显示名（providers.<key>.name），无则回退 key。
  const activeModelOptions: ActiveModelOption[] = providerNames.flatMap((name) => {
    const displayName = (config.providers[name]?.name as string | undefined) || name;
    return (config.providers[name]?.models ?? []).map((m) => ({
      value: `${name}/${m.id}`,
      label: (m.name as string | undefined) || m.id,
      hint: displayName,
    }));
  });
  const currentActiveOption = active
    ? (activeModelOptions.find(
        (o) => o.value === `${active.provider}/${active.model}`,
      ) ?? null)
    : null;

  // 选中项失效（删除/改名/首次加载）时回退到当前激活渠道或首个渠道。
  const providerKey = providerNames.join("\n");
  useEffect(() => {
    if (providerNames.length === 0) {
      setSelectedProvider(null);
      return;
    }
    if (!providerNames.includes(selectedProvider ?? "")) {
      setSelectedProvider(
        providerNames.includes(active?.provider ?? "")
          ? (active?.provider as string)
          : providerNames[0],
      );
    }
    // providerKey 已覆盖 providerNames 变化；selectedProvider 为本效应写入项。
  }, [providerKey, active?.provider]);

  const selectProvider = (name: string) => {
    setSelectedProvider(name);
    setProviderForm(null);
    setModelForm(null);
    setError(null);
  };

  // v0.7.6 需求3：左栏 = 预置渠道（默认全量显示，无需先添加）+ 自定义渠道
  //（baseUrl 未命中任何预设的 provider）。已添加预置点击进详情，未添加
  // 预置点击展开预选该预设的添加表单。
  // 需求16：官方直连置顶（anthropic → openai → 其余预置保持原序）——
  // 排序层实现，PROVIDER_PRESETS 数据序不动（被 claude-presets 等处引用）。
  const OFFICIAL_DIRECT_PRESET_IDS = ["anthropic", "openai"];
  const presetChannels = PROVIDER_PRESETS.filter((p) => p.id !== "custom")
    .sort(
      (a, b) =>
        (OFFICIAL_DIRECT_PRESET_IDS.indexOf(a.id) + 1 || 99) -
        (OFFICIAL_DIRECT_PRESET_IDS.indexOf(b.id) + 1 || 99),
    );
  const providerMatchedPresetId = (name: string): string | null =>
    matchPresetByBaseUrl(config.providers[name]?.baseUrl)?.id ?? null;

  const sidebarChannels: ChannelSidebarItem[] = [
    ...presetChannels.map((p): ChannelSidebarItem => {
      const matchedKey = providerNames.find((n) => providerMatchedPresetId(n) === p.id);
      return {
        id: `preset:${p.id}`,
        label: t(p.id_label),
        sub: p.baseUrl,
        active: matchedKey ? active?.provider === matchedKey : false,
        added: Boolean(matchedKey),
      };
    }),
    ...providerNames
      .filter((name) => !providerMatchedPresetId(name))
      .map((name): ChannelSidebarItem => {
        const p = config.providers[name];
        return {
          id: `provider:${name}`,
          label: (p?.name as string | undefined) || name,
          sub: p?.baseUrl || t("config.noBaseUrl"),
          active: active?.provider === name,
        };
      }),
  ];

  const sidebarSelectedId = providerForm
    ? providerForm.mode === "add" && providerForm.presetId && providerForm.presetId !== "custom"
      ? `preset:${providerForm.presetId}`
      : null
    : selectedProvider
      ? providerMatchedPresetId(selectedProvider)
        ? `preset:${providerMatchedPresetId(selectedProvider)}`
        : `provider:${selectedProvider}`
      : null;

  const handleSidebarSelect = (id: string) => {
    if (id.startsWith("preset:")) {
      const presetId = id.slice("preset:".length);
      const matchedKey = providerNames.find((n) => providerMatchedPresetId(n) === presetId);
      if (matchedKey) {
        selectProvider(matchedKey);
      } else {
        setSelectedProvider(null);
        setModelForm(null);
        setProviderForm({ mode: "add", presetId });
        setError(null);
      }
      return;
    }
    if (id.startsWith("provider:")) {
      selectProvider(id.slice("provider:".length));
    }
  };

  return (
    <div className="space-y-4">
      {confirmDialogNode}
      {/* v0.7.6 需求3：统一两栏——左 ChannelSidebar（预置渠道默认全量显示
          + 自定义渠道 + 底部添加按钮），右「模型设置」（当前模型大卡 +
          添加表单/模型表单/渠道详情）。 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        {/* 左：渠道列表（统一侧栏） */}
        <ChannelSidebar
          loading={loading}
          channels={sidebarChannels}
          selectedId={sidebarSelectedId}
          onSelect={handleSidebarSelect}
          onAddCustom={() => {
            setSelectedProvider(null);
            setModelForm(null);
            setProviderForm({ mode: "add", presetId: "custom" });
            setError(null);
          }}
        />

        {/* 右：模型设置（当前模型 + 渠道配置 + 模型列表） */}
        <div className="space-y-3">
          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
          <div className="text-xs font-medium text-muted-foreground">
            {t("config.colModels")}
          </div>
          <ActiveModelCard
            current={currentActiveOption}
            options={activeModelOptions}
            onSelect={(value) => {
              const sep = value.indexOf("/");
              if (sep <= 0) return;
              void setActiveFromPicker(value.slice(0, sep), value.slice(sep + 1));
            }}
            emptyHint={t("config.noModelConfigured")}
            // 需求16：不再传 emptyActionLabel/onEmptyAction——右侧无「添加接入」，渠道统一在左栏。
          />

          {providerForm ? (
            <ProviderForm
              // key 强制在「表单打开状态下切换到另一预置渠道」时重建表单
              //（否则组件实例保留首次挂载的预设 state，第二次切换不生效——
              // v0.7.6 需求3 测试期迭代二）。
              key={
                providerForm.mode === "add"
                  ? providerForm.presetId ?? "custom"
                  : `edit:${providerForm.name}`
              }
              existingName={null}
              existingProvider={undefined}
              existingProviderKeys={providerNames}
              initialPresetId={providerForm.mode === "add" ? providerForm.presetId : undefined}
              saving={saving}
              onCancel={() => setProviderForm(null)}
              onSubmit={submitProvider}
              registerSave={registerFormSave}
            />
          ) : modelForm ? (
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
              registerSave={registerFormSave}
            />
          ) : selectedProvider && config.providers[selectedProvider] ? (
            <ProviderDetailPanel
              name={selectedProvider}
              provider={config.providers[selectedProvider]}
              models={config.providers[selectedProvider].models ?? []}
              isActive={active?.provider === selectedProvider}
              activeModelId={
                active?.provider === selectedProvider ? active.model : null
              }
              onEnableProvider={() => {
                // v0.7.6 需求3 迭代三：启用渠道 = 激活该渠道第一个模型
                //（切换渠道的明确操作方式；后续可在模型列表改选其他模型）。
                const first = config.providers[selectedProvider]?.models?.[0]?.id;
                if (first) void setActiveFromPicker(selectedProvider, first);
              }}
              onDeleteProvider={() => deleteProvider(selectedProvider)}
              onSaveProvider={(next) => saveProviderFields(selectedProvider, next)}
              registerSave={registerDetailSave}
              onDirtyChange={setDetailDirty}
              onAddModel={() => startAddModel(selectedProvider)}
              onEditModel={(modelId) => startEditModel(selectedProvider, modelId)}
              onDeleteModel={(modelId) => deleteModel(selectedProvider, modelId)}
              onSetActive={(modelId) =>
                void setActiveFromPicker(selectedProvider, modelId)
              }
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("config.channelSelectHint")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const apiSelectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const API_OPTIONS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
];

/**
 * R8：选中渠道的配置卡 + 模型列表，与 claude 模型设置页的渠道卡同构——
 * 字段行内直接编辑（显示名 / API 地址 / 协议 / 密钥眼睛切换 + 保存按钮 /
 * 「当前使用」徽标），保存即时写入 models.json；不再经 ProviderForm 弹层。
 */
function ProviderDetailPanel({
  name,
  provider,
  models,
  isActive,
  activeModelId,
  onEnableProvider,
  onDeleteProvider,
  onSaveProvider,
  /** 需求16 续三：保存上抛页头（dirty 时注册提交函数）。 */
  registerSave,
  onDirtyChange,
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
  /** 启用此渠道（激活该渠道第一个模型；v0.7.6 需求3 迭代三）。 */
  onEnableProvider: () => void;
  onDeleteProvider: () => void;
  onSaveProvider: (next: PiProviderConfig) => Promise<void>;
  registerSave?: (fn: (() => void) | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onAddModel: () => void;
  onEditModel: (modelId: string) => void;
  onDeleteModel: (modelId: string) => void;
  onSetActive: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  // 行内编辑草稿：渠道切换（name 变化）时重置为已保存值。
  const [displayName, setDisplayName] = useState((provider.name as string) ?? "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [api, setApi] = useState(provider.api ?? "anthropic-messages");
  const [authHeader, setAuthHeader] = useState(provider.authHeader ?? false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});

  useEffect(() => {
    setDisplayName((provider.name as string) ?? "");
    setBaseUrl(provider.baseUrl ?? "");
    setApi(provider.api ?? "anthropic-messages");
    setAuthHeader(provider.authHeader ?? false);
    setApiKey("");
    // 仅在切换渠道时重置；保存后的新值经 provider 属性回流。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const savedKey = (provider.apiKey as string) ?? "";
  const dirty =
    displayName !== ((provider.name as string) ?? "") ||
    baseUrl !== (provider.baseUrl ?? "") ||
    api !== (provider.api ?? "anthropic-messages") ||
    authHeader !== (provider.authHeader ?? false) ||
    apiKey.trim() !== "";

  // 需求16 续三：dirty 上抛 + 提交函数注册到页头（保存统一右上角）。
  useEffect(() => {
    onDirtyChange?.(dirty);
    registerSave?.(dirty ? () => void save() : null);
    return () => {
      onDirtyChange?.(false);
      registerSave?.(null);
    };
  });

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const next: PiProviderConfig = {
        ...provider,
        name: displayName || undefined,
        baseUrl: baseUrl || undefined,
        api,
        authHeader,
      };
      if (apiKey.trim()) next.apiKey = apiKey.trim();
      await onSaveProvider(next);
      setApiKey("");
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (modelId: string) => {
    if (testingId) return;
    setTestingId(modelId);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    try {
      const result = await invokeCommand<{ response?: string | null; usage?: unknown }>("test_model", { provider: name, id: modelId });
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
    <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
      {/* 头部：名称 + 当前使用徽标 + 删除 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{displayName || name}</span>
          {displayName && displayName !== name && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">({name})</span>
          )}
          {provider.authHeader && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {t("config.authHeaderBadge")}
            </span>
          )}
          {isActive ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
              <Check className="h-3 w-3" />
              {t("config.channelActive")}
            </span>
          ) : (
            models.length > 0 && (
              <Button
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={onEnableProvider}
              >
                <Power className="mr-1 h-3 w-3" />
                {t("config.channelEnable")}
              </Button>
            )
          )}
        </div>
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

      {/* 行内字段（claude 渠道卡同构） */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`ch-name-${name}`}>{t("config.displayName")}</Label>
          <Input
            id={`ch-name-${name}`}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("config.presetDisplayNamePlaceholder")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ch-url-${name}`}>{t("config.baseUrl")}</Label>
          <Input
            id={`ch-url-${name}`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://..."
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ch-api-${name}`}>{t("config.apiProtocol")}</Label>
          <select
            id={`ch-api-${name}`}
            value={api}
            onChange={(e) => setApi(e.target.value)}
            className={apiSelectClass}
          >
            {API_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ch-key-${name}`}>{t("config.apiKey")}</Label>
          <div className="flex gap-2">
            <Input
              id={`ch-key-${name}`}
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                savedKey
                  ? `${t("config.channelKeySaved")} ••••${savedKey.slice(-4)}`
                  : t("config.apiKeyPlaceholder")
              }
              autoComplete="off"
            />
            <Button
              variant="outline"
              size="icon"
              className="shrink-0"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? t("config.hideKey") : t("config.showKey")}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          {savedKey && !apiKey.trim() && (
            <p className="text-[10px] text-muted-foreground/70">
              {t("config.channelKeySaved")}
              {savedKey.length > 8 ? `：••••${savedKey.slice(-4)}` : ""}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("config.authHeader")}</Label>
          <p className="text-[10px] text-muted-foreground">{t("config.authHeaderHint")}</p>
        </div>
        <Switch checked={authHeader} onCheckedChange={setAuthHeader} />
      </div>

      {/* 需求16 续三：保存统一在页面右上角页头（registerSave 上抛）。 */}
      {dirty && (
        <p className="text-right text-[10px] text-muted-foreground/70">
          {t("config.channelDirtyHint")}
        </p>
      )}

      {/* 模型列表 */}
      <div className="space-y-1.5 border-t border-border/40 pt-3">
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
          <p className="px-1 text-[10px] text-muted-foreground/70">
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
                    isCurrent ? "border-primary/60 bg-primary/10" : "border-border/30",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs truncate">{m.id}</span>
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
                      {isCurrent ? <Check className="h-3 w-3" /> : <Power className="h-3 w-3" />}
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
                      {testResults[m.id].ok ? "\u2713 " : "\u2717 "}
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
