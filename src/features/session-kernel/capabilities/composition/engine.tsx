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
          const renderer = rendererRegistry.get(manifest.render.component);
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
  const reg = rendererRegistry.get(manifest.render.component);
  if (!reg) {
    return <div className="p-2 text-xs text-muted-foreground">渲染组件未注册：{manifest.render.component}</div>;
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
    switch (manifest.source.type) {
      case "turns":
        return { kind: "turns", turns: ctx.turns, activeIndex: ctx.activeTurnIndex, jump: (i: number) => ctx.scrollToTurn(i) };
      case "task":
        return { kind: "task", task: ctx.task };
      case "messages":
      case "stream-state":
      default: {
        // 聚合器应用（tool-stats 等）；未声明聚合器时透传消息流。
        const aggregator = getAggregator(manifest.source.aggregate);
        return { kind: "aggregate", data: aggregator ? aggregator(ctx.messages) : ctx.messages };
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.messages, ctx.turns, ctx.activeTurnIndex, manifest.source.type]);
  return <RendererShell manifest={manifest} schema={schema} payload={payload} sessionId={ctx.sessionId} fileComponent={fileComponent} />;
}

/** manifest → 描述符（校验失败抛错，loader 负责隔离）。
 *  v0.9.3 需求25：render.component 为 "@file:<rel>" 时经 hybrid.component
 *  直供组件（混合插件）；数据面挂载的 SourceShell→RendererShell 全链透传。 */
export function buildComposedDescriptor(
  manifest: SessionComposedManifest,
  hybrid?: { component: ComponentType<RendererComponentProps> },
): SessionPluginDescriptor {
  const id = manifest.plugin.id;
  // v0.9.3 需求13 C4：pipeline 型清单——编排定义类插件，无渲染挂载；
  // 校验走流水线契约，描述符透出声明（详情模态/任务启动消费）。
  if (manifest.pipeline) {
    const pipelineErrors = validatePipeline(manifest.pipeline);
    if (pipelineErrors.length) throw new Error(`组合清单校验失败: ${pipelineErrors.join("; ")}`);
    return {
      id,
      displayNameKey: "",
      displayNameFallback: manifest.plugin.name,
      descriptionKey: "",
      descriptionFallback: manifest.plugin.description ?? "",
      contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
      source: "config",
      permissions: ["read:blocks"],
      configSchema: manifest.config?.length ? configDeclsToSchema(manifest.config) : undefined,
      pipeline: manifest.pipeline,
      mounts: [],
    };
  }
  const errors = validateManifest(manifest, rendererRegistry, {
    fileComponentReady: Boolean(hybrid),
  });
  if (errors.length) throw new Error(`组合清单校验失败: ${errors.join("; ")}`);
  const schema = configDeclsToSchema(manifest.config);
  const mounts: SessionPluginDescriptor["mounts"] = [];

  if (manifest.render.mount === "block-renderer") {
    // 匹配域按源类型定臂（测试期修复23 结构收口）：code-block 源 → 代码块域
    // （语言过滤在 languages 表达，detect 恒真=声明语言内全收）；block-type
    // 源 → 块类型域（无语言/detect 字段，类型层不可误入语言咨询路径）。
    mounts.push(
      manifest.source.blockTypes?.length
        ? {
            kind: "block-renderer",
            matching: "block-type",
            blockTypes: manifest.source.blockTypes,
            BlockComponent: ({ block }: { block: PluginBlock }) => (
              <RendererShell manifest={manifest} schema={schema} payload={{ kind: "block", blockType: block.type, block }} sessionId={null} />
            ),
          }
        : {
            kind: "block-renderer",
            matching: "code",
            languages: manifest.source.languages ?? [],
            detect: () => true,
            Component: ({ code, language }: { code: string; language: string }) => (
              <RendererShell manifest={manifest} schema={schema} payload={{ kind: "code-block", language, code }} sessionId={null} />
            ),
          },
    );
  } else if (manifest.render.mount === "event-hook") {
    mounts.push({
      kind: "event-hook",
      onSignal(signal, ctx) {
        const signalType = (signal as { type?: string }).type ?? "";
        if (manifest.source.signals && !manifest.source.signals.includes(signalType)) return;
        const options = getPluginConfigSync(id, schema);
        // 触发口径门控（desktop-notify 类：三类触发各一开关）。
        const gateKey =
          signalType === "turn-complete" ? "notifyTurnComplete"
          : signalType === "approval-request" ? "notifyApproval"
          : signalType === "task-run-failed" ? "notifyTaskFailed" : null;
        if (gateKey && options[gateKey] === false) return;
        for (const action of manifest.action ?? []) {
          const handler = actionRegistry.get(action.type);
          if (!handler) continue;
          const params = resolveActionParams(action, options);
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
  } else {
    // rail-widget / dock-panel / sidebar-panel / composer-trailing：数据面挂件。
    const mountBase = {
      Component: (props: { ctx: SessionKernelContext }) => (
        <SourceShell manifest={manifest} schema={schema} ctx={props.ctx} fileComponent={hybrid?.component} />
      ),
    };
    if (manifest.render.mount === "dock-panel") {
      // C5-slice1：dock 槽位可声明（slot = "left" | "right" | "float"，缺省
      // float）——任务看板等重面板默认停靠右侧（随迁 session.flow 形态）。
      const declaredSlot = (manifest.render as { slot?: string }).slot;
      const defaultSlot =
        declaredSlot === "left" || declaredSlot === "right" ? declaredSlot : "float";
      mounts.push({
        kind: "dock-panel",
        titleKey: "",
        titleFallback: manifest.plugin.name,
        defaultSlot,
        ...mountBase,
      } as SessionPluginDescriptor["mounts"][number]);
    } else if (manifest.render.mount === "sidebar-panel") {
      mounts.push({ kind: "sidebar-panel", ...mountBase } as SessionPluginDescriptor["mounts"][number]);
    } else if (manifest.render.mount === "composer-trailing") {
      mounts.push({ kind: "composer-trailing", ...mountBase } as SessionPluginDescriptor["mounts"][number]);
    } else {
      const side = (manifest.render as { side?: "left" | "right" }).side === "left" ? "left" : "right";
      mounts.push({ kind: "rail-widget", defaultSide: side, ...mountBase } as SessionPluginDescriptor["mounts"][number]);
    }
  }

  return {
    id,
    displayNameKey: "",
    displayNameFallback: manifest.plugin.name,
    descriptionKey: "",
    descriptionFallback: manifest.plugin.description ?? "",
    contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
    source: "config",
    permissions: ["read:blocks"],
    configSchema: schema.length ? schema : undefined,
    mounts,
  };
}

// 同步配置快照（event-hook 非 React 语境）——顶部 import 规避循环依赖。
import { getPluginConfig as getPluginConfigSync } from "../../plugins/config-plane";
