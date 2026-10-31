import { useEffect, useMemo, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";
import { Bot, FileJson, FolderOpen, Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type PluginType,
  type McpServerEntry,
  type FormState,
  parseMcpServerJson,
  parseMcpServersBatch,
  parseMcpHeaders,
  serverToMcpSection,
  parseEnvLines,
  mcpNameToId,
  buildManifest,
  parseManifest,
} from "./plugin-create-dialog-model";
import { templates, PLUGIN_TYPES } from "./plugin-create-dialog-templates";
import { IconPicker } from "@/components/ui/icon-picker";

/** v0.8.1 需求6：插件创建可视化界面——模版快速创建（claude/codex/opencode
 * 形态预填）+ 分组表单 + 字段级能力说明。提交走 plugin_create（后端全量
 * schema 校验 + serde 生成 TOML，前端零拼 TOML）。
 * v0.9.0 需求1 二期：MCP 区表单/JSON 双模式 + stdio/HTTP/SSE 三传输 +
 * 解析器（mcp-resolver）开关联动（参考 Claude Desktop 界面）。
 * v0.9.0 需求19：类型优先重构——pluginType（MCP/CLI/AGENT，用户心智三分
 * + 两种实现形式）为纯前端概念，映射 wire kind（mcp/cli→tool，agent→agent）；
 * 选中类型后下方只渲染该类型分组（渐进式披露）。 */

/** v0.9.5 收口遗留②（god-component 第一刀）：模型层（纯函数/类型）与
 * 静态数据层（模版/类型卡）已迁出至 plugin-create-dialog-model.ts 与
 * plugin-create-dialog-templates.tsx（零逻辑纯移动）；本文件保留对话框
 * 组件本体（2400→1439 行）。
 * 第二刀预案（§12，触发条件：下版触碰本文件的需求实施前先执行）：
 * 五类型专属表单分组（MCP 双模式区/CLI 传输区/SKILL 条目区/CUSTOM
 * 面板区/AGENT 区）各自组件化为 <XxxSection form={} patch={} />——
 * 表单态保持单源（FormState 留本组件，分区只收 props 不自持 state），
 * 边界 = 按 PLUGIN_TYPES 分组注释切分，预计再迁出 ~500 行。 */

interface CreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  /** 编辑模式（v0.8.1 GUI 反馈：新增插件无法编辑）：传入插件 id 时对话框
   * 预填其 manifest，id 锁定，提交走 plugin_update 覆盖写回。 */
  editPluginId?: string | null;
  /** MCP 解析器（mcp-resolver 系统插件）启用态（v0.9.0 需求1 二期）：
   * 关闭时 MCP 区不可添加（提示先启用）；编辑既有 MCP 插件不受限。 */
  mcpResolverEnabled?: boolean;
  /** Skill 解析器（skill-resolver 系统插件）启用态（v0.9.0 需求20）：
   * 关闭时 SKILL 区不可添加（提示先启用）；编辑既有 skill 插件不受限。 */
  skillResolverEnabled?: boolean;
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-snug text-muted-foreground mt-1">{children}</p>;
}

function Labeled({
  labelKey,
  fallback,
  children,
  help,
}: {
  labelKey: string;
  fallback: string;
  children: React.ReactNode;
  help?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const label = t(labelKey) === labelKey ? fallback : t(labelKey);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {help && <FieldHelp>{help}</FieldHelp>}
    </div>
  );
}

export function PluginCreateDialog({
  open,
  onOpenChange,
  onCreated,
  editPluginId,
  mcpResolverEnabled = true,
  skillResolverEnabled = true,
}: CreateProps) {
  const { t } = useTranslation();
  const { alert: alertDialog, dialogNode } = useConfirmDialog();
  const [templateKey, setTemplateKey] = useState("blank");
  const [form, setForm] = useState<FormState>(templates[0].form);
  /** M4：编辑时表单不可表达的段（[pi_extension]），提交时原文透传。 */
  const [preservedSections, setPreservedSections] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = !!editPluginId;

  // 编辑模式：打开时拉取现有 manifest 预填（失败则表单保持原样并提示）。
  useEffect(() => {
    if (!open || !editPluginId) return;
    setError(null);
    invokeCommand<Record<string, unknown>>("plugin_get", { pluginId: editPluginId })
      .then((json) => {
        if (json) {
          const parsed = parseManifest(json);
          setForm(parsed.form);
          setPreservedSections(parsed.preserved);
        }
      })
      .catch((err) => setError(String(err)));
  }, [open, editPluginId]);

  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const template = useMemo(
    () => templates.find((tp) => tp.key === templateKey) ?? templates[0],
    [templateKey],
  );

  const pickTemplate = (key: string) => {
    const tp = templates.find((x) => x.key === key);
    if (!tp) return;
    setTemplateKey(key);
    // M4：编辑模式点模板不再整体重置表单（会覆盖被锁定的 id，提交必然后端
    // 拒绝）——保留 id/display_name，只带模板的段默认值。
    setForm((prev) =>
      isEdit
        ? { ...tp.form, id: prev.id, displayName: prev.displayName }
        : { ...tp.form },
    );
    setError(null);
  };

  const patch = (partial: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...partial }));

  const pluginType = form.pluginType;
  const isTool = pluginType !== "agent";
  /** 解析器关闭且非编辑（既有 MCP 插件仍可编辑）→ MCP 区不可添加。 */
  const mcpLocked = pluginType === "mcp" && !mcpResolverEnabled && !isEdit;
  /** skill 解析器关闭且非编辑 → SKILL 区不可添加（需求20，同 MCP 语义）。 */
  const skillLocked = pluginType === "skill" && !skillResolverEnabled && !isEdit;

  // MCP 区行内校验（阻止提交 + 即时反馈）。
  const mcpJsonParsed = useMemo(
    () =>
      pluginType === "mcp" && form.mcpMode === "json" && form.mcpJson.trim()
        ? parseMcpServerJson(form.mcpJson)
        : null,
    [pluginType, form.mcpMode, form.mcpJson],
  );
  const mcpJsonError = mcpJsonParsed && !mcpJsonParsed.ok ? mcpJsonParsed.error : null;
  const mcpHeadersError = useMemo(() => {
    if (pluginType !== "mcp" || form.mcpMode !== "form" || form.mcpTransport === "stdio")
      return null;
    if (!form.mcpHeaders.trim()) return null;
    try {
      parseMcpHeaders(form.mcpHeaders);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [pluginType, form.mcpMode, form.mcpTransport, form.mcpHeaders]);

  // JSON 模式 name 键预填 id/显示名（仅新建且未填写时；插件 id 即 server 名
  // 的 slug 化——参考图「名称」字段的等价物）。
  useEffect(() => {
    if (!mcpJsonParsed?.ok || isEdit) return;
    if (form.id.trim() || form.displayName.trim()) return;
    patch({
      id: mcpNameToId(mcpJsonParsed.name),
      displayName: mcpJsonParsed.name,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpJsonParsed, isEdit]);

  /** 表单 | JSON 双向切换：表单 → JSON 按当前表单态生成草稿；JSON → 表单
   * 解析成功则回填分传输字段（失败保持表单原值，草稿保留在 JSON 文本）。 */
  const switchMcpMode = (mode: "form" | "json") => {
    if (mode === form.mcpMode) return;
    if (mode === "json") {
      const entry: McpServerEntry =
        form.mcpTransport === "stdio"
          ? {
              type: "stdio",
              command: form.mcpCommand.trim(),
              // args 恒展示（空为 []）——stdio 的参数位在 JSON 里可见可改
              //（GUI 反馈：表单切 JSON 时空参数不应整段消失）。
              args: form.mcpArgs.trim()
                ? form.mcpArgs.split(/\s+/).filter(Boolean)
                : [],
              ...(parseEnvLines(form.mcpEnv) ? { env: parseEnvLines(form.mcpEnv) } : {}),
            }
          : {
              type: form.mcpTransport,
              url: form.mcpUrl.trim(),
            };
      const name = form.id.trim() || "my-mcp-server";
      patch({
        mcpMode: "json",
        mcpJson: JSON.stringify({ [name]: entry }, null, 2),
      });
      return;
    }
    const parsed = form.mcpJson.trim() ? parseMcpServerJson(form.mcpJson) : null;
    if (parsed?.ok) {
      const s = parsed.server;
      patch({
        mcpMode: "form",
        mcpTransport: s.type,
        mcpCommand: s.command ?? form.mcpCommand,
        mcpArgs: s.args?.length ? s.args.join(" ") : form.mcpArgs,
        mcpEnv: s.env
          ? Object.entries(s.env)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n")
          : form.mcpEnv,
        mcpUrl: s.url ?? form.mcpUrl,
        mcpHeaders: s.headers ? JSON.stringify(s.headers, null, 2) : form.mcpHeaders,
      });
    } else {
      patch({ mcpMode: "form" });
    }
  };

  /** MCP 区产出是否就绪（解析器锁定时恒 false）。 */
  const mcpReady = mcpLocked
    ? false
    : form.mcpMode === "json"
      ? !!mcpJsonParsed?.ok
      : form.mcpTransport === "stdio"
        ? form.mcpCommand.trim().length > 0
        : form.mcpUrl.trim().length > 0 && !mcpHeadersError;

  const effectiveId =
    form.id.trim() ||
    (pluginType === "mcp" ? mcpNameToId(form.displayName.trim() || "") : "");
  const canSubmit =
    effectiveId.length > 0 &&
    form.displayName.trim().length > 0 &&
    !mcpJsonError &&
    (pluginType === "mcp"
      ? mcpReady ||
        (form.toolDescription.trim().length > 0 && form.toolUsage.trim().length > 0)
      : pluginType === "skill"
        ? form.skillEntries.some((s) => s.description.trim().length > 0 && s.body.trim().length > 0)
        : pluginType === "custom"
          ? (form.panelTitle.trim().length > 0 &&
              form.panelItems.some((it) => it.label.trim() && it.command.trim())) ||
            (form.toolDescription.trim().length > 0 && form.toolUsage.trim().length > 0)
          : pluginType === "cli"
        ? form.toolDescription.trim().length > 0 && form.toolUsage.trim().length > 0
        : form.transportKind === "cli"
          ? form.chatCommand.trim().length > 0
          : form.acpCommand.trim().length > 0);

  /** 切换插件类型：保留表单字段（互不干扰），模版高亮切到该类型默认模版。 */
  const pickType = (type: PluginType) => {
    if (isEdit || type === pluginType) return;
    patch({ pluginType: type });
    const tpl = templates.find((x) => x.tplKind === type);
    if (tpl) setTemplateKey(tpl.key);
  };

  /** 3a-2（v0.9.5 需求1）：能力段多选引导——勾选段 → 自动选型（单段=对应
   *  类型；多段=custom 自由组合）。pi_extension 段创建期无表单（已裁剪），
   *  引导注明经 TOML 编辑添加。 */
  const [segCli, setSegCli] = useState(false);
  const [segMcp, setSegMcp] = useState(false);
  const [segSkill, setSegSkill] = useState(false);

  /** MCP JSON 批量导入（需求19 第二轮）：多 server → 多插件，逐条落盘。 */
  const [batchOpen, setBatchOpen] = useState(false);

  /** 需求20 第三轮：Skill 导入——其他智能体 skill 清单弹层 + 文件导入。 */
  const [skillSourcesOpen, setSkillSourcesOpen] = useState(false);
  const [skillSources, setSkillSources] = useState<
    Array<{ agent: string; name: string; description: string; body: string; path: string; dir: string; asset_count: number }>
  >([]);
  const [skillSourcesLoading, setSkillSourcesLoading] = useState(false);

  /** 需求3（v0.9.4）：文件夹模式——导入含附属文件（references/scripts 等）
   * 的 skill 目录时启用；创建走 plugin_create_skill_folder（目录形式插件
   * plugins/<id>/skills/<name>/ 整目录复制，分发镜像同步含附件）。 */
  const [skillFolder, setSkillFolder] = useState<{ dir: string; skillName: string; assets: number } | null>(null);

  const applySkillImport = (imp: {
    name: string;
    description: string;
    body: string;
    dir?: string | null;
    assets?: string[];
  }) => {
    const slug =
      imp.name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "skill";
    // 需求3：有附属文件 → 文件夹模式（单条替换语义：一个文件夹 = 一个
    // skill 插件；[[skill]] 内联与目录源双轨同存会打架，不支持）。
    if (imp.dir && (imp.assets?.length ?? 0) > 0) {
      setSkillFolder({ dir: imp.dir, skillName: slug, assets: imp.assets!.length });
      patch({
        skillEntries: [{ name: slug, description: imp.description, body: imp.body }],
        ...(isEdit || form.id.trim() ? {} : { id: slug }),
        ...(form.displayName.trim() ? {} : { displayName: imp.name }),
      });
      return;
    }
    setSkillFolder(null);
    // 预填仅新建且为空时（编辑模式 id 锁定不可覆盖）；已有多条时追加为新条目。
    const entry = { name: form.skillEntries.length > 0 ? slug : "", description: imp.description, body: imp.body };
    patch({
      skillEntries:
        form.skillEntries.length === 0 ? [entry] : [...form.skillEntries, entry],
      ...(isEdit || form.id.trim() ? {} : { id: slug }),
      ...(form.displayName.trim() ? {} : { displayName: imp.name }),
    });
  };

  const openSkillSources = async () => {
    // 再点按钮 = 收起弹层。
    if (skillSourcesOpen) {
      setSkillSourcesOpen(false);
      return;
    }
    setSkillSourcesOpen(true);
    setSkillSourcesLoading(true);
    try {
      setSkillSources(
        (await invokeCommand<
          Array<{ agent: string; name: string; description: string; body: string; path: string; dir: string; asset_count: number }>
        >("skill_import_sources")) ?? [],
      );
    } catch (err) {
      setError(String(err));
      setSkillSourcesOpen(false);
    } finally {
      setSkillSourcesLoading(false);
    }
  };

  const importSkillFromFile = async () => {
    try {
      const imp = await invokeCommand<
        { name: string; description: string; body: string; dir?: string | null; assets?: string[] }
      >("skill_import_file");
      applySkillImport(imp);
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) setError(String(err));
    }
  };

  /** 需求3（v0.9.4）：从文件夹导入——目录对话框选 skill 目录（须含
   * SKILL.md），附件目录（references/scripts 等）整体携带。 */
  const importSkillFromFolder = async () => {
    try {
      const imp = await invokeCommand<
        { name: string; description: string; body: string; dir?: string | null; assets?: string[] }
      >("skill_import_folder");
      applySkillImport(imp);
    } catch (err) {
      if (!String(err).includes("USER_CANCELLED")) setError(String(err));
    }
  };

  const [batchJson, setBatchJson] = useState("");
  const [importing, setImporting] = useState(false);
  const batchParsed = useMemo(
    () => (batchOpen && batchJson.trim() ? parseMcpServersBatch(batchJson) : null),
    [batchOpen, batchJson],
  );

  const handleBatchImport = async () => {
    if (!batchParsed?.ok) return;
    setImporting(true);
    try {
      const created: string[] = [];
      const failed: string[] = [];
      for (const { name, server } of batchParsed.servers) {
        const manifest = {
          schema: 1,
          kind: "tool",
          info: { id: mcpNameToId(name), display_name: name },
          mcp: serverToMcpSection(server),
        };
        try {
          await invokeCommand("plugin_create", { manifest });
          created.push(name);
        } catch (createErr) {
          // 同名已存在 → 覆盖更新（GUI 反馈裁决：批量导入直接覆盖，整段
          // manifest 以导入内容为准）；更新也失败才计为失败。
          try {
            await invokeCommand("plugin_update", {
              pluginId: manifest.info.id,
              manifest,
            });
            created.push(`${name}（覆盖）`);
          } catch {
            failed.push(`${name}: ${String(createErr)}`);
          }
        }
      }
      setBatchOpen(false);
      if (created.length > 0) onCreated();
      void alertDialog({
        title: tr("plugins.mcpBatchTitle", "批量导入 MCP 服务"),
        description:
          `${tr("plugins.mcpBatchDone", "导入完成")}：成功 ${created.length} 个` +
          (failed.length
            ? `；失败 ${failed.length} 个：\n${failed.join("\n")}`
            : ""),
      });
    } finally {
      setImporting(false);
    }
  };

  /** [tool] 声明字段集（CLI = 核心分组；MCP = 高级折叠，共用字段）。 */
  const toolDeclareFields = (
    <>
      <Labeled labelKey="plugins.fToolDesc" fallback="描述 *">
        <Input
          value={form.toolDescription}
          onChange={(e) => patch({ toolDescription: e.target.value })}
          placeholder="钉钉消息发送与群管理"
          className="h-8 text-xs"
        />
        <FieldHelp>{tr("plugins.hToolDesc", "")}</FieldHelp>
      </Labeled>
      <Labeled labelKey="plugins.fToolUsage" fallback="用法 *">
        <Input
          value={form.toolUsage}
          onChange={(e) => patch({ toolUsage: e.target.value })}
          placeholder="dingtalk send --to <群名> --message <内容>"
          className="h-8 text-xs font-mono"
        />
        <FieldHelp>{tr("plugins.hToolUsage", "")}</FieldHelp>
      </Labeled>
      <div className="grid grid-cols-2 gap-3">
        <Labeled labelKey="plugins.fToolExample" fallback="示例">
          <Input
            value={form.toolExample}
            onChange={(e) => patch({ toolExample: e.target.value })}
            className="h-8 text-xs font-mono"
          />
        </Labeled>
        <Labeled labelKey="plugins.fToolNotes" fallback="注意">
          <Input
            value={form.toolNotes}
            onChange={(e) => patch({ toolNotes: e.target.value })}
            placeholder="需要 XXX 环境变量"
            className="h-8 text-xs font-mono"
          />
        </Labeled>
      </div>
    </>
  );

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // M4：编辑时把表单不可表达的段（[pi_extension]）原样并回 manifest——
      // 编辑往返不再丢段。
      const manifest = { ...buildManifest(form), ...preservedSections };
      // 需求3（v0.9.4）：文件夹模式 → 目录形式插件（plugin.toml + skills/
      // 整目录复制；后端取首条 skill 条目渲染 SKILL.md 并剥离 [skill] 段）。
      if (skillFolder && !isEdit) {
        if (form.skillEntries.filter((e) => e.description.trim() && e.body.trim()).length !== 1) {
          setError(tr("plugins.skillFolderSingleEntry", "文件夹模式仅支持一条完整 skill 声明"));
          return;
        }
        const created = await invokeCommand<{ id: string; path: string }>(
          "plugin_create_skill_folder",
          { manifest, skillDir: skillFolder.dir, skillName: skillFolder.skillName },
        );
        onOpenChange(false);
        onCreated();
        void alertDialog({
          title: tr("plugins.createdTitle", "插件已创建"),
          description:
            tr("plugins.createdDesc", "") + ` ${created.path}` +
            tr("plugins.skillFolderCreatedSuffix", "（文件夹形式，附属文件已复制）"),
        });
        return;
      }
      const created = isEdit
        ? await invokeCommand<{ id: string; path: string }>("plugin_update", {
            pluginId: editPluginId,
            manifest,
          })
        : await invokeCommand<{ id: string; path: string }>("plugin_create", {
            manifest,
          });
      onOpenChange(false);
      onCreated();
      void alertDialog({
        title: isEdit
          ? tr("plugins.updatedTitle", "插件已保存")
          : tr("plugins.createdTitle", "插件已创建"),
        description:
          (isEdit ? tr("plugins.updatedDesc", "") : tr("plugins.createdDesc", "")) +
          ` ${created.path}`,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {dialogNode}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>{isEdit ? tr("plugins.editTitle", "编辑插件") : tr("plugins.createTitle", "新建插件")}</DialogTitle>
            <DialogDescription>{tr("plugins.createDesc", "")}</DialogDescription>
          </DialogHeader>

          {/* 固定区（GUI 裁决 2026-09-05：类型/模版/创建按钮常驻可视，不随
           * 表单滚动——按钮永不溢出屏幕）；仅下方表单区滚动。 */}
          <div className="shrink-0 space-y-5 px-1">
            {/* 需求19：类型优先三卡（MCP/CLI/AGENT，实现形式入卡）——
             * 选中类型决定下方分组（分治渲染，消除"上面和下面什么关系"）。 */}
            <div>
              <p className="text-xs font-medium mb-2">{tr("plugins.typeSection", "插件类型")}</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {PLUGIN_TYPES.map((tp) => (
                  <button
                    key={tp.key}
                    type="button"
                    role="radio"
                    aria-checked={pluginType === tp.key}
                    disabled={isEdit}
                    onClick={() => pickType(tp.key)}
                    className={cn(
                      "flex flex-col items-start gap-1.5 rounded-md border p-3 text-left transition-colors",
                      pluginType === tp.key
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border/60 hover:border-primary/40 text-foreground",
                      isEdit && "opacity-60 cursor-not-allowed",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {tp.icon}
                      <span className="text-xs font-medium">{tr(tp.nameKey, tp.nameFallback)}</span>
                    </span>
                    <Badge variant="outline" className="px-1.5 text-[9px] leading-4 text-muted-foreground">
                      {tr(tp.formKey, tp.formFallback)}
                    </Badge>
                    <span className="text-[10px] leading-snug text-muted-foreground">
                      {tr(tp.descKey, tp.descFallback)}
                    </span>
                  </button>
                ))}
              </div>
              {isEdit && (
                <FieldHelp>{tr("plugins.hKindLockedEdit", "编辑模式不可更改插件类型（id 与文件名/会话归属均以 id 为键）")}</FieldHelp>
              )}
            </div>

            {/* 3a-2：能力段多选引导（创建模式）——先勾段后自动选型 */}
            {!isEdit && (
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/10 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground/80">想组合多种能力？勾选要包含的段：</span>
                  {([
                    ["CLI 工具（命令）", segCli, setSegCli],
                    ["MCP 工具（服务）", segMcp, setSegMcp],
                    ["Skill 知识（文件）", segSkill, setSegSkill],
                  ] as const).map(([text, on, set]) => (
                    <label key={text} className="flex cursor-pointer items-center gap-1 rounded-md border border-border/60 px-2 py-1 hover:border-primary/40">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => (set as (v: boolean) => void)(e.target.checked)}
                        className="h-3 w-3 accent-primary"
                      />
                      {text}
                    </label>
                  ))}
                  <button
                    type="button"
                    disabled={!(segCli || segMcp || segSkill)}
                    onClick={() => {
                      const n = Number(segCli) + Number(segMcp) + Number(segSkill);
                      if (n === 1) {
                        pickType(segCli ? "cli" : segMcp ? "mcp" : "skill");
                      } else if (n >= 2) {
                        pickType("custom");
                      }
                    }}
                    className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                  >
                    按此选型
                  </button>
                  <span className="text-[10px] text-muted-foreground/60">
                    智能体扩展（pi_extension 配置段）创建期无表单——保存后在详情页 TOML 编辑添加
                  </span>
                </div>
              </div>
            )}
            {/* 模版（仅当前类型；类型已选定，分组标签冗余——需求19 去噪） */}
            <div>
              <p className="text-xs font-medium mb-2">{tr("plugins.tplSection", "从模版开始")}</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {templates
                  .filter((tp) => tp.tplKind === pluginType)
                  .map((tp) => (
                    <button
                      key={tp.key}
                      type="button"
                      onClick={() => pickTemplate(tp.key)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                        templateKey === tp.key
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border/60 hover:border-primary/40",
                      )}
                    >
                      {tp.icon}
                      <span className="text-center leading-tight">{tr(tp.nameKey, tp.nameFallback)}</span>
                    </button>
                  ))}
                {pluginType === "mcp" && !mcpLocked && (
                  <button
                    type="button"
                    onClick={() => {
                      setBatchJson("");
                      setBatchOpen(true);
                    }}
                    className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 p-3 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    <FileJson className="h-4 w-4" />
                    <span className="text-center leading-tight">{tr("plugins.mcpBatchImport", "JSON 批量导入")}</span>
                  </button>
                )}
              </div>
              {/* 模版 TOML 参考行 + 取消/创建（编辑区右上角）。 */}
              <div className="mt-2 flex items-start justify-between gap-2">
                <details className="group min-w-0 flex-1">
                  <summary className="text-[11px] text-muted-foreground cursor-pointer select-none">
                    {tr("plugins.viewToml", "查看模版 TOML（manifest 格式参考）")}
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/60 p-3 text-[10px] leading-relaxed">
                    {template.toml}
                  </pre>
                </details>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                    {tr("common.cancel", "取消")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!canSubmit || submitting}
                    onClick={handleSubmit}
                  >
                    {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {isEdit ? tr("plugins.saveAction", "保存修改") : tr("plugins.createAction", "创建")}
                  </Button>
                </div>
              </div>
            </div>

            {/* Skill 导入（需求20 第三轮，GUI 裁决三：查看模版行下方）。 */}
                    {pluginType === "skill" && !skillLocked && (
                      <div className="relative flex shrink-0 items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => void openSkillSources()}
                        >
                          <Sparkles className="h-3 w-3" />
                          {tr("plugins.skillImportSources", "从其他智能体导入")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => void importSkillFromFile()}
                        >
                          <FileJson className="h-3 w-3" />
                          {tr("plugins.skillImportFile", "从文件导入")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => void importSkillFromFolder()}
                        >
                          <FolderOpen className="h-3 w-3" />
                          {tr("plugins.skillImportFolder", "从文件夹导入")}
                        </Button>
                        {skillSourcesOpen && (
                            <>
                              <div
                                className="fixed inset-0 z-[80]"
                                onClick={() => setSkillSourcesOpen(false)}
                              />
                              <div className="absolute left-0 top-[calc(100%+0.4rem)] z-[90] w-80 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                              <div className="max-h-64 overflow-y-auto">
                                {skillSourcesLoading ? (
                                  <p className="px-2.5 py-2 text-xs text-muted-foreground">
                                    <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                                    {tr("common.loading", "加载中…")}
                                  </p>
                                ) : skillSources.length === 0 ? (
                                  <p className="px-2.5 py-2 text-xs text-muted-foreground">
                                    {tr("plugins.skillImportEmpty", "未发现可导入的 skill")}
                                  </p>
                                ) : (
                                  skillSources.map((src) => (
                                    <button
                                      key={src.path}
                                      type="button"
                                      title={src.path}
                                      onClick={() => {
                                        applySkillImport(src);
                                        setSkillSourcesOpen(false);
                                      }}
                                      className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-fast hover:bg-accent/60"
                                    >
                                      <span className="flex items-center gap-1.5 text-xs text-foreground">
                                        <span className="truncate font-medium">{src.name}</span>
                                        <Badge variant="outline" className="px-1 text-[9px] text-muted-foreground">
                                          {src.agent}
                                        </Badge>
                                        {src.asset_count > 0 && (
                                          <Badge variant="outline" className="px-1 text-[9px] text-amber-600 border-amber-500/50">
                                            {tr("plugins.skillAssetBadge", "含")} {src.asset_count} {tr("plugins.skillAssetUnit", "附件")}
                                          </Badge>
                                        )}
                                      </span>
                                      <span className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                                        {src.description || src.path}
                                      </span>
                                    </button>
                                  ))
                                )}
                              </div>
                              </div>
                            </>
                          )}
                      </div>
                    )}

          </div>

          {/* 表单滚动区：基本信息 + 类型专属分组 + 探测（上方固定区不动）。 */}
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-1 pb-2">
            {/* 基本信息——MCP 只取名称（插件 ID 由名称 slug 自动生成；图标/
             * 安装提示是 CLI/AGENT 元数据，MCP 不展示，v0.9.0 需求19 GUI 裁决）。 */}
            {pluginType === "mcp" ? (
              <div className="grid grid-cols-2 gap-3">
                <Labeled labelKey="plugins.fName" fallback="名称 *">
                  <Input
                    value={form.displayName}
                    onChange={(e) => patch({ displayName: e.target.value })}
                    placeholder="my-mcp-server"
                    className="h-8 text-xs"
                  />
                  <FieldHelp>
                    {tr("plugins.hMcpNameAuto", "插件 ID 由名称自动生成")}
                    <code className="ml-1 font-mono">
                      {form.id.trim() || mcpNameToId(form.displayName.trim() || "my-mcp-server")}
                    </code>
                  </FieldHelp>
                </Labeled>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Labeled labelKey="plugins.fId" fallback="插件 ID *">
                  <Input
                    value={form.id}
                    onChange={(e) => patch({ id: e.target.value })}
                    placeholder="my-agent"
                    className="h-8 text-xs"
                    disabled={isEdit}
                  />
                  <FieldHelp>
                    {isEdit ? tr("plugins.hIdLocked", "") : tr("plugins.hId", "")}
                  </FieldHelp>
                </Labeled>
                <Labeled labelKey="plugins.fName" fallback="显示名称 *">
                  <Input
                    value={form.displayName}
                    onChange={(e) => patch({ displayName: e.target.value })}
                    placeholder="My Agent"
                    className="h-8 text-xs"
                  />
                </Labeled>
                <Labeled labelKey="plugins.fIcon" fallback="图标标识">
                  <IconPicker
                    value={form.icon || "bot"}
                    onChange={(key) => patch({ icon: key })}
                    disabled={isEdit && false}
                  />
                </Labeled>
                <Labeled labelKey="plugins.fInstallHint" fallback="安装提示命令">
                  <Input
                    value={form.installHint}
                    onChange={(e) => patch({ installHint: e.target.value })}
                    placeholder="npm install -g xxx"
                    className="h-8 text-xs font-mono"
                  />
                  <FieldHelp>{tr("plugins.hInstallHint", "")}</FieldHelp>
                </Labeled>
              </div>
            )}

            {/* 自定义插件（需求19 第八轮·声明式能力插件）：核心 = 管理面板声明
             *（面板标题 + 只读命令项，hub 渲染执行——零代码零脚本）。 */}
            {pluginType === "custom" && (
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <p className="text-xs font-medium">{tr("plugins.panelSectionTitle", "管理面板声明")}</p>
                <Labeled labelKey="plugins.fPanelTitle" fallback="面板标题 *">
                  <Input
                    value={form.panelTitle}
                    onChange={(e) => patch({ panelTitle: e.target.value })}
                    placeholder="服务状态一览"
                    className="h-8 text-xs"
                  />
                  <FieldHelp>{tr("plugins.hPanelTitle", "创建后插件页出现「面板」入口，逐项执行命令展示输出。")}</FieldHelp>
                </Labeled>
                <div className="space-y-2">
                  {form.panelItems.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={item.label}
                        onChange={(e) =>
                          patch({
                            panelItems: form.panelItems.map((it, i) =>
                              i === idx ? { ...it, label: e.target.value } : it,
                            ),
                          })
                        }
                        placeholder={tr("plugins.fPanelItemLabel", "标签 *")}
                        className="h-8 w-36 shrink-0 text-xs"
                      />
                      <Input
                        value={item.command}
                        onChange={(e) =>
                          patch({
                            panelItems: form.panelItems.map((it, i) =>
                              i === idx ? { ...it, command: e.target.value } : it,
                            ),
                          })
                        }
                        placeholder='curl -s -o /dev/null -w "%{http_code}" https://…'
                        className="h-8 min-w-0 flex-1 text-xs font-mono"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={tr("plugins.removePanelItem", "删除该项")}
                        onClick={() =>
                          patch({ panelItems: form.panelItems.filter((_, i) => i !== idx) })
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      patch({ panelItems: [...form.panelItems, { label: "", command: "" }] })
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {tr("plugins.addPanelItem", "添加面板项")}
                  </Button>
                  <FieldHelp>{tr("plugins.hPanelItem", "面板中点击执行并展示输出（10s 超时 / 4KB 截断护栏）；未填完整的行不产出。")}</FieldHelp>
                </div>
              </div>
            )}

            {/* 自定义插件附加声明（折叠，可选）：用法注入 [tool]——教会 agent
             * 面板命令的用法。 */}
            {pluginType === "custom" && (
              <details className="rounded-md border border-border/50 p-3">
                <summary className="cursor-pointer select-none text-xs font-medium">
                  {tr("plugins.customExtraSection", "附加声明（可选）：用法注入")}
                </summary>
                <div className="mt-3 space-y-3">{toolDeclareFields}</div>
              </details>
            )}

            {/* CLI 类型核心分组：工具能力声明（会话注入的用法说明）。 */}
            {pluginType === "cli" && (
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <p className="text-xs font-medium">{tr("plugins.toolSection", "工具能力声明")}</p>
                {toolDeclareFields}
              </div>
            )}

            {/* MCP server 声明（v0.9.0 需求1 二期：表单/JSON 双模式 + 三传输；
             * 解析器未启用且非编辑 → 提示锁定）。 */}
            {pluginType === "mcp" &&
              (mcpLocked ? (
                <div className="rounded-md border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                  {tr("plugins.mcpResolverDisabled", "需先启用「MCP 解析器」插件后才能添加 MCP 工具")}
                </div>
              ) : (
                <div className="rounded-md border border-border/50 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">{tr("plugins.mcpSection", "MCP server 声明")}</p>
                    <div className="flex gap-1">
                      {(["form", "json"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => switchMcpMode(mode)}
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors",
                            form.mcpMode === mode
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border/60 text-muted-foreground",
                          )}
                        >
                          {mode === "form"
                            ? tr("plugins.mcpModeForm", "表单")
                            : tr("plugins.mcpModeJson", "JSON")}
                        </button>
                      ))}
                    </div>
                  </div>

                  {form.mcpMode === "form" ? (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground">{tr("plugins.mcpTransportType", "传输类型")}</span>
                        {(["stdio", "http", "sse"] as const).map((tp) => (
                          <button
                            key={tp}
                            type="button"
                            onClick={() => patch({ mcpTransport: tp })}
                            className={cn(
                              "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors",
                              form.mcpTransport === tp
                                ? "border-primary bg-primary/5 text-primary"
                                : "border-border/60 text-muted-foreground",
                            )}
                          >
                            {tp === "stdio"
                              ? tr("plugins.mcpTransportStdio", "stdio（本地命令）")
                              : tp === "http"
                                ? tr("plugins.mcpTransportHttp", "HTTP")
                                : tr("plugins.mcpTransportSse", "SSE（Server-Sent Events）")}
                          </button>
                        ))}
                      </div>
                      {form.mcpTransport === "stdio" ? (
                        <>
                          <Labeled labelKey="plugins.fMcpCommand" fallback="命令">
                            <Input
                              value={form.mcpCommand}
                              onChange={(e) => patch({ mcpCommand: e.target.value })}
                              placeholder="npx"
                              className="h-8 text-xs font-mono"
                            />
                            <FieldHelp>{tr("plugins.hMcpCommand", "")}</FieldHelp>
                          </Labeled>
                          <div className="grid grid-cols-2 gap-3">
                            <Labeled labelKey="plugins.fMcpArgs" fallback="参数">
                              <Input
                                value={form.mcpArgs}
                                onChange={(e) => patch({ mcpArgs: e.target.value })}
                                placeholder="-y @modelcontextprotocol/server-filesystem"
                                className="h-8 text-xs font-mono"
                              />
                              <FieldHelp>{tr("plugins.hMcpArgs", "空格分隔。")}</FieldHelp>
                            </Labeled>
                            <Labeled labelKey="plugins.fMcpEnv" fallback="环境变量">
                              <textarea
                                value={form.mcpEnv}
                                onChange={(e) => patch({ mcpEnv: e.target.value })}
                                placeholder={"API_TOKEN=xxx\nDEBUG=1"}
                                className="min-h-[2.4rem] w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs font-mono"
                              />
                              <FieldHelp>{tr("plugins.hMcpEnv", "每行 KEY=VALUE。")}</FieldHelp>
                            </Labeled>
                          </div>
                        </>
                      ) : (
                        <div className="grid grid-cols-2 gap-3">
                          <Labeled labelKey="plugins.fMcpUrl" fallback="URL">
                            <Input
                              value={form.mcpUrl}
                              onChange={(e) => patch({ mcpUrl: e.target.value })}
                              placeholder="https://mcp.example.com/mcp"
                              className="h-8 text-xs font-mono"
                            />
                            <FieldHelp>{tr("plugins.hMcpUrl", "")}</FieldHelp>
                          </Labeled>
                          <Labeled labelKey="plugins.fMcpHeaders" fallback="请求头（JSON，可选）">
                            <textarea
                              value={form.mcpHeaders}
                              onChange={(e) => patch({ mcpHeaders: e.target.value })}
                              placeholder={'{"Authorization": "Bearer your-token"}'}
                              className="min-h-[2.4rem] w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs font-mono"
                            />
                            <FieldHelp>
                              {mcpHeadersError ? (
                                <span className="text-destructive">{mcpHeadersError}</span>
                              ) : (
                                tr("plugins.hMcpHeaders", "")
                              )}
                            </FieldHelp>
                          </Labeled>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <textarea
                        value={form.mcpJson}
                        onChange={(e) => patch({ mcpJson: e.target.value })}
                        placeholder={'{\n  "my-mcp-server": {\n    "type": "stdio",\n    "command": "",\n    "args": []\n  }\n}'}
                        rows={8}
                        spellCheck={false}
                        className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
                      />
                      {mcpJsonError ? (
                        <p className="text-[11px] leading-snug text-destructive">{mcpJsonError}</p>
                      ) : (
                        <FieldHelp>{tr("plugins.hMcpJson", "")}</FieldHelp>
                      )}
                    </>
                  )}
                </div>
              ))}

            {/* Skill 声明（v0.9.0 需求20 + v0.9.1 需求10 GUI/CLI 能力一致）：
             * 多条目编辑——单条且 name 留空 → [skill]（skill 名 = 插件 id）；
             * 多条/带名 → [[skill]] 数组（部署名 <插件id>__<name>）。 */}
            {pluginType === "skill" &&
              (skillLocked ? (
                <div className="rounded-md border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                  {tr("plugins.skillResolverDisabled", "需先启用「Skill 解析器」插件后才能添加 Skill 工具")}
                </div>
              ) : (
                <div className="rounded-md border border-border/50 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">{tr("plugins.skillSection", "Skill 声明")}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() =>
                        patch({ skillEntries: [...form.skillEntries, { name: "", description: "", body: "" }] })
                      }
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      {tr("plugins.addSkillEntry", "添加 skill")}
                    </Button>
                  </div>
                  {skillFolder && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed">
                      <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                      <div className="min-w-0 flex-1">
                        {tr("plugins.skillFolderNotice", "文件夹模式：将以目录形式创建插件，整目录携带")}{" "}
                        <span className="font-semibold">{skillFolder.assets}</span>{" "}
                        {tr("plugins.skillFolderNotice2", "个附属文件（references/scripts 等）；SKILL.md 按下方表单渲染。分发到各 agent 时附件一并落地。")}
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={skillFolder.dir}>
                          {skillFolder.dir}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                        onClick={() => setSkillFolder(null)}
                      >
                        {tr("plugins.skillFolderExit", "改用纯文本")}
                      </button>
                    </div>
                  )}
                  {form.skillEntries.length === 0 && (
                    <p className="text-[11px] text-muted-foreground/70">
                      {tr("plugins.skillEntriesEmpty", "尚未声明 skill——点「添加 skill」或从已有 SKILL.md 导入。")}
                    </p>
                  )}
                  {form.skillEntries.map((entry, idx) => (
                    <div key={idx} className="space-y-2 rounded-md border border-border/40 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {tr("plugins.skillEntryLabel", "Skill")} #{idx + 1}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="h-6 w-6 text-destructive hover:text-destructive"
                          aria-label={tr("plugins.removeSkillEntry", "移除")}
                          onClick={() =>
                            patch({
                              skillEntries: form.skillEntries.filter((_, i) => i !== idx),
                            })
                          }
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                      <Labeled labelKey="plugins.fSkillName" fallback="Skill 名（可选）">
                        <Input
                          value={entry.name}
                          onChange={(e) =>
                            patch({
                              skillEntries: form.skillEntries.map((s, i) =>
                                i === idx ? { ...s, name: e.target.value } : s,
                              ),
                            })
                          }
                          placeholder={
                            form.skillEntries.length > 1
                              ? tr("plugins.skillNameRequired", "多条时必填（部署名：插件id__名称）")
                              : tr("plugins.skillNameOptional", "留空 = 以插件 id 命名（单 skill 形态）")
                          }
                          className="h-8 text-xs"
                        />
                      </Labeled>
                      <Labeled labelKey="plugins.fSkillDesc" fallback="描述 *">
                        <Input
                          value={entry.description}
                          onChange={(e) =>
                            patch({
                              skillEntries: form.skillEntries.map((s, i) =>
                                i === idx ? { ...s, description: e.target.value } : s,
                              ),
                            })
                          }
                          placeholder="提交前代码自查：何时用/做什么（≤1024 字符）"
                          className="h-8 text-xs"
                        />
                      </Labeled>
                      <Labeled labelKey="plugins.fSkillBody" fallback="内容 *">
                        <textarea
                          value={entry.body}
                          onChange={(e) =>
                            patch({
                              skillEntries: form.skillEntries.map((s, i) =>
                                i === idx ? { ...s, body: e.target.value } : s,
                              ),
                            })
                          }
                          rows={8}
                          spellCheck={false}
                          placeholder={"第一步：通读 diff…\n第二步：检查错误处理…"}
                          className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
                        />
                        <FieldHelp>{tr("plugins.hSkillBody", "SKILL.md 正文指令；启用后自动分发到各 agent 的 skill 目录（启停即分发/回收）。")}</FieldHelp>
                      </Labeled>
                    </div>
                  ))}
                </div>
              ))}

            {/* 探测（仅 CLI/AGENT——MCP 表单只保留 MCP 本质字段，stdio 命令
             * 检测并入总控监控是后续路线；MCP 编辑时 probe 段值经表单状态
             * 原样保留提交）。 */}
            {pluginType !== "mcp" && (
<div className="rounded-md border border-border/50 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">{tr("plugins.probeSection", "安装探测")}{
                pluginType === "cli" ? (
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{tr("plugins.probeToolHint", "（检测工具命令是否已安装，影响注入块的「状态」行）")}</span>
                ) : null
              }</p>
                <Switch
                  checked={form.probeEnabled}
                  onCheckedChange={(v) => patch({ probeEnabled: v })}
                />
              </div>
              {form.probeEnabled && (
                <div className="grid grid-cols-3 gap-3">
                  <Labeled labelKey="plugins.fProbeCmd" fallback="命令 *">
                    <Input
                      value={form.probeCommand}
                      onChange={(e) => patch({ probeCommand: e.target.value })}
                      placeholder="gemini"
                      className="h-8 text-xs font-mono"
                    />
                    <FieldHelp>{tr("plugins.hProbeCmd", "")}</FieldHelp>
                  </Labeled>
                  <Labeled labelKey="plugins.fVersionArgs" fallback="版本参数">
                    <Input
                      value={form.versionArgs}
                      onChange={(e) => patch({ versionArgs: e.target.value })}
                      placeholder="--version"
                      className="h-8 text-xs font-mono"
                    />
                  </Labeled>
                  <Labeled labelKey="plugins.fVersionRegex" fallback="版本正则">
                    <Input
                      value={form.versionRegex}
                      onChange={(e) => patch({ versionRegex: e.target.value })}
                      placeholder="v([0-9.]+)"
                      className="h-8 text-xs font-mono"
                    />
                    <FieldHelp>{tr("plugins.hVersionRegex", "")}</FieldHelp>
                  </Labeled>
                </div>
              )}
            </div>
)}

            {/* 传输（仅智能体插件——工具插件无 transport 段，schema 互斥） */}
            {!isTool && (
            <div className="rounded-md border border-border/50 p-3 space-y-3">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium">{tr("plugins.transportSection", "传输方式")}</p>
                {(["cli", "acp"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => patch({ transportKind: kind })}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors",
                      form.transportKind === kind
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border/60 text-muted-foreground",
                    )}
                  >
                    {kind === "cli" ? "CLI 进程" : "ACP 协议"}
                  </button>
                ))}
              </div>
              {form.transportKind === "cli" ? (
                <div className="grid grid-cols-2 gap-3">
                  <Labeled labelKey="plugins.fChatCommand" fallback="会话命令 *（每行一个参数）">
                    <textarea
                      value={form.chatCommand}
                      onChange={(e) => patch({ chatCommand: e.target.value })}
                      placeholder={"gemini\n--prompt\n{prompt}"}
                      rows={3}
                      className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
                    />
                    <FieldHelp>{tr("plugins.hChatCommand", "")}</FieldHelp>
                  </Labeled>
                  <div className="space-y-3">
                    <Labeled labelKey="plugins.fCwd" fallback="工作目录模板">
                      <Input
                        value={form.cwd}
                        onChange={(e) => patch({ cwd: e.target.value })}
                        placeholder="{cwd}"
                        className="h-8 text-xs font-mono"
                      />
                    </Labeled>
                    <Labeled labelKey="plugins.fAbortBytes" fallback="中止序列（hex）">
                      <Input
                        value={form.abortBytes}
                        onChange={(e) => patch({ abortBytes: e.target.value })}
                        placeholder="0x03"
                        className="h-8 text-xs font-mono"
                      />
                      <FieldHelp>{tr("plugins.hAbortBytes", "")}</FieldHelp>
                    </Labeled>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={form.pipeStdin}
                        onCheckedChange={(v) => patch({ pipeStdin: v })}
                      />
                      <span className="text-xs">{tr("plugins.fPipeStdin", "")}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <Labeled labelKey="plugins.fAcpCommand" fallback="ACP 启动命令（每行一个参数）*">
                  <textarea
                    value={form.acpCommand}
                    onChange={(e) => patch({ acpCommand: e.target.value })}
                    placeholder={"npx\n-y\nmy-acp-agent"}
                    rows={3}
                    className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
                  />
                  <FieldHelp>{tr("plugins.hAcpCommand", "")}</FieldHelp>
                  <FieldHelp>
                    {tr(
                      "plugins.hAcpPluginDir",
                      "桥接形态：转换脚本随插件目录分发时经 CLI 安装目录包（jishu-cli plugins add <目录>），命令中用 {plugin_dir} 引用插件目录（如 node {plugin_dir}/bridge.js）——动态变量（{prompt} 等）不允许。",
                    )}
                  </FieldHelp>
                </Labeled>
              )}
            </div>
            )}

            {/* 配置与会话（仅智能体插件——工具插件 schema 禁止 config/session 段） */}
            {!isTool && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">{tr("plugins.configSection", "配置文件")}</p>
                  <Switch
                    checked={form.configEnabled}
                    onCheckedChange={(v) => patch({ configEnabled: v })}
                  />
                </div>
                {form.configEnabled && (
                  <>
                    <Labeled labelKey="plugins.fConfigPath" fallback="配置文件路径">
                      <Input
                        value={form.configPath}
                        onChange={(e) => patch({ configPath: e.target.value })}
                        placeholder="~/.xxx/settings.json"
                        className="h-8 text-xs font-mono"
                      />
                      <FieldHelp>{tr("plugins.hConfigPath", "")}</FieldHelp>
                    </Labeled>
                    <Labeled labelKey="plugins.fSkillsDir" fallback="Skill 目录（可选）">
                      <Input
                        value={form.skillsDir}
                        onChange={(e) => patch({ skillsDir: e.target.value })}
                        placeholder="~/.xxx/skills"
                        className="h-8 text-xs font-mono"
                      />
                      <FieldHelp>{tr("plugins.hSkillsDir", "填写后，启用的 Skill 插件将自动分发 SKILL.md 到该目录（<skill 名>/SKILL.md 所在处），本智能体即可使用全部已注册技能。")}</FieldHelp>
                    </Labeled>
                    <div className="flex items-center gap-2">
                      {(["json", "toml"] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => patch({ configFormat: fmt })}
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 text-[10px] font-mono",
                            form.configFormat === fmt
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border/60 text-muted-foreground",
                          )}
                        >
                          {fmt}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <p className="text-xs font-medium">{tr("plugins.sessionSection", "会话存储")}</p>
                <div className="flex gap-2">
                  {(["hub", "none"] as const).map((store) => (
                    <button
                      key={store}
                      type="button"
                      onClick={() => patch({ sessionStore: store })}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[10px]",
                        form.sessionStore === store
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border/60 text-muted-foreground",
                      )}
                    >
                      {store === "hub"
                        ? tr("plugins.storeHub", "hub（历史可回放）")
                        : tr("plugins.storeNone", "none（不持久化）")}
                    </button>
                  ))}
                </div>
                <FieldHelp>{tr("plugins.hStore", "")}</FieldHelp>
                <div className="flex flex-wrap gap-3 pt-1">
                  {(
                    [
                      ["abort", form.abort, (v: boolean) => patch({ abort: v }), tr("plugins.capAbort", "中止")],
                      ["image", form.imageInput, (v: boolean) => patch({ imageInput: v }), tr("plugins.capImage", "图片输入")],
                      ["stream", form.streamText, (v: boolean) => patch({ streamText: v }), tr("plugins.capStream", "流式文本")],
                    ] as const
                  ).map(([key, value, setter, label]) => (
                    <label key={key} className="flex items-center gap-1.5 text-xs">
                      <Switch checked={value} onCheckedChange={setter} />
                      {label}
                    </label>
                  ))}
                </div>
                <FieldHelp>{tr("plugins.hCaps", "")}</FieldHelp>
              </div>
            </div>
            )}

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive break-all">
                {error}
              </div>
            )}
          </div>

          {/* 底部固定：仅 schema 徽标（取消/创建均已上移编辑区右上角）。 */}
          <DialogFooter className="shrink-0">
            <div className="flex items-center gap-2 mr-auto">
              <Badge variant="secondary" className="text-[10px] gap-1">
                <Bot className="h-3 w-3" />
                {tr("plugins.schemaVersion", "schema v1")}
              </Badge>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* MCP JSON 批量导入（需求19 第二轮）：多 server → 多插件。 */}
      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{tr("plugins.mcpBatchTitle", "批量导入 MCP 服务")}</DialogTitle>
            <DialogDescription>
              {tr("plugins.mcpBatchDesc", "粘贴包含多个 server 的 JSON（支持 mcpServers 包裹）；每个服务将创建一个独立 MCP 插件（插件 ID 由名称生成）。")}
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={batchJson}
            onChange={(e) => setBatchJson(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={'{\n  "mcpServers": {\n    "server-a": { "type": "stdio", "command": "npx", "args": [] },\n    "server-b": { "type": "http", "url": "https://mcp.example.com/mcp" }\n  }\n}'}
            className="flex w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-mono"
          />
          {batchParsed ? (
            batchParsed.ok ? (
              <p className="text-[11px] leading-snug text-muted-foreground">
                {tr("plugins.mcpBatchDetected", "识别到")} {batchParsed.servers.length} 个：{batchParsed.servers.map((x) => x.name).join("、")}
              </p>
            ) : (
              <p className="text-[11px] leading-snug text-destructive">{batchParsed.error}</p>
            )
          ) : (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {tr("plugins.mcpBatchHint", "任一条目非法将整体报错，不会部分导入。")}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBatchOpen(false)}>
              {tr("common.cancel", "取消")}
            </Button>
            <Button size="sm" disabled={!batchParsed?.ok || importing} onClick={() => void handleBatchImport()}>
              {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {tr("plugins.mcpBatchAction", "导入")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
