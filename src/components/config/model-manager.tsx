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
  RefreshCw,
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
// v0.9.2 需求9：探测落库返回形状（与 Rust channel_models_store/channel_probe 对齐）。
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

import { probedModelToEntry } from "./provider-form";
import { byVersionDesc } from "./model-sort";
import { ModelForm } from "./model-form";
import { ActiveModelCard } from "./active-model-card";
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
  // R6 两栏结构：左渠道列表，右选中渠道详情。
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  // 骨架 provider 键集合（点击未添加预设建立的本地草稿，未写盘）。
  const [skeletonKeys, setSkeletonKeys] = useState<Set<string>>(new Set());

  // 需求16 续三：保存统一页头——当前活动保存入口（ProviderForm/ModelForm
  // 经各自 registerSave 上抛；渠道详情经 detailSaveRef）。聚合后转抛页头。
  const detailSaveRef = useRef<(() => void) | null>(null);
  const [detailDirty, setDetailDirty] = useState(false);
  const registerDetailSave = useCallback(
    (fn: (() => void) | null) => {
      detailSaveRef.current = fn;
      registerSave?.(fn);
    },
    [registerSave],
  );
  useEffect(() => {
    onSaveStateChange?.({
      dirty: detailDirty,
      saving,
    });
  }, [detailDirty, saving, onSaveStateChange]);


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
    // 补丁十：落盘即转正——骨架键已在 next.providers 里即已写盘。
    setSkeletonKeys((prev) => {
      if (prev.size === 0) return prev;
      const nextSet = new Set(prev);
      for (const k of prev) {
        if (next.providers[k]) nextSet.delete(k);
      }
      return nextSet;
    });
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
  const deleteProvider = async (name: string) => {
    const confirmed = await confirmDialog({
      title: t("config.title"),
      description: t("config.deleteProviderConfirm", {
        name: (config.providers[name]?.name as string | undefined) || name,
      }),
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

  // 补丁二十五修复：取消激活写 null——原实现借道
  // setActiveFromPicker(provider, "")，把 {provider, model: ""} 脏状态
  // 写进 settings.json 的 active（会话页读到空 model 语义不明）。
  const unsetActive = async () => {
    try {
      await invokeCommand("set_active", { agentId, active: null });
    } catch (e) {
      setError(String(e));
      return;
    }
    setActive(null);
    onActiveModelChange?.(null);
    onChanged?.();
  };

  // 补丁二十六（用户裁决）：当前模型改为**只读静态卡**——v0.9.2 需求9 的
  // 渠道内行级激活取代跨渠道下拉切换，但全局「当前激活的是哪个模型」仍需
  // 一眼可见（切到别的渠道时详情面板看不到激活行）。无下拉箭头、不可点。
  const activeDisplay = active
    ? {
        value: `${active.provider}/${active.model}`,
        label: active.model,
        hint:
          (config.providers[active.provider]?.name as string | undefined) ||
          active.provider,
      }
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
      const matchedKey = providerNames.find(
        (n) => providerMatchedPresetId(n) === p.id && !skeletonKeys.has(n),
      );
      return {
        id: `preset:${p.id}`,
        label: t(p.id_label),
        sub: p.baseUrl,
        active: matchedKey ? active?.provider === matchedKey : false,
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
          /* 补丁十五：自定义渠道行可删（hover ×）——预设=内置能力不删。 */
          onRemove: () => void deleteProvider(name),
        };
      }),
  ];

  const sidebarSelectedId = selectedProvider
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
        // v0.9.2 需求9 补丁八（用户裁决：激活前后页面一致，参考 codex）：
        // 未添加预设不再展开 ProviderForm（旧激活前表单），直接建**本地骨架**
        // provider 进 ProviderDetailPanel——与激活后同面板；首字段保存/模型
        // 落库时随 persistConfig 一并写盘，离开不保存则骨架不落盘。
        const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
        if (preset) {
          if (skeletonKeys.has(presetId)) {
            // 骨架已在（上次点击建的本地草稿）——仅选中，不重建防丢编辑。
            setSelectedProvider(presetId);
            setError(null);
            return;
          }
          setConfig((prev) => ({
            providers: {
              ...prev.providers,
              [presetId]: {
                name: t(preset.id_label),
                baseUrl: preset.baseUrl,
                api: preset.api,
              },
            },
          }));
          setSkeletonKeys((prev) => new Set(prev).add(presetId));
          setSelectedProvider(presetId);
          setError(null);
        }
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
          onRemoveChannel={(id) => {
            if (!id.startsWith("provider:")) return;
            void deleteProvider(id.slice("provider:".length));
          }}
          onAddCustom={() => {
            /* 补丁十七（用户裁决：新增自定义渠道与已有渠道展示一致）：
               不再展开 ProviderForm，直接建本地骨架 provider（唯一键）进
               ProviderDetailPanel——与已有渠道完全同款；首次字段保存随
               persistConfig 落盘，不保存切走不落盘。 */
            let key = `custom-${Date.now().toString(36).slice(-5)}`;
            while (config.providers[key]) {
              key = `custom-${Date.now().toString(36).slice(-5)}-${Math.floor(Math.random() * 90 + 10)}`;
            }
            setConfig((prev) => ({
              providers: { ...prev.providers, [key]: { api: "openai-completions" } },
            }));
            setSkeletonKeys((prev) => new Set(prev).add(key));
            setSelectedProvider(key);
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
          <ActiveModelCard current={activeDisplay} readOnly />

          {selectedProvider && config.providers[selectedProvider] ? (
            <ProviderDetailPanel
              agentId={agentId}
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
              onSaveProvider={(next) => saveProviderFields(selectedProvider, next)}
              registerSave={registerDetailSave}
              onDirtyChange={setDetailDirty}
              onDeleteModel={(modelId) => deleteModel(selectedProvider, modelId)}
              onSetActive={(modelId) =>
                void setActiveFromPicker(selectedProvider, modelId)
              }
              onUnsetActive={() => void unsetActive()}
              onAddProbedModel={(modelId) => {
                // 探测-only 模型点击 = 完整合法条目落配置并设为当前（详情
                // 面板随后可编辑 ctx/maxTokens 等参数）。
                const entry = probedModelToEntry(modelId);
                const p = config.providers[selectedProvider];
                const next: PiProviderConfig = {
                  ...p,
                  models: [...(p?.models ?? []).filter((m) => m.id !== modelId), entry],
                };
                void saveProviderFields(selectedProvider, next);
                void setActiveFromPicker(selectedProvider, modelId);
              }}
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
  agentId,
  name,
  provider,
  models,
  isActive,
  activeModelId,
  onEnableProvider,
  onSaveProvider,
  /** 需求16 续三：保存上抛页头（dirty 时注册提交函数）。 */
  registerSave,
  onDirtyChange,
  onDeleteModel,
  onSetActive,
  onUnsetActive,
  onAddProbedModel,
}: {
  /** v0.9.2 需求9：探测落库作用域（管理作用域 agent）。 */
  agentId: string;
  name: string;
  provider: PiProviderConfig;
  models: PiModelEntry[];
  isActive: boolean;
  activeModelId: string | null;
  /** 启用此渠道（激活该渠道第一个模型；v0.7.6 需求3 迭代三）。 */
  onEnableProvider: () => void;
  onSaveProvider: (next: PiProviderConfig) => Promise<void>;
  registerSave?: (fn: (() => void) | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onDeleteModel: (modelId: string) => void;
  onSetActive: (modelId: string) => void;
  /** 取消激活（当前模型再点激活钮）。 */
  onUnsetActive: () => void;
  /** v0.9.2 需求9：点击探测-only 模型 = 直接添加为渠道模型并设为当前。 */
  onAddProbedModel: (modelId: string) => void;
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
  const [keyMissing, setKeyMissing] = useState(false);

  // v0.9.2 需求9 补丁四（用户裁决：激活后添加模型 = 激活前同交互）——
  // 「添加模型」不再替换右列整页，而是在模型列表下方**内嵌展开** ModelForm
  //（与激活前 ProviderForm 同组件同形态）；页头保存 = 提交暂存 chip（可删、
  // 可继续添加），再次页头保存 = 渠道字段 + 暂存模型一并落库。编辑同位内嵌。
  const [inlineAddOpen, setInlineAddOpen] = useState(false);
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);

  // v0.9.2 需求9（用户裁决）：第三方渠道按渠道**探测**模型列表——首次自动
  // 查（配置密钥后），结果**落库**（~/.jishu-hub/channel-models.db，跨重启）；
  // 手动刷新更新；无接口（探测 unsupported）→ 静态预设列表现状、无刷新钮；
  // 未填密钥 → 列表空 + 引导文案。
  const savedKeyInitial = ((provider.apiKey as string) ?? "").trim();
  const [probedModels, setProbedModels] = useState<string[] | null>(null);
  // v0.9.2 需求9 补丁二十五：自建模型 origin 追踪——共用库记录表单保存的
  // id（探测行点击/addProbedModel 落库不记）。此前按预设静态表判定，
  // 跨渠道模型（deepseek 上的 glm-4.5）恒误判自建 → 误显删除钮。
  const [userAddedIds, setUserAddedIds] = useState<Set<string>>(new Set());
  const [probing, setProbing] = useState(false);
  const [probeState, setProbeState] = useState<"none" | "unsupported" | "failed" | "ok">("none");
  const channelKey = `${agentId}::${name}`;

  // 读已落库列表（进详情页即展示；探测写入后重读）。
  useEffect(() => {
    let cancelled = false;
    invokeCommand<StoredChannelModels | null>("channel_models_stored", {
      agentId,
      channelKey,
    })
      .then((stored) => {
        if (!cancelled && stored?.models?.length) setProbedModels(stored.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentId, channelKey]);

  const probeNow = useCallback(
    async (keyOverride?: string) => {
      const key = (keyOverride ?? (provider.apiKey as string) ?? "").trim();
      if (!baseUrl.trim() || !key) return;
      setProbing(true);
      try {
        const probe = await invokeCommand<ChannelModelsProbe>("channel_models_probe_and_store", {
          agentId,
          channelKey,
          baseUrl: baseUrl.trim(),
          apiKey: key,
        });
        if (probe.supported) {
          setProbedModels(probe.models);
          setProbeState("ok");
        } else {
          setProbeState("unsupported");
        }
      } catch {
        setProbeState("failed");
      } finally {
        setProbing(false);
      }
    },
    [agentId, baseUrl, channelKey, provider.apiKey],
  );

  // 首查：渠道已配置密钥（落库配置）且无已存列表 → 首次进详情自动探测。
  const autoProbeKey = `${agentId}::${name}::${savedKeyInitial ? "y" : "n"}`;
  useEffect(() => {
    if (!savedKeyInitial) return;
    let cancelled = false;
    invokeCommand<StoredChannelModels | null>("channel_models_stored", {
      agentId,
      channelKey,
    })
      .then((stored) => {
        if (!cancelled && !stored) void probeNow();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoProbeKey]);

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
    // v0.9.2 需求9（用户裁决）：不填密钥点击保存 → 密钥位红警示（阻断保存）。
    if (!savedKey && !apiKey.trim()) {
      setKeyMissing(true);
      return;
    }
    setKeyMissing(false);
    setSaving(true);
    try {
      const next: PiProviderConfig = {
        ...provider,
        name: displayName || undefined,
        baseUrl: baseUrl || undefined,
        api,
        authHeader,
        models,
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

  // v0.9.2 需求9：已配置模型 ∪ 探测落库模型（同 id 去重；探测-only 弱化）。
  const mergedModels: Array<{
    model: PiModelEntry;
    probeOnly: boolean;
    /** 已落库且非预设种子 = 用户自建模型：可删除。 */
    userAdded?: boolean;
  }> = (() => {
    const configuredIds = new Set(models.map((m) => m.id));
    const merged = models.map((model) => ({
      model,
      probeOnly: false,
      /* 补丁二十五：自建 = origin 库有记录（表单保存过），与预设表无关。 */
      userAdded: userAddedIds.has(model.id),
    }));
    for (const id of probedModels ?? []) {
      if (!configuredIds.has(id)) {
        merged.push({
          model: { id } as PiModelEntry,
          probeOnly: true,
          userAdded: false,
        });
      }
    }
    // v0.9.2 需求9 补丁九：版本号倒序（最新在前）。
    merged.sort((a, b) => byVersionDesc(a.model.id, b.model.id));
    return merged;
  })();

  const addProbedModel = (id: string) => {
    onAddProbedModel(id);
  };

  const originKey = `jishu-models:${name}`;
  useEffect(() => {
    let cancelled = false;
    invokeCommand<string[] | null>("channel_custom_models_get", { agentId, channelKey: originKey })
      .then((ids) => {
        if (!cancelled) setUserAddedIds(new Set(ids ?? []));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentId, originKey]);

  const trackUserAdded = (modelId: string) => {
    setUserAddedIds((prev) => {
      const next = new Set(prev);
      next.add(modelId);
      void invokeCommand("channel_custom_models_set", {
        agentId,
        channelKey: originKey,
        models: Array.from(next),
      }).catch(console.warn);
      return next;
    });
  };
  const untrackUserAdded = (modelId: string) => {
    setUserAddedIds((prev) => {
      const next = new Set(prev);
      next.delete(modelId);
      void invokeCommand("channel_custom_models_set", {
        agentId,
        channelKey: originKey,
        models: Array.from(next),
      }).catch(console.warn);
      return next;
    });
  };

  // v0.9.2 需求9 补丁五（用户裁决）：编辑在哪条下面展开、新增在列表顶做
  // 「待新增」行——行尾只显示一个保存按钮，其余行自然下移。激活前后一致。
  const renderInlineForm = (context: "add" | string) => {
    if (context === "add" && !inlineAddOpen) return null;
    if (context !== "add" && inlineEditId !== context) return null;
    return (
      <ModelForm
        key={context === "add" ? "add" : `edit:${context}`}
        providerName={name}
        existingModel={
          context === "add"
            ? undefined
            : mergedModels.find((r) => r.model.id === context)?.model
        }
        saving={saving}
        localSave
        onCancel={() => {
          setInlineAddOpen(false);
          setInlineEditId(null);
        }}
        onSubmit={({ model }) => {
          if (context !== "add") {
            const inModels = models.some((m) => m.id === context);
            const next: PiProviderConfig = {
              ...provider,
              name: displayName || undefined,
              baseUrl: baseUrl || undefined,
              api,
              authHeader,
              models: inModels
                ? models.map((m) => (m.id === context ? model : m))
                : [...models, model],
            };
            if (apiKey.trim()) next.apiKey = apiKey.trim();
            void onSaveProvider(next).then(() => {
              setApiKey("");
              setInlineEditId(null);
            });
          } else {
            // v0.9.2 需求9 补丁六（用户裁决）：添加时同 id 已存在 = **更新**
            // 该模型参数，不再产生重复条目（同 id 双条目会同时命中激活态）。
            const existingIdx = models.findIndex((m) => m.id === model.id);
            if (existingIdx >= 0) {
              const next: PiProviderConfig = {
                ...provider,
                name: displayName || undefined,
                baseUrl: baseUrl || undefined,
                api,
                authHeader,
                models: models.map((m) => (m.id === model.id ? model : m)),
              };
              if (apiKey.trim()) next.apiKey = apiKey.trim();
              void onSaveProvider(next).then(() => setApiKey(""));
            } else {
              /* 补丁二十四：内嵌表单保存 = 即时落库（含渠道字段草稿）。
                 补丁二十五：新 id 记入 origin 库（自建标记）。 */
              const next: PiProviderConfig = {
                ...provider,
                name: displayName || undefined,
                baseUrl: baseUrl || undefined,
                api,
                authHeader,
                models: models.some((x) => x.id === model.id)
                  ? models.map((x) => (x.id === model.id ? model : x))
                  : [...models, model],
              };
              if (apiKey.trim()) next.apiKey = apiKey.trim();
              trackUserAdded(model.id);
              void onSaveProvider(next).then(() => setApiKey(""));
            }
            setInlineAddOpen(false);
          }
        }}
      />
    );
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
        </div>
        {/* 补丁十四（用户裁决）：启用按钮/当前使用徽章移到右侧（原删除按钮位）；
            渠道级删除按钮移除——激活=当前使用，切换即换，删除无意义。 */}
        {isActive ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            <Check className="h-3 w-3" />
            {t("config.channelActive")}
          </span>
        ) : (
          <Button
            size="sm"
            className="h-7 shrink-0 text-xs"
            disabled={models.length === 0 && (probedModels?.length ?? 0) === 0}
            title={
              models.length === 0 && (probedModels?.length ?? 0) === 0
                ? t("config.noModelsHint")
                : undefined
            }
            onClick={() => {
              if (models.length > 0) {
                onEnableProvider();
                return;
              }
              const first = probedModels?.[0];
              if (first) {
                void addProbedModel(first);
              }
            }}
          >
            <Power className="mr-1 h-3 w-3" />
            {t("config.channelEnable")}
          </Button>
        )}
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
              onChange={(e) => {
                setApiKey(e.target.value);
                if (e.target.value.trim()) setKeyMissing(false);
              }}
              placeholder={
                savedKey
                  ? `${t("config.channelKeySaved")} ••••${savedKey.slice(-4)}`
                  : t("config.apiKeyPlaceholder")
              }
              autoComplete="off"
              className={cn(
                keyMissing && "border-red-500/60 focus-visible:ring-red-500/40",
              )}
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
          <Input
            id={`ch-key-red-${name}`}
            type="password"
            value={keyMissing ? " " : ""}
            readOnly
            hidden
            aria-hidden
          />
          {keyMissing ? (
            <p className="text-[10px] text-red-500">{t("config.keyRequired")}</p>
          ) : savedKey && !apiKey.trim() ? (
            <p className="text-[10px] text-muted-foreground/70">
              {t("config.channelKeySaved")}
              {savedKey.length > 8 ? `：••••${savedKey.slice(-4)}` : ""}
            </p>
          ) : null}
          {probeState === "unsupported" && (
            <p className="text-[10px] text-muted-foreground/60">{t("config.probeUnsupported")}</p>
          )}
          {probeState === "failed" && (
            <p className="text-[10px] text-amber-500">{t("config.probeFailed")}</p>
          )}
          {!savedKey && !apiKey.trim() && probeState !== "unsupported" && (
            <p className="text-[10px] text-muted-foreground/60">{t("config.probeNoKey")}</p>
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

      {/* 模型列表。v0.9.2 需求9：探测列表（落库持久）与已配置列表合并——
          探测出的未配置模型以弱化样式呈现（点击直接添加为该渠道模型并激活）。 */}
      <div className="space-y-1.5 border-t border-border/40 pt-3">
        <div className="flex items-center justify-between">
          <Label className="text-[10px] text-muted-foreground/80">
            {t("config.models")} ({mergedModels.length})
          </Label>
          <div className="flex items-center gap-1.5">
            {probedModels !== null && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                disabled={probing}
                onClick={() => void probeNow((apiKey.trim() || undefined) as unknown as string)}
              >
                {probing ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3 w-3" />
                )}
                {t("config.refresh")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs bg-primary/10 hover:bg-primary/20 text-primary border-transparent"
              onClick={() => {
                setInlineAddOpen((v) => !v);
                setInlineEditId(null);
              }}
            >
              <Plus className="h-3 w-3 mr-1" />
              {t("config.addModel")}
            </Button>
          </div>
        </div>

        {renderInlineForm("add")}
        {mergedModels.length === 0 && !inlineAddOpen ? (
          <p className="px-1 text-[10px] text-muted-foreground/70">
            {savedKeyInitial
              ? t("config.noModelsHint")
              : t("config.probeNoKey")}
          </p>
        ) : (
          <ul className="space-y-1">
            {mergedModels.map((entry) => {
              const m = entry.model;
              const probeOnly = entry.probeOnly;
              const userAdded = entry.userAdded ?? false;
              const isCurrent = activeModelId === m.id;
              return (
                <li
                  key={m.id}
                  className={cn(
                    "rounded border px-2 py-1.5 space-y-1",
                    isCurrent
                      ? "border-primary/60 bg-primary/10"
                      : probeOnly
                        ? "border-dashed border-border/50 opacity-80"
                        : "border-border/30",
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
                    {inlineEditId === m.id || inlineAddOpen ? null : (
                      <>
                        <Button
                          size="sm"
                          variant={isCurrent ? "default" : "outline"}
                          className="h-6 text-xs"
                          /* 补丁十一：probe-only 激活 = 落配置+设当前（addProbedModel）；
                              已配置行走原 setActive。 */
                          /* 补丁二十五（用户裁决）：激活按钮 toggle——当前模型再点取消激活。 */
                          onClick={() => {
                            if (probeOnly) {
                              addProbedModel(m.id);
                            } else if (isCurrent) {
                              onUnsetActive();
                            } else {
                              onSetActive(m.id);
                            }
                          }}
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
                          onClick={() => {
                            setInlineEditId(m.id);
                            setInlineAddOpen(false);
                          }}
                          title={t("config.editModel")}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        {userAdded && (
                          /* 补丁二十五：删除仅自建（origin 库标记）——同时移除标记。 */
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-red-400 hover:text-red-300"
                            onClick={() => {
                              untrackUserAdded(m.id);
                              onDeleteModel(m.id);
                            }}
                            title={t("common.delete")}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </>
                    )}
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
                  {/* 补丁五：编辑表单展开在目标行下方 */}
                  {renderInlineForm(m.id)}
                </li>
              );
            })}
          </ul>
        )}

      </div>
    </div>
  );
}
