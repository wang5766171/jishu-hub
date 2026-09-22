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

// ── 数据面类型（可序列化契约，供 subscribe 消费）──

/** 完整消息（含全部块类型；插件按需取用，只读约定）。 */
export interface PluginMessage {
  role: string;
  blocks: PluginBlock[];
}

/** 内容块（序列化友好投影；工具调用/思考/交互/图片/分隔线均可见）。 */
export interface PluginBlock {
  type:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "interaction"
    | "phase_divider"
    | "image";
  /** text 块正文；tool_use 为工具名；interaction 为 prompt；分隔线为 phase。 */
  text?: string;
  /** tool_use 调用 id。 */
  id?: string;
  /** tool_use 输入（JSON 对象）。 */
  input?: Record<string, unknown>;
  /** tool_result 输出。 */
  output?: string;
  /** tool_result 是否错误。 */
  isError?: boolean;
  /** interaction 选项。 */
  options?: Array<{ id: string; label: string }>;
  /** phase_divider 标题（v0.9.3 需求10 B1：插件接管渲染所需的完整块数据）。 */
  title?: string;
  /** interaction 已选答案。 */
  answer?: string;
  /** thinking 内容。 */
  thinking?: string;
}

/** 流式状态（阅读模式/实时监控/自动滚动类插件消费）。 */
export interface PluginStreamState {
  isStreaming: boolean;
  /** 流式文本（累积）。 */
  text: string;
  /** 当前重试状态（null = 无重试）。 */
  retry: { attempt: number; max: number; reason: string } | null;
  /** 错误信息（null = 无）。 */
  error: string | null;
  /** steer 注入文本列表。 */
  steerTexts: string[];
}

/** 会话元信息。 */
export interface PluginSessionMeta {
  agentId: string | null;
  agentName: string | null;
  model: string | null;
  thinkingLevel: string | null;
  /** 上下文占用（token；null = 未知）。 */
  contextUsed: number | null;
  contextTotal: number | null;
  /** 当前项目根绝对路径（v0.9.2 测试期：插件解析 tool_use 相对路径用，
   * 如产物中心把会话产出的相对路径解析为可读的绝对路径）。 */
  projectPath: string | null;
  /** 项目编码名（get_session_messages 的 encodedName 键；插件跨会话读取
   * 子节点会话产物用）。 */
  projectEncodedName: string | null;
}

/** 消息搜索结果。 */
export interface PluginSearchMatch {
  messageIndex: number;
  blockIndex: number;
  /** 命中文本片段（上下文截断）。 */
  excerpt: string;
}

/** 会话内核提供给插件的受控上下文（插件可触达的全部世界）。 */
export interface SessionKernelContext {
  // ── 数据（快照式；插件可经 subscribe 声明持续订阅）──
  /** 轮次摘要（统一视图模型同源）。 */
  turns: TurnSummary[];
  /** 当前阅读位置所在轮（scroll-spy），-1 = 未知。 */
  activeTurnIndex: number;
  /** 当前会话 id（null = 未选中/新会话）。 */
  sessionId: string | null;
  /** 当前会话显示名。 */
  sessionTitle: string | null;
  /** 完整消息（含全部块类型的只读投影）。 */
  messages: PluginMessage[];
  /** v0.9.3 需求10 A4：审批面（插件可消费的待审批投影，订阅经 ctx.subscribe）。 */
  approvals: import("../kernel/data-hub").PluginApprovalInfo[];
  /** 流式状态快照（null = 无流式会话）。 */
  streamState: PluginStreamState | null;
  /** 会话元信息。 */
  sessionMeta: PluginSessionMeta;
  /** 任务上下文（会话关联任务实例时非空）。 */
  task: TaskPanelContext | null;

  // ── 命令 ──
  scrollToTurn(index: number): void;
  /** 搜索消息文本，返回全部命中。 */
  searchMessages(query: string): PluginSearchMatch[];
  /** 滚动定位到指定消息。 */
  scrollToMessage(messageIndex: number): void;
  /** 插入文本到输入框光标处（不发送）。 */
  insertToComposer(text: string): void;
  /** 切换到指定会话。 */
  switchSession(sessionId: string): void;
  /** 打开文件预览面板。 */
  openFileViewer(path: string): void;
  /** 展开插件自己的面板（v0.9.2 测试期）：按插件声明的形态生效——dock-panel
   * 悬浮展开 / sidebar-panel 侧栏顶开；单选互斥（展开一个收起其他）。
   * event-hook 收到信号需要拉起面板时使用。 */
  openPanel(pluginId: string): void;
  /** 收起当前展开的面板（openPanel 的对称命令）。 */
  closePanel(): void;
  /** v0.9.3 需求8：会话压缩命令（上下文占用环等插件消费）——异步触发，
   *  进度经 isCompacting 观察。仅在 capabilities.compact 为真时插件应提供
   *  压缩控制（与原内置门控同口径）。 */
  compactSession(): void;
  isCompacting: boolean;
  /** 当前会话智能体的能力面（CONTEXT_COMPACT 等）。 */
  capabilities: { compact: boolean };
  /** 自动压缩偏好（null = 跟随 agent 默认/未配置）。 */
  autoCompaction: boolean | null;
  setAutoCompaction(enabled: boolean): void;
  /** 弹确认对话框（Promise<boolean>）。 */
  confirmDialog(opts: { title: string; description?: string; variant?: "default" | "destructive" }): Promise<boolean>;
  /** 会话信息解析：id → 标题 + 类型。 */
  resolveSessionInfo(
    sessionId: string,
  ): { title: string; kind: "session" | "task" | "node" | "unknown" } | null;

  // ── 订阅（声明制；未订阅不推送）──
  subscribe: {
    /** 完整消息流（含全部块类型）。 */
    messages(cb: (msgs: PluginMessage[]) => void): Unsubscribe;
    /** 流式状态（进行中/内容/重试/错误/steer）。 */
    streamState(cb: (state: PluginStreamState | null) => void): Unsubscribe;
    /** 会话元信息（agent/模型/思考档/上下文占用）。 */
    sessionMeta(cb: (meta: PluginSessionMeta) => void): Unsubscribe;
    /** 轮次摘要（已有 turns 快照的持续版）。 */
    turns(cb: (turns: TurnSummary[]) => void): Unsubscribe;
    /** v0.9.3 需求10 A4：审批面订阅（注册即回放）。 */
    approvals(cb: (list: import("../kernel/data-hub").PluginApprovalInfo[]) => void): Unsubscribe;
    /** 内核信号（通知/音效等）。 */
    events(cb: (signal: SessionSignal) => void): Unsubscribe;
  };
}

/** 订阅取消句柄。 */
export type Unsubscribe = () => void;

/** 全景面板节点的呈现态摘要（内核侧组装，插件不直接触达 store）。 */
export interface TaskPanelNode {
  nodeId: string;
  title: string;
  status: string;
  /** 依赖未就绪提示（如「等待 ②」）。 */
  waitingFor?: string;
}

/** 已执行节点的子会话索引（TaskPanelContext.nodeSessions 条目）。 */
export interface TaskNodeSession {
  nodeId: string;
  title: string;
  /** 子代理会话 id（已回填时非空）。 */
  sessionId: string | null;
  /** 子代理 agent id（读会话存储用；空 = 未知）。 */
  agentId: string | null;
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
  /** 已执行节点的子会话索引（v0.9.2 测试期：插件跨会话识别子节点产出物，
   * 如产物中心拉取各节点会话消息提取产物文件）。 */
  nodeSessions: TaskNodeSession[];
  /** 当前钻入的子任务会话节点（无选中为 null）——看板高亮用。
   * 可选字段：插件与内核独立演进（版本错位容错），缺失时看板不高亮。 */
  selectedNodeId?: string | null;
  /** 钻入子任务会话；null = 取消选择（主区回退任务阶段会话/主会话）。 */
  onSelectNode(nodeId: string | null): void;
  /** 打开全屏流程画布（高级视图）。 */
  onOpenCanvas(): void;
  /** 取消整个流程（二次确认由内核承担）。 */
  onCancelRun(): void;
}

// ── 挂载点 ──

/** 贴边挂件挂载点：贴消息流左/右缘的细条（无标题栏）。 */
export interface RailWidgetMount {
  kind: "rail-widget";
  Component: ComponentType<{ ctx: SessionKernelContext }>;
  /** 初始侧位（无布局记忆时）；默认 left。v0.9.3 需求3：流式状态挂件等
   *  与导航列（左缘）同屏的挂件声明 right 避让。 */
  defaultSide?: import("../shell/dock-layout").RailSide;
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

/** 侧边栏面板挂载点（v0.9.2 测试期，用户裁决：能力中心支持两种形态）：
 * 挤压式布局——面板展开时主区被顶开让位（同文件预览形态），区别于
 * dock-panel 的悬浮覆盖。宽度固定 50vw（会话侧栏 shell 统一管理）。 */
export interface SidebarPanelMount {
  kind: "sidebar-panel";
  /** 标题 i18n key 与兜底文案。 */
  titleKey: string;
  titleFallback: string;
  Component: ComponentType<{ ctx: SessionKernelContext }>;
}

/** 块渲染器挂载点（v0.9.2 底座增强）：按匹配域判别联合（测试期修复23
 * 结构收口）——两种匹配语义（代码块语言匹配 / 核心块类型接管）此前共用
 * 一个形状且字段全可选，组合引擎把 block-type 源适配成 languages=[] +
 * detect 恒真即命中一切代码块；联合后跨域匹配在类型层不可表达。
 * 匹配域只有一条进入路径：code → matchBlockRenderer（语言咨询），
 * block-type → matchBlockTypeRenderer（块类型咨询）。 */
export interface CodeBlockRendererMount {
  kind: "block-renderer";
  matching: "code";
  /** 语言匹配（小写，如 ["html"]）——**显式封闭集，无通配**：插件只接管
   *  自己声明的语言；bash 等未声明的常规对话代码块结构上不可命中（空集
   *  同样不匹配任何语言）。 */
  languages: string[];
  /** 内容判定（如 HTML 是否完整文档）。 */
  detect: (language: string, code: string) => boolean;
  Component: ComponentType<{ code: string; language: string }>;
}

export interface BlockTypeRendererMount {
  kind: "block-renderer";
  matching: "block-type";
  /** 接管的核心块类型（interaction / phase_divider 等）。 */
  blockTypes: string[];
  /** 块渲染组件（接收完整 PluginBlock；联合臂必带，不再有"空挂载"态）。 */
  BlockComponent: ComponentType<{ block: PluginBlock }>;
}

export type BlockRendererMount = CodeBlockRendererMount | BlockTypeRendererMount;

/** composer 尾部控制行挂载点（v0.9.3 需求8：上下文占用环迁移）：渲染在
 *  模型选择器/思考档同一行的内联槽位（模型行与无模型行两处互斥位点，
 *  宿主按启用集渲染）。 */
export interface ComposerTrailingMount {
  kind: "composer-trailing";
  Component: ComponentType<{ ctx: SessionKernelContext }>;
}

export type PluginMount =
  | RailWidgetMount
  | DockPanelMount
  | SidebarPanelMount
  | BlockRendererMount
  | ComposerTrailingMount
  | EventHookMount
  | HeaderActionMount;

/** 内核信号（事件钩子挂载点的数据面）。 */
export type SessionSignal =
  | { type: "turn-complete"; sessionId: string; agentId: string; error?: boolean }
  /** v0.9.4 需求6 v2：AI 会话标题已生成落盘（session_info）——会话列表可刷新。 */
  | { type: "session-titled"; sessionId: string; title: string }
  | { type: "approval-request"; sessionId: string; agentId: string }
  | { type: "task-run-failed"; taskId: string; title: string }
  /** 文件预览请求（v0.9.2 测试期）：agent 工具（如 preview_html）经内核
   * 事件管线转发——插件自行决定是否响应（产物中心打开侧栏渲染）。 */
  | { type: "file-preview-request"; file: string; sessionId?: string };

/** 事件钩子挂载点：无 UI 的事件消费（通知/音效等）。 */
export interface EventHookMount {
  kind: "event-hook";
  /** v0.9.2 测试期：补 ctx 入参——常驻事件消费可能需要内核命令（如
   * file-preview-request → ctx.openPanel 展开面板）。 */
  onSignal: (signal: SessionSignal, ctx: SessionKernelContext) => void;
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
  /** v0.9.3 需求12 P1：配置面声明——详情抽屉自动生成设置表单，组件经
   * usePluginConfig 取值（代码常量抽离为可编辑参数的挂点）。 */
  configSchema?: import("./config-plane").PluginConfigField[];
  /** v0.9.3 需求13 C4：阶段流水线声明（pipeline 型组合插件——编排定义，
   * 运行时驱动随 C4-slice-2 接 conductor）。 */
  pipeline?: import("../capabilities/pipeline/contracts").PipelineDeclaration;
  descriptionKey?: string;
  descriptionFallback?: string;
  /** 描述符契约版本（演进接缝：Stage 2 版本协商基础）。 */
  contractVersion: number;
  /** 来源标记（本期恒 builtin）。 */
  source: "builtin" | "config" | "dynamic";
  /** 声明制授权（本期仅数据订阅面，占位对齐 05 §3.3）。 */
  permissions: string[];
  mounts: PluginMount[];
  /** 快捷键（如 "ctrl+f"）：按下组合键切换对应面板显隐。null = 无绑定。 */
  shortcut?: string;
}

export function dockPanelsOf(plugin: SessionPluginDescriptor): DockPanelMount[] {
  return plugin.mounts.filter((m): m is DockPanelMount => m.kind === "dock-panel");
}

export function sidebarPanelsOf(plugin: SessionPluginDescriptor): SidebarPanelMount[] {
  return plugin.mounts.filter((m): m is SidebarPanelMount => m.kind === "sidebar-panel");
}

export function railWidgetsOf(plugin: SessionPluginDescriptor): RailWidgetMount[] {
  return plugin.mounts.filter((m): m is RailWidgetMount => m.kind === "rail-widget");
}

export function composerTrailingsOf(plugin: SessionPluginDescriptor): ComposerTrailingMount[] {
  return plugin.mounts.filter((m): m is ComposerTrailingMount => m.kind === "composer-trailing");
}
