// v0.7.4 R12：opencode 自定义模型供应商管理块。
// v0.7.6 需求3 迭代：统一为 ChannelSidebar 布局——左栏内置渠道预置
//（models.dev provider id，复用 opencode 原有渠道）+ 自定义渠道 + 底部
// 添加按钮；右栏渠道卡（预置 = 密钥 + 模型 chips + 启用；自定义 = 行内
// 编辑）。数据为 opencode.json 的 provider.<id> 段（name/npm/options/
// models，官方 schema），模型引用格式 `${provider}/${model}`；密钥经
// provider 段 options.apiKey 覆盖写入（内置 provider 无段也可引用 model）。
// 显隐由 ConfigSurface.supports_custom_providers 门控（§5）。

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, ExternalLink, Eye, EyeOff, Plus, Power, Save, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  OPENCODE_CHANNEL_PRESETS,
  OPENCODE_DEFAULT_PROVIDER_NPM,
} from "@/agents/config/presets/opencode-models";
import { ChannelSidebar, type ChannelSidebarItem } from "./channel-sidebar";

type ProviderObj = Record<string, unknown>;
type ModelObj = Record<string, unknown>;

function asObj(v: unknown): ProviderObj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as ProviderObj) : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const NEW_CHANNEL_ID = "__new";

export function OpencodeProvidersBlock({
  providers,
  model,
  modelCard,
  onChange,
}: {
  providers: Record<string, ProviderObj> | null;
  /** 当前模型（config.model，"provider/model" 格式；渠道激活判定） */
  model: string | null;
  /** 模型卡（由 ConfigModelsZone 组装传入——右栏顶部「模型设置」） */
  modelCard: ReactNode;
  onChange: (patch: { customProviders?: Record<string, ProviderObj>; model?: string | null }) => void;
}) {
  const { t } = useTranslation();
  const providersMap = providers ?? {};
  const activeProvider = model?.split("/")[0] || null;
  // 默认跟随激活渠道；未命中预置/自定义渠道时选中激活渠道本身（自定义）。
  const fallbackId =
    OPENCODE_CHANNEL_PRESETS.find((p) => p.id === activeProvider)?.id ??
    (activeProvider && providersMap[activeProvider] ? activeProvider : null);
  const [selectedId, setSelectedId] = useState<string | null>(fallbackId);
  const [newProviderId, setNewProviderId] = useState("");

  const customChannelIds = Object.keys(providersMap).filter(
    (id) => !OPENCODE_CHANNEL_PRESETS.some((p) => p.id === id),
  );

  const channels: ChannelSidebarItem[] = [
    ...OPENCODE_CHANNEL_PRESETS.map((p): ChannelSidebarItem => {
      const override = providersMap[p.id];
      return {
        id: p.id,
        label: t(p.labelKey),
        sub: str(asObj(override?.options).baseURL) || `opencode:${p.id}`,
        active: activeProvider === p.id,
        added: Boolean(override),
      };
    }),
    ...customChannelIds.map((id): ChannelSidebarItem => ({
      id,
      label: str(providersMap[id]?.name) || id,
      sub: str(asObj(providersMap[id]?.options).baseURL) || `opencode:${id}`,
      active: activeProvider === id,
    })),
  ];

  /** 密钥写入 provider 段（覆盖合并，保留未知键——opencode 官方 schema）。 */
  const setProviderApiKey = (id: string, key: string) => {
    const existing = providersMap[id] ?? {};
    onChange({
      customProviders: {
        ...providersMap,
        [id]: { ...existing, options: { ...asObj(existing.options), apiKey: key } },
      },
    });
  };

  const enableChannel = (id: string, modelId: string) => {
    if (modelId) onChange({ model: `${id}/${modelId}` });
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
      {/* 左：统一渠道侧栏（内置渠道预置 + 自定义渠道 + 添加按钮） */}
      <ChannelSidebar
        channels={channels}
        selectedId={selectedId === NEW_CHANNEL_ID ? null : selectedId}
        onSelect={setSelectedId}
        onAddCustom={() => setSelectedId(NEW_CHANNEL_ID)}
      />

      {/* 右：模型设置 + 渠道配置 */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground">{t("config.colModels")}</div>
        {modelCard}

        {selectedId === NEW_CHANNEL_ID ? (
          <AddProviderForm
            existingIds={Object.keys(providersMap)}
            newProviderId={newProviderId}
            setNewProviderId={setNewProviderId}
            onCreate={(id) => {
              onChange({
                customProviders: {
                  ...providersMap,
                  [id]: {
                    name: id,
                    npm: OPENCODE_DEFAULT_PROVIDER_NPM,
                    options: { baseURL: "", apiKey: "" },
                    models: {},
                  },
                },
              });
              setSelectedId(id);
            }}
          />
        ) : selectedId && OPENCODE_CHANNEL_PRESETS.some((p) => p.id === selectedId) ? (
          <PresetChannelCard
            presetId={selectedId}
            providers={providersMap}
            active={activeProvider === selectedId}
            model={model}
            onSetApiKey={(key) => setProviderApiKey(selectedId, key)}
            onEnable={enableChannel}
          />
        ) : selectedId && providersMap[selectedId] ? (
          <CustomChannelPanel
            id={selectedId}
            provider={providersMap[selectedId]}
            active={activeProvider === selectedId}
            model={model}
            onEnable={enableChannel}
            onDelete={() => {
              const next = { ...providersMap };
              delete next[selectedId];
              onChange({ customProviders: next });
              setSelectedId(null);
            }}
            onPatch={(patch) =>
              onChange({
                customProviders: {
                  ...providersMap,
                  [selectedId]: { ...providersMap[selectedId], ...patch },
                },
              })
            }
          />
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("config.channelSelectHint")}
          </p>
        )}
      </div>
    </div>
  );
}

/** 预置（内置）渠道卡：密钥 + 获取密钥外链 + 预置模型 chips + 启用。 */
function PresetChannelCard({
  presetId,
  providers,
  active,
  model,
  onSetApiKey,
  onEnable,
}: {
  presetId: string;
  providers: Record<string, ProviderObj>;
  active: boolean;
  model: string | null;
  onSetApiKey: (key: string) => void;
  onEnable: (id: string, modelId: string) => void;
}) {
  const { t } = useTranslation();
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const preset = OPENCODE_CHANNEL_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  const savedKey = str(asObj(providers[presetId]?.options).apiKey);
  const currentModel = active ? (model?.split("/")[1] ?? "") : "";

  return (
    <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{t(preset.labelKey)}</div>
        {active ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            <Check className="h-3 w-3" />
            {t("config.channelActive")}
          </span>
        ) : (
          <Button size="sm" className="h-7 text-xs" onClick={() => onEnable(preset.id, preset.models[0])}>
            <Power className="mr-1 h-3 w-3" />
            {t("config.channelEnable")}
          </Button>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor={`opencode-key-${preset.id}`}>{t("config.apiKey")}</Label>
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
        <div className="flex gap-2">
          <Input
            id={`opencode-key-${preset.id}`}
            type={showKey ? "text" : "password"}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={t("config.quickSetupKeyPlaceholder")}
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
          <Button
            size="sm"
            className="h-9 shrink-0"
            disabled={!keyDraft.trim()}
            onClick={() => {
              onSetApiKey(keyDraft.trim());
              setKeyDraft("");
            }}
          >
            {t("config.quickSetupApplyKey")}
          </Button>
        </div>
        {savedKey && (
          <p className="text-[10px] text-muted-foreground/70">
            {t("config.channelKeySaved")}
            {savedKey.length > 8 ? `：••••${savedKey.slice(-4)}` : ""}
          </p>
        )}
      </div>

      {/* 预置模型 chips：点击即启用该模型 */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{t("config.presetStepModels")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {preset.models.map((mid) => {
            const isCurrent = active && currentModel === mid;
            return (
              <button
                key={mid}
                type="button"
                onClick={() => onEnable(preset.id, mid)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                  isCurrent
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-border/40 text-muted-foreground hover:border-border",
                )}
              >
                {isCurrent && <Check className="h-3 w-3" />}
                {mid}
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        {t("config.channelSaveHint")}
      </p>
    </div>
  );
}

/** 自定义渠道详情（行内编辑，能力与旧版一致）+ 启用。 */
function CustomChannelPanel({
  id,
  provider,
  active,
  model,
  onEnable,
  onDelete,
  onPatch,
}: {
  id: string;
  provider: ProviderObj;
  active: boolean;
  model: string | null;
  onEnable: (id: string, modelId: string) => void;
  onDelete: () => void;
  onPatch: (patch: ProviderObj) => void;
}) {
  const { t } = useTranslation();
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [newModelId, setNewModelId] = useState("");

  const options = asObj(provider.options);
  const savedKey = str(options.apiKey);
  const models = asObj(provider.models);
  const modelEntries = Object.entries(models);
  const currentModel = active ? (model?.split("/")[1] ?? "") : "";

  const setModelField = (modelId: string, patch: ModelObj) => {
    onPatch({ models: { ...models, [modelId]: { ...asObj(models[modelId]), ...patch } } });
  };
  const removeModel = (modelId: string) => {
    const next = { ...models };
    delete next[modelId];
    onPatch({ models: next });
  };
  const addModel = () => {
    const mid = newModelId.trim();
    if (!mid || models[mid]) return;
    onPatch({ models: { ...models, [mid]: { name: mid } } });
    setNewModelId("");
  };

  return (
    <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{str(provider.name) || id}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">({id})</span>
          {active && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
              <Check className="h-3 w-3" />
              {t("config.channelActive")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!active && modelEntries.length > 0 && (
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => onEnable(id, modelEntries[0][0])}
            >
              <Power className="mr-1 h-3 w-3" />
              {t("config.channelEnable")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-red-400 hover:text-red-300"
            onClick={onDelete}
            title={t("common.delete")}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t("config.displayName")}</Label>
          <Input
            value={str(provider.name)}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder={id}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("config.baseUrl")}</Label>
          <Input
            value={str(options.baseURL)}
            onChange={(e) => onPatch({ options: { ...options, baseURL: e.target.value } })}
            placeholder="https://..."
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{t("config.apiKey")}</Label>
          <div className="flex gap-2">
            <Input
              type={showKey ? "text" : "password"}
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              placeholder={
                savedKey
                  ? `${t("config.channelKeySaved")} ••••${savedKey.slice(-4)}`
                  : "sk-..."
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
            <Button
              size="sm"
              className="h-9 shrink-0"
              disabled={!apiKeyDraft.trim()}
              onClick={() => {
                onPatch({ options: { ...options, apiKey: apiKeyDraft.trim() } });
                setApiKeyDraft("");
              }}
            >
              <Save className="h-3.5 w-3.5" />
              {t("config.quickSetupApplyKey")}
            </Button>
          </div>
        </div>
      </div>

      {/* 模型列表（行内编辑 + 设为当前） */}
      <div className="space-y-1.5 border-t border-border/40 pt-3">
        <Label className="text-[10px] text-muted-foreground/80">
          {t("config.models")} ({modelEntries.length})
        </Label>
        {modelEntries.length === 0 ? (
          <p className="px-1 text-[10px] text-muted-foreground/70">{t("config.noModelsHint")}</p>
        ) : (
          <ul className="space-y-1">
            {modelEntries.map(([mid, m]) => {
              const isCurrent = active && currentModel === mid;
              return (
                <li
                  key={mid}
                  className={cn(
                    "flex items-center gap-2 rounded border px-2 py-1.5",
                    isCurrent ? "border-primary/60 bg-primary/10" : "border-border/30",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <span className="truncate font-mono text-xs">{mid}</span>
                    <input
                      value={str(asObj(m).name)}
                      onChange={(e) => setModelField(mid, { name: e.target.value })}
                      placeholder={mid}
                      className="mt-0.5 w-full bg-transparent text-[11px] text-muted-foreground outline-none"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant={isCurrent ? "default" : "outline"}
                    className="h-6 text-xs"
                    onClick={() => onEnable(id, mid)}
                    title={t("config.setActive")}
                  >
                    {isCurrent ? <Check className="h-3 w-3" /> : <Power className="h-3 w-3" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-red-400 hover:text-red-300"
                    onClick={() => removeModel(mid)}
                    title={t("common.delete")}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Input
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            placeholder={t("config.modelId")}
            className="h-8 flex-1 font-mono text-xs"
            onKeyDown={(e) => e.key === "Enter" && addModel()}
          />
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={addModel}>
            <Plus className="mr-1 h-3 w-3" />
            {t("config.addModel")}
          </Button>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground/70">
          {t("config.customProvidersHint")}
        </p>
      </div>
    </div>
  );
}

/** 新建自定义渠道表单（v0.7.6 需求3：底部「添加自定义渠道」触发）。 */
function AddProviderForm({
  existingIds,
  newProviderId,
  setNewProviderId,
  onCreate,
}: {
  existingIds: string[];
  newProviderId: string;
  setNewProviderId: (v: string) => void;
  onCreate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const id = newProviderId.trim();
  const valid = id && !existingIds.includes(id);

  return (
    <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
      <div className="text-sm font-medium">{t("config.channelAddCustom")}</div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("config.customProvidersHint")}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="opencode-new-provider">{t("config.customProviderIdPlaceholder")}</Label>
        <Input
          id="opencode-new-provider"
          value={newProviderId}
          onChange={(e) => setNewProviderId(e.target.value)}
          className="font-mono text-xs"
          onKeyDown={(e) => e.key === "Enter" && valid && onCreate(id)}
          placeholder="my-provider"
        />
      </div>
      <Button size="sm" disabled={!valid} onClick={() => onCreate(id)}>
        <Plus className="mr-1 h-3 w-3" />
        {t("common.add")}
      </Button>
    </div>
  );
}
