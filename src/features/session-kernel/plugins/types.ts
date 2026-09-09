import type { ComponentType } from "react";
import type { TurnSummary } from "@/features/session-kernel/view-model";
import type { DockSlot } from "../shell/dock-layout";

export type { DockSlot };

/**
 * 会话能力插件契约（v0.9.2 需求1，架构详见 docs/v0.9.2/需求1.../05）。
 *
 * 三大纪律（演进接缝，05 §5）：
 * 1. 插件只经 `SessionKernelContext` 取数/发命令，禁止 import 内核与页面模块
 *    （lint 约束随后续版本补齐）；
 * 2. 契约面数据可序列化（为 Stage 2 沙箱 postMessage 协议化预留）；
 * 3. 描述符携带 `contractVersion` 与 `source`（本期恒为 1/builtin，字段先行）。
 */

export const SESSION_PLUGIN_CONTRACT_VERSION = 1;

/** 会话内核提供给插件的受控上下文（插件可触达的全部世界）。 */
export interface SessionKernelContext {
  /** 轮次摘要（统一视图模型同源）。 */
  turns: TurnSummary[];
  /** 当前阅读位置所在轮（scroll-spy），-1 = 未知。 */
  activeTurnIndex: number;
  /** 内核定位 API：滚动到指定轮次。 */
  scrollToTurn(index: number): void;
  /** 任务上下文（会话关联任务实例时非空；任务流程全景插件消费）。 */
  task: TaskPanelContext | null;
  /** 当前会话 id（null = 未选中/新会话）。 */
  sessionId: string | null;
  /** 当前会话显示名（导出文件名等用途）。 */
  sessionTitle: string | null;
  /** 当前会话完整消息（导出等消费；只读约定，插件不得变更）。 */
  messages: { role: string; text: string }[];
  /** 会话信息解析（用量面板等消费）：id → 标题 + 类型（会话/任务/子节点）。 */
  resolveSessionInfo(
    sessionId: string,
  ): { title: string; kind: "session" | "task" | "node" | "unknown" } | null;
}

/** 全景面板节点的呈现态摘要（内核侧组装，插件不直接触达 store）。 */
export interface TaskPanelNode {
  nodeId: string;
  title: string;
  status: string;
  /** 依赖未就绪提示（如「等待 ②」）。 */
  waitingFor?: string;
}

/** 任务上下文（v0.9.2 需求2：流程执行能力与核心会话松耦合的数据面）。 */
export interface TaskPanelContext {
  taskId: string;
  title: string;
  phase: string;
  runStatus: string | null;
  /** 执行进度（终态节点数 / 总数）。 */
  completed: number;
  total: number;
  nodes: TaskPanelNode[];
  /** 钻入子任务会话。 */
  onSelectNode(nodeId: string): void;
  /** 打开全屏流程画布（高级视图）。 */
  onOpenCanvas(): void;
  /** 取消整个流程（二次确认由内核承担）。 */
  onCancelRun(): void;
}

/** 贴边挂件挂载点：贴消息流左/右缘的细条（无标题栏）。 */
export interface RailWidgetMount {
  kind: "rail-widget";
  Component: ComponentType<{ ctx: SessionKernelContext }>;
}

/** 停靠面板挂载点：标准面板（标题栏+内容+收起钮）。 */
export interface DockPanelMount {
  kind: "dock-panel";
  /** 标题 i18n key 与兜底文案。 */
  titleKey: string;
  titleFallback: string;
  Component: ComponentType<{ ctx: SessionKernelContext }>;
  /** 首次启用时的默认停靠槽位（此后跟随用户布局记忆）。 */
  defaultSlot: DockSlot;
}

export type PluginMount =
  | RailWidgetMount
  | DockPanelMount
  | BlockRendererMount
  | EventHookMount
  | HeaderActionMount;

/** 块渲染器挂载点：对某类代码块/内容块注册增强渲染，未命中或插件禁用时
 * 回退核心渲染（markdown 代码块原样显示）。 */
export interface BlockRendererMount {
  kind: "block-renderer";
  /** 语言匹配（小写，如 ["html"]）；空数组 = 全部语言由 detect 判定。 */
  languages: string[];
  /** 内容判定（如 HTML 是否完整文档）。 */
  detect: (language: string, code: string) => boolean;
  Component: ComponentType<{ code: string; language: string }>;
}

/** 内核信号（事件钩子挂载点的数据面）。 */
export type SessionSignal =
  | { type: "turn-complete"; sessionId: string; agentId: string; error?: boolean }
  | { type: "approval-request"; sessionId: string; agentId: string }
  | { type: "task-run-failed"; taskId: string; title: string };

/** 事件钩子挂载点：无 UI 的事件消费（通知/音效等）。 */
export interface EventHookMount {
  kind: "event-hook";
  onSignal: (signal: SessionSignal) => void;
}

/** 会话头部动作挂载点：头部工具条按钮（导出等轻动作）。 */
export interface HeaderActionMount {
  kind: "header-action";
  labelKey: string;
  labelFallback: string;
  icon?: ComponentType<{ className?: string }>;
  onClick: (ctx: SessionKernelContext) => void;
}

/** 会话能力插件描述符（前端注册表条目）。 */
export interface SessionPluginDescriptor {
  id: string;
  /** 显示名 i18n key 与兜底（插件页/快捷图标消费）。 */
  displayNameKey: string;
  displayNameFallback: string;
  descriptionKey?: string;
  descriptionFallback?: string;
  /** 描述符契约版本（演进接缝：Stage 2 版本协商基础）。 */
  contractVersion: number;
  /** 来源标记（本期恒 builtin）。 */
  source: "builtin" | "config" | "dynamic";
  /** 声明制授权（本期仅数据订阅面，占位对齐 05 §3.3）。 */
  permissions: string[];
  mounts: PluginMount[];
}

export function dockPanelsOf(plugin: SessionPluginDescriptor): DockPanelMount[] {
  return plugin.mounts.filter((m): m is DockPanelMount => m.kind === "dock-panel");
}

export function railWidgetsOf(plugin: SessionPluginDescriptor): RailWidgetMount[] {
  return plugin.mounts.filter((m): m is RailWidgetMount => m.kind === "rail-widget");
}
