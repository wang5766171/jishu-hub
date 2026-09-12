// v0.9.2 需求9 补丁七返工（用户裁决：第三方渠道前端**完全一致**，各 agent 只在
// 保存时适配）：三 agent（claude/codex/opencode）渠道详情面板共享本组件，
// 交互与 jishu ProviderDetailPanel 一致——
//   字段行内编辑（写草稿，页头统一保存，无单独密钥按钮）+ 密钥空警示 +
//   探测模型列表（首查+刷新+落库）∪ 手动配置模型（channel_custom_models）+
//   probe-only 虚线行点击落配置 + 行内 设为当前/联调测试/编辑/删除 +
//   添加模型（列表顶内嵌 ModelForm：模板下拉 + [取消][保存]）。
//
// 适配器契约（各 agent 注入）：
//   onPatchFields  字段变更写草稿（baseUrl/协议/密钥——保存走页头）
//   onEnable       启用渠道（写激活渠道 + 默认模型）
//   onSelectModel  设为当前模型（含渠道激活）
//   onTest         联调测试（agent 各自的 test 命令封装）
// 保存语义：字段=草稿（页头）；模型=立即持久化（channel_custom_models 共用库）。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Eye, EyeOff, Loader2, Pencil, Plus, Power, RefreshCw, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { invokeCommand } from "@/hooks/use-invoke";
import { ModelForm } from "./model-form";
import { byVersionDesc } from "./model-sort";
import type { PiModelEntry } from "./model-types";

/** 面向三 agent 的渠道字段形状（jishu 走自身 ProviderDetailPanel）。 */
export interface ThirdPartyChannelFields {
  /** 显示名（自定义渠道可编辑；预置渠道传 undefined 隐藏）。 */
  displayName?: string;
  baseUrl: string;
  /** 协议（codex wire_api / claude 固定 / opencode 无）；undefined = 隐藏。 */
  protocol?: string;
  apiKey: string;
  /** 已保存密钥（草稿/agent 配置里的明文，探测与测试用）。 */
  savedApiKey: string;
  protocolOptions?: Array<{ value: string; label: string }>;
}

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

export interface ThirdPartyModelRow {
  model: PiModelEntry;
  probeOnly: boolean;
}

export function ThirdPartyChannelPanel({
  agentId,
  channelKey,
  title,
  isActive,
  fields,
  presetModels,
  activeModelId,
  onPatchFields,
  displayNameEditable,
  onEnable,
  onSelectModel,
  onTest,
}: {
  agentId: string;
  channelKey: string;
  title: string;
  isActive: boolean;
  fields: ThirdPartyChannelFields;
  /** 名称是否可编辑（claude env 无名可存——false 渲染只读）。 */
  displayNameEditable?: boolean;
  /** 预设静态模型（探测失败回退 + 并集底座）。 */
  presetModels: string[];
  activeModelId: string | null | undefined;
  onPatchFields: (patch: Partial<ThirdPartyChannelFields>) => void;
  onEnable: () => void;
  onSelectModel: (modelId: string) => void;
  onTest: (modelId: string) => Promise<{ ok: boolean; text: string }>;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(fields.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(fields.baseUrl);
  const [protocol, setProtocol] = useState(fields.protocol ?? "");
  const [apiKey, setApiKey] = useState(fields.apiKey);
  const [showKey, setShowKey] = useState(false);
  const [keyMissing, setKeyMissing] = useState(false);

  // 渠道切换（channelKey 变化）重置草稿。
  useEffect(() => {
    setDisplayName(fields.displayName ?? "");
    setBaseUrl(fields.baseUrl);
    setProtocol(fields.protocol ?? "");
    setApiKey(fields.apiKey);
    setKeyMissing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey]);

  // ── 字段保存（页头统一，本面板无单独保存钮——与 jishu 一致）：
  //    字段写草稿经 onPatchFields（父级映射到 agent 配置），dirty 提示。
  const dirty =
    displayName !== (fields.displayName ?? "") ||
    baseUrl !== fields.baseUrl ||
    protocol !== (fields.protocol ?? "") ||
    apiKey.trim() !== fields.apiKey.trim();
  useEffect(() => {
    if (!dirty) return;
    onPatchFields({
      ...(displayName !== (fields.displayName ?? "") ? { displayName } : {}),
      ...(baseUrl !== fields.baseUrl ? { baseUrl } : {}),
      ...(protocol !== (fields.protocol ?? "") ? { protocol } : {}),
      ...(apiKey.trim() !== fields.apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, baseUrl, protocol, apiKey]);

  // ── 探测模型列表（首查+刷新+落库；与 jishu 同语义：成功才写库/标记）──
  const savedKey = fields.savedApiKey.trim() || apiKey.trim();
  const keyReady = Boolean(savedKey);
  const [probed, setProbed] = useState<string[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!keyReady || !baseUrl) return;
    let cancelled = false;
    invokeCommand<StoredChannelModels | null>("channel_models_stored", {
      agentId,
      channelKey,
    })
      .then((s) => {
        if (!cancelled && s?.models?.length) setProbed(s.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentId, channelKey, keyReady, baseUrl]);

  const probe = useCallback(
    async (key: string) => {
      if (!baseUrl || !key) return;
      setProbing(true);
      try {
        const result = await invokeCommand<ChannelModelsProbe>(
          "channel_models_probe_and_store",
          { agentId, channelKey, baseUrl, apiKey: key },
        );
        if (result.supported) {
          setProbed(result.models);
          setUnsupported(false);
        } else {
          setUnsupported(true);
        }
      } catch {
        setUnsupported(true);
      } finally {
        setProbing(false);
      }
    },
    [agentId, channelKey, baseUrl],
  );

  // 首查：密钥可用且无落库 → 自动一次。
  const gate = `${agentId}|${channelKey}|${keyReady}|${baseUrl}`;
  const [attempted, setAttempted] = useState<string | null>(null);
  useEffect(() => {
    if (!keyReady || !baseUrl || attempted === gate) return;
    setAttempted(gate);
    if (probed?.length) return;
    void probe(savedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, probed?.length]);

  // ── 手动配置模型（channel_custom_models 共用库，立即持久化）──
  const [customModels, setCustomModels] = useState<PiModelEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    invokeCommand<PiModelEntry[] | null>("channel_custom_models_get", {
      agentId,
      channelKey,
    })
      .then((m) => {
        if (!cancelled) setCustomModels(m ?? []);
      })
      .catch(() => setCustomModels([]));
    return () => {
      cancelled = true;
    };
  }, [agentId, channelKey]);

  const persistCustom = useCallback(
    (next: PiModelEntry[]) => {
      setCustomModels(next);
      void invokeCommand("channel_custom_models_set", {
        agentId,
        channelKey,
        models: next,
      }).catch(console.warn);
    },
    [agentId, channelKey],
  );

  // 合并列表：手动配置 ∪ 探测落库（同 id 手动优先）∪ 预设回退。
  const rows: ThirdPartyModelRow[] = (() => {
    const byId = new Map<string, ThirdPartyModelRow>();
    for (const mid of presetModels) byId.set(mid, { model: { id: mid }, probeOnly: false });
    for (const mid of probed ?? []) byId.set(mid, { model: { id: mid }, probeOnly: byId.has(mid) ? byId.get(mid)!.probeOnly : true });
    for (const m of customModels) byId.set(m.id, { model: m, probeOnly: false });
    // v0.9.2 需求9 补丁九：版本号倒序（最新在前）。
    return Array.from(byId.values()).sort((a, b) => byVersionDesc(a.model.id, b.model.id));
  })();

  // ── 行内添加/编辑（与 jishu 同：新增列表顶 / 编辑行下，[取消][保存]）──
  const [inlineAddOpen, setInlineAddOpen] = useState(false);
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);

  const commitAdd = (model: PiModelEntry) => {
    // 同 id = 更新（用户裁决）；probe-only id 落配置后不再是 probe-only。
    const exists = rows.some((r) => r.model.id === model.id);
    if (exists) {
      // 更新手动配置条目（若原为预设/探测行，则新增覆盖条目进 custom）。
      const inCustom = customModels.some((m) => m.id === model.id);
      persistCustom(
        inCustom
          ? customModels.map((m) => (m.id === model.id ? model : m))
          : [...customModels, model],
      );
    } else {
      persistCustom([...customModels, model]);
    }
    setInlineAddOpen(false);
  };

  const commitEdit = (model: PiModelEntry, previousId: string) => {
    const inCustom = customModels.some((m) => m.id === previousId);
    persistCustom(
      inCustom
        ? customModels.map((m) => (m.id === previousId ? model : m))
        : [...customModels.filter((m) => m.id !== model.id), model],
    );
    setInlineEditId(null);
  };

  const removeCustom = (modelId: string) => {
    persistCustom(customModels.filter((m) => m.id !== modelId));
  };

  // ── 联调测试 ──
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const runTest = async (modelId: string) => {
    if (testingId) return;
    if (!savedKey) {
      setKeyMissing(true);
      return;
    }
    setTestingId(modelId);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    try {
      const r = await onTest(modelId);
      setTestResults((prev) => ({ ...prev, [modelId]: r }));
    } finally {
      setTestingId(null);
    }
  };

  const selectModel = (modelId: string) => {
    if (!savedKey) {
      setKeyMissing(true);
      return;
    }
    setKeyMissing(false);
    onSelectModel(modelId);
  };

  const enable = () => {
    if (!savedKey) {
      setKeyMissing(true);
      return;
    }
    setKeyMissing(false);
    onEnable();
  };

  const renderInlineForm = (context: "add" | string) => {
    if (context === "add" && !inlineAddOpen) return null;
    if (context !== "add" && inlineEditId !== context) return null;
    return (
      <ModelForm
        key={context === "add" ? "add" : `edit:${context}`}
        providerName={title}
        existingModel={context === "add" ? undefined : rows.find((r) => r.model.id === context)?.model}
        saving={false}
        localSave
        onCancel={() => {
          setInlineAddOpen(false);
          setInlineEditId(null);
        }}
        onSubmit={({ model }) => {
          if (context === "add") commitAdd(model);
          else commitEdit(model, context);
        }}
      />
    );
  };

  const protocolSelectClass =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm";

  return (
    <div className="space-y-3 rounded-md border border-border/40 bg-muted/20 p-4">
      {/* 头部：标题 + 启用/激活徽标 */}
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-sm font-semibold">{title}</div>
        {isActive ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            <Check className="h-3 w-3" />
            {t("config.channelActive")}
          </span>
        ) : (
          <Button size="sm" className="h-7 shrink-0 text-xs" onClick={enable}>
            <Power className="mr-1 h-3 w-3" />
            {t("config.channelEnable")}
          </Button>
        )}
      </div>

      {/* 字段行内编辑（草稿，页头统一保存） */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {fields.displayName !== undefined && (
          <div className="space-y-1.5">
            <Label>{t("config.displayName")}</Label>
            {displayNameEditable === false ? (
              <code className="block truncate rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground">
                {displayName}
              </code>
            ) : (
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            )}
          </div>
        )}
        <div className="space-y-1.5">
          <Label>{t("config.baseUrl")}</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        {fields.protocolOptions && fields.protocolOptions.length > 0 && (
          <div className="space-y-1.5">
            <Label>{t("config.apiProtocol")}</Label>
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              className={protocolSelectClass}
            >
              {fields.protocolOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="space-y-1.5">
          <Label>{t("config.apiKey")}</Label>
          <div className="flex gap-2">
            <Input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (e.target.value.trim()) setKeyMissing(false);
              }}
              placeholder={
                fields.savedApiKey
                  ? `${t("config.channelKeySaved")} ••••${fields.savedApiKey.slice(-4)}`
                  : t("config.apiKeyPlaceholder")
              }
              autoComplete="off"
              className={cn(keyMissing && "border-red-500/60 focus-visible:ring-red-500/40")}
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
          {keyMissing ? (
            <p className="text-[10px] text-red-500">{t("config.keyRequired")}</p>
          ) : fields.savedApiKey && !apiKey.trim() ? (
            <p className="text-[10px] text-muted-foreground/70">
              {t("config.channelKeySaved")}
              {fields.savedApiKey.length > 8 ? `：••••${fields.savedApiKey.slice(-4)}` : ""}
            </p>
          ) : !apiKey.trim() ? (
            <p className="text-[10px] text-muted-foreground/60">{t("config.probeNoKey")}</p>
          ) : null}
          {unsupported && (
            <p className="text-[10px] text-muted-foreground/60">{t("config.probeUnsupported")}</p>
          )}
        </div>
      </div>

      {dirty && (
        <p className="text-right text-[10px] text-muted-foreground/70">
          {t("config.channelDirtyHint")}
        </p>
      )}

      {/* 模型列表（与 jishu ProviderDetailPanel 同构） */}
      <div className="space-y-1.5 border-t border-border/40 pt-3">
        <div className="flex items-center justify-between">
          <Label className="text-[10px] text-muted-foreground/80">
            {t("config.models")} ({rows.length})
          </Label>
          <div className="flex items-center gap-1.5">
            {(probed?.length || !unsupported) && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                disabled={probing}
                onClick={() => void probe(savedKey)}
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

        {rows.length === 0 && !inlineAddOpen ? (
          <p className="px-1 text-[10px] text-muted-foreground/70">
            {keyReady
              ? probing
                ? t("common.loading")
                : t("config.noModelsHint")
              : t("config.probeNoKey")}
          </p>
        ) : (
          <ul className="space-y-1">
            {rows.map(({ model: m, probeOnly }) => {
              const isCurrent = activeModelId === m.id;
              return (
                <li key={m.id}>
                  <div
                    className={cn(
                      "space-y-1 rounded border px-2 py-1.5",
                      isCurrent
                        ? "border-primary/60 bg-primary/10"
                        : probeOnly
                          ? "border-dashed border-border/50 opacity-80"
                          : "border-border/30",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                      {m.contextWindow ? (
                        <span className="text-[10px] text-muted-foreground/70">
                          {m.contextWindow >= 1000
                            ? `${Math.round(m.contextWindow / 1000)}K ctx`
                            : `${m.contextWindow} ctx`}
                        </span>
                      ) : null}
                      {inlineEditId === m.id ? null : (
                        <>
                          <Button
                            size="sm"
                            variant={isCurrent ? "default" : "outline"}
                            className="h-6 text-xs"
                            /* 补丁十一：probe-only 激活 = 落配置（custom 库）+ 设当前；
                                已配置行走 selectModel。 */
                            onClick={() => {
                              if (probeOnly) {
                                commitAdd({ id: m.id, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) });
                              }
                              selectModel(m.id);
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
                          {customModels.some((x) => x.id === m.id) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-red-400 hover:text-red-300"
                              onClick={() => removeCustom(m.id)}
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
                          "break-all rounded px-2 py-1 font-mono text-[10px]",
                          testResults[m.id].ok
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "bg-red-500/10 text-red-400",
                        )}
                        title={testResults[m.id].text}
                      >
                        {testResults[m.id].ok ? "✓ " : "✗ "}
                        {testResults[m.id].text}
                      </div>
                    )}
                  </div>
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
