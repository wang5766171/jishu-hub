/**
 * 组合引擎（需求13 C1）：manifest → SessionPluginDescriptor 装配。
 * 挂载生成按 render.mount 分派（block-renderer / rail-widget / dock-panel /
 * sidebar-panel / composer-trailing / event-hook）；config 字段（含 group 聚合
 * 为 section）直转需求12 configSchema；动作条经注册表装配（@config 引用先
 * 解析）。capabilities 分层唯一同时知道「能力注册表」与「插件描述符」的模块。
 */
import { useMemo } from "react";
import type { ComponentType } from "react";
import { usePluginConfig, type PluginConfigField, type PluginConfigValues } from "../../plugins/config-plane";
import type { SessionPluginDescriptor, SessionKernelContext, PluginBlock } from "../../plugins/types";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../../plugins/types";
import { rendererRegistry } from "../renderers/registry";
import { actionRegistry, resolveActionParams } from "../actions";
import { getAggregator } from "../sources/aggregate-source";
import { HybridErrorBoundary } from "./hybrid-runtime";
import type { ComposedConfigFieldDecl, RendererComponentProps, SessionComposedManifest, SourcePayload } from "../types";
import { validateManifest } from "../types";
import { validatePipeline } from "../pipeline/contracts";

/** manifest config 声明 → configSchema（group 相邻聚合为 section）。 */
export function configDeclsToSchema(decls: ComposedConfigFieldDecl[] | undefined): PluginConfigField[] {
  if (!decls?.length) return [];
  const fields = decls.map((d) => ({ ...d, group: undefined })) as PluginConfigField[];
  const sections: PluginConfigField[] = [];
  const loose: PluginConfigField[] = [];
  const groupOrder: string[] = [];
  for (let i = 0; i < decls.length; i += 1) {
    const group = decls[i].group;
    const field = fields[i];
    if (!group) {
      loose.push(field);
      continue;
    }
    let section = sections.find((s) => s.type === "section" && s.label === group);
    if (!section) {
      section = { type: "section", key: `grp-${group}`, label: group, fields: [] } as PluginConfigField & { fields: PluginConfigField[] };
      sections.push(section);
      groupOrder.push(group);
    }
    (section as { fields: PluginConfigField[] }).fields.push(field);
  }
  return [...loose, ...sections];
}

/** 动作条装配：声明 + 当前配置 → 可点动作引用。 */
function buildActions(
  manifest: SessionComposedManifest,
  options: PluginConfigValues,
  sessionId: string | null,
  payload: SourcePayload,
): Array<{ key: string; label: string; run: () => void }> {
  return (manifest.action ?? []).map((action, i) => {
    const handler = actionRegistry.get(action.type);
    const label = String((action.label as string) ?? action.type);
    return {
      key: `${action.type}-${i}`,
      label,
      run: () => {
        if (!handler) return;
        const params = resolveActionParams(action, options);
        // export-file 的转换器由引擎注入（组件能力，动作层不感知注册表键）。
        if (action.type === "export-file") {
          const renderer = rendererRegistry.get(manifest.render?.component ?? "");
          params.__toFile = renderer?.capabilities?.toFile;
          // 组件转换管线的配置直通（pngScale 等读取整个 options——修复21
          // 返工：此前仅传 payload/format，PNG 倍率读 undefined 崩）。
          params.__options = options;
        }
        if (action.type === "desktop-notify") {
          params.__options = options;
        }
        void handler.run(params, payload, { sessionId, pluginId: manifest.plugin.id });
      },
    };
  });
}

/** 渲染包装：注入 options（配置面）与 actions（动作条）。
 *  v0.9.3 需求25：@file: 混合插件经 fileComponent 直供组件（绕过注册表），
 *  渲染包裹 HybridErrorBoundary（崩溃回调宿主自动停用）。 */
function RendererShell({
  manifest,
  schema,
  payload,
  sessionId,
  fileComponent,
}: {
  manifest: SessionComposedManifest;
  schema: PluginConfigField[];
  payload: SourcePayload;
  sessionId: string | null;
  fileComponent?: ComponentType<RendererComponentProps>;
}) {
  const { values } = usePluginConfig(manifest.plugin.id, schema);
  if (fileComponent) {
    const HybridComp = fileComponent;
    return (
      <HybridErrorBoundary pluginId={manifest.plugin.id}>
        <HybridComp payload={payload} options={values} actions={buildActions(manifest, values, sessionId, payload)} />
      </HybridErrorBoundary>
    );
  }
  const reg = rendererRegistry.get(manifest.render!.component);
  if (!reg) {
    return <div className="p-2 text-xs text-muted-foreground">渲染组件未注册：{manifest.render!.component}</div>;
  }
  const Comp = reg.component as ComponentType<RendererComponentProps>;
  return <Comp payload={payload} options={values} actions={buildActions(manifest, values, sessionId, payload)} />;
}

/** 数据面源包装：rail/dock 等挂件组件经 ctx 计算 payload。 */
function SourceShell({
  manifest,
  schema,
  ctx,
  fileComponent,
}: {
  manifest: SessionComposedManifest;
  schema: PluginConfigField[];
  ctx: SessionKernelContext;
  fileComponent?: ComponentType<RendererComponentProps>;
}) {
  const payload = useMemo<SourcePayload>(() => {
    switch (manifest.source!.type) {
      case "turns":
        return { kind: "turns", turns: ctx.turns, activeIndex: ctx.activeTurnIndex, jump: (i: number) => ctx.scrollToTurn(i) };
      case "task":
        return { kind: "task", task: ctx.task };
      case "messages":
      case "stream-state":
      default: {
        // 聚合器应用（tool-stats 等）；未声明聚合器时透传消息流。
        const aggregator = getAggregator(manifest.source!.aggregate);
        return { kind: "aggregate", data: aggregator ? aggregator(ctx.messages) : ctx.messages };
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.messages, ctx.turns, ctx.activeTurnIndex, manifest.source!.type]);
  return <RendererShell manifest={manifest} schema={schema} payload={payload} sessionId={ctx.sessionId} fileComponent={fileComponent} />;
}

/** manifest → 描述符（校验失败抛错，loader 负责隔离）。
 *  v0.9.3 需求25：render.component 为 "@file:<rel>" 时经 hybrid.component
 *  直供组件（混合插件）；数据面挂载的 SourceShell→RendererShell 全链透传。
 *  v0.9.5 需求1（原需敆26）1a：去 pipeline 早退——两臂合并装配，同一清单
 *  同时声明 pipeline 与 source/render 时流水线阶段与渲染挂载**同时生效**
 *  （原早退会静默丢弃渲染声明）；纯 pipeline 清单（video-maker） mounts 留空。 */
export function buildComposedDescriptor(
  manifest: SessionComposedManifest,
  hybrid?: { component: ComponentType<RendererComponentProps> },
): SessionPluginDescriptor {
  const id = manifest.plugin.id;
  // C4：pipeline 臂——编排定义类声明，校验走流水线契约，描述符透出
  //（详情模态/任务启动消费）；无 pipeline 时跳过。
  if (manifest.pipeline) {
    const pipelineErrors = validatePipeline(manifest.pipeline);
    if (pipelineErrors.length) throw new Error(`组合清单校验失败: ${pipelineErrors.join("; ")}`);
  }
  // 渲染臂：无 source/render 声明的纯流水线清单跳过（validateManifest 的
  // 「至少一臂」总校验保证空清单在此前已被拒）。
  const hasRenderArm = Boolean(manifest.source) || Boolean(manifest.render);
  // 无条件校验：validateManifest 内部按「是否声明渲染臂」门控字段校验——
  // 纯 pipeline 清单返回空（video-maker 形态）；空清单报「至少一臂」。
  {
    const errors = validateManifest(manifest, rendererRegistry, {
      fileComponentReady: Boolean(hybrid),
    });
    if (errors.length) throw new Error(`组合清单校验失败: ${errors.join("; ")}`);
  }
  const schema = configDeclsToSchema(manifest.config);
  const mounts: SessionPluginDescriptor["mounts"] = [];

  if (hasRenderArm) {
    // 校验已保证两字段存在（缺失在校验期抛），收窄供装配链使用。
    const source = manifest.source as NonNullable<SessionComposedManifest["source"]>;
    const render = manifest.render as NonNullable<SessionComposedManifest["render"]>;

    if (render.mount === "block-renderer") {
    // 匹配域按源类型定臂（测试期修复23 结构收口）：code-block 源 → 代码块域
    // （语言过滤在 languages 表达，detect 恒真=声明语言内全收）；block-type
    // 源 → 块类型域（无语言/detect 字段，类型层不可误入语言咨询路径）。
    mounts.push(
      source.blockTypes?.length
        ? {
            kind: "block-renderer",
            matching: "block-type",
            blockTypes: source.blockTypes,
            BlockComponent: ({ block }: { block: PluginBlock }) => (
              <RendererShell manifest={manifest} schema={schema} payload={{ kind: "block", blockType: block.type, block }} sessionId={null} />
            ),
          }
        : {
            kind: "block-renderer",
            matching: "code",
            languages: source.languages ?? [],
            detect: () => true,
            Component: ({ code, language }: { code: string; language: string }) => (
              <RendererShell manifest={manifest} schema={schema} payload={{ kind: "code-block", language, code }} sessionId={null} />
            ),
          },
    );
  } else if (render.mount === "event-hook") {
    mounts.push({
      kind: "event-hook",
      onSignal(signal, ctx) {
        const signalType = (signal as { type?: string }).type ?? "";
        if (source.signals && !source.signals.includes(signalType)) return;
        const options = getPluginConfigSync(id, schema);
        // 触发口径门控（desktop-notify 类：三类触发各一开关）。
        // v0.9.5 需求1（原需求26）5b：gateKey 数据驱动——内置三类信号维持
        // 硬编码映射；自定义信号（plugin: 前缀）由信号名推导 notify_<name>，
        // 配置无该键则不门控（设计裁决：无配置即放行）。
        const gateKey =
          signalType === "turn-complete" ? "notifyTurnComplete"
          : signalType === "approval-request" ? "notifyApproval"
          : signalType === "task-run-failed" ? "notifyTaskFailed"
          : signalType.startsWith("plugin:") ? `notify_${signalType.split(":").pop() ?? ""}` : null;
        if (gateKey && options[gateKey] === false) return;
        for (const action of manifest.action ?? []) {
          const handler = actionRegistry.get(action.type);
          if (!handler) continue;
          const params = resolveActionParams(action, options);
          if (action.type === "emit-signal") {
            // 5b：链式信号——onSignal 消费的自定义信号再发射，来源深度传入
            //（handler 内 +1 且 >3 阻断，防 A→B→C→A 循环）。
            params.__fromDepth = (signal as { depth?: number }).depth ?? 1;
            void handler.run(params, { kind: "signal", signal }, { sessionId: ctx.sessionId, pluginId: id });
            continue;
          }
          if (action.type === "desktop-notify") {
            const sig = signal as { error?: boolean; title?: string; sessionId?: string };
            const sid = (sig.sessionId ?? ctx.sessionId ?? "").slice(0, 12);
            const title =
              signalType === "turn-complete" ? (sig.error ? "回合失败" : "回合完成")
              : signalType === "approval-request" ? "等待审批"
              : sig.title ? `任务失败：${sig.title}` : "任务失败";
            const body = sid ? `会话 ${sid}…` : "";
            params.title = title;
            params.body = body;
            params.__options = options;
            void handler.run(params, { kind: "signal", signal }, { sessionId: ctx.sessionId, pluginId: id });
          }
        }
      },
    } as SessionPluginDescriptor["mounts"][number]);
  } else if (render.mount === "tool-output") {
    // 8b：工具返回值挂载——组件经注册表/@file: 解析，挂载声明交
    // matchToolResultRenderer 咨询消费（ToolCallCard output 区替换渲染）。
    const fileComp = (manifest.render?.component ?? "").startsWith("@file:") ? hybrid?.component : undefined;
    const reg = fileComp ? undefined : rendererRegistry.get(render.component);
    const Comp = (fileComp ?? reg?.component) as ComponentType<RendererComponentProps> | undefined;
    if (Comp) {
      mounts.push({
        kind: "tool-result-renderer",
        toolName: source.tool_name,
        toolPattern: source.tool_pattern,
        // SAFETY: 渲染器组件签名 ComponentType<RendererComponentProps> 与
        // ToolResultRendererMount 的 Record<string, unknown> props 袋运行时
        // 兼容——两者均为纯 props 透传（payload/ctx 形状由注册表装载期校验
        // 背书），无构造器/泛型逆变等 TS 可检查的等价关系。
        component: Comp as unknown as ComponentType<Record<string, unknown>>,
      } as SessionPluginDescriptor["mounts"][number]);
    }
  } else {
    // rail-widget / dock-panel / sidebar-panel / composer-trailing：数据面挂件。
    const mountBase = {
      Component: (props: { ctx: SessionKernelContext }) => (
        <SourceShell manifest={manifest} schema={schema} ctx={props.ctx} fileComponent={hybrid?.component} />
      ),
    };
    if (render.mount === "dock-panel") {
      // C5-slice1：dock 槽位可声明（slot = "left" | "right" | "float"，缺省
      // float）——任务看板等重面板默认停靠右侧（随迁 session.flow 形态）。
      const declaredSlot = (render as { slot?: string }).slot;
      const defaultSlot =
        declaredSlot === "left" || declaredSlot === "right" ? declaredSlot : "float";
      mounts.push({
        kind: "dock-panel",
        titleKey: "",
        titleFallback: manifest.plugin.name,
        defaultSlot,
        ...mountBase,
      } as SessionPluginDescriptor["mounts"][number]);
    } else if (render.mount === "sidebar-panel") {
      mounts.push({ kind: "sidebar-panel", ...mountBase } as SessionPluginDescriptor["mounts"][number]);
    } else if (render.mount === "composer-trailing") {
      mounts.push({ kind: "composer-trailing", ...mountBase } as SessionPluginDescriptor["mounts"][number]);
    } else {
      const side = (render as { side?: "left" | "right" }).side === "left" ? "left" : "right";
      mounts.push({ kind: "rail-widget", defaultSide: side, ...mountBase } as SessionPluginDescriptor["mounts"][number]);
    }
  }
  }  // 闭 if (hasRenderArm)——两臂合并装配

  // v0.9.5 需求1 GUI 改造 批次2：实现维度标记（双维度 X 轴，plugins-page
  // 双徽标/筛选消费）——combo（流水线与数据面臂并存）> code（@file: 代码
  // 组件）> config（纯清单声明）。
  const hasCodeFile = (manifest.render?.component ?? "").startsWith("@file:");
  const implKind: SessionPluginDescriptor["implKind"] =
    manifest.pipeline && hasRenderArm ? "combo" : hasCodeFile ? "code" : "config";

  return {
    id,
    displayNameKey: "",
    displayNameFallback: manifest.plugin.name,
    descriptionKey: "",
    descriptionFallback: manifest.plugin.description ?? "",
    contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
    source: "config",
    implKind,
    permissions: ["read:blocks"],
    configSchema: schema.length ? schema : undefined,
    pipeline: manifest.pipeline,
    mounts,
  };
}

// 同步配置快照（event-hook 非 React 语境）——顶部 import 规避循环依赖。
import { getPluginConfig as getPluginConfigSync } from "../../plugins/config-plane";
