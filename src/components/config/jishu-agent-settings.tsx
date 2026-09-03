// v0.7.5 行为与权限页补全：R15 死字段整改后仅剩 defaultThinkingLevel 一项，
// 设置项不完整。本块暴露 Pi Settings schema（settings-manager.ts）核查过的
// 行为相关真实字段：
//  - defaultThinkingLevel：全局默认思考档位
//  - compaction：{enabled, thresholdPercent} 全局默认压缩（v0.8.0 需求9：
//    阈值按窗口百分比，默认 90%；项目级 .pi/settings.json 深合并覆盖）
//    （项目级 .pi/settings.json 深合并覆盖）
//  - defaultTools：新会话初始激活的内置工具（全集 read/bash/edit/write/
//    grep/find/ls；未设置时 Pi 默认 read/bash/edit/write）。类型选择是
//    defaultTools 的前端预设（默认=自定义勾选；只读/全部=固定工具集），
//    落盘始终是这一个 Pi 原生字段——Pi 无 permission/bypassPermissions 配置
//  - retry：{enabled, maxRetries, baseDelayMs} 模型请求重试
// 历史死字段（permissions/temperature/maxTokens/thinkingEnabled/skipDangerous/
// verbose/maxTurns）Pi 不读取，不恢复；会话页的工具模式（完整/只读）是 Hub
// 侧会话时能力（spawn --tools 覆盖 defaultTools），与本页互不冲突。
// 保存为键级覆盖：null = 删除键恢复 Pi 默认（后端 merge_config_patch）。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { useAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RotateCcw } from "lucide-react";
import { SectionHelp } from "./section-help";

const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"] as readonly string[];
/** 只读预设（同 PiRpc readonly 模式白名单：全集去掉 bash/edit/write）。 */
const PI_READONLY_TOOLS = ["read", "grep", "find", "ls"] as readonly string[];
const PI_ALL_TOOLS = PI_BUILTIN_TOOLS as readonly string[];

/** defaultTools 预设类型（v0.7.5 需求1 迭代二）：类型只是前端预设，
 *  落盘始终是 Pi 原生的 defaultTools 单字段——default=自定义勾选，
 *  readonly/all=固定工具集（Pi 原生无 permission/bypassPermissions 配置）。 */
type ToolPresetType = "default" | "readonly" | "all";

/** Pi CompactionSettings 的可编辑子集；null = 未配置（用 Pi 默认）。 */
type Compaction = { enabled?: boolean; thresholdPercent?: number; keepRecentTokens?: number };
/** Pi RetrySettings 的可编辑子集；null = 未配置（用 Pi 默认）。 */
type Retry = { enabled?: boolean; maxRetries?: number; baseDelayMs?: number };

const jsonEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 数字输入 → 子字段：空串 = 不写该子键（沿用 Pi 默认）。 */
const numField = (raw: string): number | undefined => {
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

const sameToolSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && b.every((x) => a.includes(x));

/** 从落盘的 defaultTools 反推预设类型。 */
const deriveToolPreset = (tools: string[] | null): ToolPresetType => {
  if (tools && sameToolSet(tools, PI_READONLY_TOOLS)) return "readonly";
  if (tools && sameToolSet(tools, PI_ALL_TOOLS)) return "all";
  return "default";
};

export function JishuAgentSettingsBlock({
  agentConfig,
  onSaved,
  onSaveStateChange,
  registerSave,
}: {
  agentConfig: Record<string, unknown> | null;
  onSaved: () => void;
  /** v0.8.0 需求9 收尾：向宿主页头上报保存可用态（按钮渲染在 ConfigPageShell
      的 actionsSlot，与大标题同行）。 */
  onSaveStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
  /** 注册保存函数（宿主页头按钮调用）。 */
  registerSave?: (save: () => void) => void;
}) {
  const { t } = useTranslation();
  const { manageAgentId, manageAgent } = useAgent();
  // v0.8.0 需求3（B2-② 收敛）：档位全集来自 AgentStatus（adapter 声明），
  // 不再前端硬编码 PI_THINKING_LEVELS。
  const manageThinkingLevels = manageAgent?.thinking_levels ?? [
    "off", "minimal", "low", "medium", "high",
  ];
  const agentId = manageAgentId ?? "";

  const savedThinking =
    typeof agentConfig?.defaultThinkingLevel === "string"
      ? (agentConfig.defaultThinkingLevel as string)
      : "";
  const savedCompaction = (agentConfig?.compaction ?? null) as Compaction | null;
  const savedTools = (agentConfig?.defaultTools ?? null) as string[] | null;
  const savedRetry = (agentConfig?.retry ?? null) as Retry | null;

  const [thinking, setThinking] = useState(savedThinking);
  const [compaction, setCompaction] = useState<Compaction | null>(savedCompaction);
  const [tools, setTools] = useState<string[] | null>(savedTools);
  const [toolPreset, setToolPreset] = useState<ToolPresetType>(deriveToolPreset(savedTools));
  const [retry, setRetry] = useState<Retry | null>(savedRetry);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setThinking(savedThinking);
    setCompaction(savedCompaction);
    setTools(savedTools);
    setToolPreset(deriveToolPreset(savedTools));
    setRetry(savedRetry);
    // saved* 由 agentConfig 派生，依赖收敛到它即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentConfig]);

  // 预设类型联动落盘值：readonly/all 覆盖为固定工具集，default 才用自定义勾选。
  const toolsPayload =
    toolPreset === "readonly"
      ? [...PI_READONLY_TOOLS]
      : toolPreset === "all"
        ? [...PI_ALL_TOOLS]
        : tools;

  const dirty =
    thinking !== savedThinking ||
    !jsonEq(compaction, savedCompaction) ||
    !jsonEq(toolsPayload, savedTools) ||
    !jsonEq(retry, savedRetry);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      // 键级覆盖：4 个键全量提交，null = 删除键恢复 Pi 默认；
      // 未变化的键写入原值，后端合并后等价无操作。
        await invokeCommand("save_config", {
          agentId,
          config: {
            defaultThinkingLevel: thinking || null,
            compaction: compaction ?? null,
            defaultTools: toolsPayload ?? null,
            retry: retry ?? null,
          },
        });
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  // v0.8.0 需求9 收尾：保存按钮移至页头 actionsSlot——上报状态 + 注册保存。
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    onSaveStateChange?.({ dirty, saving });
  }, [dirty, saving, onSaveStateChange]);
  useEffect(() => {
    registerSave?.(() => void saveRef.current());
  }, [registerSave]);

  // 联动展示：预设类型决定勾选显示与可编辑性（readonly/all 固定不可勾选）。
  const displayTools =
    toolPreset === "readonly"
      ? PI_READONLY_TOOLS
      : toolPreset === "all"
        ? PI_ALL_TOOLS
        : (tools ?? PI_DEFAULT_TOOLS);
  const toolsEditable = toolPreset === "default";
  const toggleTool = (name: string, on: boolean) => {
    const next = on
      ? PI_BUILTIN_TOOLS.filter((t) => displayTools.includes(t) || t === name)
      : displayTools.filter((t) => t !== name);
    setTools(next);
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* 默认思考档位 */}
      <div className="space-y-1.5 sm:max-w-[280px]">
        <Label htmlFor="jishu-default-thinking">
          <span className="inline-flex items-center gap-0.5">
            {t("sessions.thinkingLevel.title")}
            <SectionHelp content={t("config.defaultThinkingLevelHelp")} />
          </span>
        </Label>
        <select
          id="jishu-default-thinking"
          value={manageThinkingLevels.includes(thinking) ? thinking : ""}
          onChange={(e) => setThinking(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">{t("sessions.thinkingLevel.unset")}</option>
          {manageThinkingLevels.map((lvl) => (
            <option key={lvl} value={lvl}>
              {t(`sessions.thinkingLevel.${lvl}`)}
            </option>
          ))}
        </select>
      </div>

      {/* 上下文压缩 */}
      <div className="space-y-2.5 rounded-md border border-border/40 bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="inline-flex items-center gap-0.5">
            {t("config.compactionTitle")}
            <SectionHelp content={t("config.compactionHelp")} />
          </Label>
          {compaction !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => setCompaction(null)}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {t("config.resetToDefault")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm">{t("projectConfig.compactionEnabled")}</span>
          <Switch
            checked={compaction?.enabled !== false}
            onCheckedChange={(checked) =>
              setCompaction({
                enabled: checked,
                thresholdPercent: compaction?.thresholdPercent,
                keepRecentTokens: compaction?.keepRecentTokens,
              })
            }
          />
        </div>
        {/* v0.8.0 需求9：阈值按窗口百分比（默认 90%）替代绝对 reserveTokens；
            保留近期 token（默认 20000）为压缩执行参数——切割点后的近期内容
            按此预算原文保留，之前的历史被摘要。两项说明经标题旁问号查看。 */}
        <div className="flex flex-wrap gap-3">
          <div className="w-36 space-y-1">
            <Label className="inline-flex items-center gap-0.5 truncate text-xs">
              {t("projectConfig.compactionThreshold")}
              <SectionHelp content={t("projectConfig.compactionThresholdHelp")} />
            </Label>
            <div className="relative">
              <Input
                className="h-8 pr-7 text-sm"
                type="number"
                min={1}
                max={99}
                placeholder="90"
                value={compaction?.thresholdPercent ?? ""}
                onChange={(e) =>
                  setCompaction({
                    enabled: compaction?.enabled,
                    keepRecentTokens: compaction?.keepRecentTokens,
                    thresholdPercent: numField(e.target.value),
                  })
                }
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
            </div>
          </div>
          <div className="w-36 space-y-1">
            <Label className="inline-flex items-center gap-0.5 truncate text-xs">
              {t("projectConfig.compactionKeepRecent")}
              <SectionHelp content={t("projectConfig.compactionKeepRecentHelp")} />
            </Label>
            <Input
              className="h-8 text-sm"
              type="number"
              min={0}
              placeholder="20000"
              value={compaction?.keepRecentTokens ?? ""}
              onChange={(e) =>
                setCompaction({
                  enabled: compaction?.enabled,
                  thresholdPercent: compaction?.thresholdPercent,
                  keepRecentTokens: numField(e.target.value),
                })
              }
            />
          </div>
        </div>
      </div>

      {/* 初始工具集 */}
      <div className="space-y-2.5 rounded-md border border-border/40 bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="inline-flex items-center gap-0.5">
            {t("config.defaultToolsTitle")}
            <SectionHelp content={t("config.defaultToolsHelp")} />
          </Label>
          {toolsEditable && tools !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => setTools(null)}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {t("config.resetToDefault")}
            </Button>
          )}
        </div>
        <div className="space-y-1.5 sm:max-w-[280px]">
          <Label htmlFor="jishu-tool-preset" className="text-xs">
            {t("config.toolPresetType")}
          </Label>
          <select
            id="jishu-tool-preset"
            value={toolPreset}
            onChange={(e) => setToolPreset(e.target.value as ToolPresetType)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="default">{t("config.toolPresetDefault")}</option>
            <option value="readonly">{t("config.toolPresetReadonly")}</option>
            <option value="all">{t("config.toolPresetAll")}</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          {PI_BUILTIN_TOOLS.map((name) => (
            <label
              key={name}
              className={`inline-flex items-center gap-1.5 ${toolsEditable ? "" : "opacity-70"}`}
            >
              <input
                type="checkbox"
                className="h-3 w-3"
                disabled={!toolsEditable}
                checked={displayTools.includes(name)}
                onChange={(e) => toggleTool(name, e.target.checked)}
              />
              {t(`config.tools.${name}`)}
            </label>
          ))}
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground/70">
          {toolPreset === "readonly"
            ? t("config.toolPresetReadonlyHint")
            : toolPreset === "all"
              ? t("config.toolPresetAllHint")
              : tools === null
                ? t("config.defaultToolsUnsetHint")
                : t("config.defaultToolsCustomHint")}
        </p>
      </div>

      {/* 请求重试 */}
      <div className="space-y-2.5 rounded-md border border-border/40 bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="inline-flex items-center gap-0.5">
            {t("config.retryTitle")}
            <SectionHelp content={t("config.retryHelp")} />
          </Label>
          {retry !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => setRetry(null)}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {t("config.resetToDefault")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm">{t("config.retryEnabled")}</span>
          <Switch
            checked={retry?.enabled !== false}
            onCheckedChange={(checked) =>
              setRetry({
                enabled: checked,
                maxRetries: retry?.maxRetries,
                baseDelayMs: retry?.baseDelayMs,
              })
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="truncate text-xs">{t("config.retryMaxRetries")}</Label>
            <Input
              className="h-8 text-sm"
              type="number"
              min={0}
              placeholder="3"
              value={retry?.maxRetries ?? ""}
              onChange={(e) =>
                setRetry({
                  enabled: retry?.enabled,
                  baseDelayMs: retry?.baseDelayMs,
                  maxRetries: numField(e.target.value),
                })
              }
            />
          </div>
          <div className="space-y-1">
            <Label className="truncate text-xs">{t("config.retryBaseDelay")}</Label>
            <Input
              className="h-8 text-sm"
              type="number"
              min={0}
              placeholder="2000"
              value={retry?.baseDelayMs ?? ""}
              onChange={(e) =>
                setRetry({
                  enabled: retry?.enabled,
                  maxRetries: retry?.maxRetries,
                  baseDelayMs: numField(e.target.value),
                })
              }
            />
          </div>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground/70">
          {t("config.retryDefaultHint")}
        </p>
      </div>
    </div>
  );
}
