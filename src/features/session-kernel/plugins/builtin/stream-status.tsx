import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type {
  PluginStreamState,
  SessionKernelContext,
  SessionPluginDescriptor,
} from "../types";

/**
 * 流式状态指示（v0.9.3 需求3 / P1-3）：PluginStreamState 的**首个真实订阅
 * 消费者**——经 ctx.subscribe.streamState 订阅 SessionDataHub（真订阅：数据
 * 变更逐次回调）。v0.9.3 测试期（用户裁决）自右缘 rail 挂载迁至
 * **composer 行内槽**（水位环/模型选择器同排——"生成中"与停止按钮同一操作
 * 语境；会话列表侧由列表行整轮加载图标承担，见 stream-store 别名展开修复）。
 * 形态：流式=主色脉冲点（悬停已生成字数）、重试=琥珀点（attempt/max/原因）、
 * 错误=红点（悬停错误信息）；空闲不可见。
 */
function StreamStatusIndicator({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const [state, setState] = useState<PluginStreamState | null>(null);

  useEffect(() => ctx.subscribe.streamState(setState), [ctx]);

  if (!state || (!state.isStreaming && !state.retry && !state.error)) return null;

  const chars = state.text.length;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5"
      title={
        state.error
          ? state.error
          : state.retry
            ? `${t("sessionPlugins.streamStatus.retrying", "重试")} ${state.retry.attempt}/${state.retry.max}${state.retry.reason ? ` · ${state.retry.reason}` : ""}`
            : `${t("sessionPlugins.streamStatus.streaming", "生成中")} · ${chars}`
      }
    >
      {state.isStreaming && (
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary/80" />
      )}
      {state.retry && (
        <span className="h-2 w-2 rounded-full bg-amber-500/90" />
      )}
      {state.error && (
        <span className="h-2 w-2 rounded-full bg-destructive/90" />
      )}
    </span>
  );
}

export const streamStatusPlugin: SessionPluginDescriptor = {
  id: "session.stream-status",
  displayNameKey: "sessionPlugins.streamStatus.name",
  displayNameFallback: "流式状态指示",
  descriptionKey: "sessionPlugins.streamStatus.description",
  descriptionFallback: "输入行的生成活动指示（流式/重试/错误，空闲时不可见）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:stream-state"],
  mounts: [
    {
      kind: "composer-trailing",
      Component: StreamStatusIndicator,
    },
  ],
};
