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
import type { ComposedConfigFieldDecl, RendererComponentProps, SessionComposedManifest, SourcePayload } from "../types";
import { validateManifest } from "../types";

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
        }
        if (action.type === "desktop-notify") {
          params.__options = options;
        }
        const payload: SourcePayload = { kind: "signal", signal: { type: "action", sessionId } };
        void handler.run(params, payload, { sessionId, pluginId: manifest.plugin.id });
      },
    };
  });
}

/** 渲染包装：注入 options（配置面）与 actions（动作条）。 */
function RendererShell({
  manifest,
  schema,
  payload,
  sessionId,
}: {
  manifest: SessionComposedManifest;
  schema: PluginConfigField[];
  payload: SourcePayload;
  sessionId: string | null;
}) {
  const { values } = usePluginConfig(manifest.plugin.id, schema);
  const reg = rendererRegistry.get(manifest.render.component);
  if (!reg) {
    return <div className="p-2 text-xs text-muted-foreground">渲染组件未注册：{manifest.render.component}</div>;
  }
  const Comp = reg.component as ComponentType<RendererComponentProps>;
  return <Comp payload={payload} options={values} actions={buildActions(manifest, values, sessionId)} />;
}

/** 数据面源包装：rail/dock 等挂件组件经 ctx 计算 payload。 */
function SourceShell({ manifest, schema, ctx }: { manifest: SessionComposedManifest; schema: PluginConfigField[]; ctx: SessionKernelContext }) {
  const payload = useMemo<SourcePayload>(() => {
    switch (manifest.source.type) {
      case "turns":
        return { kind: "turns", turns: ctx.turns, activeIndex: ctx.activeTurnIndex, jump: (i: number) => ctx.scrollToTurn(i) };
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
  return <RendererShell manifest={manifest} schema={schema} payload={payload} sessionId={ctx.sessionId} />;
}

/** manifest → 描述符（校验失败抛错，loader 负责隔离）。 */
export function buildComposedDescriptor(manifest: SessionComposedManifest): SessionPluginDescriptor {
  const errors = validateManifest(manifest, rendererRegistry);
  if (errors.length) throw new Error(`组合清单校验失败: ${errors.join("; ")}`);
  const schema = configDeclsToSchema(manifest.config);
  const id = manifest.plugin.id;
  const mounts: SessionPluginDescriptor["mounts"] = [];

  if (manifest.render.mount === "block-renderer") {
    mounts.push({
      kind: "block-renderer",
      languages: manifest.source.languages ?? [],
      detect: () => true,
      blockTypes: manifest.source.blockTypes,
      Component: ({ code, language }: { code: string; language: string }) => (
        <RendererShell manifest={manifest} schema={schema} payload={{ kind: "code-block", language, code }} sessionId={null} />
      ),
      BlockComponent: manifest.source.blockTypes
        ? ({ block }: { block: PluginBlock }) => (
            <RendererShell manifest={manifest} schema={schema} payload={{ kind: "block", blockType: block.type, block }} sessionId={null} />
          )
        : undefined,
    } as SessionPluginDescriptor["mounts"][number]);
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
    const mountBase = { Component: (props: { ctx: SessionKernelContext }) => <SourceShell manifest={manifest} schema={schema} ctx={props.ctx} /> };
    if (manifest.render.mount === "dock-panel") {
      mounts.push({
        kind: "dock-panel",
        titleKey: "",
        titleFallback: manifest.plugin.name,
        defaultSlot: "float",
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
