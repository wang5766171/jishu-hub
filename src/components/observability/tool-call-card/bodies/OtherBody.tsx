import { memo } from "react";
import i18n from "@/i18n";
import type { ToolKind } from "../types";
import { kindLabel } from "../kind-icon";
// 8a（v0.9.5 需求1，原需求26）：output 区内容嗅探——SVG/HTML/表格/图片/
// Markdown 自动渲染（零配置层一）；插件认领（8b tool-result 咨询）优先。
import { SniffedOutput } from "../sniffed-output";
import { matchToolResultRenderer } from "@/features/session-kernel/plugins/mounts/use-block-renderers";

export const OtherBody = memo(function OtherBody({ input, output, kind, toolName }: { input: Record<string, unknown>; output?: string; kind: ToolKind; toolName?: string }) {
  // 8b：插件认领（source.tool_name/tool_pattern 匹配该工具 → 插件组件替换）。
  const claimed = toolName ? matchToolResultRenderer(toolName) : null;

  return (
    <div className="text-[0.95em] space-y-2">
      <div className="text-[0.85em] text-muted-foreground uppercase tracking-wide">{kindLabel(kind)}</div>
      {Object.keys(input).length > 0 && (
        <pre className="font-mono text-[0.95em] bg-[var(--tool-card-code-bg)] border border-border/45 rounded-[6px] p-2.5 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre">
          {JSON.stringify(input, null, 2).slice(0, 2000)}
        </pre>
      )}
      {claimed ? (
        <claimed.component payload={{ kind: "tool-result", toolName: toolName ?? "", output: output ?? "" }} options={claimed.options} actions={[]} />
      ) : output ? (
        <>
          <SniffedOutput output={output} />
          <details className="group">
            <summary className="cursor-pointer select-none text-[10px] text-muted-foreground/70 hover:text-foreground">
              {i18n.t("tools.rawOutput", { defaultValue: "Raw output" })}
            </summary>
            <pre className="mt-1 font-mono text-[0.95em] bg-[var(--tool-card-code-bg)] border border-border/45 rounded-[6px] p-2.5 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre">
              {output.length > 2000 ? output.slice(0, 2000) + "\n… (truncated)" : output}
            </pre>
          </details>
        </>
      ) : null}
    </div>
  );
});
