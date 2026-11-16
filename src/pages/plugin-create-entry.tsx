/**
 * 统一插件创建入口（v0.9.7 需求7 修1e/1f/1c 重构）。
 *
 * 用户原话交互诉求：「用户自然操作应该就跳转到会话创建……逻辑上是我点选
 * 分类之后，将我选择的内容带过去进行创建，手动创建反而得点选特殊按钮才行」：
 * - 点分类卡 = 主路径——带模板描述跳会话创建（AI 代做）；
 * - 不点选、直接输入描述 → 会话创建（保留）；
 * - 手动向导（主题/组合/混合/流水线）= 次要特殊入口（折叠区）。
 *
 * 分类与已安装列表统一（八类口径）：智能体/会话能力/MCP/skill 工具/CLI 工具/
 * 自定义插件（含流水线）/外观；核心引擎不可新建（仅筛选）。
 */
import { useTranslation } from "react-i18next";
import { useState } from "react";
import {
  Bot,
  Code2,
  FileCode2,
  LayoutDashboard,
  Lightbulb,
  Palette,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { UniModal } from "@/components/ui/uni-modal";
import { cn } from "@/lib/utils";

export type CreateEntryChoice =
  | { kind: "agent-tool" } // → 手动：agents 向导
  | { kind: "session-composed"; face?: SessionPluginFace }
  | { kind: "pipeline-guide" }
  | { kind: "hybrid-guide"; face?: SessionPluginFace }
  | { kind: "theme-wizard" }
  | { kind: "describe"; text: string }; // 主路径：会话创建（分类模板或自由描述）

export type SessionPluginFace = "panel" | "widget" | "render" | "action";

/** 分类卡（v0.9.7 需求3 五类口径：自建智能体暂不支持——用户裁决 2026-11-14，
 * 智能体卡撤除，此类意图并入自定义模板；核心引擎不在创建面）。
 * 第五轮评审 P2-1：副标题此前硬编码中文（英文态泄漏）——i18n 化，
 * descKey/descFallback 双轨与标题同款。 */
const CATEGORY_CARDS: Array<{
  key: string;
  icon: typeof Bot;
  titleKey: string;
  titleFallback: string;
  descKey: string;
  descFallback: string;
  template: string;
}> = [
  {
    key: "session",
    icon: LayoutDashboard,
    titleKey: "plugins.catSession",
    titleFallback: "会话能力",
    descKey: "plugins.catSessionDesc",
    descFallback: "面板 / 挂件 / 会话内渲染与交互",
    template: "我想创建一个会话能力插件（面板/挂件/会话内渲染），需求是：",
  },
  {
    key: "mcp",
    icon: Terminal,
    titleKey: "plugins.typeMcp",
    titleFallback: "MCP",
    descKey: "plugins.typeMcpDesc",
    descFallback: "注册 MCP 服务（结构化外部能力）",
    template: "我想注册一个 MCP 服务插件（数据库/API/内部系统等结构化能力）。",
  },
  {
    key: "skill",
    icon: FileCode2,
    titleKey: "plugins.typeSkill",
    titleFallback: "skill 工具",
    descKey: "plugins.typeSkillDesc",
    descFallback: "把可复用流程固化成技能",
    template: "我想创建一个 skill 工具插件（把可复用流程固化成技能），流程是：",
  },
  {
    key: "cli",
    icon: Wrench,
    titleKey: "plugins.typeCli",
    titleFallback: "CLI 工具",
    descKey: "plugins.typeCliDesc",
    descFallback: "命令行能力单元",
    template: "我想创建一个 CLI 工具插件（命令行能力），功能是：",
  },
  {
    key: "custom",
    icon: Code2,
    titleKey: "plugins.catCustom",
    titleFallback: "自定义插件",
    descKey: "plugins.catCustomDesc",
    descFallback: "自由形态（含流水线/菜单入口）",
    template: "我想创建一个自定义插件（形态不限，可以是流水线或菜单入口），需求是：",
  },
  {
    key: "appearance",
    icon: Palette,
    titleKey: "plugins.catAppearance",
    titleFallback: "外观",
    descKey: "plugins.catAppearanceDesc",
    descFallback: "主题 / 配色 / 聊天背景",
    template: "我想创建一个外观主题插件（配色/聊天背景）。",
  },
];

/** 手动向导快捷入口（次要——特殊按钮）。第五轮评审 P2-1：整块硬编码
 * 中文——i18n 化（专用短键 wiz.entryWizards.*，与向导页自身的长标题键
 * 分开——入口卡要的是一行短文案）。 */
const MANUAL_WIZARDS: Array<{
  kind: CreateEntryChoice["kind"];
  labelKey: string;
  labelFallback: string;
  descKey: string;
  descFallback: string;
}> = [
  {
    kind: "theme-wizard",
    labelKey: "plugins.wiz.entryWizards.theme",
    labelFallback: "主题向导",
    descKey: "plugins.wiz.entryWizards.themeDesc",
    descFallback: "可视化调色板",
  },
  {
    kind: "session-composed",
    labelKey: "plugins.wiz.entryWizards.composed",
    labelFallback: "组合式向导",
    descKey: "plugins.wiz.entryWizards.composedDesc",
    descFallback: "TOML 清单零代码",
  },
  {
    kind: "hybrid-guide",
    labelKey: "plugins.wiz.entryWizards.hybrid",
    labelFallback: "混合代码向导",
    descKey: "plugins.wiz.entryWizards.hybridDesc",
    descFallback: "component.js 自定义",
  },
  {
    kind: "pipeline-guide",
    labelKey: "plugins.wiz.entryWizards.pipeline",
    labelFallback: "流水线向导",
    descKey: "plugins.wiz.entryWizards.pipelineDesc",
    descFallback: "多阶段编排",
  },
  {
    kind: "agent-tool",
    labelKey: "plugins.wiz.entryWizards.agent",
    labelFallback: "智能体向导",
    descKey: "plugins.wiz.entryWizards.agentDesc",
    descFallback: "agents 清单",
  },
];

export function PluginCreateEntry({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: CreateEntryChoice) => void;
}) {
  const { t } = useTranslation();
  const [describeText, setDescribeText] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  if (!open) return null;

  const goChat = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onOpenChange(false);
    onChoose({ kind: "describe", text: trimmed });
  };

  return (
    <UniModal
      open={open}
      onClose={() => onOpenChange(false)}
      className="w-[min(880px,94vw)]"
      label={t("plugins.entryTitleV2", "创建插件")}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-base font-semibold text-foreground">
              {t("plugins.entryTitleV2", "创建插件")}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("plugins.entryHintV2", "点选分类，AI 帮你把插件做出来（跳到会话继续）；也可以直接输入描述")}
            </div>
          </div>
          <button type="button" onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 分类卡（点选 = 带模板跳会话创建——自然主路径） */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {CATEGORY_CARDS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => goChat(c.template)}
              className="flex flex-col items-start gap-1.5 rounded-xl border border-border bg-muted/20 p-3.5 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                <c.icon className="h-4.5 w-4.5 text-primary" />
              </div>
              <span className="text-[13px] font-medium text-foreground">{t(c.titleKey, c.titleFallback)}</span>
              <span className="text-[11px] leading-snug text-muted-foreground">{t(c.descKey, c.descFallback)}</span>
            </button>
          ))}
        </div>

        {/* 自由描述（保留：不点选直接说） */}
        <div className="mt-5 rounded-xl border border-dashed border-border px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lightbulb className="h-4 w-4 shrink-0 text-amber-500" />
            {t("plugins.entryDescribeV2", "直接描述你想要的功能（可选）")}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              className="h-8 flex-1 rounded-md border border-border/70 bg-transparent px-2.5 text-xs outline-none focus:border-primary/60"
              value={describeText}
              onChange={(e) => setDescribeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") goChat(describeText);
              }}
              placeholder={t(
                "plugins.entryDescribePh",
                "如：帮我做个倒计时挂件 / 每轮结束显示花销 / 接入我们的内部 API",
              )}
            />
            <button
              type="button"
              disabled={!describeText.trim()}
              onClick={() => goChat(describeText)}
              className={cn(
                "shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                describeText.trim()
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "cursor-not-allowed bg-muted text-muted-foreground/50"
              )}
            >
              {t("plugins.entryGoChat", "去会话创建")}
            </button>
          </div>
        </div>

        {/* 手动向导（次要特殊入口） */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            className="text-[11px] text-muted-foreground/70 underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {manualOpen
              ? t("plugins.entryManualCollapse", "收起手动向导")
              : t("plugins.entryManualExpand", "想自己配？展开手动向导")}
          </button>
          {manualOpen && (
            <div className="mt-2 flex flex-wrap gap-2">
              {MANUAL_WIZARDS.map((w) => (
                <button
                  key={w.kind}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onChoose({ kind: w.kind } as CreateEntryChoice);
                  }}
                  className="flex flex-col items-start rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-left transition-colors hover:border-primary/40"
                >
                  <span className="text-xs font-medium text-foreground">{t(w.labelKey, w.labelFallback)}</span>
                  <span className="text-[10px] text-muted-foreground">{t(w.descKey, w.descFallback)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </UniModal>
  );
}
