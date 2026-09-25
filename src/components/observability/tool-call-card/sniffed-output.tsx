/**
 * 嗅探结果渲染组件（v0.9.5 需求1（原需求26）8a/8c）：
 * SVG/图片（img）/ HTML（sandbox iframe srcdoc 禁脚本——工具返回内容不可
 * 信，渲染面收窄）/ JSON 表格（render.table 原语同款实现）/ Markdown
 * （react-markdown 与消息流一致配置的轻量子集）。
 */
import { memo } from "react";
import Markdown from "react-markdown";
import { sniffContentType } from "./output-sniff";

function JsonTable({ columns, rows }: { columns: unknown[]; rows: unknown[][] }): React.JSX.Element {
  const heads = columns.map((c) => String(c));
  return (
    <div className="max-h-64 overflow-auto rounded-md border border-border/45">
      <table className="w-full border-collapse text-left font-mono text-[11px]">
        <thead className="sticky top-0 bg-[var(--tool-card-code-bg)]">
          <tr>
            {heads.map((h, i) => (
              <th key={i} className="border-b border-border/50 px-2 py-1 font-medium text-foreground/80">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((row, r) => (
            <tr key={r} className="odd:bg-muted/20">
              {heads.map((_, c) => (
                <td key={c} className="border-b border-border/25 px-2 py-1 align-top text-foreground/75">
                  {formatCell(row?.[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 100 && (
        <div className="px-2 py-1 text-[10px] text-muted-foreground">… 共 {rows.length} 行（显示前 100）</div>
      )}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 嗅探输出渲染（8a 层一）：非 text 类型返回节点，text 返回 null（调用方走默认）。 */
export const SniffedOutput = memo(function SniffedOutput({ output }: { output: string }): React.JSX.Element | null {
  const type = sniffContentType(output);
  switch (type) {
    case "svg": {
      const url = `data:image/svg+xml;utf8,${encodeURIComponent(output)}`;
      return (
        <div className="flex max-h-64 items-center justify-center overflow-auto rounded-md border border-border/45 bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="SVG 输出" className="max-h-60 max-w-full" />
        </div>
      );
    }
    case "image-data": {
      const url = output.trim().startsWith("data:") ? output.trim() : `data:image/png;base64,${output.replace(/\s+/g, "")}`;
      return (
        <div className="flex max-h-64 items-center justify-center overflow-auto rounded-md border border-border/45 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="图片输出" className="max-h-60 max-w-full" />
        </div>
      );
    }
    case "html":
      return (
        <iframe
          title="HTML 输出"
          srcDoc={output}
          sandbox=""
          className="h-56 w-full rounded-md border border-border/45 bg-white"
        />
      );
    case "table-json": {
      try {
        const parsed = JSON.parse(output.trim()) as { columns?: unknown[]; rows?: unknown[][] };
        return <JsonTable columns={parsed.columns ?? []} rows={parsed.rows ?? []} />;
      } catch {
        return null;
      }
    }
    case "markdown":
      return (
        <div className="max-h-64 overflow-auto rounded-md border border-border/45 bg-[var(--tool-card-code-bg)] px-3 py-2 text-xs leading-relaxed [&_code]:font-mono [&_pre]:overflow-x-auto">
          <Markdown>{output}</Markdown>
        </div>
      );
    default:
      return null;
  }
});
