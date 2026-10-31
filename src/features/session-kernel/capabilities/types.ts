/**
 * 基座能力契约（v0.9.3 需求13：组合式插件体系）。
 *
 * 分层纪律（入 DEVELOP_READ）：本层（capabilities/**）禁止 import plugins/**
 * 与 pages/**；渲染组件只依赖本契约与第三方库；组合引擎（composition/）是
 * 唯一同时知道「能力注册表」与「插件描述符」的装配层。
 */
import type { ComponentType } from "react";
import type { PluginConfigValues } from "../plugins/config-plane";

// ── 内容源 ──

export type SourcePayload =
  | { kind: "code-block"; language: string; code: string }
  | { kind: "block"; blockType: string; block: unknown }
  | { kind: "aggregate"; data: unknown }
  | { kind: "turns"; turns: Array<{ question: string; answer: string }>; activeIndex: number; jump?: (i: number) => void }
  | { kind: "task"; task: import("../plugins/types").TaskPanelContext | null }
  | { kind: "signal"; signal: unknown };

export interface SourceDeclaration {
  type:
    | "code-block"
    | "block-type"
    | "messages"
    | "turns"
    | "stream-state"
    | "task"
    | "signal"
    /** v0.9.5 需求1（原需求26）8b：工具返回值源——配 tool-output 挂载
     *  （渲染在 tool_use 卡 output 区，替换默认文本/嗅探）。 */
    | "tool-result";
  languages?: string[];
  blockTypes?: string[];
  aggregate?: string;
  signals?: string[];
  /** tool-result 源：精确工具名。 */
  tool_name?: string;
  /** tool-result 源：工具名正则（tool_name 未声明时生效）。 */
  tool_pattern?: string;
}

/** messages 源的聚合器（注册表键 → 消息流压缩为 payload.data）。 */
export type Aggregator = (messages: Array<{ blocks: Array<{ type: string; text?: string; isError?: boolean }> }>) => unknown;

// ── 渲染组件（第三方绑定=唯一代码位） ──

export interface ComposedActionRef {
  key: string;
  label: string;
  run: () => void;
}

export interface RendererComponentProps<P = SourcePayload> {
  payload: P;
  /** 需求12 配置面直通（保存即热生效）。 */
  options: PluginConfigValues;
  /** 引擎装配的动作条（导出/打开等；组件负责呈现与转发）。 */
  actions: ComposedActionRef[];
}

export interface RendererRegistration {
  key: string;
  component: ComponentType<RendererComponentProps>;
  /** 组件能力声明（动作层据此路由；export-file 的格式转换经 toFile）。 */
  capabilities?: {
    exportFormats?: string[];
    toFile?: (payload: SourcePayload, format: string, options?: PluginConfigValues) => Promise<Blob | string>;
  };
  /** 组合向导的说明文案。 */
  description?: string;
}

// ── 动作 ──

export interface ActionDeclaration {
  /** v0.9.5 需求1（原需求26）5b：emit-signal——发射插件间自定义信号
   *  （params: signal 自定义名 / payload_key 从渲染 payload 顶层取值）。 */
  type: "export-file" | "open-external" | "desktop-notify" | "clipboard" | "insert-composer" | "jump" | "emit-signal";
  [key: string]: unknown;
}

export interface ActionContext {
  sessionId: string | null;
  pluginId: string;
}

export interface ActionHandler {
  type: string;
  /** params 中 "@config.<key>" 字符串值已由引擎解析为插件配置值。 */
  run(params: Record<string, unknown>, payload: SourcePayload, ctx: ActionContext): void;
}

// ── 组合清单（manifest，Rust 侧 toml→json 透传） ──

export interface ComposedConfigFieldDecl {
  key: string;
  type: "switch" | "number" | "select" | "text" | "textarea";
  label: string;
  default: unknown;
  /** 分组标签（引擎聚合为 section）。 */
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Array<{ value: string; label: string }>;
  description?: string;
}

/** agent 可调用工具声明（v0.9.5 需求1（原需求26）6a——方向四：任何插件
 *  都能声明 agent 按需触发的入口；通用 plugin-invoke pi 扩展动态注册为
 *  agent 工具（hub_invoke 桥，pi v0.87.1 起 registerTool 强制 object
 *  parameters schema——缺省由扩展兜底空 Object）。 */
export interface AgentToolDecl {
  /** 工具名（全局唯一——6c 冲突检查；与既有 agent 工具撞名拒绝）。 */
  name: string;
  /** agent 读它判断调用时机（与 [tool].description 同理）。 */
  description: string;
  /** 可选参数 schema（JSON Schema object 形态）。 */
  parameters?: Record<string, unknown>;
}

export interface SessionComposedManifest {
  /** C4：阶段流水线声明（pipeline 型插件——编排定义，可无渲染挂载）。
   *  v0.9.5 需求1（原需汅26）1a：pipeline 与渲染挂载可共存（engine 合并装配），
   *  source/render 改可选——纯流水线清单（如 video-maker）不再被迫填假渲染臂；
   *  「至少一臂」由 validateManifest 保证（无 pipeline 且无 source/render 拒绝）。 */
  pipeline?: import("./pipeline/contracts").PipelineDeclaration;
  plugin: { id: string; name: string; description?: string; icon?: string };
  kind: "session-composed";
  source?: SourceDeclaration;
  render?: { component: string; mount: string; fallback?: string };
  /** 需求14 M2（S3 外观能力点）：主题声明段——css 只覆盖公开令牌契约子集
   *  （--color-background/--color-layer-0~4/--message-*-bg 等，见 02 §4.1），
   *  base = 基座三档（light/colorful/dark，data-theme 属性保留供 variant 工具类），
   *  preview = 选择器色卡。装载走「后端读文件 → 前端内联 <style>」
   * （R3-b：免改 CSP，级联顺序确定在打包 CSS 之后）。 */
  theme?: { css: string; base?: string; preview?: string[] };
  action?: ActionDeclaration[];
  config?: ComposedConfigFieldDecl[];
  /** [[agent-tool]] 声明段（6a；可选——缺失即旧行为）。 */
  agent_tool?: AgentToolDecl[];
}

// ── 组合引擎对外产物（挂载生成所需） ──

export interface ComposedBuildInput {
  manifest: SessionComposedManifest;
  renderers: { get(key: string): RendererRegistration | undefined };
  actions: { get(type: string): ActionHandler | undefined };
}

/** source × mount 配对矩阵（测试期修复23 契约收口）：块渲染挂载只吃
 *  代码块/块类型源，数据面挂载（rail/dock/sidebar/composer）只吃数据面源，
 *  事件挂载只吃信号源——非法组合在清单载入期拒绝，而非渲染期静默错乱
 *  （此前 turns 源配 block-renderer 会命中一切代码块、block-type 源配
 *  rail 挂载会把整个消息数组当聚合载荷喂给渲染件，均无报错）。 */
const MOUNT_SOURCE_MATRIX: Record<string, string[]> = {
  "block-renderer": ["code-block", "block-type"],
  "rail-widget": ["messages", "turns", "stream-state"],
  "dock-panel": ["messages", "turns", "stream-state", "task"],
  "sidebar-panel": ["messages", "turns", "stream-state", "task"],
  "composer-trailing": ["messages", "turns", "stream-state"],
  "event-hook": ["signal"],
  // 8b：工具返回值挂载语义（渲染在 tool_use 卡 output 区——非独立块；
  // P1-4 更正：tool_result 块不作为独立块渲染，此挂载由 ToolCallCard 的
  // matchToolResultRenderer 咨询消费）。
  "tool-output": ["tool-result"],
  // 需求14 M2（02 §4.2）：全局外观挂载——无源（不消费会话数据面，主题由
  // 应用级装载器消费描述符 theme 字段，非会话挂载臂）。
  "app-theme": [],
  // 需求14 M5（06-P2/G12）：应用级浮层挂载——无源（全局悬浮钮/铺开面板，
  // 页面层外常驻；宿主 AppOverlayHost 挂 app.tsx 全局浮层区）。开放给
  // 第三方复刻「应用级监控面板」（DevLogCenter 形态）。
  "app-overlay": [],
};

/** manifest 校验：结构合法 + 组件键存在 + 源域字段显式且互斥 + 挂载配对
 * 合法（矩阵）；返回错误列表（空=通过）。内部格式原则：可匹配格式只有
 * 「核心块类型」与「显式声明的语言封闭集」两类，无通配——常规对话内容
 * 结构上不可被插件接管。
 * v0.9.3 需求25：component 支持 "@file:<rel>" 前缀（混合插件——代码文件
 * 提供组件）；opts.fileComponentReady 表示代码组件已装载可装配。 */
export function validateManifest(
  manifest: SessionComposedManifest,
  renderers: { get(key: string): RendererRegistration | undefined },
  opts?: { fileComponentReady?: boolean },
): string[] {
  const errors: string[] = [];
  if (!manifest.plugin?.id) errors.push("[plugin] id 缺失");
  // 1a（v0.9.5 需求1，原需求26）：至少一臂——无 pipeline 且无渲染声明（source/render
  // 均缺失）的空清单拒绝；纯 pipeline 清单（如 video-maker）不再强求渲染字段。
  // 声明了 source/render 任一字段即视为声明了渲染臂，按完整渲染校验（残缺报具体缺失）。
  const hasPipeline = Boolean(manifest.pipeline);
  const hasRenderArm = Boolean(manifest.source) || Boolean(manifest.render) || Boolean(manifest.theme);
  if (!hasPipeline && !hasRenderArm) {
    errors.push("清单需至少声明 pipeline 或 source/render 之一");
  }
  if (!hasRenderArm) return errors;
  // Rust 扫描注入的代码文件存在性错误（@file: 引用缺失）优先透出。
  const fileError = (manifest as SessionComposedManifest & { _file_error?: string })._file_error;
  if (fileError) errors.push(`[render] ${fileError}`);
  const component = manifest.render?.component;
  const mount = manifest.render?.mount;
  // 无源挂载集（app-theme 外观 / app-overlay 应用浮层——不消费会话数据面）。
  const isSourceless = mount === "app-theme" || mount === "app-overlay";
  // 需求14 M2：app-theme 挂载的渲染体即 theme.css（无组件键）——component
  // 必填校验对主题形态豁免；其余挂载维持必填。
  if (!component && !isSourceless) errors.push("[render] component 缺失");
  const isFileComponent = typeof component === "string" && component.startsWith("@file:");
  if (isFileComponent) {
    // 混合插件（需求25）：组件来自插件目录代码文件。
    // 需求14 M1（02 §3.1）：block-renderer 解禁——代码组件可接管代码块
    // 渲染，payload 与其他挂载统一（{kind:"code-block", language, code}，
    // 引擎 block-renderer 臂透传 fileComponent）。export-file 维持禁令
    //（依赖注册表渲染件 toFile，代码组件无此通道——02 §13-6 方案 b：
    // 随真需求再评审 API 加法）。
    if ((manifest.action ?? []).some((a) => a.type === "export-file")) {
      errors.push("[action] @file: 代码组件不支持 export-file 动作");
    }
    if (!opts?.fileComponentReady) {
      errors.push(`[render] 代码组件未就绪: ${component}`);
    }
  } else if (component && !renderers.get(component)) {
    errors.push(`渲染组件未注册: ${component}`);
  }
  // 需求14 M1（B1）：fallback 键校验——fallback 此前为死字段（三处写、
  // 零处读），本期起消费（组件崩溃时渲染兜底键，见 RendererShell）；
  // 声明了但未注册 → fail loud（typo 在装载期暴露而非崩溃期）。
  const fallback = manifest.render?.fallback;
  if (fallback) {
    if (fallback.startsWith("@file:")) {
      errors.push("[render] fallback 不支持 @file:（须为内置渲染键，如 render.mono-text）");
    } else if (!renderers.get(fallback)) {
      errors.push(`回退渲染组件未注册: ${fallback}`);
    }
  }
  // 需求14 M2（B6）：app-theme 挂载免 source 强校验（主题不消费会话数据面，
  // 矩阵行声明无源）——其余挂载维持「声明渲染臂必须带源」的既有强校验。
  if (!isSourceless && !manifest.source?.type) errors.push("[source] type 缺失");
  // 需求14 M2：[theme] 段校验——css 必须 @file:（存在性经 Rust _file_error）、
  // base 三档枚举、主题段必须配 app-theme 挂载（且反向：app-theme 必须带主题段）。
  const theme = manifest.theme;
  if (theme) {
    if (mount !== "app-theme") {
      errors.push("[theme] 主题声明须配 [render] mount = \"app-theme\"");
    }
    if (!theme.css.startsWith("@file:")) {
      errors.push("[theme] css 必须为 @file: 引用（如 \"@file:theme.css\"）");
    }
    if (theme.base !== undefined && !["light", "colorful", "dark"].includes(theme.base)) {
      errors.push(`[theme] base 非法: ${String(theme.base)}（合法：light/colorful/dark）`);
    }
  }
  if (mount === "app-theme" && !theme) {
    errors.push("[render] app-theme 挂载须声明 [theme] 段");
  }
  if (manifest.source?.type === "code-block" && !(manifest.source.languages?.length)) {
    errors.push("[source] code-block 需声明 languages");
  }
  // 源域字段互斥：code-block 只认语言集、block-type 只认块类型集——
  // 双声明（跨域混合）与空声明（无显式格式）都拒绝。
  if (manifest.source?.type === "block-type") {
    if (!(manifest.source.blockTypes?.length)) errors.push("[source] block-type 需声明 blockTypes");
    if (manifest.source.languages?.length) errors.push("[source] block-type 不得声明 languages（跨匹配域混合）");
  }
  if (manifest.source?.type === "code-block" && manifest.source.blockTypes?.length) {
    errors.push("[source] code-block 不得声明 blockTypes（跨匹配域混合）");
  }
  // 挂载配对矩阵。
  if (!mount || !MOUNT_SOURCE_MATRIX[mount]) {
    errors.push(`[render] mount 非法: ${String(mount)}`);
  } else if (manifest.source?.type && !MOUNT_SOURCE_MATRIX[mount].includes(manifest.source.type)) {
    errors.push(`[render] mount ${mount} 不接受源类型 ${manifest.source.type}（合法：${MOUNT_SOURCE_MATRIX[mount].join("/")}）`);
  }
  return errors;
}
