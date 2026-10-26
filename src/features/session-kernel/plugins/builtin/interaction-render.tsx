import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, PluginBlock } from "../types";
import { InteractionCard } from "@/components/sessions/interaction-card";

/**
 * 交互问答卡渲染插件（v0.9.2 底座增强后首批拆出；v0.9.3 需求2 完成接线）：
 * 经 blockTypes: ["interaction"] 声明接管 interaction 块渲染——message-view
 * 三个渲染点（renderBlock / 助手气泡分组项 / 用户侧气泡分组项）统一经
 * InteractionBlockWithRenderers 行级咨询，未启用/未命中时回退内置
 * InteractionCard，插件页开关真实生效。detect/Component（代码块路径）不接管。
 */

function InteractionBlockRenderer({ block }: { block: PluginBlock }) {
  // v0.9.4 需求11（用户裁决：样式统一为内置 InteractionCard——插件自定义
  // 样式用户不满意，且插件亦为本仓库开发可直接改）：插件命中后**委托内置卡
  // 渲染**（默认展开保留选项、已选高亮）——接管机制/开关完整保留，视觉与
  // 流式/未启用插件的回放完全一致。
  return (
    <InteractionCard
      items={[{
        prompt: block.text ?? "",
        options: (block.options ?? []).map((o) => ({ option_id: o.id, label: o.label })),
        answer: block.answer ?? "",
      }]}
      origin={block.origin}
      renderSource={block.renderSource}
      defaultOpen
    />
  );
}

export const interactionRenderPlugin: SessionPluginDescriptor = {
  id: "session.interaction-render",
  displayNameKey: "sessionPlugins.interaction.name",
  displayNameFallback: "交互问答卡",
  descriptionKey: "sessionPlugins.interaction.description",
  descriptionFallback: "交互问答块渲染（样式统一内置卡，含选项与已选高亮）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:messages"],
  mounts: [
    {
      kind: "block-renderer",
      matching: "block-type",
      blockTypes: ["interaction"],
      BlockComponent: InteractionBlockRenderer,
    },
  ],
};
