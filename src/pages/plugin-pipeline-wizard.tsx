/**
 * 流水线插件可视化向导（v0.9.5 需求1（原需求26）3c）。
 *
 * 列表式阶段编排器（风险表裁决：先列表后拖拽）：阶段列表 + 添加/删除/
 * 上移下移 + 每阶段模板（phase.discuss/plan/execute/review）或自定义
 * （prompt/gate）→ TOML 生成预览 → composed_plugin_save 保存（1a 后流水线
 * 清单可不写 source/render，保存后出现在插件中心「流水线」tab）。
 */
import { UniModal, UniModalHeader } from "@/components/ui/uni-modal";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { invokeCommand } from "@/hooks/use-invoke";
import {
  STAGE_TEMPLATES,
  type StageTemplateKey,
} from "@/features/session-kernel/capabilities/pipeline/contracts";

interface StageDraft {
  name: string;
  template: StageTemplateKey | "custom";
  prompt: string;
  gate: boolean;
}

const TEMPLATE_KEYS = Object.keys(STAGE_TEMPLATES) as StageTemplateKey[];

function newStage(): StageDraft {
  return { name: "", template: "phase.discuss", prompt: "", gate: false };
}

function tomlStr(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function PluginPipelineWizard({
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
  const [description, setDescription] = useState("");
  const [stages, setStages] = useState<StageDraft[]>([
    { name: "需求讨论", template: "phase.discuss", prompt: "", gate: false },
    { name: "执行", template: "phase.execute", prompt: "", gate: false },
  ]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const id = useMemo(() => {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
    return `session.${slug}`;
  }, [name]);

  const buildToml = (): string => {
    const lines: string[] = [];
    lines.push("[plugin]");
    lines.push(`id = ${tomlStr(id)}`);
    lines.push(`name = ${tomlStr(name.trim() || "流水线")}`);
    if (description.trim()) lines.push(`description = ${tomlStr(description.trim())}`);
    lines.push('kind = "session-composed"');
    for (const stage of stages) {
      lines.push("");
      lines.push("[[pipeline.stages]]");
      lines.push(`name = ${tomlStr(stage.name.trim() || (stage.template !== "custom" ? STAGE_TEMPLATES[stage.template].name : "阶段"))}`);
      if (stage.template !== "custom") {
        lines.push(`template = ${tomlStr(stage.template)}`);
      }
      if (stage.prompt.trim()) {
        lines.push(`prompt = ${tomlStr(stage.prompt.trim())}`);
      }
      if (stage.gate) {
        lines.push('gate = "confirm"');
      }
    }
    return lines.join("\n") + "\n";
  };

  const save = async () => {
    if (!name.trim()) {
      await alertDialog({ title: "请填写流水线名称" });
      return;
    }
    if (stages.length === 0) {
      await alertDialog({ title: "流水线至少需要一个阶段" });
      return;
    }
    setSaving(true);
    try {
      await invokeCommand("composed_plugin_save", { id, toml: buildToml() });
      onCreated?.();
      onOpenChange(false);
    } catch (e) {
      await alertDialog({ title: "保存失败", description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  const label = "mb-1 block text-[11px] font-medium text-muted-foreground";
  const inputCls = "h-7 w-full rounded-md border border-border/70 bg-transparent px-2 text-xs outline-none focus:border-primary/60";

  const patch = (i: number, next: Partial<StageDraft>): void => {
    setStages((prev) => prev.map((s, j) => (j === i ? { ...s, ...next } : s)));
  };
  const move = (i: number, delta: number): void => {
    setStages((prev) => {
      const j = i + delta;
      if (j < 0 || j >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(i, 1);
      copy.splice(j, 0, item);
      return copy;
    });
  };

  return (
    <UniModal open={open} onClose={() => onOpenChange(false)} size="lg" label="流水线向导">
      <UniModalHeader
        title="流水线向导（阶段编排）"
        subtitle="编排多阶段工作流——阶段优先用内置模板（讨论/规划/执行/评审），自定义阶段写提示词与门禁"
        trailing={<span className="font-mono text-[10px] text-muted-foreground/70">{id}</span>}
        onClose={() => onOpenChange(false)}
      />
        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>名称 *</span>
              <Input className="h-7 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：视频制作" />
            </div>
            <div>
              <span className={label}>说明</span>
              <Input className="h-7 text-xs" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话用途" />
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">阶段编排（{stages.length} 个，自上而下依次执行）</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  setStages((prev) => [...prev, newStage()]);
                  setExpanded(stages.length);
                }}
              >
                <Plus className="h-3 w-3" />
                <span className="ml-1">添加阶段</span>
              </Button>
            </div>
            <div className="space-y-1.5">
              {stages.map((stage, i) => (
                <div key={i} className="rounded-lg border border-border/70">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground">
                      {i + 1}
                    </span>
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setExpanded(expanded === i ? null : i)}
                    >
                      <span className="text-xs font-medium">
                        {stage.name.trim() || (stage.template !== "custom" ? STAGE_TEMPLATES[stage.template].name : "（未命名）")}
                      </span>
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        {stage.template !== "custom" ? `模板 ${stage.template}` : "自定义"}
                        {stage.gate ? " · 需确认" : ""}
                      </span>
                    </button>
                    <button type="button" title="上移" onClick={() => move(i, -1)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button type="button" title="下移" onClick={() => move(i, 1)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title="删除阶段"
                      onClick={() => setStages((prev) => prev.filter((_, j) => j !== i))}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  {expanded === i && (
                    <div className="space-y-2 border-t border-border/50 bg-muted/10 px-3 py-2.5">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className={label}>阶段名</span>
                          <Input
                            className="h-7 text-xs"
                            value={stage.name}
                            onChange={(e) => patch(i, { name: e.target.value })}
                            placeholder={stage.template !== "custom" ? STAGE_TEMPLATES[stage.template].name : "如：分镜设计"}
                          />
                        </div>
                        <div>
                          <span className={label}>阶段来源</span>
                          <select
                            className={inputCls}
                            value={stage.template}
                            onChange={(e) => patch(i, { template: e.target.value as StageTemplateKey | "custom" })}
                          >
                            {TEMPLATE_KEYS.map((k) => (
                              <option key={k} value={k}>{STAGE_TEMPLATES[k].name}（{k}）</option>
                            ))}
                            <option value="custom">自定义</option>
                          </select>
                        </div>
                      </div>
                      {stage.template !== "custom" && (
                        <div className="text-[10px] leading-relaxed text-muted-foreground">
                          {STAGE_TEMPLATES[stage.template].description}
                        </div>
                      )}
                      <div>
                        <span className={label}>提示词{stage.template !== "custom" ? "（追加在模板基座上）" : " *"}</span>
                        <textarea
                          className="min-h-16 w-full rounded-md border border-border/70 bg-transparent px-2 py-1.5 text-xs outline-none focus:border-primary/60"
                          value={stage.prompt}
                          onChange={(e) => patch(i, { prompt: e.target.value })}
                          placeholder={stage.template === "custom" ? "该阶段的指令（必填）" : "对模板提示词的补充（可选）"}
                        />
                      </div>
                      <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={stage.gate}
                          onChange={(e) => patch(i, { gate: e.target.checked })}
                          className="h-3 w-3 accent-primary"
                        />
                        进下一阶段前需要用户确认（gate = "confirm"）
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg bg-muted/40 p-2.5">
            <div className="mb-1 text-[10px] font-medium text-muted-foreground">生成预览（plugin.toml——流水线清单无需 source/render）</div>
            <pre className="max-h-36 overflow-auto font-mono text-[10px] leading-relaxed text-foreground/80">{buildToml()}</pre>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/50 px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("common.cancel", "取消")}</Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            <span className="ml-1">创建流水线</span>
          </Button>
        </div>
    </UniModal>
  );
}
