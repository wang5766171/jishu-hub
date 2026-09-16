/**
 * 阶段分隔渲染插件（v0.9.3 需求10 / B1，规划目标2「PhaseDivider →
 * block-renderer」条件已具备项）：经 blockTypes: ["phase_divider"] 接管
 * 阶段分隔块渲染——message-view / streaming-message 的 phase_divider 分支
 * 行级咨询（matchBlockTypeRenderer），未启用/未命中回退内置 PhaseDivider
 * （interaction 同款机制，v0.9.3 需求2 基建）。视觉复用既有 PhaseDivider
 * 组件（components 层可被插件引用，非内核/页面模块）。
 */
import { PhaseDivider } from "@/components/sessions/conversation-content";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor, PluginBlock } from "../types";

function PhaseDividerBlockRenderer({ block }: { block: PluginBlock }) {
  return <PhaseDivider phase={block.text ?? ""} title={block.title ?? ""} />;
}

export const phaseDividerPlugin: SessionPluginDescriptor = {
  id: "session.phase-divider",
  displayNameKey: "sessionPlugins.phaseDivider.name",
  displayNameFallback: "阶段分隔渲染",
  descriptionKey: "sessionPlugins.phaseDivider.description",
  descriptionFallback: "任务阶段分隔条（规划/执行等阶段的视觉分界）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:blocks"],
  mounts: [
    {
      kind: "block-renderer",
      languages: [],
      detect: () => false,
      Component: () => null,
      blockTypes: ["phase_divider"],
      BlockComponent: PhaseDividerBlockRenderer,
    },
  ],
};
