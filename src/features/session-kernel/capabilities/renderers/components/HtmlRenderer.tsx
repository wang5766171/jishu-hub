/**
 * render.html：HTML 卡片实时渲染（需求14 M5 批1——自 TS 内置件组合化，
 * mermaid 先例模式：渲染键 + 内置组合清单 session.html-render.toml）。
 * 组件本体沿用 v0.9.3 测试期四轮打磨的 HtmlPreviewCard（高度协议/ESC
 * 转发/宽版阅读器语义不变）；组合臂 detect 恒真——不可渲染内容（无标签
 * 纯文本）在此回退源码视图（与原 detect 拒绝等价）。
 */
import { rendererRegistry } from "../registry";
import type { RendererComponentProps, SourcePayload } from "../../types";
import { HtmlPreviewCard, isRenderableHtmlBlock } from "@/features/session-kernel/plugins/builtin/html-render";

function HtmlBlockRenderer({ payload }: RendererComponentProps<SourcePayload>) {
  const code = payload.kind === "code-block" ? payload.code : "";
  if (!isRenderableHtmlBlock(code)) {
    return (
      <pre className="my-2 overflow-auto rounded-lg border border-border/60 p-2 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  }
  return <HtmlPreviewCard code={code} />;
}

rendererRegistry.register({
  key: "render.html",
  component: HtmlBlockRenderer,
  description: "HTML 卡片实时渲染（官方，随包）",
});
