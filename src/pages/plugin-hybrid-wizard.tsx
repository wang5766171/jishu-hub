/**
 * 混合插件可视化向导（v0.9.5 需求1（原需求26）3b）。
 *
 * 结构（01 §二 C）：基本信息（id/源/挂载——@file: 限定数据面挂载）→
 * 代码编辑（CodeEditor 实时语法/契约校验 + API v1 参考面板 + 实时预览
 * HybridPreviewPanel）→ 保存（hybrid_plugin_save → 默认禁用 + 确认卡启用）。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeEditor } from "@/components/code-editor";
import { HybridPreviewPanel } from "@/components/hybrid-preview-panel";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { invokeCommand } from "@/hooks/use-invoke";

type HybridSourceType = "messages" | "turns" | "task" | "stream-state";
type HybridMount = "dock-panel" | "rail-widget" | "sidebar-panel" | "composer-trailing";

const SOURCE_TYPES: Array<{ value: HybridSourceType; label: string; hint: string }> = [
  { value: "messages", label: "消息流", hint: "props.payload.data = Message[]（可配聚合器）" },
  { value: "turns", label: "轮次视图", hint: "props.payload.turns / activeIndex / jump(i)" },
  { value: "task", label: "任务信息", hint: "props.payload.task" },
  { value: "stream-state", label: "流状态", hint: "同消息流形态" },
];

const MOUNTS: Array<{ value: HybridMount; label: string }> = [
  { value: "dock-panel", label: "停靠面板（侧边，可收起）" },
  { value: "rail-widget", label: "贴边挂件（会话边缘小图标）" },
  { value: "sidebar-panel", label: "侧栏面板（多标签）" },
  { value: "composer-trailing", label: "输入框尾部（行内小部件）" },
];

function templateCode(id: string, sourceType: HybridSourceType): string {
  const body =
    sourceType === "turns"
      ? `    const turns = props.payload.turns ?? [];
    const last = turns[turns.length - 1];
    return api.h("div", { className: "p-2 text-sm" },
      api.h("span", { className: "text-muted-foreground" },
        "共 " + turns.length + " 轮" + (last?.cost ? " · 本轮 ¥" + last.cost : "")));`
      : sourceType === "task"
        ? `    const task = props.payload.task;
    return api.h("div", { className: "p-2 text-sm" }, task ? task.title : "暂无任务");`
        : `    const data = props.payload.data ?? [];
    return api.h("div", { className: "p-2 text-sm" },
      api.h("div", { className: "font-medium" }, "共 " + data.length + " 条"),
      data.slice(-3).map((m, i) =>
        api.h("div", { key: i, className: "text-xs text-muted-foreground" },
          String((m as { role?: string }).role ?? "") + ": " +
          String((m as { content?: string }).content ?? "").slice(0, 20))));`;
  return `JishuPlugin.register("${id}", {
  version: 1,
  component: (api) => (props) => {
${body}
  },
});
`;
}

export function PluginHybridWizard({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const { t } = useTranslation();
  const { alert: alertDialog } = useConfirmDialog();
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<HybridSourceType>("messages");
  const [mount, setMount] = useState<HybridMount>("dock-panel");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showApiRef, setShowApiRef] = useState(true);

  const id = useMemo(() => {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "hybrid";
    return `session.${slug}`;
  }, [name]);

  // 未手改过代码时随基本信息联动刷新模板（手改后不再覆盖）。
  const effectiveCode = codeTouched
    ? code
    : templateCode(id, sourceType);

  const buildToml = (): string => {
    const lines = [
      "[plugin]",
      `id = "${id}"`,
      `name = ${JSON.stringify(name.trim() || "混合插件")}`,
      'kind = "session-composed"',
      "",
      "[source]",
      `type = "${sourceType}"`,
      "",
      "[render]",
      'component = "@file:component.js"',
      `mount = "${mount}"`,
    ];
    return lines.join("\n") + "\n";
  };

  const save = async () => {
    if (!name.trim()) {
      await alertDialog({ title: "请填写插件名称" });
      return;
    }
    if (!codeTouched || !effectiveCode.includes("JishuPlugin.register")) {
      await alertDialog({ title: "代码缺少 JishuPlugin.register 注册调用" });
      return;
    }
    setSaving(true);
    try {
      await invokeCommand("hybrid_plugin_save", {
        id,
        toml: buildToml(),
        componentJs: effectiveCode,
      });
      onCreated?.();
      onOpenChange(false);
      await alertDialog({
        title: "已保存（默认禁用）",
        description:
          "混合插件包含自定义代码，安装确认卡已出现——点「启用」后生效（含代码的插件统一走确认安全阀）。",
      });
    } catch (e) {
      await alertDialog({ title: "保存失败", description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  const label = "mb-1 block text-[11px] font-medium text-muted-foreground";
  const inputCls = "h-7 w-full rounded-md border border-border/70 bg-transparent px-2 text-xs outline-none focus:border-primary/60";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative flex max-h-[88vh] w-[min(1020px,96vw)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-5 py-3.5">
          <div>
            <div className="text-sm font-semibold">混合插件向导（TOML + component.js）</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              自定义渲染的会话界面插件——左侧编辑代码（实时校验），右侧实时预览
            </div>
          </div>
          <div className="font-mono text-[10px] text-muted-foreground/70">{id}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <span className={label}>名称 *</span>
              <Input className="h-7 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：轮次花销" />
            </div>
            <div>
              <span className={label}>内容源</span>
              <select className={inputCls} value={sourceType} onChange={(e) => setSourceType(e.target.value as HybridSourceType)}>
                {SOURCE_TYPES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <div className="mt-0.5 text-[10px] text-muted-foreground/70">{SOURCE_TYPES.find((s) => s.value === sourceType)?.hint}</div>
            </div>
            <div>
              <span className={label}>挂载（@file: 限定数据面）</span>
              <select className={inputCls} value={mount} onChange={(e) => setMount(e.target.value as HybridMount)}>
                {MOUNTS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-[1fr_340px] gap-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">component.js（实时语法 + 契约校验）</span>
                <button
                  type="button"
                  onClick={() => setShowApiRef((v) => !v)}
                  className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <BookOpen className="h-3 w-3" />
                  API 参考
                </button>
              </div>
              {showApiRef && (
                <div className="mb-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  <div><span className="text-foreground/80">api.</span>h(tag, props, ...children) · useState · useEffect · useMemo · useRef · useCallback · t(key, fallback) · cn(...cls)</div>
                  <div><span className="text-foreground/80">props.</span>payload（按内容源形状）· options（配置值）· actions（动作条）</div>
                  <div><span className="text-foreground/80">注册.</span>JishuPlugin.register("{id}", {"{"} version: 1, component (api) =&gt; (props) =&gt; vnode {"}"})</div>
                </div>
              )}
              <CodeEditor
                value={effectiveCode}
                onChange={(next) => {
                  setCode(next);
                  setCodeTouched(true);
                }}
                pluginId={id}
                height="300px"
                placeholder="JishuPlugin.register(...)"
              />
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">实时预览（模拟数据，非沙箱）</div>
              <HybridPreviewPanel
                source={effectiveCode}
                pluginId={id}
                sourceType={sourceType === "stream-state" ? "messages" : sourceType}
                height="372px"
              />
            </div>
          </div>

          <div className="mt-3 rounded-lg bg-muted/40 p-2.5">
            <div className="mb-1 text-[10px] font-medium text-muted-foreground">生成预览（plugin.toml + 保存位置 plugins/{id}/）</div>
            <pre className="max-h-28 overflow-auto font-mono text-[10px] leading-relaxed text-foreground/80">{buildToml()}</pre>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/50 px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("common.cancel", "取消")}</Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            <span className="ml-1">保存并安装</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
