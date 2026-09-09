import { TurnRail } from "@/components/sessions/turn-rail";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor } from "../types";

/**
 * 会话导航列插件（v0.9.2 需求1 P4：由 chat-page 硬编码装配迁移为插件）。
 * 行为与 v0.9.1 完全一致——同一 TurnRail 组件，同一数据源（统一视图模型）。
 */
export const navigationPlugin: SessionPluginDescriptor = {
  id: "session.navigation",
  displayNameKey: "sessionPlugins.navigation.name",
  displayNameFallback: "会话导航列",
  descriptionKey: "sessionPlugins.navigation.description",
  descriptionFallback: "会话左缘快速跳转到每轮提问位置",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:turns"],
  mounts: [
    {
      kind: "rail-widget",
      Component: function NavigationRailWidget({ ctx }) {
        return (
          <TurnRail
            turns={ctx.turns}
            activeIndex={ctx.activeTurnIndex}
            onJump={ctx.scrollToTurn}
          />
        );
      },
    },
  ],
};
