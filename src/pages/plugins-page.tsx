import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { NativeMcpSection } from "./native-mcp-section";
import { AgentLogo, useAgent } from "@/agents";
import { PluginIcon } from "@/components/ui/icon-picker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { AlertCircle, Download, ExternalLink, Loader2, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 , Bug as BugIcon, Package } from "lucide-react";
import type { AgentStatus } from "@/agents/types";
import { PluginCreateDialog } from "./plugin-create-dialog";
import { PluginDetailModal, type DrawerPluginInfo } from "./plugin-detail-modal";
import { generalizeEngineCodename } from "./engine-codename";
import { PluginComposeDialog } from "./plugin-compose-dialog";
// 3b（v0.9.5 需求1）：混合插件可视化向导（编辑器 + 预览 + API 参考）。
import { PluginHybridWizard } from "./plugin-hybrid-wizard";
// 3c（v0.9.5 需求1）：流水线向导（列表式阶段编排器）。
import { PluginPipelineWizard } from "./plugin-pipeline-wizard";
// 需求14 补齐：主题可视化向导。
import { PluginThemeWizard } from "./plugin-theme-wizard";
// 3a-1（v0.9.5 需求1，原需求26）：统一创建入口——类型选择卡片页分流。
import { PluginCreateEntry } from "./plugin-create-entry";
// v0.9.7 需求3 C2：插件市场面板（精选/扩展生态/技能市场三源一套交互）。
import { PluginMarketPanel } from "./plugin-market";
import { marketUpdateFailures, startExtensionUpdateAll, startSkillUpdateAll, updatesPending, useMarketUpdates, type ExtensionUpdateStatus, type SkillUpdateStatus } from "./plugin-market-updates";
import { MarketSearchBox } from "./plugin-market";
import { buildGuiAdaptDraft } from "@/components/market/gui-adapt-draft";
import { listSessionPlugins } from "@/features/session-kernel/plugins/registry";
import { isPluginForm, PLUGIN_FORM_VALUES, type PluginForm } from "./plugin-wizard-utils";
import { composedVersion, subscribeComposed } from "@/features/session-kernel/capabilities/composition/loader";
import { Info, Settings2, FileCode2, LayoutGrid, Pin, Bell, MousePointerClick, Palette, Layers, Rocket, Wrench } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LayoutDashboard } from "lucide-react";

/** v0.8.1 需求3：插件中心页（v0.9.3 需求11 更名）。数据源 plugin_list（需求2 的统一插件模型），
 * 启停/卸载/重载均热生效（后端重建 registry，无需重启应用）。
 * v0.8.1 需求5：承接原环境检测页的智能体安装检测（未安装展示安装命令与
 * 一键安装；核心引擎仍走环境检测页）。 */
interface PluginDescriptor {
  id: string;
  display_name: string;
  /** v0.9.3 需求11：中文说明（Rust 侧 [tool]/[skill] 首句或内置对照表；
   * session 插件走前端 i18n；null = 无来源，用类型兜底文案）。 */
  description?: string | null;
  kind: "builtin" | "manifest" | "tool" | "session";
  version: string | null;
  source_path: string | null;
  core: boolean;
  enabled: boolean;
  /** v0.9.0 需求1：声明了 [mcp] 段（hub 聚合 server 工具来源）。 */
  has_mcp?: boolean;
  /** v0.9.0 需求20：声明了 [skill] 段（skill 分发服务来源）。 */
  has_skill?: boolean;
  /** v0.9.0 需求19 第三轮：声明了 [pi_extension] 段（自适应/深度形态插件）。 */
  has_pi_extension?: boolean;
  /** info.icon 声明值（v0.9.0 需求19：图标注册表渲染，未知键回退 Bot）。 */
  icon?: string;
  /** v0.9.0 需求8：声明式面板（list 只读模板 MVP）。 */
  has_panel?: boolean;
  panel?: {
    title: string;
    items: Array<{ label: string; command: string }>;
  } | null;
  /** v0.9.0 需求1 二期：系统插件（hub 随包分发、幂等重部署）——不可卸载/
   * 编辑（mcp-resolver / task-requirements / task-plan），可禁用。 */
  system?: boolean;
  /** v0.9.3 需求13：组合式插件（manifest 装配；用户创建的可删除）。 */
  composed?: boolean;
  /** v0.9.5 需求1（原需求26）1d：声明了 [[pipeline.stages]]（流水线形态——
   * 插件中心独立「流水线」tab，不混入「会话能力」）。 */
  has_pipeline?: boolean;
  /** 需求14 M4（G10 分类显式化）：清单显式声明的业务分类（A 家族
   * [info].category / 组合家族 [plugin].category）——声明值优先于推断链。 */
  category?: string | null;
  /** v0.9.7 需求3（2026-11-14 标签裁决）：[info].form 形态显式声明
   *（session/sidebar/floating/none）；未声明按挂载位推导兜底。 */
  form?: string | null;
}

interface PluginListResult {
  plugins: PluginDescriptor[];
  manifest_errors: [string, string][];
}

/** 需求4 D4-8b：扩展统一登记簿视图（契约=Rust extension_registry_list，
 * snake_case）。 */
interface ExtGuiAdapter {
  plugin_id: string;
  enabled: boolean;
  cascade_disabled: boolean;
}
interface ExtGuiEntry {
  source: string;
  pkg_key: string;
  display: string;
  builtin: boolean;
  state: string;
  replaced_by: string | null;
  gui_verdict: string;
  verdict_note: string | null;
  adapters: ExtGuiAdapter[];
}
interface ExtGuiDep {
  pkg_key: string;
  display: string;
  state: string;
}

/** 需求19 第二轮：管理页分类。v0.9.7 需求3（2026-11-14 用户裁决）分类重整
 * 为**五类**：核心引擎/技能/MCP/扩展包/自定义与外观——智能体与系统能力
 * 归核心引擎；CLI 工具（代码开发+配置的混合场景）与自建智能体归自定义；
 * **兜底规则：无法明确归为技能、MCP、扩展包的插件一律归自定义**。
 * 旧八类声明值（存量清单 [info].category）经 LEGACY_CATEGORY_MAP 归一。 */
type PluginCategory = "core" | "skill" | "mcp" | "extension" | "custom";

/** 旧八类声明值 → 五类归一（存量清单兼容）。 */
const LEGACY_CATEGORY_MAP: Record<string, PluginCategory> = {
  core: "core",
  skill: "skill",
  mcp: "mcp",
  custom: "custom",
  appearance: "custom",
  cli: "custom",
  agent: "custom",
  session: "custom",
};

/** 需求14 M4-5（06 §5.3 △ 兑现）：呈现位徽标——会话插件卡片右上挂载位小
 *  图标组（title 中文呈现位），「装完即知在哪用」。 */


/** npm 源串解析正则（`npm:<pkg>[@<ver>]`，非贪婪取包名）——pkgOfSource
 * 与扩展卡渲染共用（第三轮评审修复：消除同文件双拷贝）。 */
const NPM_SOURCE_RE = /^npm:(.+?)@(.+)$/;

// 第三轮评审修复：label 字段为死数据（十七轮⑤ 后展示只走 FORM_BADGE 词
// 表，此处仅剩 icon 用途）——删除防口径漂移。
const MOUNT_FACE_ICONS: Record<string, typeof LayoutGrid> = {
  "block-renderer": FileCode2,
  "dock-panel": LayoutDashboard,
  "sidebar-panel": LayoutDashboard,
  "rail-widget": Pin,
  "composer-trailing": Pin,
  "event-hook": Bell,
  "header-action": MousePointerClick,
  "tool-result-renderer": Wrench,
  "app-theme": Palette,
  "app-overlay": Layers,
};

/** 需求7 修1c：呈现位标签（文字化——用户看得懂「在哪用」，不再只悬停图标）。
 * 十七轮⑤：与形态徽章去重——主形态挂载位已由形态徽章承载（十六轮起
 * 挂载位即形态），此处只列**次挂载**（多挂载件的其余呈现位，如产物中心
 * = 侧边栏面板(主) + 事件钩子(次)）；文案统一形态徽章词表（同物同名），
 * pipeline 声明非挂载位，保留「流程」标注。 */
function MountFaces({ pluginId, primary }: { pluginId: string; primary: FormValue }) {
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const desc = listSessionPlugins().find((p) => p.id === pluginId);
  const faces = [...new Set((desc?.mounts ?? []).map((m) => m.kind))]
    // 主形态挂载排除（theme ↔ app-theme 语义对应——app-theme 不在
    // PluginMount 联合但组合件运行时可能携带，字符串比较放宽；none/流水线
    // 无对应挂载不排）。
    .filter((k) => {
      const mount = k as string;
      return mount !== primary && !(primary === "theme" && mount === "app-theme");
    });
  const pipeline = desc?.pipeline ? ["pipeline"] : [];
  const all = [...faces, ...pipeline];
  if (all.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {all.map((k) => {
        const mount = k as string;
        const Icon = k === "pipeline" ? Rocket : MOUNT_FACE_ICONS[mount] ?? LayoutGrid;
        const f = k === "pipeline" || mount === "app-theme" ? null : FORM_BADGE[k as FormValue];
        const label =
          k === "pipeline" ? tr("plugins.mountPipeline", "流程")
          : mount === "app-theme" ? tr(FORM_BADGE.theme.key, FORM_BADGE.theme.fallback)
          : f ? tr(f.key, f.fallback)
          : mount;
        return (
          <span
            key={k}
            className="inline-flex items-center gap-0.5 rounded-full border border-border/50 bg-muted/40 px-1.5 py-px text-[9px] text-muted-foreground/80"
          >
            <Icon className="h-2.5 w-2.5" />
            {label}
          </span>
        );
      })}
    </span>
  );
}

const CATEGORY_VALUES: ReadonlySet<string> = new Set([
  "core", "skill", "mcp", "extension", "custom",
]);

/** 五类口径归类（2026-11-14 用户裁决，见 00-原始需求「已安装统一页与分类
 * 重整」）：显式声明优先（五类直用/旧八类归一）→ 系统能力（内置智能体/
 * 核心引擎/系统插件/内置会话能力）归核心引擎 → 技能/MCP 按声明段 →
 * 其余（CLI/面板/流水线/自建智能体/自建会话能力）兜底自定义。 */
function categoryOf(p: PluginDescriptor): PluginCategory {
  if (p.category && CATEGORY_VALUES.has(p.category)) return p.category as PluginCategory;
  // 旧「session」声明值按内置性分流（内置会话能力=系统能力归核心引擎，
  // 自建会话能力归自定义）；其余旧值静态归一。
  if (p.category && p.category !== "session" && LEGACY_CATEGORY_MAP[p.category]) {
    return LEGACY_CATEGORY_MAP[p.category];
  }
  // 核心引擎归属边界（用户裁决 2026-11-14 三轮）：声明 core 件（解析器/
  // 任务件/指南）+ 内置智能体（builtin）+ 内置会话核心功能（implKind=
  // builtin 的 session 件）。系统闸门件（包治理/预览治理等 system 标记
  // 件）**不**因此进核心引擎——按兜底规则留自定义（归属只增加智能体，
  // 其他不变）。
  if (p.kind === "builtin" || p.core) return "core";
  // 十八轮：session 件核心引擎归属直查 descriptor（TS 内置组件
  // source=builtin 归核心引擎，三轮裁决口径不变）——原经 implKindOf
  // 中转在新实现下成环（implKindOf 判核心引擎卡又调 categoryOf）。
  if (p.kind === "session") {
    const d = listSessionPlugins().find((x) => x.id === p.id);
    return d?.source === "builtin" ? "core" : "custom";
  }
  if (p.kind === "tool") {
    if (p.has_mcp) return "mcp";
    if (p.has_skill) return "skill";
    // CLI/面板/pi_extension/流水线——代码开发+配置的混合场景，归自定义。
    return "custom";
  }
  // 自建 manifest 智能体（用户让 hub 做的）属自定义。
  return "custom";
}

/** v0.9.5 需求1 GUI 改造 批次2：实现维度（双维度 X 轴）——业务 tab 之外的第二
 * 视角（怎么造的/能不能改）。会话插件看描述符（engine 装配标记 implKind；
 * source=builtin → 内置🔒只读）；非会话插件 core/system → 内置，
 * 其余（tool/manifest 声明式清单）→ 配置。十七轮⑥：市场安装件加值
 * 「市场安装」（市场台账在册——其构建方式对用户无意义，与内置件「内置」
 * 同口径，判定见 implOfCard）。 */
type ImplKind = "config" | "code" | "combo";

function implKindOf(p: PluginDescriptor): ImplKind | null {
  // 十八轮裁决（2026-11-15）：实现回归纯语义——配置实现/混合实现（涉及
  // 代码即混合：@file: 组件 / [pi_extension] 扩展部署 / 流水线+渲染臂）；
  // 「内置/市场安装」移来源维度（sourceOf），十七轮④⑥的实现值作废。
  // 核心引擎卡（引擎本体）无实现方式语义——不标徽章不参与实现筛选
  //（十轮先例：无该维度留空不硬凑）。
  if (categoryOf(p) === "core") return null;
  if (p.kind === "session") {
    const d = listSessionPlugins().find((x) => x.id === p.id);
    if (!d) return "config";
    // descriptor.implKind 客观标记构成（code=@file 组件）——展示口径按
    // 十八轮「涉及代码即混合」归 combo（engine 标记保持，消费侧映射）。
    if (d.implKind === "code" || d.implKind === "combo") return "combo";
    return "config";
  }
  // tool 家族：部署 [pi_extension] 扩展 ts（带代码文件）→ 混合实现；
  // MCP/Skill/CLI 声明清单（纯配置）→ 配置实现。
  if (p.has_pi_extension) return "combo";
  return "config";
}

/** 十八轮裁决（2026-11-15）：身份维度瘦身——原四值中内置插件/市场安装/
 * 自建三值是来源语义，迁至 SOURCE_BADGE/sourceOf；身份仅保留「核心引擎」
 * 专属徽章（核心引擎 tab 成员）。inMarketLedger 参数保留签名兼容，判定
 * 已由 sourceOf 承担。 */
function identityOf(
  p: PluginDescriptor,
  _inMarketLedger: boolean,
): "core" | "custom" {
  if (categoryOf(p) === "core") return "core";
  return "custom";
}

/** 身份徽章（十八轮瘦身）：仅核心引擎专属值——其余原值归 SOURCE_BADGE。 */
const IDENTITY_BADGE: Record<"core", { key: string; fallback: string; cls: string }> = {
  core: { key: "plugins.identityCore", fallback: "核心引擎", cls: "border-primary/40 bg-primary/10 text-primary" },
};

/** 形态九类 + 主题/无 UI 两兜底（v0.9.7 需求3 十六轮用户裁决：**形态 =
 * 九类挂载位粒度**，十/十一轮的五值合并口径作废——标题栏动作、输入框尾
 * 挂件等是独立形态，不得并入「会话」「悬浮窗」大桶）。枚举单一真源见
 * plugin-wizard-utils（与后端 PLUGIN_FORM_VALUES 同集）。 */
type FormValue = PluginForm;

/** hub 随包件形态基表（存量已物化副本不走 resources 重部署——非必需件
 * 已物化不覆盖，此处一处真源覆盖全部已装副本；新创建件由显式 form 声明）。
 * 会话内渲染卡/清单 = block-renderer；纯工具/技能/解析器底座 = none。 */
const HUB_FORMS: Record<string, FormValue> = {
  "html-preview": "block-renderer", // 会话内 HTML 预览
  "interactive-qa": "block-renderer", // 交互问答卡
  "task-requirements": "block-renderer", // 需求澄清卡
  "task-plan": "block-renderer", // 流程规划卡
  "pi-todo": "block-renderer", // 待办清单（pi 会话内渲染）
  "jishu-subagent": "none",
  "pi-lens": "none",
  "pi-web-access": "none",
  "jishu-cli-guide": "none",
  "mcp-create-tool": "none",
  "skill-create-tool": "none",
  "mcp-resolver": "none",
  "skill-resolver": "none",
};

/** 形态判定链：显式 [info].form/[plugin].form 声明（九类+两兜底；旧五值
 * 声明不入新集，走后续推导自动升级为挂载位粒度）→ hub 随包件基表 →
 * 外观类声明（category=appearance）→ 会话插件挂载位推导 → 无 UI 呈现。 */
function formOf(p: PluginDescriptor): FormValue {
  // 二十轮：纯菜单件（[menu] 声明且无 UI 挂载）归「菜单入口」形态。
  // 二十二轮修正：带面板挂载的菜单件（点击开独立面板）以挂载形态为准
  //（它长什么样是面板，菜单只是入口）——menu 优先级让位挂载推导。
  if (p.kind === "session") {
    const d = listSessionPlugins().find((x) => x.id === p.id);
    if (d?.menu && !d.mounts.some((m) => m.kind !== "event-hook")) return "menu";
  }
  if (isPluginForm(p.form)) return p.form;
  if (HUB_FORMS[p.id]) return HUB_FORMS[p.id];
  if (p.category === "appearance") return "theme";
  if (p.kind === "session") {
    const mounts = [
      ...new Set(listSessionPlugins().find((x) => x.id === p.id)?.mounts.map((m) => m.kind) ?? []),
    ];
    // 多挂载位取**最有信息量**的形态——event-hook（无 UI）常与真实 UI 挂载
    // 并存（产物中心 = event-hook + sidebar-panel），首个命中会被无 UI 截胡。
    const ui = mounts.filter((m) => m !== "event-hook");
    return ui[0] ?? mounts[0] ?? "none";
  }
  return "none";
}

/** 形态徽章（九类挂载位 + 主题外观 + 无 UI 呈现，十六轮全量口径）。 */
const FORM_BADGE: Record<FormValue, { key: string; fallback: string }> = {
  "block-renderer": { key: "plugins.formBlockRenderer", fallback: "会话内渲染" },
  "tool-result-renderer": { key: "plugins.formToolResult", fallback: "工具结果渲染" },
  "header-action": { key: "plugins.formHeaderAction", fallback: "标题栏动作" },
  "sidebar-panel": { key: "plugins.formSidebarPanel", fallback: "侧边栏面板" },
  "dock-panel": { key: "plugins.formDockPanel", fallback: "停靠面板" },
  "rail-widget": { key: "plugins.formRailWidget", fallback: "贴边挂件" },
  "composer-trailing": { key: "plugins.formComposerTrailing", fallback: "输入框尾挂件" },
  "app-overlay": { key: "plugins.formAppOverlay", fallback: "应用浮层" },
  "event-hook": { key: "plugins.formEventHook", fallback: "事件钩子" },
  menu: { key: "plugins.formMenu", fallback: "菜单入口" },
  theme: { key: "plugins.formTheme", fallback: "主题外观" },
  none: { key: "plugins.formNone", fallback: "无 UI 呈现" },
};

/** 实现徽标（十八轮裁决：纯实现语义——绿配置/紫代码/橙混合；code 值
 * 保留枚举但当前无产出件（@file 组件按「涉及代码即混合」归 combo），
 * 筛选 chips 只列有徽章的值（一一对应）。 */
const IMPL_BADGE: Record<ImplKind, { key: string; fallback: string; cls: string }> = {
  config: { key: "plugins.implConfig", fallback: "配置实现", cls: "border-emerald-500/40 text-emerald-600" },
  code: { key: "plugins.implCode", fallback: "代码实现", cls: "border-fuchsia-500/40 text-fuchsia-600" },
  combo: { key: "plugins.implCombo", fallback: "混合实现", cls: "border-amber-500/40 text-amber-600" },
};

/** 来源（十八轮裁决 2026-11-15：内置/自建/市场安装从实现摘出独立成维——
 * 「这种属于来源」；原身份徽章三值迁移至此，核心引擎徽章单独保留）。
 * 来源筛选排在实现后面。 */
type SourceValue = "builtin" | "custom" | "market";
const SOURCE_BADGE: Record<SourceValue, { key: string; fallback: string; cls: string }> = {
  builtin: { key: "plugins.identityBuiltin", fallback: "内置", cls: "border-border/60 text-muted-foreground" },
  custom: { key: "plugins.identityCustom", fallback: "自建", cls: "border-emerald-500/40 text-emerald-600" },
  market: { key: "plugins.identityMarket", fallback: "市场安装", cls: "border-primary/40 text-primary" },
};

/** hub 随包分发但 plugin_list 无 system/core 标记的补充表（实测口径
 * 2026-11-15）——mermaid（组合件物化副本不带 system 标记）与
 * html-preview/interactive-qa（pi_extension 闸门件）。用户裁决：「系统
 * 自带的就叫内置」。新随包件应在此登记或补 system 标记。 */
const HUB_SHIPPED_EXTRA: ReadonlySet<string> = new Set([
  "session.mermaid-render",
  "html-preview",
  "interactive-qa",
]);

/** 来源判定（十八轮）：市场台账 → 市场安装；系统自带（system/core 标记、
 * 引擎 kind=builtin、session TS 内置组件 source=builtin、随包补充表）
 * → 内置；其余 → 自建。 */
function sourceOf(p: PluginDescriptor, inMarketLedger: boolean): SourceValue {
  if (inMarketLedger) return "market";
  if (p.kind === "builtin" || p.core || p.system || HUB_SHIPPED_EXTRA.has(p.id)) {
    return "builtin";
  }
  if (p.kind === "session") {
    const d = listSessionPlugins().find((x) => x.id === p.id);
    if (d?.source === "builtin") return "builtin";
  }
  return "custom";
}

/** v0.9.3 需求11：分类改横向 tab（顺序按用户口径，智能体置首）。 */
// v0.9.7 需求3（2026-11-14 用户裁决）：分类五类——核心引擎（含智能体与
// 系统能力）/ 技能 / MCP / 扩展包（pi 生态 npm/git 件）/ 自定义与外观。
const PLUGIN_CATEGORIES: Array<{ key: PluginCategory; labelKey: string; fallback: string }> = [
  { key: "core", labelKey: "plugins.catCore", fallback: "核心引擎" },
  { key: "skill", labelKey: "plugins.catSkill", fallback: "技能" },
  { key: "mcp", labelKey: "plugins.typeMcp", fallback: "MCP" },
  { key: "extension", labelKey: "plugins.catExtension", fallback: "扩展包" },
  { key: "custom", labelKey: "plugins.catCustomGroup", fallback: "自定义与外观" },
];

export function PluginsPage({
  onLaunchPipeline,
  onLaunchDescribe,
  onNavigateConfig,
}: {
  onLaunchPipeline?: (pluginId: string, name: string) => void;
  /** v0.9.7 需求3 C1：描述需求 → 跳会话页预填创作指令（app 层经
   * pluginCreateLaunch state 承接，pipelineLaunch 同款模式）。 */
  onLaunchDescribe?: (text: string) => void;
  /** v0.9.8 需求4：市场装后引导卡「需要配置」一键到配置位（Manage 层
   * navigateToAgentModels 通道复用）。 */
  onNavigateConfig?: () => void;
} = {}) {
  const { t } = useTranslation();
  const { alert: alertDialog, confirm: confirmDialog, dialogNode } = useConfirmDialog();
  // v0.9.3 需求13：组合清单异步装载完成后重算卡片（⚙ 设置钮/描述依赖前端描述符）。
  useSyncExternalStore(subscribeComposed, composedVersion, () => 0);
  const { agents, refreshHealth } = useAgent();
  const [result, setResult] = useState<PluginListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  // 编辑模式目标（GUI 反馈：新增插件无法编辑）：manifest 插件可改表单覆盖写回。
  const [editPluginId, setEditPluginId] = useState<string | null>(null);
  // v0.9.0 需求8：声明式面板 Dialog 状态。
  const [panelTarget, setPanelTarget] = useState<PluginDescriptor | null>(null);
  // v0.9.3 需求12 P1（交互返工）：卡片显式按钮进入详情/编辑模态
  //（用户裁决：不点卡片弹出；编辑按钮直落设置 tab）。
  const [detailTarget, setDetailTarget] = useState<PluginDescriptor | null>(null);
  // v0.9.3 需求13 C3：新建组合插件向导。
  const [composeOpen, setComposeOpen] = useState(false);
  // 3a-1（v0.9.5 需求1）：统一创建入口（类型选择卡片页）。
  const [entryOpen, setEntryOpen] = useState(false);
  // 3b：混合插件向导。
  const [hybridOpen, setHybridOpen] = useState(false);
  // 批次6：创建入口业务形态 → 混合向导挂载预选。
  const [hybridPresetMount, setHybridPresetMount] = useState<"dock-panel" | "rail-widget" | "sidebar-panel" | "composer-trailing" | undefined>(undefined);
  // 3c：流水线向导。
  const [pipelineOpen, setPipelineOpen] = useState(false);
  // 需求14 补齐：主题向导。
  const [themeWizardOpen, setThemeWizardOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"info" | "settings" | "source">("info");
  const [panelOutputs, setPanelOutputs] = useState<Record<number, string>>({});
  const [panelRunning, setPanelRunning] = useState<number | null>(null);
  const runPanelItem = useCallback(async (pluginId: string, index: number) => {
    setPanelRunning(index);
    setPanelOutputs((prev) => ({ ...prev, [index]: "…" }));
    try {
      const r = await invokeCommand<{ label: string; output: string; ok: boolean }>(
        "plugin_panel_run",
        { pluginId, itemIndex: index },
      );
      setPanelOutputs((prev) => ({
        ...prev,
        [index]: `${r.output.trim() || "(无输出)"}${r.ok ? "" : "\n[退出码非零]"}`,
      }));
    } catch (err) {
      setPanelOutputs((prev) => ({ ...prev, [index]: `执行失败：${err}` }));
    } finally {
      setPanelRunning(null);
    }
  }, []);

  // 需求8 修复B-T2：MCP 插件连接健康徽标（数据源 = 聚合 server 健康快照；
  // 无快照/会话未跑过 → 空表不显示徽标——安装态与运行态不再错位）。
  const [mcpHealth, setMcpHealth] = useState<Record<string, { status: string; error: string | null }>>({});

  // v0.9.7 需求3 已安装统一页（2026-11-14 裁决）：扩展包/市场技能的更新
  // 与还原数据面（市场「已安装」子页并入本页）。
  const [extInstalled, setExtInstalled] = useState<string[]>([]);
  // 十七轮⑧：已装扩展实装版本（node_modules package.json——浮动安装/更新
  // 后的真实版本；settings 源串 @version 是意图快照会陈旧/缺失）。
  const [extVersions, setExtVersions] = useState<Record<string, string>>({});
  const [extPins, setExtPins] = useState<Array<{ source: string; package: string; version: string }>>([]);
  const [skillLedger, setSkillLedger] = useState<Record<string, string>>({});
  const [piindexMeta, setPiindexMeta] = useState<Array<{
    name: string; description: string; npm_package: string | null; install_command: string;
    detail_url: string | null; category: string;
  }> | null>(null);
  const [extUpdates, setExtUpdates] = useState<ExtensionUpdateStatus[] | null>(null);
  const [skillUpdates, setSkillUpdates] = useState<SkillUpdateStatus[] | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateBusy, setUpdateBusy] = useState<string | null>(null);
  const batchUpdates = useMarketUpdates();

  // ── 需求4 D4-8b（v0.9.8）：扩展统一登记簿消费面 ──
  // 扩展条目「界面」行（adapters 反查）+ 适配件「基于」行 + 级联停用呈现。
  const [extGui, setExtGui] = useState<Map<string, ExtGuiEntry>>(new Map());
  const [pluginDeps, setPluginDeps] = useState<Map<string, ExtGuiDep[]>>(new Map());
  const refreshExtGui = useCallback(() => {
    void (async () => {
      try {
        const [entries, deps] = await Promise.all([
          invokeCommand<ExtGuiEntry[]>("extension_registry_list").catch(() => [] as ExtGuiEntry[]),
          invokeCommand<Array<{ plugin_id: string; deps: ExtGuiDep[] }>>("plugin_extension_deps").catch(() => []),
        ]);
        setExtGui(new Map((entries ?? []).map((e) => [e.pkg_key, e])));
        setPluginDeps(new Map((deps ?? []).map((d) => [d.plugin_id, d.deps])));
      } catch {
        // 索引层：失败静默（两行整体隐藏，不阻塞清单）。
      }
    })();
  }, []);
  useEffect(() => { refreshExtGui(); }, [refreshExtGui]);
  /** 适配件名点击 → 跳到该插件所在分类 tab 并聚光（复用 spotlight 事件）。 */
  const jumpToPlugin = useCallback((id: string) => {
    const hit = result?.plugins.find((p) => p.id === id);
    if (hit) {
      setSearch("");
      setActiveTab(categoryOf(hit));
    }
    window.dispatchEvent(new CustomEvent("jishu:plugin-spotlight", { detail: { id } }));
  }, [result]);
  /** 实现徽章/筛选判定（十八轮：市场感知移除——「市场安装」归来源维度
   * sourceOf；实现=纯实现语义，核心引擎卡返回 null 不参与）。 */
  const implOfCard = (p: PluginDescriptor): ImplKind | null => implKindOf(p);
  /** 单卡检查更新结果并入全局更新状态（十二轮裁决：全部检查与单独检查
   * 联动——单查结果即时反映到版本箭头/全部更新按钮可见性）。 */
  const mergeExtUpdate = (status: ExtensionUpdateStatus) =>
    setExtUpdates((prev) =>
      prev?.some((u) => u.package === status.package)
        ? prev.map((u) => (u.package === status.package ? status : u))
        : [...(prev ?? []), status],
    );
  const mergeSkillUpdate = (status: SkillUpdateStatus) =>
    setSkillUpdates((prev) =>
      prev?.some((u) => u.slug === status.slug)
        ? prev.map((u) => (u.slug === status.slug ? status : u))
        : [...(prev ?? []), status],
    );
  const [extDetailMeta, setExtDetailMeta] = useState<{
    name: string; description: string; detail_url: string | null; category: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await invokeCommand<PluginListResult>("plugin_list"));
    } catch (err) {
      console.error("Failed to list plugins:", err);
    } finally {
      setLoading(false);
    }
    try {
      const h = await invokeCommand<{
        available?: boolean;
        plugins?: { plugin: string; status: string; error: string | null }[];
      }>("mcp_plugin_health");
      const map: Record<string, { status: string; error: string | null }> = {};
      for (const p of h?.plugins ?? []) map[p.plugin] = { status: p.status, error: p.error };
      setMcpHealth(map);
    } catch {
      setMcpHealth({}); // 只读展示位：失败静默（不显徽标）
    }
    // 扩展包（pi 生态件）/技能台账/钉版快照/目录元数据（失败静默——
    // 各自独立展示位，不阻塞插件清单）。
    const [sources, versions, pins, ledger, piindex] = await Promise.all([
      invokeCommand<string[]>("pi_package_installed_sources").catch(() => [] as string[]),
      invokeCommand<Record<string, string>>("pi_package_installed_versions").catch(() => ({}) as Record<string, string>),
      invokeCommand<Array<{ source: string; package: string; version: string }>>("pi_package_builtin_pins").catch(() => []),
      invokeCommand<Record<string, string>>("skillhub_installed").catch(() => ({}) as Record<string, string>),
      invokeCommand<Array<{
        name: string; description: string; npm_package: string | null; install_command: string;
        detail_url: string | null; category: string;
      }>>("piindex_search", { keyword: null }).catch(() => null),
    ]);
    setExtInstalled(sources ?? []);
    setExtVersions(versions ?? {});
    setExtPins(pins ?? []);
    setSkillLedger(ledger ?? {});
    setPiindexMeta(piindex ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 需求25：混合插件加载失败自动回滚 → plugins-changed 广播 → 插件中心
  // 需要刷新才能反映回滚后的开关状态（否则用户手动开启后 loader 延迟
  // 回滚，但开关显示停在开——竞态：手动 refresh 在 auto-disable 之前）。
  // 需求4 D4-8b（R2-T2 实测抓到的刷新缺口）：确认卡启用适配件后
  // plugins-changed 也会触发——登记簿（界面/基于行）必须一并刷新，
  // 否则扩展包 tab 停留在启用前的旧适配态。
  useEffect(() => {
    const unlistenPromise = import("@tauri-apps/api/event").then(({ listen }) =>
      listen("plugins-changed", () => {
        void refresh();
        refreshExtGui();
      }),
    );
    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, [refresh, refreshExtGui]);

  const withBusy = useCallback(
    async (id: string, action: () => Promise<void>) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        await action();
        await refresh();
      } catch (err) {
        void alertDialog({ title: t("plugins.actionFailed"), description: String(err) });
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [alertDialog, refresh, t],
  );

  const handleToggle = useCallback(
    (plugin: PluginDescriptor, enabled: boolean) => {
      void withBusy(plugin.id, async () => {
        await invokeCommand("plugin_set_enabled", {
          pluginId: plugin.id,
          enabled,
        });
      });
    },
    [withBusy],
  );

  const handleRemove = useCallback(
    (plugin: PluginDescriptor) => {
      void (async () => {
        // 需求4 D4-8b：适配插件卸载提示——告知其呈现的扩展将失去此界面。
        const deps = pluginDeps.get(plugin.id);
        const depsNote =
          deps && deps.length > 0
            ? "\n" + t("market.uninstallAdapterWarn", {
                defaultValue: "该插件为「{{ext}}」提供界面——卸载后该扩展失去此界面（扩展本体不受影响）",
                ext: deps.map((d) => d.display).join("、"),
              })
            : "";
        const ok = await confirmDialog({
          title: t("plugins.removeTitle", { name: plugin.display_name }),
          description: t("plugins.removeDesc") + depsNote,
          confirmText: t("plugins.removeConfirm"),
          variant: "destructive",
        });
        if (!ok) return;
        await withBusy(plugin.id, async () => {
          await invokeCommand("plugin_remove", { pluginId: plugin.id });
        });
        refreshExtGui();
      })();
    },
    [confirmDialog, pluginDeps, refreshExtGui, t, withBusy],
  );

  /** 7c 层二：导入扩展（文件选择 → 摘要确认 → 复制，默认不启用——
   * 启用经发现卡「启用」动作）。 */
  const handleImportExtension = async (): Promise<void> => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "智能体扩展", extensions: ["ts"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      const target = await invokeCommand<string>("pi_extension_import", { path: picked });
      await alertDialog({
        title: "扩展已导入（默认不启用）",
        description: target + " —— 启用请重启或稍后经「发现新扩展」提示卡点「启用」（注册 settings.json 后下次会话生效）。",
      });
    } catch (err) {
      await alertDialog({ title: "导入失败", description: String(err) });
    }
  };

  const handleReload = useCallback(async () => {
    setLoading(true);
    try {
      await invokeCommand("plugin_reload");
      await refresh();
    } catch (err) {
      console.error("Failed to reload plugins:", err);
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  /** 需求5：安装（精简版 env-check 流程——提权询问 + install_agent_command）。 */
  const handleInstall = useCallback(
    (plugin: PluginDescriptor, status: AgentStatus) => {
      const command = status.native_install_command || status.install_hint;
      if (!command) return;
      void (async () => {
        setInstallingIds((prev) => new Set(prev).add(plugin.id));
        try {
          let needsElevation = false;
          try {
            needsElevation = await invokeCommand<boolean>(
              "install_command_needs_elevation",
              { command },
            );
          } catch {
            // 查询失败不阻断：按无需提权继续，由安装命令自身给出结果。
          }
          if (needsElevation) {
            const agreed = await confirmDialog({
              title: t("env.elevationTitle"),
              description: t("env.elevationDesc", {
                defaultValue: "安装「{{name}}」需要管理员权限，授权窗口（UAC）中点击「是」完成。",
                name: plugin.display_name,
              }),
              confirmText: t("env.elevationConfirm"),
              cancelText: t("common.cancel", "取消"),
            });
            if (!agreed) return;
          }
          const installResult = await invokeCommand<string>("install_agent_command", {
            command,
          });
          if (installResult && !installResult.includes("[PATH_ADDED]")) {
            void alertDialog({ title: t("env.installSuccess", "安装成功"), description: installResult });
          }
          await refreshHealth();
          await refresh();
        } catch (err) {
          void alertDialog({
            title: t("env.installFailed", "安装失败"),
            description: String(err),
          });
        } finally {
          setInstallingIds((prev) => {
            const next = new Set(prev);
            next.delete(plugin.id);
            return next;
          });
        }
      })();
    },
    [alertDialog, confirmDialog, refresh, refreshHealth, t],
  );

  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));

  // v0.9.3 需求11：分类改横向 tab（替换需求20 的折叠分区），记忆最后选择。
  // v0.9.7 五类化：旧八类存量记忆值直接回落默认「core」。
  const TAB_KEY = "plugins-center-tab";
  const [activeTab, setActiveTab] = useState<PluginCategory>(() => {
    const saved = localStorage.getItem(TAB_KEY);
    return PLUGIN_CATEGORIES.some((c) => c.key === saved) ? (saved as PluginCategory) : "core";
  });
  const switchTab = (key: PluginCategory) => {
    setActiveTab(key);
    try {
      localStorage.setItem(TAB_KEY, key);
    } catch {
      // 存储不可用时仅本次会话生效
    }
  };
  // 批次2：实现维度筛选（与业务 tab 正交——双视角管理，v3 双维度设计）。
  // v0.9.7 需求3 二版（2026-11-14 裁决「检索标签对应」）：实现筛选与实现
  // 徽章一一对应。十八轮：实现回归纯语义（配置/混合；code 当前无产出件
  // 不放 chip），「内置/市场安装」chip 移除（归来源组）。
  type ImplFilter = ImplKind | "all";
  const [implFilter, setImplFilter] = useState<ImplFilter>("all");
  // 十八轮裁决（2026-11-15）：来源筛选——内置/自建/市场安装（「这种属于
  // 来源」），新增组排在实现后面、形态前面；与来源徽章一一对应。
  const [sourceFilter, setSourceFilter] = useState<SourceValue | "all">("all");
  // v0.9.7 需求3 十六轮（用户裁决）：形态筛选——九类挂载位+两兜底全量，
  // 与形态徽章一一对应（五值合并口径作废）。
  const [formFilter, setFormFilter] = useState<FormValue | "all">("all");
  // 十七轮：各筛选维度均「全部」才显示不参与筛选的专属区块（开发日志
  // 虚拟卡/原生 MCP 区/扩展包卡）——它们无形态/实现/来源徽章（与「筛选
  // 与徽章一一对应」裁决一致），筛选激活时挂着不动会被误读为命中。
  const filtersIdle = implFilter === "all" && sourceFilter === "all" && formFilter === "all";
  // 需求14 M4（G8 搜索）：跨分类搜索（id/名称/描述/路径/接管语言集命中）；
  // 非空时网格展示全库命中项（忽略当前 tab），实现维度筛选仍叠加。
  const [search, setSearch] = useState("");
  // v0.9.7 需求3 C2：插件中心顶部二级页签「已安装 | 插件市场」。
  const [view, setView] = useState<"installed" | "market">("installed");
  // 需求14 M4（R7）：待确认安装页内一等分区（app 级确认模态保留——本区
  // 是「插件中心能自己发现」的补充入口，轮询同一 plugin_confirm_pending）。
  const [pendingInstalls, setPendingInstalls] = useState<Array<{
    id: string; name: string; mount: string; dir: string;
    assets?: Array<{ name: string; size: number; sha8: string }>;
    takeover?: string | null;
  }>>([]);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const list = await invokeCommand<unknown>("plugin_confirm_pending");
        if (alive) setPendingInstalls((list as typeof pendingInstalls) ?? []);
      } catch {
        /* 后端无待确认项或命令失败——静默 */
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  const pendingIds = useMemo(() => new Set(pendingInstalls.map((p) => p.id)), [pendingInstalls]);
  // v0.9.7 需求3 C1 回跳聚光：确认卡启用成功 → openManagePage("plugins") +
  // spotlight 事件 → 本页滚动到位 + ring 高亮 2s（P2-7：事件通道而非直设 tab）。
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  useEffect(() => {
    const onSpotlight = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      setSpotlightId(id);
      window.setTimeout(() => {
        document
          .querySelector(`[data-plugin-card="${id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 120);
      window.setTimeout(() => setSpotlightId(null), 2200);
    };
    window.addEventListener("jishu:plugin-spotlight", onSpotlight);
    return () => window.removeEventListener("jishu:plugin-spotlight", onSpotlight);
  }, []);
  /** 搜索命中：id/显示名/描述/来源路径 +（会话插件）块渲染器接管语言集。 */
  const matchesSearch = useCallback((p: PluginDescriptor) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const langs = p.kind === "session"
      ? (listSessionPlugins().find((x) => x.id === p.id)?.mounts ?? []).flatMap((m) =>
          m.kind === "block-renderer" && "languages" in m ? (m.languages as string[]) : [],
        )
      : [];
    return [p.id, p.display_name, p.description ?? "", p.source_path ?? "", ...langs]
      .join(" ")
      .toLowerCase()
      .includes(q);
  }, [search]);

  /** 扩展包搜索匹配（十四轮：搜索「pi-subagents」搜不到——生态件不在
   * plugin_list 且搜索态被隐藏；并入全库检索：包名/piindex 说明）。 */
  const pkgOfSource = useCallback((src: string) => {
    const m = src.match(NPM_SOURCE_RE);
    return m?.[1] ?? src.replace(/^npm:/, "");
  }, []);
  const matchesExtSearch = useCallback(
    (src: string) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      const pkg = pkgOfSource(src);
      const meta = piindexMeta?.find((e) => e.npm_package === pkg);
      return [pkg, meta?.description ?? ""].join(" ").toLowerCase().includes(q);
    },
    [search, piindexMeta, pkgOfSource],
  );

  // v0.9.0 需求1 二期：MCP 解析器（mcp-resolver 系统插件）启用态——新建
  // 插件对话框的 MCP 区门控（列表未加载完成前按启用放行，避免首开误锁）。
  const mcpResolverEnabled = result
    ? (result.plugins.find((p) => p.id === "mcp-resolver")?.enabled ?? false)
    : true;
  // 需求20：skill 解析器启用态（新建插件 SKILL 区门控）。
  const skillResolverEnabled = result
    ? (result.plugins.find((p) => p.id === "skill-resolver")?.enabled ?? false)
    : true;


  /** v0.9.3 需求11：插件卡片（workbuddy 风格紧凑卡）——图标+名称+开关一行，
   * 徽章与元信息两行内收敛，动作按钮底部一行；网格自适应列数铺满区域。 */
  const renderCard = (plugin: PluginDescriptor) => {
        const busy = busyIds.has(plugin.id);
        const installing = installingIds.has(plugin.id);
        // 需求5：健康状态 join（内置与 manifest 插件的安装检测承接）。
        const status = agents.find((a) => a.id === plugin.id);
        const installed = status?.health?.installed ?? null;
        const cliVersion = status?.health?.version ?? null;
        return (
          <div
            key={plugin.id}
            data-plugin-card={plugin.id}
            className={cn(
              "flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3 transition-colors hover:border-border",
              spotlightId === plugin.id && "ring-2 ring-primary animate-pulse"
            )}
          >
            {/* 首行：图标 + 名称 + 开关（workbuddy 卡头形态）。 */}
            <div className="flex items-center gap-2">
              {plugin.kind === 'builtin' ? (
                <AgentLogo agentId={plugin.id} size={26} />
              ) : (
                <PluginIcon icon={plugin.icon} size={26} />
              )}
              <span
                className="min-w-0 flex-1 truncate text-[13px] font-medium"
                title={plugin.kind === "session"
                  ? tr(`sessionPlugins.${plugin.id.replace("session.", "")}.name`, plugin.display_name)
                  : plugin.display_name}
              >
                {plugin.kind === "session"
                  ? tr(`sessionPlugins.${plugin.id.replace("session.", "")}.name`, plugin.display_name)
                  : plugin.display_name}
              </span>
              {plugin.core ? (
                <span className="text-[10px] text-muted-foreground/60">—</span>
              ) : (
                <Switch
                  checked={plugin.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) => handleToggle(plugin, checked)}
                  aria-label={tr("plugins.toggle", "启用/禁用")}
                />
              )}
            </div>
            {/* 徽章行：状态收敛（禁用显眼、其余轻量；核心引擎类目内不再重复徽章）。 */}
            <div className="flex min-h-[16px] flex-wrap items-center gap-1">
              {!plugin.enabled && !plugin.core && (
                <Badge variant="outline" className="px-1 py-0 text-[9px] text-muted-foreground">
                  {tr("plugins.disabledBadge", "已禁用")}
                </Badge>
              )}
              {/* 需求14 M4（G8 状态统一）：待确认安装一等徽标（红色角标引导——
                  卡片直达确认动作，不必等 app 级模态轮询弹出）。 */}
              {pendingIds.has(plugin.id) && (
                <Badge variant="outline" className="border-amber-500/50 px-1 py-0 text-[9px] text-amber-600">
                  {tr("plugins.pendingBadge", "待确认")}
                </Badge>
              )}
              {/* v0.9.7 需求3 标签体系（十轮立三类 → 十八轮裁决 2026-11-15
                  定四类拆分）：核心引擎专属徽章 → 来源（内置/自建/市场安装，
                  从实现摘出独立成维）→ 实现方式（配置/混合；核心引擎卡无此
                  维度不硬凑）→ 插件形态（显式声明优先/挂载位推导/无 UI 兜底）。 */}
              {identityOf(plugin, !!skillLedger[plugin.id]) === "core" && (() => {
                const identity = IDENTITY_BADGE.core;
                return (
                  <Badge variant="outline" className={cn("px-1 py-0 text-[9px]", identity.cls)}>
                    {tr(identity.key, identity.fallback)}
                  </Badge>
                );
              })()}
              {(() => {
                const src = SOURCE_BADGE[sourceOf(plugin, !!skillLedger[plugin.id])];
                return (
                  <Badge variant="outline" className={cn("px-1 py-0 text-[9px]", src.cls)}>
                    {tr(src.key, src.fallback)}
                  </Badge>
                );
              })()}
              {(() => {
                // 十八轮裁决：实现=纯实现语义（涉及代码即混合实现）；
                // implKindOf 对核心引擎卡返回 null——不标徽章不参与实现筛选。
                const impl = implOfCard(plugin);
                if (!impl) return null;
                const b = IMPL_BADGE[impl];
                return (
                  <Badge variant="outline" className={cn("px-1 py-0 text-[9px]", b.cls)}>
                    {tr(b.key, b.fallback)}
                  </Badge>
                );
              })()}
              {(() => {
                const f = FORM_BADGE[formOf(plugin)];
                return (
                  <Badge variant="outline" className="border-border/60 px-1 py-0 text-[9px] text-muted-foreground">
                    {tr(f.key, f.fallback)}
                  </Badge>
                );
              })()}
              {plugin.has_mcp && (
                <Badge variant="outline" className="px-1 py-0 text-[9px]">
                  {tr("plugins.mcpBadge", "MCP")}
                </Badge>
              )}
              {plugin.has_mcp && mcpHealth[plugin.id] && (
                <span
                  className="inline-flex items-center gap-1 text-[9px] text-muted-foreground"
                  title={mcpHealth[plugin.id].error ?? undefined}
                >
                  <span
                    className={cn(
                      "inline-block size-1.5 rounded-full",
                      mcpHealth[plugin.id].status === "connected" ? "bg-emerald-500" : "bg-amber-500",
                    )}
                  />
                  {mcpHealth[plugin.id].status === "connected"
                    ? tr("plugins.mcpConnected", "已连接")
                    : tr("plugins.mcpConnecting", "启动中·稍后自动恢复")}
                </span>
              )}
              {(() => {
                // 需求4 D4-8b：级联停用/手动覆盖呈现（登记簿 deps 驱动）。
                const deps = pluginDeps.get(plugin.id);
                if (!deps || deps.length === 0) return null;
                const stopped = deps.filter((d) => d.state === "disabled" || d.state === "missing");
                if (stopped.length === 0) return null;
                return (
                  <Badge variant="outline" className="border-amber-500/50 px-1 py-0 text-[9px] text-amber-600">
                    {!plugin.enabled
                      ? tr("market.cascadeDisabledTag", "因数据来源停用而停用")
                      : tr("market.manualOverrideWarn", "数据来源已停用（当前为手动启用）")}
                  </Badge>
                );
              })()}
              {plugin.kind === "session" && <MountFaces pluginId={plugin.id} primary={formOf(plugin)} />}
            </div>
            {/* 需求4 D4-8b：基于行——适配件的数据来源（点击跳扩展包 tab 并以
                名称搜索定位）；空态守卫=无 deps 记录不露行。 */}
            {(() => {
              const deps = pluginDeps.get(plugin.id);
              if (!deps || deps.length === 0) return null;
              return (
                <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground/80">
                  <span className="shrink-0">{tr("market.basedOnLabel", "基于")}</span>
                  {deps.map((d) => (
                    <button
                      key={d.pkg_key}
                      type="button"
                      className={cn(
                        "max-w-[130px] truncate underline decoration-dotted underline-offset-2 hover:text-foreground",
                        (d.state === "disabled" || d.state === "missing") && "text-amber-600",
                      )}
                      title={d.pkg_key}
                      onClick={() => {
                        setActiveTab("extension");
                        setSearch(d.display);
                      }}
                    >
                      {d.display}
                    </button>
                  ))}
                </div>
              );
            })()}
            {/* 说明（v0.9.3 需求11 用户裁决：中文说明取代 id/版本显示；编码与
             * 版本等运维信息收进 title 悬停）。来源链：session → i18n →
             * Rust description（[tool]/[skill] 首句或内置对照表）→ 类型兜底。 */}
            <div
              className="line-clamp-2 min-h-[26px] text-[10px] leading-[13px] text-muted-foreground/80"
              title={[
                plugin.id,
                plugin.version ? `v${plugin.version}` : "",
                installed != null
                  ? installed
                    ? `${tr("plugins.installed", "已安装")}${cliVersion ? ` v${cliVersion}` : ""}`
                    : tr("plugins.notInstalled", "未安装")
                  : "",
                plugin.source_path ?? "",
                !installed && status?.install_hint ? status.install_hint : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              {plugin.kind === "session"
                ? tr(`sessionPlugins.${plugin.id.replace("session.", "")}.description`, plugin.display_name)
                : plugin.description
                  ? generalizeEngineCodename(plugin.description)
                  : tr(
                      plugin.kind === "builtin"
                        ? "plugins.descFallbackBuiltin"
                        : plugin.kind === "manifest"
                          ? "plugins.descFallbackManifest"
                          : "plugins.descFallbackTool",
                      plugin.kind === "builtin"
                        ? "内置智能体适配器"
                        : plugin.kind === "manifest"
                          ? "manifest 声明的自定义智能体"
                          : "自定义能力插件",
                    )}
            </div>
            {/* 动作行：安装 / 面板 / 详情 / 编辑 / 卸载 / 加载中。v0.9.3
                需求12 返工：详情（全插件）与设置编辑（有配置面的会话插件）
                图标钮直达模态。 */}
            <div className="mt-auto flex items-center gap-1 pt-0.5">
              {(busy || installing) && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              {status && !installed && (status.native_install_command || status.install_hint) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  disabled={busy || installing}
                  onClick={() => handleInstall(plugin, status)}
                >
                  <Download className="h-3 w-3" />
                  <span className="ml-0.5">{tr("env.install", "安装")}</span>
                </Button>
              )}
              {plugin.has_panel && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => {
                    setPanelTarget(plugin);
                    setPanelOutputs({});
                  }}
                >
                  <LayoutDashboard className="h-3 w-3" />
                  <span className="ml-0.5">{tr("plugins.panelButton", "面板")}</span>
                </Button>
              )}
              <span className="flex-1" />
              {/* v0.9.7 需求3 十三轮：市场技能单卡检查更新（恢复——市场已装
                  子页并入统一页时丢失）+检出新版时的更新按钮；与全部检查联动
                  （全局检查每卡转圈，单查结果并入全局更新状态）。 */}
              {(() => {
                if (!skillLedger[plugin.id]) return null;
                const upd = skillUpdates?.find((u) => u.slug === plugin.id);
                const busyCard = updateBusy === plugin.id || batchUpdates.skillRunning;
                return (
                  <>
                    {upd?.has_update && (
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={busyCard}
                        onClick={() =>
                          void (async () => {
                            setUpdateBusy(plugin.id);
                            try {
                              await invokeCommand("skillhub_update", { slugs: [plugin.id] });
                              const status = await invokeCommand<SkillUpdateStatus>(
                                "skillhub_check_update",
                                { slug: plugin.id },
                              );
                              mergeSkillUpdate(status);
                              await refresh();
                            } catch (e) {
                              console.warn("skillhub_update failed:", e);
                              void alertDialog({ title: tr("plugins.actionFailed", "操作失败"), description: String(e) });
                            } finally {
                              // 第三轮评审修复：compare-and-clear——单值 busy 被
                              // 后发起的操作覆盖时，先完成者不得清掉后者的忙态
                              //（修前 finally 无条件置 null，另一卡 spinner 提前
                              // 消失且按钮解锁，可重复触发并发更新）。
                              setUpdateBusy((prev) => (prev === plugin.id ? null : prev));
                            }
                          })()
                        }
                      >
                        {busyCard ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                        <span className="ml-0.5">{tr("market.updateOne", "更新")} v{upd.latest}</span>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      disabled={busyCard || checkingUpdates}
                      onClick={() =>
                        void (async () => {
                          setUpdateBusy(plugin.id);
                          try {
                            const status = await invokeCommand<SkillUpdateStatus>("skillhub_check_update", {
                              slug: plugin.id,
                            });
                            mergeSkillUpdate(status);
                          } catch (e) {
                            console.warn("skillhub_check_update failed:", e);
                            void alertDialog({ title: tr("plugins.actionFailed", "操作失败"), description: String(e) });
                          } finally {
                            setUpdateBusy((prev) => (prev === plugin.id ? null : prev));
                          }
                        })()
                      }
                    >
                      {busyCard || checkingUpdates ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      <span className="ml-0.5">{tr("market.checkUpdate", "检查更新")}</span>
                    </Button>
                  </>
                );
              })()}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={tr("plugins.viewDetails", "详情")}
                title={tr("plugins.viewDetails", "详情")}
                onClick={() => {
                  setDetailTab("info");
                  setDetailTarget(plugin);
                }}
              >
                <Info className="h-3 w-3" />
              </Button>
              {plugin.kind === "session" &&
                listSessionPlugins().find((p) => p.id === plugin.id)?.configSchema && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label={tr("plugins.editSettings", "设置")}
                    title={tr("plugins.editSettings", "设置")}
                    onClick={() => {
                      setDetailTab("settings");
                      setDetailTarget(plugin);
                    }}
                  >
                    <Settings2 className="h-3 w-3" />
                  </Button>
                )}
              {/* v0.9.0 需求1 二期：系统插件隐藏编辑/卸载（随包分发、启动
               * 幂等重部署——编辑会被覆盖，卸载是无操作）。
               * 需求14 M4（G9 全类型可编辑）：组合/混合件编辑铅笔直达详情
               * 「源码」tab（可编辑保存）；A 家族维持表单向导编辑模式。 */}
              {!plugin.system && (plugin.kind === "manifest" || plugin.kind === "tool") && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={busy}
                  aria-label={tr("plugins.edit", "编辑")}
                  onClick={() => {
                    setCreateOpen(false);
                    setEditPluginId(plugin.id);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
              {!plugin.system && plugin.kind === "session" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={busy}
                  aria-label={tr("plugins.editSource", "编辑源码")}
                  title={tr("plugins.editSource", "编辑源码")}
                  onClick={() => {
                    setDetailTab("source");
                    setDetailTarget(plugin);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
              {(plugin.composed && !plugin.system) || (!plugin.system && (plugin.kind === "manifest" || plugin.kind === "tool")) ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive hover:text-destructive"
                  disabled={busy}
                  aria-label={tr("plugins.remove", "卸载")}
                  onClick={() => {
                    if (plugin.composed) {
                      // 用户实测补修（2026-11-15）：补确认弹窗——修前组合件
                      // 卸载静默直删（「点击没反应」观感），与 A 家族
                      // handleRemove 的 destructive 确认交互对齐；失败显性
                      // 弹窗（修前只 console.warn）。
                      // 第四轮评审修复：①包进 withBusy（与 A 家族对齐——
                      // 慢删除期间按钮灰化防重复触发，refresh/错误弹窗复用
                      // 同链）；②删除后清 detailTarget（修前详情面板残留
                      // 已删插件信息）。
                      void (async () => {
                        const ok = await confirmDialog({
                          title: t("plugins.removeTitle", { name: plugin.display_name }),
                          description: t("plugins.removeDesc"),
                          confirmText: t("plugins.removeConfirm"),
                          variant: "destructive",
                        });
                        if (!ok) return;
                        await withBusy(plugin.id, async () => {
                          await invokeCommand("composed_plugin_delete", { id: plugin.id });
                          setDetailTarget(null);
                        });
                      })();
                      return;
                    }
                    handleRemove(plugin);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              ) : null}
            </div>
          </div>
        );
  };

  /** v0.9.7 需求3（2026-11-14 裁决）：扩展包 tab 卡片——pi 生态件（npm/git）
   * 统一呈现：内置钉版件带「内置」徽章，支持更新与**还原原生版本**（钉版
   * 快照=hub 分发时版本）；市场安装件支持更新与卸载。说明来自 piindex。 */
  const renderExtCards = (sources: string[] = extInstalled) => {
    if (sources.length === 0) {
      return (
        <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
          {tr("plugins.extEmpty", "暂无扩展包——可在插件市场「扩展生态」安装")}
        </p>
      );
    }
    return sources.map((src) => {
      // 第三轮评审修复：正则单源（NPM_SOURCE_RE）——与 pkgOfSource 同款
      // 内联拷贝删除，改解析只改一处。
      const m = src.match(NPM_SOURCE_RE);
      const pkg = m?.[1] ?? src.replace(/^npm:/, "");
      const pin = extPins.find((p) => p.package === pkg);
      // 十七轮⑧：版本三级兜底——实装目录（真源）→ 源串 @version 钉定
      //（浮动安装无此后缀）→ 钉版快照（还原锚点）。
      const ver = extVersions[pkg] ?? m?.[2] ?? pin?.version ?? "";
      const meta = piindexMeta?.find((e) => e.npm_package === pkg);
      const upd = extUpdates?.find((u) => u.package === pkg);
      const busyCard = updateBusy === pkg || batchUpdates.extensionRunning;
      const runPkg = (action: () => Promise<unknown>, refreshSources = true) => void (async () => {
        setUpdateBusy(pkg);
        try {
          await action();
          if (refreshSources) {
            const sources = await invokeCommand<string[]>("pi_package_installed_sources").catch(() => [] as string[]);
            // 十五轮：动作后单查消解该卡更新态（更新按钮不残留，回到最新/新箭头）。
            await invokeCommand<ExtensionUpdateStatus>("extension_check_update", { package: pkg })
              .then(mergeExtUpdate)
              .catch(() => null);
            // 十七轮⑧：实装版本同步刷新（安装/更新/还原后版本随之变化）。
            const versions = await invokeCommand<Record<string, string>>("pi_package_installed_versions").catch(() => ({}) as Record<string, string>);
            setExtVersions(versions ?? {});
            setExtInstalled(sources ?? []);
          }
        } catch (e) {
          console.warn("ext action failed:", e);
          void alertDialog({ title: tr("plugins.actionFailed", "操作失败"), description: String(e) });
        } finally {
          setUpdateBusy((prev) => (prev === pkg ? null : prev));
        }
      })();
      // 单卡检查：结果并入全局更新状态（与全部检查联动）。
      const checkOne = () =>
        runPkg(
          () => invokeCommand<ExtensionUpdateStatus>("extension_check_update", { package: pkg }).then(mergeExtUpdate),
          false,
        );
      return (
        <div key={src} className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 shrink-0 text-primary/70" />
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium" title={pkg}>{pkg}</span>
            {pin ? (
              <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[9px]">{tr("plugins.identityBuiltin", "内置")}</Badge>
            ) : (
              <Badge variant="outline" className="shrink-0 border-primary/40 px-1 py-0 text-[9px] text-primary">
                {tr("plugins.badgeMarket", "市场安装")}
              </Badge>
            )}
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{ver ? `v${ver}` : ""}</span>
          </div>
          {meta?.description ? (
            <p className="line-clamp-2 min-h-[26px] text-[10px] leading-[13px] text-muted-foreground/80" title={meta.description}>
              {meta.description}
            </p>
          ) : (
            <div className="min-h-[26px]" />
          )}
          {/* 需求4 D4-8b：界面行（登记簿驱动，四态；空态守卫=无记录不露行）。
              适配/新增适配=D4-6 持久入口（与市场引导卡同一预填草稿链）。 */}
          {(() => {
            const entry = extGui.get(`npm:${pkg}`);
            if (!entry || entry.state === "disabled") return null;
            const launch = () =>
              onLaunchDescribe?.(buildGuiAdaptDraft(t, { title: entry.display, packageName: `npm:${pkg}` }));
            return (
              <div className="flex min-h-[18px] flex-wrap items-center gap-1 text-[10px] text-muted-foreground/80">
                <span className="shrink-0">{tr("market.extGuiLabel", "界面")}</span>
                {entry.adapters.length > 0 ? (
                  <>
                    {entry.adapters.map((a) => (
                      <button
                        key={a.plugin_id}
                        type="button"
                        className="max-w-[130px] truncate underline decoration-dotted underline-offset-2 hover:text-foreground"
                        title={a.plugin_id}
                        onClick={() => jumpToPlugin(a.plugin_id)}
                      >
                        {a.plugin_id}
                      </button>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-4 px-1.5 text-[9px]"
                      onClick={launch}
                    >
                      {tr("market.addAdaptAction", "新增适配")}
                    </Button>
                  </>
                ) : entry.gui_verdict === "noneeded" ? (
                  <span className="flex items-center gap-1" title={entry.verdict_note ?? undefined}>
                    {tr("market.extGuiNotNeeded", "无需（后台能力）")}
                    <button
                      type="button"
                      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                      onClick={() => {
                        void invokeCommand("extension_gui_verdict_set", {
                          pkgKey: entry.pkg_key,
                          verdict: "pending",
                        })
                          .catch(() => null)
                          .then(() => refreshExtGui());
                      }}
                    >
                      {tr("market.extGuiReset", "重新判定")}
                    </button>
                  </span>
                ) : (
                  <>
                    <span>{tr("market.extGuiNone", "未适配")}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-4 px-1.5 text-[9px]"
                      onClick={launch}
                    >
                      {tr("market.adaptAction", "适配")}
                    </Button>
                  </>
                )}
              </div>
            );
          })()}
          <div className="mt-auto flex flex-wrap items-center gap-1 pt-0.5 text-[10px] text-muted-foreground/70">
            {upd?.has_update ? (
              <span className="shrink-0 text-amber-600">→ v{upd.latest}</span>
            ) : upd ? (
              <span>{tr("market.upToDate", "最新")}</span>
            ) : null}
            <span className="flex-1" />
            {meta && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={tr("plugins.viewDetails", "详情")}
                title={tr("plugins.viewDetails", "详情")}
                onClick={() => setExtDetailMeta(meta)}
              >
                <Info className="h-3 w-3" />
              </Button>
            )}
            {upd?.has_update && (
              <Button
                size="sm"
                className="h-6 px-2 text-[10px]"
                disabled={busyCard}
                onClick={() => runPkg(() => invokeCommand("extension_update", { packages: [pkg] }))}
              >
                {busyCard ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                <span className="ml-0.5">{tr("market.updateOne", "更新")}</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              disabled={busyCard || checkingUpdates}
              onClick={checkOne}
            >
              {busyCard || checkingUpdates ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              <span className="ml-0.5">{tr("market.checkUpdate", "检查更新")}</span>
            </Button>
            {/* 垃圾桶统一（十五轮裁决；十七轮⑦文案分流）：内置件=卸载更新
                （还原钉版原生版本），市场件=卸载——悬停提示各自如实。 */}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
              disabled={busyCard}
              aria-label={pin ? tr("plugins.uninstallUpdate", "卸载更新") : tr("plugins.remove", "卸载")}
              title={pin ? tr("plugins.uninstallUpdate", "卸载更新") : tr("plugins.remove", "卸载")}
              onClick={() => {
                if (pin) {
                  void runPkg(() => invokeCommand("pi_package_install_online", { source: pin.source }));
                  return;
                }
                // 需求4 D4-8b④（R2-T5 实测抓到的缺口收口）：卸载被适配件
                // 使用的扩展前先确认（界面将停用）——与市场已装卡同款。
                void (async () => {
                  const entry = extGui.get(`npm:${pkg}`);
                  if (entry && entry.adapters.length > 0) {
                    const ok = await confirmDialog({
                      title: tr("plugins.remove", "卸载"),
                      description: t("market.uninstallExtDepsWarn", {
                        defaultValue: "该扩展被 {{n}} 个界面插件使用：{{names}}——卸载后这些界面将停用",
                        n: entry.adapters.length,
                        names: entry.adapters.map((a) => a.plugin_id).join("、"),
                      }),
                      confirmText: tr("plugins.remove", "卸载"),
                      variant: "destructive",
                    });
                    if (!ok) return;
                  }
                  void runPkg(() => invokeCommand("pi_package_uninstall_online", { source: pkg }));
                })();
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      );
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      {dialogNode}
      {/* v0.9.7 需求3：扩展包详情弹窗（已装卡叹号——说明+查看来源）。 */}
      <Dialog open={!!extDetailMeta} onOpenChange={(open) => !open && setExtDetailMeta(null)}>
        <DialogContent className="max-w-md">
          {extDetailMeta ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-start gap-2">
                  <Package className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
                  <span className="min-w-0 break-all">{extDetailMeta.name}</span>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="leading-relaxed text-muted-foreground">{extDetailMeta.description || "-"}</p>
                {extDetailMeta.category && (
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{extDetailMeta.category}</span>
                  </div>
                )}
                {extDetailMeta.detail_url && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => void invokeCommand("open_url", { url: extDetailMeta.detail_url })}
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span className="ml-1">{tr("market.viewSource", "查看来源")}</span>
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <PluginComposeDialog open={composeOpen} onOpenChange={setComposeOpen} onCreated={refresh} />
      <PluginHybridWizard open={hybridOpen} onOpenChange={setHybridOpen} onCreated={refresh} presetMount={hybridPresetMount} />
      <PluginPipelineWizard open={pipelineOpen} onOpenChange={setPipelineOpen} onCreated={refresh} />
      <PluginThemeWizard open={themeWizardOpen} onOpenChange={setThemeWizardOpen} onCreated={refresh} />
      {/* 3a-1：统一创建入口——四类型卡片分流（agent-tool → agents 向导；
          session-composed → 组合式向导；pipeline/hybrid → 指引卡；describe →
          引导到会话对话创建）。替换原两并列按钮（新建插件/新建组合插件）。 */}
      <PluginCreateEntry
        open={entryOpen}
        onOpenChange={setEntryOpen}
        onChoose={(choice) => {
          switch (choice.kind) {
            case "agent-tool":
              setEditPluginId(null);
              setCreateOpen(true);
              break;
            case "session-composed":
              setComposeOpen(true);
              break;
            case "hybrid-guide":
              // 批次6：业务形态预选挂载（面板→停靠面板/挂件→贴边挂件）。
              setHybridPresetMount(
                choice.face === "panel" ? "dock-panel" : choice.face === "widget" ? "rail-widget" : undefined,
              );
              setHybridOpen(true);
              break;
            case "pipeline-guide":
              setPipelineOpen(true);
              break;
            case "theme-wizard":
              setThemeWizardOpen(true);
              break;
            case "describe":
              // v0.9.7 需求3 C1：真链路——跳会话页预填创作指令（原 alert 死分支）。
              onLaunchDescribe?.(choice.text);
              break;
            default:
              break; // pipeline/hybrid 指引卡在入口组件内消化
          }
        }}
      />
      {detailTarget ? (
        <PluginDetailModal
          plugin={detailTarget satisfies DrawerPluginInfo as DrawerPluginInfo}
          initialTab={detailTab}
          onClose={() => setDetailTarget(null)}
          onLaunchPipeline={onLaunchPipeline}
        />
      ) : null}
      <PluginCreateDialog
        open={createOpen || !!editPluginId}
        onOpenChange={(open) => {
          if (!open) setEditPluginId(null);
          setCreateOpen(open);
        }}
        onCreated={refresh}
        editPluginId={editPluginId}
        mcpResolverEnabled={mcpResolverEnabled}
        skillResolverEnabled={skillResolverEnabled}
      />
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{tr("plugins.title", "插件中心")}</h2>
          <p className="text-xs text-muted-foreground mt-1">{tr("plugins.desc", "")}</p>
          {/* v0.9.0 需求11/12 终版裁决：页外零 MCP 入口——MCP/skills 等一切能力
              经插件机制统一管控（创建走「新建插件」；四家注入由启停/启动自动同步）。 */}
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            {tr("plugins.unifiedNote", "MCP、skills、面板等能力统一通过插件机制管理")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              setEditPluginId(null);
              setEntryOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            <span className="ml-1.5">{tr("plugins.createTitle", "创建插件")}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleImportExtension()}
            title={tr("plugins.importExtTitle", "导入 .ts 智能体扩展文件（安全摘要确认后复制，默认不启用）")}
          >
            <FileCode2 className="h-4 w-4" />
            <span className="ml-1.5">{tr("plugins.importExt", "导入扩展")}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={handleReload} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-1.5">{tr("plugins.reload", "重新加载")}</span>
          </Button>
        </div>
      </div>

      {/* v0.9.7 需求3 C2：插件中心二级页签——已安装（原管理面）| 插件市场。 */}
      <div className="flex items-center gap-1.5 border-b border-border/40 pb-2">
        <button
          type="button"
          onClick={() => setView("installed")}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-medium transition-colors",
            view === "installed"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {tr("market.tabInstalled", "已安装")}
        </button>
        <button
          type="button"
          onClick={() => setView("market")}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-medium transition-colors",
            view === "market"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {tr("market.tabMarket", "插件市场")}
        </button>
      </div>

      {view === "market" && (
        <PluginMarketPanel
          onChanged={refresh}
          onLaunchDescribe={onLaunchDescribe}
          onNavigateConfig={onNavigateConfig}
        />
      )}

      {view === "installed" && (<>
      {result && result.manifest_errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertCircle className="h-4 w-4" />
            {tr("env.manifestErrorsTitle", "自定义智能体配置文件加载失败")}
          </div>
          <ul className="mt-2 space-y-1">
            {result.manifest_errors.map(([file, reason]) => (
              <li key={file} className="text-xs font-mono text-destructive/90 break-all">
                {file}: {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 需求14 M4（R7）：待确认安装页内一等分区——红色角标引导，动作直达
          （与 app 级确认模态共存：模态轮询兜底跨页发现，本区管「在这里看清」）。 */}
      {pendingInstalls.length > 0 && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-600">
            <ShieldAlert className="h-4 w-4" />
            {tr("plugins.pendingSectionTitle", "待确认安装")}
            <Badge variant="outline" className="border-amber-500/50 px-1.5 py-0 text-[10px] text-amber-600">
              {pendingInstalls.length}
            </Badge>
          </div>
          <ul className="mt-2 space-y-1.5">
            {pendingInstalls.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-medium text-foreground">{p.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground/70">{p.id}</span>
                <span className="text-muted-foreground">
                  {p.mount} · {(p.assets ?? []).length > 0
                    ? `${(p.assets ?? []).length} ${tr("plugins.pendingAssetUnit", "个文件")}`
                    : tr("plugins.pendingNoAssets", "纯清单")}
                </span>
                {p.takeover ? <span className="text-amber-600">{p.takeover}</span> : null}
                <span className="flex-1" />
                <Button
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => void (async () => {
                    try {
                      await invokeCommand("plugin_set_enabled", { pluginId: p.id, enabled: true });
                      await refresh();
                    } catch (e) {
                      void alertDialog({ title: tr("plugins.actionFailed", "操作失败"), description: String(e) });
                    }
                  })()}
                >
                  {tr("plugins.pendingEnable", "启用")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => void (async () => {
                    try {
                      await invokeCommand("plugin_set_enabled", { pluginId: p.id, enabled: false });
                      await refresh();
                    } catch (e) {
                      void alertDialog({ title: tr("plugins.actionFailed", "操作失败"), description: String(e) });
                    }
                  })()}
                >
                  {tr("plugins.pendingDismiss", "暂不")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* v0.9.3 需求11：分类横向 tab（胶囊形态）——业务 tab（Y 轴：在哪用）
          × 实现筛选（X 轴：怎么造）双视角（批次2）+ 需求14 搜索框（G8）。 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
        {PLUGIN_CATEGORIES.map((cat) => {
          const items = cat.key === "extension"
            ? extInstalled
            : (result?.plugins ?? []).filter((x) => categoryOf(x) === cat.key);
          const active = activeTab === cat.key;
          return (
            <button
              key={cat.key}
              type="button"
              onClick={() => switchTab(cat.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {tr(cat.labelKey, cat.fallback)}
              <span className={cn("text-[10px] tabular-nums", active ? "opacity-80" : "opacity-50")}>
                {items.length}
              </span>
            </button>
          );
        })}
        </div>
      </div>

      {/* 工具行（十四轮 UI 统一）：筛选 chips 在左、搜索框恒最右（跨分类
          搜索——非空时网格展示全库命中，忽略 tab）。 */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        {/* 筛选维度分组（十二轮样式优化；十七轮小组不折行；十八轮四组：
            实现（配置/混合——code 无产出件不放 chip，内置/市场安装移来源组）
            → 来源（内置/自建/市场安装，新增组排实现后）→ 形态（九类+两兜底）。 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px]">
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
              {tr("plugins.implFilterLabel", "实现")}
            </span>
            <div className="flex items-center gap-1">
              {(["all", "config", "combo"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setImplFilter(k)}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 transition-colors",
                    implFilter === k
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {k === "all" ? tr("plugins.implAll", "全部") : tr(IMPL_BADGE[k].key, IMPL_BADGE[k].fallback)}
                </button>
              ))}
            </div>
          </div>
          <div className="h-3.5 w-px bg-border/70" />
          {/* 十八轮新增：来源筛选（内置/自建/市场安装）——排在实现后面。 */}
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
              {tr("plugins.sourceFilterLabel", "来源")}
            </span>
            <div className="flex items-center gap-1">
              {(["all", "builtin", "custom", "market"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSourceFilter(k)}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 transition-colors",
                    sourceFilter === k
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {k === "all" ? tr("plugins.sourceAll", "全部") : tr(SOURCE_BADGE[k].key, SOURCE_BADGE[k].fallback)}
                </button>
              ))}
            </div>
          </div>
          <div className="h-3.5 w-px bg-border/70" />
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
              {tr("plugins.formFilterLabel", "形态")}
            </span>
            <div className="flex items-center gap-1">
              {(["all", ...PLUGIN_FORM_VALUES] as Array<"all" | FormValue>).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFormFilter(k)}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 transition-colors",
                    formFilter === k
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {k === "all" ? tr("plugins.formAll", "全部") : tr(FORM_BADGE[k].key, FORM_BADGE[k].fallback)}
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* 搜索框：工具行恒最右（十四轮统一；十五轮一键清除）。 */}
        <MarketSearchBox
          value={search}
          onChange={setSearch}
          placeholder={tr("plugins.searchPlaceholder", "搜索 id/名称/描述/语言…")}
        />
      </div>

      {/* v0.9.7 需求3 已装页优化二版（2026-11-14 裁决）：更新检查按当前
          tab 范围——仅技能/扩展包 tab 有更新语义；当前 tab 无可更新内容
          （无市场件/无包）不显示检查更新；全部更新仅在检出新版或批量进行
          中出现。 */}
      {(() => {
        const updatableCount =
          activeTab === "skill"
            ? (result?.plugins ?? []).filter((p) => skillLedger[p.id]).length
            : activeTab === "extension"
              ? extInstalled.length
              : 0;
        if (updatableCount === 0) return null;
        const isSkillTab = activeTab === "skill";
        const anyUpdate = isSkillTab
          ? !!skillUpdates?.some((u) => u.has_update)
          : !!extUpdates?.some((u) => u.has_update);
        const batchRunning = isSkillTab ? batchUpdates.skillRunning : batchUpdates.extensionRunning;
        const showUpdateAll = anyUpdate || batchRunning;
        return (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={checkingUpdates || batchRunning}
              onClick={() =>
                void (async () => {
                  setCheckingUpdates(true);
                  try {
                    if (isSkillTab) {
                      const skill = await invokeCommand<SkillUpdateStatus[]>("skillhub_check_updates").catch(() => null);
                      setSkillUpdates(skill);
                    } else {
                      const ext = await invokeCommand<ExtensionUpdateStatus[]>("extension_check_updates").catch(() => null);
                      setExtUpdates(ext);
                    }
                  } finally {
                    setCheckingUpdates(false);
                  }
                })()
              }
            >
              {checkingUpdates ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              <span className="ml-1">{tr("market.checkUpdates", "检查更新")}</span>
            </Button>
            {showUpdateAll && (
              <Button
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={batchRunning}
                onClick={() => {
                  if (isSkillTab) startSkillUpdateAll();
                  else startExtensionUpdateAll();
                  // 批量完成后刷新本页数据（全局 store 离开不打断）。
                  void (async () => {
                    while (updatesPending()) await new Promise((r) => setTimeout(r, 800));
                    try {
                      if (isSkillTab) {
                        const [skillsLatest, ledger] = await Promise.all([
                          invokeCommand<SkillUpdateStatus[]>("skillhub_check_updates").catch(() => null),
                          invokeCommand<Record<string, string>>("skillhub_installed").catch(() => ({}) as Record<string, string>),
                        ]);
                        if (skillsLatest) setSkillUpdates(skillsLatest);
                        setSkillLedger(ledger ?? {});
                      } else {
                        const [sources, latest, versions] = await Promise.all([
                          invokeCommand<string[]>("pi_package_installed_sources").catch(() => [] as string[]),
                          invokeCommand<ExtensionUpdateStatus[]>("extension_check_updates").catch(() => null),
                          // 十七轮⑧：批量更新后实装版本同步刷新。
                          invokeCommand<Record<string, string>>("pi_package_installed_versions").catch(() => ({}) as Record<string, string>),
                        ]);
                        setExtVersions(versions ?? {});
                        setExtInstalled(sources ?? []);
                        if (latest) setExtUpdates(latest);
                      }
                      await refresh();
                      // 批量失败项如实呈现（评审修复轮关切：failed 不能无前端消费）。
                      const failures = marketUpdateFailures();
                      if (failures.length > 0) {
                        void alertDialog({
                          title: tr("env.updateFailed", "更新失败"),
                          description: tr("market.updateFailedItems", "以下项更新失败：{{names}}").replace(
                            "{{names}}",
                            failures.join("、"),
                          ),
                        });
                      }
                    } catch { /* 完成刷新失败静默 */ }
                  })();
                }}
              >
                {batchRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                <span className="ml-1">
                  {batchRunning
                    ? tr("market.updatingProgress", "更新中 {{d}}/{{n}}")
                        .replace("{{d}}", String(isSkillTab ? batchUpdates.skillDone : batchUpdates.extensionDone))
                        .replace("{{n}}", String(isSkillTab ? batchUpdates.skillTotal : batchUpdates.extensionTotal))
                    : tr("market.updateAll", "全部更新")}
                </span>
              </Button>
            )}
          </div>
        );
      })()}

      {/* 卡片网格：自适应列数铺满区域（v0.9.3 需求11，minmax 卡宽 ~230px）；
          批次2：叠加实现维度过滤；需求14 M4（G8）：搜索非空时跨分类展示
          全库命中（tab 失效、实现筛选叠加、专属区块隐藏）。 */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
        {/* v0.9.4 需求12：开发日志中心虚拟卡（用户裁决：入口放插件中心核心引擎
            分类，默认关闭手动开启；开关写 settings.json 跨启动保持）。十七轮：
            无形态/实现徽章，筛选激活时隐藏（见 filtersIdle）。 */}
        {/* 二十轮：DevLogCard 已有形态徽章（侧边栏面板）——形态筛选命中
            该值时显示（实现/来源筛选激活仍隐藏：无这两维徽章）。 */}
        {activeTab === "core" && !search.trim() && implFilter === "all" && sourceFilter === "all"
          && (formFilter === "all" || formFilter === "sidebar-panel") && <DevLogCard />}
        {/* 需求11 追加三 A：原生 MCP 服务管理区（jishu 直连条目，键级管
            mcp.json 非 jishu-hub 用户条目；与聚合插件互补）。十七轮：同上
            筛选门控。 */}
        {activeTab === "mcp" && !search.trim() && filtersIdle && <NativeMcpSection />}
{/* v0.9.7 需求3 十四轮：扩展包参与检索——扩展包 tab 无搜索显示全量；
    搜索态生态件命中卡并入全库结果（插件全库命中 + 扩展包命中）。
    十七轮：扩展卡无形态/实现徽章，筛选激活时同样隐藏。 */}
        {activeTab === "extension" && !search.trim() && filtersIdle && renderExtCards()}
        {search.trim() && filtersIdle && extInstalled.filter(matchesExtSearch).length > 0 && renderExtCards(extInstalled.filter(matchesExtSearch))}
        {(result?.plugins ?? [])
          .filter((x) =>
            search.trim()
              ? matchesSearch(x) && (implFilter === "all" || implOfCard(x) === implFilter)
                  && (sourceFilter === "all" || sourceOf(x, !!skillLedger[x.id]) === sourceFilter)
                  && (formFilter === "all" || formOf(x) === formFilter)
              : categoryOf(x) === activeTab && (implFilter === "all" || implOfCard(x) === implFilter)
                  && (sourceFilter === "all" || sourceOf(x, !!skillLedger[x.id]) === sourceFilter)
                  && (formFilter === "all" || formOf(x) === formFilter),
          )
          .map((plugin) => renderCard(plugin))}
      </div>
      {(result?.plugins ?? []).filter((x) =>
        search.trim()
          ? matchesSearch(x) && (implFilter === "all" || implOfCard(x) === implFilter)
              && (sourceFilter === "all" || sourceOf(x, !!skillLedger[x.id]) === sourceFilter)
              && (formFilter === "all" || formOf(x) === formFilter)
          : categoryOf(x) === activeTab && (implFilter === "all" || implOfCard(x) === implFilter)
              && (sourceFilter === "all" || sourceOf(x, !!skillLedger[x.id]) === sourceFilter)
              && (formFilter === "all" || formOf(x) === formFilter),
      ).length === 0 &&
        // v0.9.7 第三轮评审修复 P1-4：空态误判——旧条件把「装过扩展包」
        //（extInstalled 全局非空）当成「当前视图有内容」，但扩展卡只在
        // 扩展包 tab（或搜索态）渲染：装过扩展包的用户切到无插件分类看到
        // 整片空白无提示。按「当前视图实际会渲染的区块」判断：tab 模式下
        // 非扩展包 tab 不看 extInstalled；扩展包 tab 且筛选 idle 时才以
        // 扩展卡有无为准（筛选激活时扩展卡隐藏，视为无内容）。
        (search.trim()
          ? !filtersIdle || extInstalled.filter(matchesExtSearch).length === 0
          : activeTab !== "extension" || !filtersIdle || extInstalled.length === 0) && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {search.trim()
            ? tr("plugins.searchEmpty", "无匹配插件")
            : result && result.plugins.length === 0
              ? tr("plugins.empty", "无插件")
              : tr("plugins.categoryEmpty", "暂无插件")}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        {tr("plugins.hint", "")}
      </p>
      </>)}

      {/* v0.9.0 需求8：声明式面板（list 只读模板）——逐项执行声明命令并展示输出。 */}
      <Dialog open={!!panelTarget} onOpenChange={(open) => { if (!open) setPanelTarget(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{panelTarget?.panel?.title ?? panelTarget?.display_name}</DialogTitle>
            <DialogDescription>
              {tr("plugins.panelDescription", "插件声明的只读命令面板，点击执行查看输出。")}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto">
            {(panelTarget?.panel?.items ?? []).map((item, index) => (
              <div key={index} className="rounded-md border border-border/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{item.label}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={panelRunning !== null}
                    onClick={() => runPanelItem(panelTarget!.id, index)}
                  >
                    {panelRunning === index ? tr("plugins.panelRunning", "执行中…") : tr("plugins.panelRun", "执行")}
                  </Button>
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground" title={item.command}>
                  <code>{item.command}</code>
                </p>
                {panelOutputs[index] && (
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-2 text-[11px]">
                    {panelOutputs[index]}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * v0.9.4 需求12：开发日志中心卡（用户裁决：入口放插件中心「核心引擎」分类，
 * 默认关闭、手动开启）——开关写 ~/.jishu-hub/settings.json 的 devLogForced
 *（后端权威持久化，跨启动保持），开启后生产构建同样显示会话区日志中心。
 */
function DevLogCard() {
  const { t } = useTranslation();
  // 第三轮评审修复：开关失败显性化（修前只 console.warn——点开关无反应
  // 像按钮失灵）。hook 需渲染自身 dialogNode（e89bfe7 同款坑）。
  const { alert: alertDialog, dialogNode: alertNode } = useConfirmDialog();
  const [forced, setForced] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invokeCommand<boolean>("get_dev_log_forced")
      .then(setForced)
      .catch(() => setForced(false));
  }, []);

  const toggle = async () => {
    if (busy || forced === null) return;
    setBusy(true);
    try {
      await invokeCommand("set_dev_log_forced", { enabled: !forced });
      setForced(!forced);
    } catch (e) {
      console.warn("[dev-log] 切换失败:", e);
      void alertDialog({
        title: t("plugins.actionFailed", { defaultValue: "操作失败" }),
        description: String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3 transition-colors hover:border-border">
      <div className="flex items-center gap-2">
        <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground">
          <BugIcon className="h-4 w-4" />
        </div>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {t("plugins.devLogName", { defaultValue: "开发日志中心" })}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={forced === true}
          disabled={forced === null || busy}
          onClick={() => void toggle()}
          className={
            "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 " +
            (forced ? "bg-primary" : "bg-muted-foreground/30")
          }
        >
          <span
            className={
              "absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-all " +
              (forced ? "left-[18px]" : "left-0.5")
            }
          />
        </button>
      </div>
      {/* 徽章行（十七轮样式对齐；二十轮用户裁决：日志中心归侧边栏面板
          形态——加形态徽章，参与形态筛选联动）。 */}
      <div className="flex min-h-[16px] flex-wrap items-center gap-1">
        <Badge variant="outline" className={cn("px-1 py-0 text-[9px]", IDENTITY_BADGE.core.cls)}>
          {t("plugins.coreBadge", "核心引擎")}
        </Badge>
        <Badge variant="outline" className="border-border/60 px-1 py-0 text-[9px] text-muted-foreground">
          {t("plugins.formSidebarPanel", "侧边栏面板")}
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          {t("plugins.devLogKind", { defaultValue: "调试能力" })}
        </span>
      </div>
      <p className="line-clamp-2 min-h-[26px] text-[10px] leading-[13px] text-muted-foreground/80">
        {t("plugins.devLogDesc", { defaultValue: "开启后显示会话区日志中心入口（含生产构建），全流程会话流转/时序日志可复制导出，便于问题排查。默认关闭。" })}
      </p>
      {alertNode}
    </div>
  );
}
