/**
 * 混合插件可视化向导（v0.9.5 需求1（原需求26）3b）。
 *
 * 结构（01 §二 C）：基本信息（id/源/挂载——@file: 限定数据面挂载）→
 * 代码编辑（CodeEditor 实时语法/契约校验 + API v1 参考面板 + 实时预览
 * HybridPreviewPanel）→ 保存（hybrid_plugin_save → 默认禁用 + 确认卡启用）。
 */
import { UniModal, UniModalHeader } from "@/components/ui/uni-modal";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeEditor } from "@/components/code-editor";
import { HybridPreviewPanel } from "@/components/hybrid-preview-panel";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { invokeCommand } from "@/hooks/use-invoke";
import { composedIdTaken, slugify } from "./plugin-wizard-utils";

type HybridSourceType = "messages" | "turns" | "task" | "stream-state";
type HybridMount = "dock-panel" | "rail-widget" | "sidebar-panel" | "composer-trailing";

// 三轮评审 P1-5：label 改 i18n 键（渲染点翻译，语言切换即生效）。
const SOURCE_TYPES: Array<{ value: HybridSourceType; labelKey: string; hint: string }> = [
  { value: "messages", labelKey: "plugins.wiz.srcMessages", hint: "props.payload.data = Message[]（可配聚合器）" },
  { value: "turns", labelKey: "plugins.wiz.srcTurns", hint: "props.payload.turns / activeIndex / jump(i)" },
  { value: "task", labelKey: "plugins.wiz.srcTask", hint: "props.payload.task" },
  { value: "stream-state", labelKey: "plugins.wiz.srcStreamState", hint: "同消息流形态" },
];

const MOUNTS: Array<{ value: HybridMount; labelKey: string }> = [
  { value: "dock-panel", labelKey: "plugins.wiz.mountDock" },
  { value: "rail-widget", labelKey: "plugins.wiz.mountRail" },
  { value: "sidebar-panel", labelKey: "plugins.wiz.mountSidebar" },
  { value: "composer-trailing", labelKey: "plugins.wiz.mountComposer" },
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
  presetMount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  /** 批次6：创建入口业务形态预选挂载（面板→dock-panel/挂件→rail-widget）。 */
  presetMount?: "dock-panel" | "rail-widget" | "sidebar-panel" | "composer-trailing";
}) {
  const { t } = useTranslation();
  const { alert: alertDialog } = useConfirmDialog();
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<HybridSourceType>("messages");
  const [mount, setMount] = useState<HybridMount>(presetMount ?? "dock-panel");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showApiRef, setShowApiRef] = useState(true);

  // 三轮评审 P1-3：slugify Unicode 感知——修前纯中文名全部坍缩为
  // session.hybrid 互相静默覆盖。
  const id = useMemo(() => `session.${slugify(name, "hybrid")}`, [name]);

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
      await alertDialog({ title: t("plugins.wiz.nameRequired", "请填写插件名称") });
      return;
    }
    if (!codeTouched || !effectiveCode.includes("JishuPlugin.register")) {
      await alertDialog({ title: t("plugins.wiz.registerMissing", "代码缺少 JishuPlugin.register 注册调用") });
      return;
    }
    // 三轮评审 P1-3：id 占用检测——同名插件已存在时阻止静默覆盖。
    if (await composedIdTaken(id)) {
      await alertDialog({
        title: t("plugins.wiz.idTaken", { id, defaultValue: "" }),
        description: t("plugins.wiz.idTakenDesc", ""),
      });
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
        title: t("plugins.wiz.savedDisabled", ""),
        description: t("plugins.wiz.savedDisabledDesc", ""),
      });
    } catch (e) {
      await alertDialog({ title: t("plugins.wiz.saveFailed", ""), description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  const label = "mb-1 block text-[11px] font-medium text-muted-foreground";
  const inputCls = "h-7 w-full rounded-md border border-border/70 bg-transparent px-2 text-xs outline-none focus:border-primary/60";

  // 批次1 统一弹窗：外壳收敛 UniModal（z-80/遮罩/Esc），编辑器/预览链不变。
  return (
    <UniModal open={open} onClose={() => onOpenChange(false)} className="w-[min(1020px,96vw)]" label={t("plugins.wiz.hybridTitle", "混合插件向导")}>
      <UniModalHeader
        title={t("plugins.wiz.hybridTitle", "混合插件向导") + "（TOML + component.js）"}
        subtitle={t("plugins.wiz.hybridSubtitle", "")}
        trailing={<span className="font-mono text-[10px] text-muted-foreground/70">{id}</span>}
        onClose={() => onOpenChange(false)}
      />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <span className={label}>{t("plugins.wiz.nameStar", "名称 *")}</span>
              <Input className="h-7 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("plugins.wiz.namePlaceholderHybrid", "")} />
            </div>
            <div>
              <span className={label}>{t("plugins.wiz.contentSource", "内容源")}</span>
              <select className={inputCls} value={sourceType} onChange={(e) => setSourceType(e.target.value as HybridSourceType)}>
                {SOURCE_TYPES.map((s) => (
                  <option key={s.value} value={s.value}>{t(s.labelKey, "")}</option>
                ))}
              </select>
              <div className="mt-0.5 text-[10px] text-muted-foreground/70">{SOURCE_TYPES.find((s) => s.value === sourceType)?.hint}</div>
            </div>
            <div>
              <span className={label}>{t("plugins.wiz.mountLabel", "挂载（@file: 限定数据面）")}</span>
              <select className={inputCls} value={mount} onChange={(e) => setMount(e.target.value as HybridMount)}>
                {MOUNTS.map((m) => (
                  <option key={m.value} value={m.value}>{t(m.labelKey, "")}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-[1fr_340px] gap-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">{t("plugins.wiz.codeSection", "")}</span>
                <button
                  type="button"
                  onClick={() => setShowApiRef((v) => !v)}
                  className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <BookOpen className="h-3 w-3" />
                  {t("plugins.wiz.apiRef", "API 参考")}
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
    </UniModal>
  );
}
