import { ContextRing } from "@/components/sessions/context-ring";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor } from "../types";

/**
 * 上下文水位环插件（v0.9.3 需求8：自 chat-page 内置渲染迁移为插件）——
 * composer 尾部控制行的水位指示（点击弹详情/压缩控制），复用既有
 * ContextRing 组件（同导航列复用 TurnRail 的先例：共享组件层不属内核/
 * 页面禁区）。数据面：组件内部经 session-usage store 取用量，阈值经
 * load_config 读取；压缩命令/偏好经 ctx（compactSession/isCompacting/
 * autoCompaction/setAutoCompaction）。
 *
 * 插件页停用 = 水位环消失（chat-page 不再内置渲染）；启用恢复原视觉。
 */
export const contextRingPlugin: SessionPluginDescriptor = {
  id: "session.context-ring",
  displayNameKey: "sessionPlugins.contextRing.name",
  displayNameFallback: "上下文水位环",
  descriptionKey: "sessionPlugins.contextRing.description",
  descriptionFallback: "模型选择器旁的上下文水位指示（点击查看详情与压缩控制）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:session-usage", "invoke:session.compact"],
  mounts: [
    {
      kind: "composer-trailing",
      Component: function ContextRingWidget({ ctx }) {
        return (
          <ContextRing
            agentId={ctx.sessionMeta.agentId}
            sessionId={ctx.sessionId}
            projectPath={ctx.sessionMeta.projectPath}
            compact={
              ctx.capabilities.compact
                ? {
                    onCompact: () => ctx.compactSession(),
                    compacting: ctx.isCompacting,
                    autoCompaction: ctx.autoCompaction,
                    onAutoCompactionChange: (enabled) => ctx.setAutoCompaction(enabled),
                  }
                : undefined
            }
          />
        );
      },
    },
  ],
};
