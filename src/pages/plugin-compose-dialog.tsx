/**
 * 新建组合插件向导（v0.9.3 需求13 C3）：零代码造插件——选内容源 × 渲染
 * 组件（注册表实时列出）× 挂载（按源自动推导）× 导出动作（按组件能力）×
 * 自定义配置项 → 生成 TOML → composed_plugin_save → plugins-changed 热生效。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invokeCommand } from "@/hooks/use-invoke";
import { rendererRegistry } from "@/features/session-kernel/capabilities/renderers/registry";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

type SourceType = "code-block" | "block-type" | "messages" | "turns" | "signal";
type FieldType = "switch" | "number" | "text";

interface ConfigDraft {
  key: string;
  label: string;
  type: FieldType;
  def: string;
}

const SOURCE_TYPES: Array<{ value: SourceType; label: string; hint: string }> = [
  { value: "code-block", label: "代码块（按语言）", hint: "如 mermaid/html/katex 代码块" },
  { value: "block-type", label: "消息块类型", hint: "如 phase_divider/interaction" },
  { value: "messages", label: "消息流（聚合统计）", hint: "工具统计类挂件" },
  { value: "turns", label: "轮次视图", hint: "大纲/导航类" },
  { value: "signal", label: "内核信号", hint: "通知类（回合完成/审批/失败）" },
];

/** 源类型 → 可用挂载（推导默认）。 */
function defaultMountOf(source: SourceType): string {
  switch (source) {
    case "code-block":
    case "block-type":
      return "block-renderer";
    case "messages":
      return "rail-widget";
    case "turns":
      return "dock-panel";
    case "signal":
      return "event-hook";
  }
}

function tomlStr(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function PluginComposeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const { alert: alertDialog } = useConfirmDialog();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>("code-block");
  const [languages, setLanguages] = useState("");
  const [blockTypes, setBlockTypes] = useState("");
  const [signals, setSignals] = useState("turn-complete, approval-request, task-run-failed");
  const [component, setComponent] = useState("render.mermaid");
  const [turnsMount, setTurnsMount] = useState<"dock-panel" | "rail-widget">("dock-panel");
  const [exportFormats, setExportFormats] = useState<string[]>([]);
  const [configFields, setConfigFields] = useState<ConfigDraft[]>([]);
  const [saving, setSaving] = useState(false);

  const renderers = useMemo(() => rendererRegistry.list(), []);
  const renderer = renderers.find((r) => r.key === component);
  const exportFormatsAvailable = renderer?.capabilities?.exportFormats ?? [];

  const id = useMemo(() => {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
    return `session.${slug}`;
  }, [name]);

  if (!open) return null;

  const mount = sourceType === "turns" ? turnsMount : defaultMountOf(sourceType);

  const buildToml = (): string => {
    const lines: string[] = [];
    lines.push("[plugin]");
    lines.push(`id = ${tomlStr(id)}`);
    lines.push(`name = ${tomlStr(name.trim() || "自定义插件")}`);
    if (description.trim()) lines.push(`description = ${tomlStr(description.trim())}`);
    lines.push('kind = "session-composed"');
    lines.push("");
    lines.push("[source]");
    lines.push(`type = ${tomlStr(sourceType)}`);
    if (sourceType === "code-block" && languages.trim()) {
      lines.push(`languages = [${languages.split(/[,，\s]+/).filter(Boolean).map(tomlStr).join(", ")}]`);
    }
    if (sourceType === "block-type" && blockTypes.trim()) {
      lines.push(`blockTypes = [${blockTypes.split(/[,，\s]+/).filter(Boolean).map(tomlStr).join(", ")}]`);
    }
    if (sourceType === "signal" && signals.trim()) {
      lines.push(`signals = [${signals.split(/[,，\s]+/).filter(Boolean).map(tomlStr).join(", ")}]`);
    }
    lines.push("");
    lines.push("[render]");
    lines.push(`component = ${tomlStr(sourceType === "signal" ? "render.none" : component)}`);
    lines.push(`mount = ${tomlStr(mount)}`);
    lines.push('fallback = "render.mono-text"');
    if (exportFormats.length) {
      lines.push("");
      for (const format of exportFormats) {
        lines.push("[[action]]");
        lines.push('type = "export-file"');
        lines.push(`format = ${tomlStr(format)}`);
        lines.push(`label = ${tomlStr(format.toUpperCase())}`);
      }
    }
    if (sourceType === "signal") {
      lines.push("");
      lines.push("[[action]]");
      lines.push('type = "desktop-notify"');
    }
    if (configFields.length) {
      for (const field of configFields) {
        if (!field.key.trim() || !field.label.trim()) continue;
        lines.push("");
        lines.push("[[config]]");
        lines.push(`key = ${tomlStr(field.key.trim())}`);
        lines.push(`type = ${tomlStr(field.type)}`);
        lines.push(`label = ${tomlStr(field.label.trim())}`);
        if (field.type === "switch") lines.push(`default = ${field.def.trim() === "false" ? "false" : "true"}`);
        else if (field.type === "number") lines.push(`default = ${Number(field.def) || 0}`);
        else lines.push(`default = ${tomlStr(field.def)}`);
      }
    }
    return lines.join("\n") + "\n";
  };

  const save = async () => {
    if (!name.trim()) {
      await alertDialog({ title: "请填写插件名称" });
      return;
    }
    if (sourceType === "code-block" && !languages.trim()) {
      await alertDialog({ title: "代码块源需要至少一个语言标记（如 katex）" });
      return;
    }
    setSaving(true);
    try {
      await invokeCommand("composed_plugin_save", { id, toml: buildToml() });
      onCreated();
      onOpenChange(false);
      setName("");
      setDescription("");
      setConfigFields([]);
    } catch (e) {
      await alertDialog({ title: "保存失败", description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const label = "mb-1 block text-[11px] font-medium text-muted-foreground";
  const input = "h-7 w-full rounded-md border border-border/70 bg-transparent px-2 text-xs outline-none focus:border-primary/60";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative flex max-h-[86vh] w-[min(720px,94vw)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-5 py-3.5">
          <div>
            <div className="text-sm font-semibold">新建组合插件</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">选内容源与渲染组件，零代码生成插件（TOML 组合清单）</div>
          </div>
          <div className="font-mono text-[10px] text-muted-foreground/70">{id}</div>
        </div>
        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>名称 *</span>
              <Input className="h-7 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：数学公式渲染" />
            </div>
            <div>
              <span className={label}>说明</span>
              <Input className="h-7 text-xs" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话用途" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>内容源</span>
              <select className={input} value={sourceType} onChange={(e) => setSourceType(e.target.value as SourceType)}>
                {SOURCE_TYPES.map((st) => (
                  <option key={st.value} value={st.value}>{st.label}</option>
                ))}
              </select>
              <div className="mt-0.5 text-[10px] text-muted-foreground/70">{SOURCE_TYPES.find((st) => st.value === sourceType)?.hint}</div>
            </div>
            {sourceType === "code-block" ? (
              <div>
                <span className={label}>语言标记（逗号分隔）*</span>
                <Input className="h-7 text-xs" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="katex, tex" />
              </div>
            ) : sourceType === "block-type" ? (
              <div>
                <span className={label}>块类型（逗号分隔）</span>
                <Input className="h-7 text-xs" value={blockTypes} onChange={(e) => setBlockTypes(e.target.value)} placeholder="phase_divider" />
              </div>
            ) : sourceType === "signal" ? (
              <div>
                <span className={label}>信号（逗号分隔）</span>
                <Input className="h-7 text-xs" value={signals} onChange={(e) => setSignals(e.target.value)} />
              </div>
            ) : null}
          </div>
          {sourceType !== "signal" ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className={label}>渲染组件（注册表）</span>
                <select className={input} value={component} onChange={(e) => { setComponent(e.target.value); setExportFormats([]); }}>
                  {renderers.filter((r) => r.key !== "render.none").map((r) => (
                    <option key={r.key} value={r.key}>{r.key}{r.description ? ` — ${r.description}` : ""}</option>
                  ))}
                </select>
              </div>
              {sourceType === "turns" ? (
                <div>
                  <span className={label}>挂载形态</span>
                  <select className={input} value={turnsMount} onChange={(e) => setTurnsMount(e.target.value as "dock-panel" | "rail-widget")}>
                    <option value="dock-panel">停靠面板（大纲）</option>
                    <option value="rail-widget">贴边挂件（导航条）</option>
                  </select>
                </div>
              ) : null}
            </div>
          ) : null}
          {exportFormatsAvailable.length > 0 ? (
            <div>
              <span className={label}>导出动作（组件能力）</span>
              <div className="flex gap-2">
                {exportFormatsAvailable.map((format) => (
                  <label key={format} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={exportFormats.includes(format)}
                      onChange={(e) =>
                        setExportFormats((prev) => (e.target.checked ? [...prev, format] : prev.filter((f) => f !== format)))
                      }
                    />
                    导出 {format.toUpperCase()}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <div className="flex items-center justify-between">
              <span className={label}>配置项（可选）</span>
              <Button variant="outline" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => setConfigFields((p) => [...p, { key: "", label: "", type: "switch", def: "" }])}>
                <Plus className="h-3 w-3" /> 添加
              </Button>
            </div>
            {configFields.map((field, i) => (
              <div key={i} className="mt-1 flex items-center gap-1.5">
                <Input className="h-6 flex-1 text-[11px]" placeholder="键（camelCase）" value={field.key}
                  onChange={(e) => setConfigFields((p) => p.map((f, j) => (j === i ? { ...f, key: e.target.value } : f)))} />
                <Input className="h-6 flex-1 text-[11px]" placeholder="显示名" value={field.label}
                  onChange={(e) => setConfigFields((p) => p.map((f, j) => (j === i ? { ...f, label: e.target.value } : f)))} />
                <select className="h-6 rounded-md border border-border/70 bg-transparent px-1 text-[11px]" value={field.type}
                  onChange={(e) => setConfigFields((p) => p.map((f, j) => (j === i ? { ...f, type: e.target.value as FieldType } : f)))}>
                  <option value="switch">开关</option>
                  <option value="number">数字</option>
                  <option value="text">文本</option>
                </select>
                <Input className="h-6 w-20 text-[11px]" placeholder="默认" value={field.def}
                  onChange={(e) => setConfigFields((p) => p.map((f, j) => (j === i ? { ...f, def: e.target.value } : f)))} />
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setConfigFields((p) => p.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
          <div className="rounded-lg bg-muted/40 p-2.5">
            <div className="mb-1 text-[10px] font-medium text-muted-foreground">生成预览（plugin.toml）</div>
            <pre className="max-h-36 overflow-auto font-mono text-[10px] leading-relaxed text-foreground/80">{buildToml()}</pre>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/50 px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("common.cancel", "取消")}</Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            <span className="ml-1">创建插件</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
