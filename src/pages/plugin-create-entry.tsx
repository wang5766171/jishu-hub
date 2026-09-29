/**
 * 统一插件创建入口（v0.9.5 需求1（原需求26）3a-1）：类型选择卡片页。
 *
 * 设计原则（用户原话）：「不是所有的插件都一个样，挨个选，挨个点，是有
 * 明确引导，明确适配插件类型的友好操作」——第一个问题是「你要造什么
 * 类型的插件？」，之后每步按类型分流，不同类型走不同流程。
 *
 * V1 分流落点：智能体工具 → agents 创建向导（PluginCreateDialog）；
 * 会话界面插件 → 组合式向导（PluginComposeDialog）；任务流水线 / 混合
 * 代码插件 → 指引卡（模板 TOML/代码 + CLI 安装命令——专属可视化向导
 * 分别为 V2 3c/3b 交付）；「描述功能」入口 → 引导到会话对话创建
 * （agent 读 jishu-plugin-authoring skill 四层指南，V1-4a 已部署）。
 */
import { useTranslation } from "react-i18next";
import { useState } from "react";
import {
  Bot,
  LayoutDashboard,
  ListChecks,
  Code2,
  Lightbulb,
  Copy,
  X,
  Activity,
  Bell,
} from "lucide-react";
import { UniModal } from "@/components/ui/uni-modal";
import { cn } from "@/lib/utils";
// 3a-4：描述功能 → 实时推荐类型。
import { recommendIntent, intentLabel } from "./plugin-intent-recommend";

export type CreateEntryChoice =
  | { kind: "agent-tool" } // → PluginCreateDialog（agents 流程）
  // 批次6：face = 业务形态预填（面板/挂件/渲染/动作——向导预选挂载用）。
  | { kind: "session-composed"; face?: SessionPluginFace } // → PluginComposeDialog（组合式向导）
  | { kind: "pipeline-guide" } // 流水线向导（V2 3c）
  | { kind: "hybrid-guide"; face?: SessionPluginFace } // 混合代码向导（V2 3b，face→presetMount）
  | { kind: "describe" }; // 描述功能 → 会话对话创建指引

const PIPELINE_TEMPLATE = `[plugin]
id = "session.my-flow"
name = "我的流水线"
description = "多阶段工作流"
kind = "session-composed"

[[pipeline.stages]]
name = "需求讨论"
template = "phase.discuss"

[[pipeline.stages]]
name = "执行"
prompt = "按已确认的方案执行"
gate = "confirm"`;

const HYBRID_TOML = `[plugin]
id = "session.my-hybrid"
name = "我的混合插件"
kind = "session-composed"

[source]
type = "messages"

[render]
component = "@file:component.js"
mount = "dock-panel"`;

const HYBRID_CODE = `JishuPlugin.register("session.my-hybrid", {
  version: 1,
  component: (api) => (props) =>
    api.h("div", { className: "p-2 text-sm" },
      "共 " + (props.payload.data?.length ?? 0) + " 条消息"),
});`;

// 批次6：多臂组合模板（流水线 + 渲染面板 + 动作自由组合——v3 双维度 X④）。
const COMBO_TEMPLATE = `[plugin]
id = "session.my-combo"
name = "我的组合插件"
description = "流水线+面板+动作多臂组合"
kind = "session-composed"

# 臂1：多阶段流水线（可整体删去）
[[pipeline.stages]]
name = "需求讨论"
template = "phase.discuss"

[[pipeline.stages]]
name = "执行"
prompt = "按已确认的方案执行"
gate = "confirm"

# 臂2：数据面板（可整体删去）
[source]
type = "messages"

[render]
component = "render.stats-list"
mount = "dock-panel"

# 臂3：回合事件动作（可整体删去）
[[action]]
type = "desktop-notify"`;

function GuideCard({
  title,
  steps,
  code,
  cli,
  onClose,
}: {
  title: string;
  steps: string[];
  code: string;
  cli: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };
  return (
    <UniModal open onClose={onClose} className="w-[min(640px,92vw)]" label={title}>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <div className="relative mt-3">
          <pre className="max-h-56 overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 text-[11px] leading-relaxed">{code}</pre>
          <button
            type="button"
            onClick={() => copy(code, "code")}
            className="absolute right-2 top-2 rounded-md border border-border/60 bg-background/80 p-1 text-muted-foreground hover:text-foreground"
            title={t("common.copy", "复制")}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        {copied === "code" && (
          <div className="mt-1 text-[11px] text-emerald-600">✓ {t("common.copied", "已复制")}</div>
        )}
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground/80">{cli}</code>
          <button
            type="button"
            onClick={() => copy(cli, "cli")}
            className="shrink-0 rounded-md border border-border/60 p-1 text-muted-foreground hover:text-foreground"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          💡 也可以直接在会话中告诉 agent 你想要的插件——它会按
          jishu-plugin-authoring 指南产出并安装（对话即创建）。
        </div>
      </div>
    </UniModal>
  );
}

export type SessionPluginFace = "panel" | "widget" | "render" | "action";

type EntryFace = SessionPluginFace | "pipeline" | "tool";

type EntryImpl = "config" | "code" | "combo";

/** 业务形态 × 可行实现（v3 双维度交叉矩阵的创建侧子集：✓向导直达 / guide=指引卡承接）。 */
const FACE_IMPLS: Record<EntryFace, Array<{ impl: EntryImpl; route: "compose" | "hybrid" | "pipeline" | "guide" }>> = {
  panel: [
    { impl: "config", route: "compose" },
    { impl: "code", route: "hybrid" },
    { impl: "combo", route: "guide" },
  ],
  widget: [
    { impl: "config", route: "compose" },
    { impl: "code", route: "hybrid" },
    { impl: "combo", route: "guide" },
  ],
  render: [
    { impl: "config", route: "compose" },
    { impl: "code", route: "guide" },
    { impl: "combo", route: "guide" },
  ],
  action: [
    { impl: "config", route: "compose" },
    { impl: "code", route: "guide" },
    { impl: "combo", route: "guide" },
  ],
  pipeline: [
    { impl: "config", route: "pipeline" },
    { impl: "combo", route: "guide" },
  ],
  tool: [], // 声明式定义——向导内配置，无实现选择
};

const FACES: Array<{ key: EntryFace; icon: typeof Bot; title: string; desc: string }> = [
  { key: "panel", icon: LayoutDashboard, title: "会话面板", desc: "悬浮/侧栏数据面板（会话大纲、统计类）" },
  { key: "widget", icon: Activity, title: "会话挂件", desc: "边缘细条/输入区小挂件（常驻轻展示）" },
  { key: "render", icon: Code2, title: "会话渲染", desc: "消息流内渲染（代码块/图表接管）" },
  { key: "action", icon: Bell, title: "会话动作", desc: "头部轻动作/通知（点按即执行）" },
  { key: "pipeline", icon: ListChecks, title: "流水线", desc: "多阶段工作流：讨论→设计→执行→审查" },
  { key: "tool", icon: Bot, title: "智能体工具", desc: "给 AI 新能力：CLI/MCP/Skill/自建智能体" },
];

const IMPLS: Array<{ key: EntryImpl; title: string; desc: string }> = [
  { key: "config", title: "纯配置", desc: "TOML 清单零代码，表单可改" },
  { key: "code", title: "写代码", desc: "component.js 自定义 TS/JS，带校验" },
  { key: "combo", title: "多臂组合", desc: "流水线+渲染+动作自由组合" },
];

export function PluginCreateEntry({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 选定类型后回调（父级打开对应向导；guide/describe 在本组件内消化）。 */
  onChoose: (choice: CreateEntryChoice) => void;
}) {
  const { t } = useTranslation();
  const [guide, setGuide] = useState<"pipeline" | "hybrid" | "combo" | null>(null);
  const [describeText, setDescribeText] = useState("");
  // 批次6：两步正交——Step1 业务形态（做什么·在哪用）× Step2 实现方式
  // （怎么造）——v3 双维度交叉矩阵的创建侧落地。
  const [face, setFace] = useState<EntryFace | null>(null);
  if (!open) return null;

  const faceImpls = face ? FACE_IMPLS[face] : [];

  // 实现方式点击即分流（少一跳）：向导直达 / 指引卡组件内弹出。
  const dispatchImpl = (impl: EntryImpl) => {
    if (!face) return;
    const route = faceImpls.find((x) => x.impl === impl)?.route;
    if (!route) return;
    onOpenChange(false);
    if (route === "compose") {
      onChoose({ kind: "session-composed", face: face as SessionPluginFace });
    } else if (route === "hybrid") {
      onChoose({ kind: "hybrid-guide", face: face as SessionPluginFace });
    } else if (route === "pipeline") {
      onChoose({ kind: "pipeline-guide" });
    } else {
      // 组合/代码渲染：多臂 TOML 指引（V2 3b/3c 专属向导前落点）。
      onOpenChange(true);
      setGuide("combo");
    }
  };

  return (
    <>
    <UniModal open={open} onClose={() => onOpenChange(false)} className="w-[min(680px,92vw)]" label={t("plugins.entryTitle", "你想创建什么类型的插件？")}>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">
            {t("plugins.entryTitle", "你想创建什么类型的插件？")}
          </div>
          <button type="button" onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* 批次6：两步正交——左 Step1 业务形态（做什么·在哪用），右 Step2
            实现方式（怎么造·按业务过滤可行性，点击即分流）。 */}
        <div className="mt-4 grid grid-cols-2 gap-4">
          {/* Step1 业务形态 */}
          <div>
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">
              ① {t("plugins.entryStepFace", "业务形态（做什么·在哪用）")}
            </div>
            <div className="space-y-2">
              {FACES.map((f) => {
                const active = face === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => {
                      setFace(f.key);
                      // 智能体工具：声明式定义无实现选择，直达 agents 向导。
                      if (f.key === "tool") {
                        onOpenChange(false);
                        onChoose({ kind: "agent-tool" });
                      }
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                      active
                        ? "border-primary/60 bg-primary/5"
                        : "border-border bg-muted/20 hover:border-primary/40 hover:bg-primary/5",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <f.icon className={cn("h-4 w-4", active ? "text-primary" : "text-primary/70")} />
                      <span className="text-[13px] font-medium text-foreground">{f.title}</span>
                    </div>
                    <span className="text-[11px] leading-relaxed text-muted-foreground">{f.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {/* Step2 实现方式 */}
          <div>
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">
              ② {t("plugins.entryStepImpl", "实现方式（怎么造）")}
            </div>
            {!face || face === "tool" ? (
              <div className="flex h-full min-h-[200px] items-center justify-center rounded-lg border border-dashed border-border/60 p-4 text-center text-[11px] text-muted-foreground/70">
                {face === "tool"
                  ? t("plugins.entryToolNoImpl", "智能体工具为声明式定义——已在左侧直达创建向导")
                  : t("plugins.entryPickFaceFirst", "先在左侧选择业务形态，再选实现方式")}
              </div>
            ) : (
              <div className="space-y-2">
                {IMPLS.filter((im) => faceImpls.some((fi) => fi.impl === im.key)).map((im) => {
                  const route = faceImpls.find((fi) => fi.impl === im.key)?.route;
                  return (
                    <button
                      key={im.key}
                      type="button"
                      onClick={() => dispatchImpl(im.key)}
                      className="flex w-full flex-col items-start gap-1 rounded-lg border border-border bg-muted/20 p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-[13px] font-medium text-foreground">{im.title}</span>
                        {route === "guide" ? (
                          <span className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {t("plugins.entryGuideMode", "指引模式")}
                          </span>
                        ) : (
                          <span className="text-[10px] text-primary/70">{t("plugins.entryWizardMode", "向导直达")}</span>
                        )}
                      </div>
                      <span className="text-[11px] leading-relaxed text-muted-foreground">{im.desc}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-dashed border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lightbulb className="h-4 w-4 shrink-0 text-amber-500" />
            {t("plugins.entryDescribe", "不确定？描述你想要的功能，我来推荐类型")}
          </div>
          <input
            className="mt-2 h-7 w-full rounded-md border border-border/70 bg-transparent px-2 text-xs outline-none focus:border-primary/60"
            value={describeText}
            onChange={(e) => setDescribeText(e.target.value)}
            placeholder="如：每轮结束在输入框旁显示花销 / 让 AI 能搜索网页"
          />
          {(() => {
            const rec = recommendIntent(describeText);
            if (!rec) return null;
            const composed = rec.intent === "data-panel" || rec.intent === "notify" || rec.intent === "content-render" || rec.intent === "navigation";
            const jump = () => {
              onOpenChange(false);
              if (composed) onChoose({ kind: "session-composed" });
              else if (rec.intent === "pipeline") setGuide("pipeline");
              else if (rec.intent === "hybrid") setGuide("hybrid");
              else onChoose({ kind: "agent-tool" });
            };
            return (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5">
                <span className="min-w-0 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{intentLabel(rec.intent)}</span>
                  <span className="ml-1.5">{rec.reason}</span>
                </span>
                <button
                  type="button"
                  onClick={jump}
                  className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {t("plugins.entryGo", "去创建")}
                </button>
              </div>
            );
          })()}
          <div className="mt-1.5 text-[10px] text-muted-foreground/70">
            也可以直接在会话中告诉 agent——它会按插件创作指南（jishu-plugin-authoring）产出并安装。
          </div>
        </div>
      </div>
    </UniModal>
      {guide === "combo" && (
        <GuideCard
          title={t("plugins.comboGuideTitle", "多臂组合插件 · 创建指引")}
          steps={[
            "新建目录，创建 plugin.toml（下方模板可复制）——多臂 = 流水线/渲染面板/动作在同一清单声明，按需删减",
            "每臂独立生效：流水线进插件中心「流水线」tab，面板经能力中心调出，动作在事件触发时执行",
            "校验：jishu-cli plugins validate <目录>（hub 运行中为完整校验）",
            "安装后热生效；详情页「设置」可调使用行为（归所/自动展开/作用域）",
          ]}
          code={COMBO_TEMPLATE}
          cli="jishu-cli plugins add <目录或 toml 路径>"
          onClose={() => setGuide(null)}
        />
      )}
      {guide === "pipeline" && (
        <GuideCard
          title={t("plugins.pipelineGuideTitle", "任务流水线 · 创建指引")}
          steps={[
            "新建目录，创建 plugin.toml（下方模板可复制）——阶段优先用内置模板 phase.discuss / phase.plan / phase.execute / phase.review",
            "自定义阶段写 prompt（对阶段的指令）与 gate = \"confirm\"（进下一阶段前需确认）",
            "校验：jishu-cli plugins validate <目录>（hub 运行中为完整校验）",
            "安装后到插件中心「流水线」tab 启用，详情页可「作为任务启动」",
          ]}
          code={PIPELINE_TEMPLATE}
          cli="jishu-cli plugins add <目录或 toml 路径>"
          onClose={() => setGuide(null)}
        />
      )}
      {guide === "hybrid" && (
        <GuideCard
          title={t("plugins.hybridGuideTitle", "混合代码插件 · 创建指引")}
          steps={[
            "新建目录，放 plugin.toml 与 component.js（下方模板可复制）",
            "component.js 必须含 JishuPlugin.register(\"<id>\", { version: 1, component })——两参数形态",
            "校验：jishu-cli plugins validate <目录>（含代码契约检查）",
            "安装后经确认卡启用（默认禁用是安全阀）；渲染崩溃会自动停用并提示",
          ]}
          code={`${HYBRID_TOML}\n\n# component.js（同目录）\n${HYBRID_CODE}`}
          cli="jishu-cli plugins add-hybrid <目录>"
          onClose={() => setGuide(null)}
        />
      )}
    </>
  );
}
