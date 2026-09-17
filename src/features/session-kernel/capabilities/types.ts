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
  | { kind: "turns"; turns: Array<{ question: string; answer: string }>; activeIndex: number; jump?: (index: number) => void }
  | { kind: "signal"; signal: unknown };

export interface SourceDeclaration {
  type: "code-block" | "block-type" | "messages" | "turns" | "stream-state" | "signal";
  languages?: string[];
  blockTypes?: string[];
  aggregate?: string;
  signals?: string[];
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
    toFile?: (payload: SourcePayload, format: string, options: PluginConfigValues) => Promise<Blob | string>;
  };
  /** 组合向导的说明文案。 */
  description?: string;
}

// ── 动作 ──

export interface ActionDeclaration {
  type: "export-file" | "open-external" | "desktop-notify" | "clipboard" | "insert-composer" | "jump";
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

export interface SessionComposedManifest {
  /** C4：阶段流水线声明（pipeline 型插件——编排定义，无渲染挂载）。 */
  pipeline?: import("./pipeline/contracts").PipelineDeclaration;
  plugin: { id: string; name: string; description?: string };
  kind: "session-composed";
  source: SourceDeclaration;
  render: { component: string; mount: string; fallback?: string };
  action?: ActionDeclaration[];
  config?: ComposedConfigFieldDecl[];
}

// ── 组合引擎对外产物（挂载生成所需） ──

export interface ComposedBuildInput {
  manifest: SessionComposedManifest;
  renderers: { get(key: string): RendererRegistration | undefined };
  actions: { get(type: string): ActionHandler | undefined };
}

/** manifest 校验：结构合法 + 组件键存在；返回错误列表（空=通过）。 */
export function validateManifest(
  manifest: SessionComposedManifest,
  renderers: { get(key: string): RendererRegistration | undefined },
): string[] {
  const errors: string[] = [];
  if (!manifest.plugin?.id) errors.push("[plugin] id 缺失");
  if (!manifest.render?.component) errors.push("[render] component 缺失");
  if (manifest.render?.component && !renderers.get(manifest.render.component)) {
    errors.push(`渲染组件未注册: ${manifest.render.component}`);
  }
  if (!manifest.source?.type) errors.push("[source] type 缺失");
  if (manifest.source?.type === "code-block" && !(manifest.source.languages?.length)) {
    errors.push("[source] code-block 需声明 languages");
  }
  return errors;
}
