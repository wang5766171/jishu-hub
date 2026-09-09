import { Gauge } from "lucide-react";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor } from "../types";

/**
 * 上下文占用环插件（v0.9.2 底座增强后首批拆出）：
 * 原为 chat-page 头部硬编码装配的 context-ring 组件，现迁移为 header-action
 * 插件——消费 ctx.sessionMeta 的 contextUsed/contextTotal（底座增强的数据面）。
 * 悬停显示 token 详情；点击打开用量面板的快捷入口（后续版本）。
 */

export const contextRingPlugin: SessionPluginDescriptor = {
  id: "session.context-ring",
  displayNameKey: "sessionPlugins.contextRing.name",
  displayNameFallback: "上下文占用环",
  descriptionKey: "sessionPlugins.contextRing.description",
  descriptionFallback: "会话上下文占用指示（悬停查看 token 详情）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:session-meta"],
  mounts: [
    {
      kind: "header-action",
      labelKey: "sessionPlugins.contextRing.action",
      labelFallback: "上下文占用",
      icon: Gauge,
      onClick: (ctx) => {
        const meta = ctx.sessionMeta;
        const used = meta.contextUsed;
        const total = meta.contextTotal;
        if (used == null || total == null || total === 0) {
          return;
        }
        // v1：点击无操作（悬停 title 展示详情）；后续可跳转用量面板
      },
    },
  ],
};
