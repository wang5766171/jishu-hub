/**
 * 插件详情/编辑模态（v0.9.3 需求12 P1 返工：用户交互裁决——卡片上直接给
 * 「详情/编辑」按钮而非点卡片弹抽屉；弹层重做为大尺寸模态，参考 VS Code
 * 扩展详情页 + shadcn 大对话框形态）。
 *
 * 结构：头部（大图标/名称/徽章/启停开关 + id/版本/安装态）→ 双 tab
 * （有 configSchema 时）：「概览」（说明/挂载点/权限/元信息）与「设置」
 * （configSchema 自动表单，字号放宽 text-sm、行距充足、粘底保存栏）；
 * 无 schema 仅概览。详情按钮进概览 tab，编辑按钮直落设置 tab。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Loader2, Rocket, RotateCcw, Save, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AgentLogo } from "@/agents";
import { PluginIcon } from "@/components/ui/icon-picker";
import {
  diffAgainstDefaults,
  getPluginConfig,
  mergeConfig,
  setPluginConfig,
  type PluginConfigField,
  type PluginConfigValues,
} from "@/features/session-kernel/plugins/config-plane";
import { listSessionPlugins } from "@/features/session-kernel/plugins/registry";
import { resolveStages } from "@/features/session-kernel/capabilities/pipeline/contracts";
import { cn } from "@/lib/utils";

/** plugins-page 的描述符投影（避免循环依赖：仅取模态所需字段）。 */
export interface DrawerPluginInfo {
  id: string;
  display_name: string;
  kind: "builtin" | "manifest" | "tool" | "session";
  description?: string | null;
  version: string | null;
  system?: boolean;
  core?: boolean;
  has_mcp?: boolean;
  enabled: boolean;
}

type LeafField = Exclude<PluginConfigField, { type: "section" }>;

function flatten(schema: PluginConfigField[]): LeafField[] {
  const out: LeafField[] = [];
  for (const field of schema) {
    if (field.type === "section") out.push(...flatten(field.fields));
    else out.push(field);
  }
  return out;
}

/** 字段控件（text-sm 级、宽松可点区；number 步进/select/text/开关）。 */
function FieldControl({
  field,
  value,
  onChange,
}: {
  field: LeafField;
  value: PluginConfigValues[string] | undefined;
  onChange: (value: string | number | boolean) => void;
}) {
  switch (field.type) {
    case "switch":
      return (
        <Switch checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked)} />
      );
    case "number": {
      const num = typeof value === "number" ? value : field.default;
      const step = field.step ?? 1;
      return (
        <span className="inline-flex items-center gap-1.5">
          <button
            type="button"
            className="h-7 w-7 rounded-md border border-border/70 text-sm leading-none hover:bg-accent"
            onClick={() => onChange(Math.max(field.min ?? -Infinity, num - step))}
          >
            −
          </button>
          <input
            type="number"
            className="h-7 w-20 rounded-md border border-border/70 bg-transparent px-2 text-center text-sm tabular-nums outline-none focus:border-primary/60"
            value={num}
            min={field.min}
            max={field.max}
            step={step}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <button
            type="button"
            className="h-7 w-7 rounded-md border border-border/70 text-sm leading-none hover:bg-accent"
            onClick={() => onChange(Math.min(field.max ?? Infinity, num + step))}
          >
            +
          </button>
          {field.unit ? <span className="text-xs text-muted-foreground">{field.unit}</span> : null}
        </span>
      );
    }
    case "select":
      return (
        <select
          className="h-8 rounded-md border border-border/70 bg-transparent px-2 text-sm outline-none focus:border-primary/60"
          value={String(value ?? field.default)}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    case "text":
      return (
        <input
          type="text"
          className="h-8 w-64 rounded-md border border-border/70 bg-transparent px-2.5 text-sm outline-none focus:border-primary/60"
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          value={String(value ?? field.default)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "textarea":
      return (
        <textarea
          className="w-full rounded-md border border-border/70 bg-transparent p-2 text-sm outline-none focus:border-primary/60"
          rows={field.rows ?? 3}
          value={String(value ?? field.default)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return <span className="text-xs text-muted-foreground">P4</span>;
  }
}

function SettingsForm({
  schema,
  values,
  onChange,
}: {
  schema: PluginConfigField[];
  values: PluginConfigValues;
  onChange: (key: string, value: string | number | boolean) => void;
}) {
  return (
    <div className="divide-y divide-border/40">
      {schema.map((field, index) =>
        field.type === "section" ? (
          <section key={`sec-${index}`} className="py-3">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {field.label}
            </h4>
            {flatten([field]).map((leaf) => (
              <div key={leaf.key} className="flex items-center justify-between gap-6 border-b border-border/20 py-3 last:border-0">
                <div className="min-w-0">
                  <div className="text-sm text-foreground/90">{leaf.label}</div>
                  {leaf.description ? (
                    <div className="mt-0.5 max-w-md text-xs leading-relaxed text-muted-foreground/80">{leaf.description}</div>
                  ) : null}
                </div>
                <div className="shrink-0">
                  <FieldControl field={leaf} value={values[leaf.key]} onChange={(v) => onChange(leaf.key, v)} />
                </div>
              </div>
            ))}
          </section>
        ) : (
          <div key={field.key} className="flex items-center justify-between gap-6 py-3.5">
            <div className="min-w-0">
              <div className="text-sm text-foreground/90">{field.label}</div>
              {field.description ? (
                <div className="mt-0.5 max-w-md text-xs leading-relaxed text-muted-foreground/80">{field.description}</div>
              ) : null}
            </div>
            <div className="shrink-0">
              <FieldControl field={field} value={values[field.key]} onChange={(v) => onChange(field.key, v)} />
            </div>
          </div>
        ),
      )}
    </div>
  );
}

export function PluginDetailModal({
  plugin,
  initialTab = "info",
  onClose,
  onLaunchPipeline,
}: {
  plugin: DrawerPluginInfo;
  initialTab?: "info" | "settings";
  onClose: () => void;
  /** C4-slice2c：pipeline 型插件「作为任务启动」——跳会话页预填 /jishu-pipeline。 */
  onLaunchPipeline?: (pluginId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"info" | "settings">(initialTab);
  const [draft, setDraft] = useState<PluginConfigValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stored, setStored] = useState<PluginConfigValues>({});

  const sessionDescriptor = plugin.kind === "session"
    ? listSessionPlugins().find((p) => p.id === plugin.id)
    : null;
  const configSchema = sessionDescriptor?.configSchema;
  // v0.9.3 需求13 C4：pipeline 型插件——阶段流水线可视化（模板段带标记）。
  const pipelineStages = useMemo(
    () => (sessionDescriptor?.pipeline ? resolveStages(sessionDescriptor.pipeline) : null),
    [sessionDescriptor],
  );

  useEffect(() => {
    if (configSchema) setStored(getPluginConfig(plugin.id, configSchema));
  }, [plugin.id, configSchema]);

  const effective = useMemo(
    () => (configSchema ? mergeConfig(configSchema, diffOf(stored, configSchema)) : {}),
    [configSchema, stored],
  );
  const values = draft ?? effective;
  const dirty = useMemo(
    () =>
      configSchema
        ? JSON.stringify(diffAgainstDefaults(configSchema, values)) !==
          JSON.stringify(diffAgainstDefaults(configSchema, effective))
        : false,
    [configSchema, values, effective],
  );

  const save = useCallback(async () => {
    if (!configSchema) return;
    setSaving(true);
    try {
      await setPluginConfig(plugin.id, configSchema, values);
      // 保存后同步本地快照——否则草稿清空后 effective 仍按打开时的旧值计算，
      // 表单显示会回退（后端与消费组件实际已生效新值；用户实测 30%→弹回 50%）。
      setStored(values);
      setDraft(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [configSchema, plugin.id, values]);

  const resetDefaults = useCallback(async () => {
    if (!configSchema) return;
    setSaving(true);
    try {
      await setPluginConfig(plugin.id, configSchema, {});
      setDraft(null);
      setStored({});
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [configSchema, plugin.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !dirty) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dirty]);

  const description = plugin.kind === "session"
    ? sessionDescriptor?.descriptionFallback ?? plugin.display_name
    : plugin.description || t("plugins.descFallbackBuiltin", "内置智能体适配器");

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={() => !dirty && onClose()} />
      <div className="relative flex h-[min(80vh,760px)] w-[min(920px,94vw)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        {/* 头部：大图标 + 名称/徽章 + id/版本；右侧启停语义提示（启停开关在
            列表卡片上，模态内不重复——保持单一操作位）。 */}
        <div className="flex shrink-0 items-start gap-4 border-b border-border/50 px-6 py-4">
          {plugin.kind === "builtin" ? (
            <AgentLogo agentId={plugin.id} size={44} />
          ) : (
            <PluginIcon icon={undefined} size={44} />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold">{plugin.display_name}</span>
              {plugin.core ? <Badge className="px-1.5 py-0 text-[10px]">{t("plugins.coreBadge", "核心引擎")}</Badge> : null}
              {plugin.system ? (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {t("plugins.systemBadge", "系统")}
                </Badge>
              ) : null}
              {plugin.has_mcp ? (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {t("plugins.mcpBadge", "MCP")}
                </Badge>
              ) : null}
              {!plugin.enabled && !plugin.core ? (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                  {t("plugins.disabledBadge", "已禁用")}
                </Badge>
              ) : null}
            </div>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground/70">
              {plugin.id}
              {plugin.version ? ` · v${plugin.version}` : ""}
            </div>
          </div>
          <button
            type="button"
            title={t("common.close", "关闭")}
            onClick={() => !dirty && onClose()}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* tab 行（有配置面才有设置页签） */}
        {configSchema ? (
          <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-6">
            {(["info", "settings"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                  tab === key
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {key === "info"
                  ? t("plugins.modalTabInfo", "概览")
                  : t("plugins.modalTabSettings", "设置")}
              </button>
            ))}
          </div>
        ) : null}

        {/* 主体 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {tab === "settings" && configSchema ? (
            <>
              <SettingsForm
                schema={configSchema}
                values={values}
                onChange={(key, value) => setDraft((prev) => ({ ...(prev ?? effective), [key]: value }))}
              />
              {error ? (
                <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              ) : null}
            </>
          ) : (
            <div className="space-y-5">
              <p className="text-sm leading-relaxed text-foreground/85">{description}</p>
              {pipelineStages ? (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("plugins.modalPipelineStages", "阶段流水线")}
                    </h4>
                    {onLaunchPipeline ? (
                      <Button
                        size="sm"
                        onClick={() => onLaunchPipeline(plugin.id, plugin.display_name)}
                      >
                        <Rocket className="mr-1 h-3.5 w-3.5" />
                        {t("plugins.launchPipelineTask", "作为任务启动")}
                      </Button>
                    ) : null}
                  </div>
                  <ol className="space-y-1.5">
                    {pipelineStages.map((stage, index) => (
                      <li key={stage.key} className="flex items-start gap-2 rounded-lg border border-border/50 px-3 py-2">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary tabular-nums">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium">{stage.name}</span>
                            {stage.template ? (
                              <Badge variant="outline" className="px-1.5 py-0 text-[9px]">核心能力复用</Badge>
                            ) : null}
                            {stage.gate === "confirm" ? (
                              <Badge variant="secondary" className="px-1.5 py-0 text-[9px]">门禁确认</Badge>
                            ) : null}
                          </div>
                          {stage.prompt ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">{stage.prompt}</p> : null}
                          {stage.skills.length ? <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">skills: {stage.skills.join(", ")}</p> : null}
                          {stage.tools.length ? <p className="font-mono text-[10px] text-muted-foreground/60">tools: {stage.tools.join(", ")}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
              {sessionDescriptor ? (
                <>
                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("plugins.drawerMounts", "挂载点")}
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                      {sessionDescriptor.mounts.map((mount, i) => (
                        <Badge key={i} variant="outline" className="px-2 py-0.5 font-mono text-[10px]">
                          {mount.kind}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("plugins.drawerPermissions", "权限声明")}
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                      {sessionDescriptor.permissions.map((perm) => (
                        <Badge key={perm} variant="secondary" className="px-2 py-0.5 font-mono text-[10px]">
                          {perm}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
              <div className="rounded-lg bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                {t("plugins.modalEditableNote", "配置面将随插件化改造逐步开放——更多可编辑项见后续版本")}
              </div>
            </div>
          )}
        </div>

        {/* 粘底保存栏（设置页且有改动） */}
        {configSchema && tab === "settings" ? (
          <div className="flex shrink-0 items-center justify-between border-t border-border/50 px-6 py-3">
            <button
              type="button"
              onClick={() => void resetDefaults()}
              disabled={saving}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("plugins.drawerResetDefaults", "恢复默认")}
            </button>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setDraft(null)} disabled={!dirty || saving}>
                {t("common.cancel", "取消")}
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                <span className="ml-1.5">{t("common.save", "保存")}</span>
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** 已存值中相对 defaults 的差异（存储即差异语义的读取侧）。 */
function diffOf(stored: PluginConfigValues, schema: PluginConfigField[]): PluginConfigValues {
  const defaults = mergeConfig(schema, {});
  const user: PluginConfigValues = {};
  for (const [k, v] of Object.entries(stored)) {
    if (v !== defaults[k]) user[k] = v;
  }
  return user;
}
