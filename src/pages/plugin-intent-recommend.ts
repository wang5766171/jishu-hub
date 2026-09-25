/**
 * 插件意图推荐（v0.9.5 需求1（原需求26）3a-4）：功能描述 → 插件类型与
 * 积木组合推荐。本地规则匹配（关键词计分），供统一创建入口与组合向导的
 * 「描述功能」输入共用；agent 对话创建有更完整的判断（skill 四层指南），
 * 这里服务 GUI 场景的零延迟推荐。
 */

export type PluginIntent =
  | "data-panel" // 数据面板：统计/列表/图表
  | "notify" // 通知提醒：桌面通知/状态指示
  | "content-render" // 内容渲染：代码块/块类型增强显示
  | "navigation" // 导航辅助：轮次导航/大纲
  | "pipeline" // 任务流水线（→ 指引卡）
  | "agent-tool" // 智能体工具（→ agents 向导）
  | "hybrid"; // 需要自定义代码（→ 混合向导指引）

export interface IntentRecommendation {
  intent: PluginIntent;
  /** 推荐理由（命中关键词摘要，给用户置信依据）。 */
  reason: string;
  /** 积木组合预填（组合向导消费；非会话侧形态为 null）。 */
  preset:
    | {
        sourceType: "code-block" | "block-type" | "messages" | "turns" | "signal";
        component?: string;
        mount: string;
        /** 是否预置桌面通知动作。 */
        notifyAction?: boolean;
        languages?: string;
        blockTypes?: string;
      }
    | null;
}

interface Rule {
  intent: PluginIntent;
  keywords: Array<[string, number]>; // [关键词, 权重]
}

const RULES: Rule[] = [
  {
    intent: "notify",
    keywords: [
      ["通知", 3], ["提醒", 3], ["弹窗", 2], ["桌面", 1], ["完成时", 2],
      ["notify", 2], ["失败时", 2], ["审批", 1], ["响铃", 2],
    ],
  },
  {
    intent: "data-panel",
    keywords: [
      ["统计", 3], ["面板", 2], ["看板", 3], ["图表", 2], ["列表", 1],
      ["显示数据", 3], ["用量", 2], ["花费", 2], ["花销", 2], ["成本", 2],
      ["次数", 2], ["dashboard", 2], ["监控", 2], ["显示", 1], ["每轮", 1], ["花了", 2],
    ],
  },
  {
    intent: "content-render",
    keywords: [
      ["代码块", 3], ["渲染", 2], ["mermaid", 3], ["latex", 3], ["katex", 3],
      ["高亮", 2], ["图表语法", 2], ["美化", 2], ["预览代码", 2],
    ],
  },
  {
    intent: "navigation",
    keywords: [
      ["导航", 3], ["轮次", 2], ["跳转", 2], ["大纲", 3], ["目录", 2],
      ["快速定位", 2], ["回到底部", 1], ["回合", 1],
    ],
  },
  {
    intent: "pipeline",
    keywords: [
      ["流水线", 3], ["阶段", 2], ["工作流", 2], ["多步骤", 2], ["编排", 3],
      ["先讨论", 2], ["分镜", 2], ["逐步", 1],
    ],
  },
  {
    intent: "agent-tool",
    keywords: [
      ["工具", 2], ["让 ai", 3], ["让ai", 3], ["ai 能", 2], ["命令", 2],
      ["mcp", 3], ["知识", 1], ["搜索", 1], ["生成二维码", 2], ["能力", 1],
    ],
  },
  {
    intent: "hybrid",
    keywords: [["自定义代码", 3], ["写代码", 2], ["组件", 1], ["现有积木", 3], ["不够用", 2]],
  },
];

/** 积木组合预设（intent → 组合向导预填）。 */
const PRESETS: Partial<Record<PluginIntent, IntentRecommendation["preset"]>> = {
  "data-panel": { sourceType: "messages", component: "render.list", mount: "dock-panel" },
  notify: { sourceType: "signal", component: "render.none", mount: "event-hook", notifyAction: true },
  "content-render": { sourceType: "code-block", component: "render.mermaid", mount: "block-renderer", languages: "mermaid" },
  navigation: { sourceType: "turns", component: "render.list", mount: "rail-widget" },
};

const INTENT_LABEL: Record<PluginIntent, string> = {
  "data-panel": "数据面板",
  notify: "通知提醒",
  "content-render": "内容渲染",
  navigation: "导航辅助",
  pipeline: "任务流水线",
  "agent-tool": "智能体工具",
  hybrid: "混合代码插件",
};

export function intentLabel(intent: PluginIntent): string {
  return INTENT_LABEL[intent];
}

/** 描述 → 推荐（计分最高者；零命中返回 null——追问用户细节）。 */
export function recommendIntent(description: string): IntentRecommendation | null {
  const text = description.trim().toLowerCase();
  if (!text) return null;
  const scores = new Map<PluginIntent, { score: number; hits: string[] }>();
  for (const rule of RULES) {
    for (const [kw, weight] of rule.keywords) {
      if (text.includes(kw)) {
        const cur = scores.get(rule.intent) ?? { score: 0, hits: [] };
        cur.score += weight;
        cur.hits.push(kw);
        scores.set(rule.intent, cur);
      }
    }
  }
  if (scores.size === 0) return null;
  let best: PluginIntent | null = null;
  let bestScore = 0;
  for (const [intent, { score }] of scores) {
    if (score > bestScore) {
      best = intent;
      bestScore = score;
    }
  }
  if (!best) return null;
  const hits = scores.get(best)?.hits ?? [];
  return {
    intent: best,
    reason: `命中「${hits.slice(0, 4).join("、")}」→ 推荐${INTENT_LABEL[best]}`,
    preset: PRESETS[best] ?? null,
  };
}

/** 组合向导的四个功能定位卡（3a-3：选定位 → 推荐积木预填）。 */
export const INTENT_CARDS: Array<{
  intent: Extract<PluginIntent, "data-panel" | "notify" | "content-render" | "navigation">;
  title: string;
  desc: string;
}> = [
  { intent: "data-panel", title: "数据面板", desc: "统计、列表、图表——停靠在会话侧边" },
  { intent: "notify", title: "通知提醒", desc: "回合完成/审批/失败时弹桌面通知" },
  { intent: "content-render", title: "内容渲染", desc: "特定代码块/消息块的增强显示" },
  { intent: "navigation", title: "导航辅助", desc: "轮次导航、大纲、快速跳转" },
];
