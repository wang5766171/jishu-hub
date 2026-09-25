/**
 * 混合插件实时预览面板（v0.9.5 需求1（原需求26）2b）。
 *
 * 向导编辑器源码 →（防抖 600ms）hybrid_preview_write 写入
 * `plugins/.preview/component.js`（assetProtocol scope 内，CSP 零变化）→
 * loadHybridComponent 完整装载链（指纹热更/script 注入/JishuPlugin.register
 * 匹配/2s 超时）→ HybridErrorBoundary 包裹渲染（非沙箱——评审 P1-6：iframe
 * 沙箱与 CSP/assetProtocol 冲突，复用 hybrid-runtime 的可注入缝）。
 *
 * 预览 payload：模拟数据（按源类型给最小可用形状——消息流/轮次/块）。
 * 失败形态：装载错误（语法/未注册/超时）或渲染崩溃（ErrorBoundary）都
 * 显示具体错误信息（复用 hybrid-runtime 错误态文案语义）。
 */
import { createElement, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { Loader2 } from "lucide-react";
import { invokeCommand } from "@/hooks/use-invoke";
import {
  loadHybridComponent,
  HybridErrorBoundary,
} from "@/features/session-kernel/capabilities/composition/hybrid-runtime";
import type { SourcePayload } from "@/features/session-kernel/capabilities/types";

/** 预览用的插件 id（固定隐藏目录，不与真实插件冲突）。 */
const PREVIEW_DIR_SUFFIX = ".preview";

export interface HybridPreviewPanelProps {
  /** 编辑器当前源码。 */
  source: string;
  /** 清单 plugin.id（register 匹配 + 装载链 pending 键）。 */
  pluginId: string;
  /** 模拟源类型（决定 payload 形状）。 */
  sourceType?: "messages" | "turns" | "task" | "code-block";
  /** 预览区高度。 */
  height?: string;
}

/** 模拟 payload（按源类型最小形状）。 */
function demoPayloadOf(sourceType: NonNullable<HybridPreviewPanelProps["sourceType"]>): SourcePayload {
  switch (sourceType) {
    case "turns":
      return {
        kind: "turns",
        turns: [
          { role: "user", text: "示例问题", cost: 0.01 } as never,
          { role: "assistant", text: "示例回答……", cost: 0.03 } as never,
        ],
        activeIndex: 1,
        jump: () => undefined,
      };
    case "task":
      return { kind: "task", task: { title: "示例任务", status: "running" } as never };
    case "code-block":
      return { kind: "code-block", language: "js", code: "console.log('demo');" };
    case "messages":
    default:
      return {
        kind: "aggregate",
        data: [
          { role: "user", content: "你好" },
          { role: "assistant", content: "你好！这是预览数据。" },
          { role: "user", content: "再来一条" },
        ] as never,
      };
  }
}

export function HybridPreviewPanel({
  source,
  pluginId,
  sourceType = "messages",
  height = "240px",
}: HybridPreviewPanelProps) {
  const [component, setComponent] = useState<ComponentType<Record<string, unknown>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 防抖：编辑器停顿 600ms 后再写盘装载（每次击键都注入会抖）。
    const timer = window.setTimeout(() => {
      let cancelled = false;
      void (async () => {
        setLoading(true);
        setError(null);
        try {
          const fingerprint = await invokeCommand<string>("hybrid_preview_write", { source });
          if (cancelled) return;
          const dir = await invokeCommand<string>("hybrid_preview_dir");
          const loaded = await loadHybridComponent(
            pluginId,
            `${dir}/${PREVIEW_DIR_SUFFIX}`,
            "component.js",
            fingerprint,
          );
          if (cancelled) return;
          if (loaded instanceof Error) {
            setComponent(null);
            setError(loaded.message);
          } else {
            setComponent(() => loaded as ComponentType<Record<string, unknown>>);
          }
        } catch (err) {
          if (!cancelled) {
            setComponent(null);
            setError(String(err));
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, 600);
    return () => window.clearTimeout(timer);
  }, [source, pluginId]);

  const payload = demoPayloadOf(sourceType);

  return (
    <div
      className="relative overflow-auto rounded-md border border-border bg-muted/10 p-3"
      style={{ height }}
    >
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/40 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          预览装载中…
        </div>
      )}
      {error && (
        <div className="space-y-1 p-2 font-mono text-[11px] leading-relaxed text-destructive">
          <div className="font-semibold">预览失败</div>
          <div className="whitespace-pre-wrap">{error}</div>
        </div>
      )}
      {!error && component && (
        <HybridErrorBoundary pluginId={pluginId}>
          <PreviewHost component={component} payload={payload} />
        </HybridErrorBoundary>
      )}
      {!error && !component && !loading && (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          编写代码后此处实时预览（模拟数据）
        </div>
      )}
    </div>
  );
}

/** JSX 宿主渲染（class/function 组件统一 createElement）。 */
function PreviewHost({
  component,
  payload,
}: {
  component: ComponentType<Record<string, unknown>>;
  payload: SourcePayload;
}) {
  return createElement(component, { payload, options: {}, actions: [] } as Record<string, unknown>);
}
