// v0.7.4 R12：opencode 自定义模型供应商管理块（模型设置页，模型大卡下方）。
// 数据为 opencode.json 的 provider.<id> 段（name/npm/options{baseURL,apiKey}/
// models{<id>:{name,...}}，官方 schema）。编辑保留供应商对象上的未知键；
// 变更写入 structured 配置草稿的 customProviders（页头「保存」落盘）。
// 显隐由 ConfigSurface.supports_custom_providers 门控（§5，无 agentId 分支）。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Plus, Save, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { OPENCODE_DEFAULT_PROVIDER_NPM } from "@/agents/config/presets/opencode-models";

type ProviderObj = Record<string, unknown>;
type ModelObj = Record<string, unknown>;

function asObj(v: unknown): ProviderObj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as ProviderObj) : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function OpencodeProvidersBlock({
  providers,
  onChange,
}: {
  providers: Record<string, ProviderObj> | null;
  onChange: (providers: Record<string, ProviderObj>) => void;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(providers ?? {});
  const [selectedId, setSelectedId] = useState<string | null>(entries[0]?.[0] ?? null);
  const [newProviderId, setNewProviderId] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");

  // 选中项失效（删除）时回退到首个。
  useEffect(() => {
    const ids = Object.keys(providers ?? {});
    if (ids.length === 0) {
      setSelectedId(null);
    } else if (!selectedId || !ids.includes(selectedId)) {
      setSelectedId(ids[0]);
    }
  }, [providers, selectedId]);

  const selected = selectedId ? (providers?.[selectedId] ?? null) : null;

  const patchProvider = (id: string, patch: ProviderObj) => {
    const next = { ...(providers ?? {}) };
    next[id] = { ...(next[id] ?? {}), ...patch };
    onChange(next);
  };
  const removeProvider = (id: string) => {
    const next = { ...(providers ?? {}) };
    delete next[id];
    onChange(next);
  };

  const addProvider = () => {
    const id = newProviderId.trim();
    if (!id || (providers ?? {})[id]) return;
    const next = { ...(providers ?? {}) };
    next[id] = {
      name: id,
      npm: OPENCODE_DEFAULT_PROVIDER_NPM,
      options: { baseURL: "", apiKey: "" },
      models: {},
    };
    onChange(next);
    setSelectedId(id);
    setNewProviderId("");
  };

  const savedKey = str(asObj(selected?.options).apiKey);
  const models = asObj(selected?.models);
  const modelEntries = Object.entries(models);

  const patchOptions = (key: string, value: string) => {
    if (!selectedId) return;
    patchProvider(selectedId, {
      options: { ...asObj(selected?.options), [key]: value },
    });
  };
  const setModelField = (modelId: string, patch: ModelObj) => {
    if (!selectedId) return;
    patchProvider(selectedId, {
      models: { ...models, [modelId]: { ...asObj(models[modelId]), ...patch } },
    });
  };
  const removeModel = (modelId: string) => {
    if (!selectedId) return;
    const nextModels = { ...models };
    delete nextModels[modelId];
    patchProvider(selectedId, { models: nextModels });
  };
  const addModel = () => {
    const id = newModelId.trim();
    if (!id || !selectedId || models[id]) return;
    patchProvider(selectedId, {
      models: { ...models, [id]: { name: newModelName.trim() || id } },
    });
    setNewModelId("");
    setNewModelName("");
  };

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-muted-foreground">
        {t("config.customProvidersLabel")}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        {/* 左：供应商列表 */}
        <div className="space-y-2">
          <div className="space-y-1 rounded-lg border border-border/40 p-1.5">
            {entries.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] leading-relaxed text-muted-foreground/70">
                {t("config.customProvidersEmpty")}
              </p>
            ) : (
              entries.map(([id, p]) => {
                const options = asObj(p.options);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelectedId(id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-fast",
                      selectedId === id
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{str(p.name) || id}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                        {str(options.baseURL) || t("config.noBaseUrl")}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={newProviderId}
              onChange={(e) => setNewProviderId(e.target.value)}
              placeholder={t("config.customProviderIdPlaceholder")}
              className="h-8 font-mono text-xs"
              onKeyDown={(e) => e.key === "Enter" && addProvider()}
            />
            <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={addProvider}>
              <Plus className="mr-1 h-3 w-3" />
              {t("common.add")}
            </Button>
          </div>
        </div>

        {/* 右：选中供应商详情（行内编辑） */}
        {selectedId && selected ? (
          <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold">
                  {str(selected.name) || selectedId}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  ({selectedId})
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-red-400 hover:text-red-300"
                onClick={() => removeProvider(selectedId)}
                title={t("common.delete")}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("config.displayName")}</Label>
                <Input
                  value={str(selected.name)}
                  onChange={(e) => patchProvider(selectedId, { name: e.target.value })}
                  placeholder={selectedId}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("config.baseUrl")}</Label>
                <Input
                  value={str(asObj(selected.options).baseURL)}
                  onChange={(e) => patchOptions("baseURL", e.target.value)}
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
                      patchOptions("apiKey", apiKeyDraft.trim());
                      setApiKeyDraft("");
                    }}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {t("config.quickSetupApplyKey")}
                  </Button>
                </div>
              </div>
            </div>

            {/* 模型列表 */}
            <div className="space-y-1.5 border-t border-border/40 pt-3">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] text-muted-foreground/80">
                  {t("config.models")} ({modelEntries.length})
                </Label>
              </div>
              {modelEntries.length === 0 ? (
                <p className="px-1 text-[10px] text-muted-foreground/70">
                  {t("config.noModelsHint")}
                </p>
              ) : (
                <ul className="space-y-1">
                  {modelEntries.map(([mid, m]) => {
                    const modelObj = asObj(m);
                    return (
                    <li
                      key={mid}
                      className="flex items-center gap-2 rounded border border-border/30 px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-xs">{mid}</span>
                        </div>
                        <input
                          value={str(modelObj.name)}
                          onChange={(e) => setModelField(mid, { name: e.target.value })}
                          placeholder={mid}
                          className="mt-0.5 w-full bg-transparent text-[11px] text-muted-foreground outline-none"
                        />
                      </div>
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
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Input
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                  placeholder={t("config.modelId")}
                  className="h-8 min-w-[140px] flex-1 font-mono text-xs"
                  onKeyDown={(e) => e.key === "Enter" && addModel()}
                />
                <Input
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  placeholder={t("config.displayName")}
                  className="h-8 min-w-[120px] flex-1 text-xs"
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
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("config.customProvidersEmptyHint")}
          </p>
        )}
      </div>
    </div>
  );
}
