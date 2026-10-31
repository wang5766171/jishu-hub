/**
 * render.interaction：交互问答卡渲染（需求14 M5 批1——自 TS 内置件组合化）。
 * 委托内置 InteractionCard（v0.9.4 需求11 用户裁决：插件命中后与回放视觉
 * 完全一致；接管机制/开关保留在组合清单 session.interaction-render.toml）。
 */
import { rendererRegistry } from "../registry";
import type { RendererComponentProps, SourcePayload } from "../../types";
import type { PluginBlock } from "../../../plugins/types";
import { InteractionCard } from "@/components/sessions/interaction-card";

/** 供单测直用（原 builtin 描述符 BlockComponent 的同体）。 */
export function InteractionBlockRenderer({ block }: { block: PluginBlock }) {
  return (
    <InteractionCard
      items={[{
        prompt: block.text ?? "",
        options: (block.options ?? []).map((o) => ({
          option_id: o.id,
          label: o.label,
          description: o.description ?? null,
        })),
        answer: block.answer ?? "",
        // v0.9.5 需求5 T6：selectedOptions 透传——多选回放以选项高亮表达。
        selectedOptions: block.selectedOptions,
      }]}
      origin={block.origin}
      renderSource={block.renderSource}
      defaultOpen
    />
  );
}

function InteractionPayloadRenderer({ payload }: RendererComponentProps<SourcePayload>) {
  if (payload.kind !== "block") return null;
  return <InteractionBlockRenderer block={payload.block as PluginBlock} />;
}

rendererRegistry.register({
  key: "render.interaction",
  component: InteractionPayloadRenderer,
  description: "交互问答卡（官方，随包，委托内置卡）",
});
