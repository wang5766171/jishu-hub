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
} from "lucide-react";
import { createPortal } from "react-dom";
// 3a-4：描述功能 → 实时推荐类型。
import { recommendIntent, intentLabel } from "./plugin-intent-recommend";

export type CreateEntryChoice =
  | { kind: "agent-tool" } // → PluginCreateDialog（agents 流程）
  | { kind: "session-composed" } // → PluginComposeDialog（组合式向导）
  | { kind: "pipeline-guide" } // 流水线指引卡（V2 3c 专属向导前的落点）
  | { kind: "hybrid-guide" } // 混合代码指引卡（V2 3b 编辑器向导前的落点）
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
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="max-h-[86vh] w-[min(640px,92vw)] overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-2xl">
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
    </div>,
    document.body,
  );
}

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
  const [guide, setGuide] = useState<"pipeline" | "hybrid" | null>(null);
  const [describeText, setDescribeText] = useState("");
  if (!open) return null;

  const cards: Array<{
    key: CreateEntryChoice["kind"];
    icon: typeof Bot;
    title: string;
    desc: string;
    ready: boolean;
  }> = [
    {
      key: "agent-tool",
      icon: Bot,
      title: t("plugins.entryAgentTool", "智能体工具"),
      desc: t("plugins.entryAgentToolDesc", "给 AI 新能力：CLI 命令、MCP 服务、skill 知识、自建智能体"),
      ready: true,
    },
    {
      key: "session-composed",
      icon: LayoutDashboard,
      title: t("plugins.entrySession", "会话界面插件"),
      desc: t("plugins.entrySessionDesc", "在会话中显示内容：数据面板、通知提醒、内容渲染（零代码）"),
      ready: true,
    },
    {
      key: "pipeline-guide",
      icon: ListChecks,
      title: t("plugins.entryPipeline", "任务流水线"),
      desc: t("plugins.entryPipelineDesc", "多阶段工作流编排：讨论→设计→执行→审查"),
      ready: false,
    },
    {
      key: "hybrid-guide",
      icon: Code2,
      title: t("plugins.entryHybrid", "混合代码插件"),
      desc: t("plugins.entryHybridDesc", "写自定义代码的会话界面插件（TOML + component.js）"),
      ready: false,
    },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[min(680px,92vw)] rounded-xl border border-border bg-background p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">
            {t("plugins.entryTitle", "你想创建什么类型的插件？")}
          </div>
          <button type="button" onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {cards.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                if (c.key === "pipeline-guide") {
                  setGuide("pipeline");
                } else if (c.key === "hybrid-guide") {
                  setGuide("hybrid");
                } else {
                  onOpenChange(false);
                  onChoose({ kind: c.key } as CreateEntryChoice);
                }
              }}
              className="group flex flex-col items-start gap-2 rounded-lg border border-border bg-muted/20 p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <div className="flex items-center gap-2">
                <c.icon className="h-5 w-5 text-primary/80" />
                <span className="text-sm font-medium text-foreground">{c.title}</span>
                {!c.ready && (
                  <span className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t("plugins.entryGuideMode", "指引模式")}
                  </span>
                )}
              </div>
              <span className="text-xs leading-relaxed text-muted-foreground">{c.desc}</span>
            </button>
          ))}
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
    </div>,
    document.body,
  );
}
