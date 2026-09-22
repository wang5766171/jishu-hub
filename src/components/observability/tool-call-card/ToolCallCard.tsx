import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ToolCall } from "./types";
import { StatusBadge } from "./status-badge";
import { KindIcon, kindLabel } from "./kind-icon";
import { FileReadBody } from "./bodies/FileEditBody";
import { ShellExecBody } from "./bodies/ShellExecBody";
import { SearchBody } from "./bodies/SearchBody";
import { OtherBody } from "./bodies/OtherBody";
import { useFileViewer } from "@/components/file-viewer";
import { ChevronDown, ChevronRight, FileSearch } from "lucide-react";
import { buildDiffPreview, getToolPath } from "@/lib/text-preview";

/** v0.9.4 需求8：running 态实时计时（每秒 tick；完成态用 endedAt 差值，
 * 无 tick）。返回与既有 duration 展示同格式的字符串。 */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s}s`;
}

function useRunningElapsed(startedAt: number | undefined, endedAt: number | undefined): string | null {
  const [, forceTick] = useState(0);
  const isRunning = startedAt !== undefined && endedAt === undefined;
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);
  if (startedAt === undefined) return null;
  if (endedAt !== undefined) {
    const dur = endedAt - startedAt;
    return dur >= 0 ? `${(dur / 1000).toFixed(1)}s` : null;
  }
  return formatElapsed(Date.now() - startedAt);
}

/** v0.9.4 需求8：运行中实时输出区（长时 bash 类工具的中间输出快照，
 * 等宽滚动区 + 自动贴底，不撑开布局——与「卡死」明确区分）。 */
function PartialOutputBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  const preRef = useRef<HTMLPreElement | null>(null);
  const lastLenRef = useRef(0);
  useEffect(() => {
    // 只在新增内容时贴底（用户上翻阅读时不拉回）。
    if (preRef.current && text.length >= lastLenRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
    lastLenRef.current = text.length;
  }, [text]);
  const display = text.length > 4000 ? text.slice(text.length - 4000) : text;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[0.82em] text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--tool-running)] animate-pulse" />
        {t("sessions.toolRunningBackground", "后台执行中，输出实时刷新")}
      </div>
      <pre
        ref={preRef}
        className="font-mono text-[0.92em] bg-[var(--tool-card-code-bg)] border border-border/45 rounded-[6px] p-2.5 overflow-x-auto max-h-56 overflow-y-auto whitespace-pre-wrap break-all"
      >{display}</pre>
    </div>
  );
}

function ToolCallCardBody({ call }: { call: ToolCall }) {
  // v0.9.4 需求8：运行中且已有中间输出 → body 区先展示实时输出（命令
  // 行等 input 信息仍在，由 ShellExecBody 呈现）；完成态维持既有渲染。
  if (call.status === "running" && call.partialOutput) {
    return (
      <div className="space-y-2">
        <ToolCallCardBodyResolved call={call} />
        <PartialOutputBlock text={call.partialOutput} />
      </div>
    );
  }
  return <ToolCallCardBodyResolved call={call} />;
}

function ToolCallCardBodyResolved({ call }: { call: ToolCall }) {
  switch (call.kind) {
    case "file_read":
    case "file_write":
    case "file_edit":
    case "file_delete":
      return <FileReadBody input={call.input} output={call.output} kind={call.kind} />;
    case "shell_exec":
      return <ShellExecBody input={call.input} output={call.output} error={call.error} />;
    case "search":
      return <SearchBody input={call.input} output={call.output} />;
    default:
      return <OtherBody input={call.input} output={call.output} kind={call.kind} />;
  }
}

const statusBorder: Record<ToolCall["status"], string> = {
  pending: "border-dashed border-muted-foreground/35",
  running: "border-solid border-[var(--tool-card-border)]",
  success: "border-solid border-[var(--tool-card-border)]",
  error: "border-solid border-[var(--tool-error)] ring-1 ring-[var(--tool-error)]/30",
  aborted: "border-solid border-muted-foreground/25 opacity-70",
};

export const ToolCallCard = memo(function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(call.status === "error" || (call.status === "running" && Boolean(call.partialOutput)));
  const { openViewer } = useFileViewer();
  const { t } = useTranslation();
  const diff = call.kind === "file_edit" || call.kind === "file_write" ? buildDiffPreview(call.input) : null;
  // v0.8.0 需求2 Phase 1：位置优先取渲染意图（归一化层提取），
  // 缺失（历史数据）回退输入解析。
  const viewPath = call.view?.locations?.[0]?.path;
  const path = viewPath
    || getToolPath(call.input)
    || (call.input.command as string)
    || (call.input.pattern as string)
    || "";
  const shortPath = path.length > 60 ? "..." + path.slice(path.length - 55) : path;
  const duration = useRunningElapsed(call.startedAt, call.endedAt);
  const isFile = call.kind.startsWith("file_") && path;
  // v0.9.1 需求3 #3 测试期补充：powershell 与 bash 共用 shell_exec 卡片
  // （同款渲染/审批），但徽标按真实工具名显示——否则 PowerShell 原生调用
  // 顶着 "Bash" 徽标，用户实测误判成"还是 bash 套壳"。
  const headerLabel =
    call.kind === "shell_exec" && call.toolName.toLowerCase() === "powershell"
      ? "PowerShell"
      : kindLabel(call.kind);

  return (
    <div
      style={{ fontSize: "var(--font-size-prose)" }}
      className={cn(
        "overflow-hidden rounded-[8px] border bg-[var(--tool-card-bg)] text-[1em] shadow-sm transition-colors",
        statusBorder[call.status],
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 bg-[var(--tool-card-header-bg)] px-3 py-2 text-left hover:bg-[var(--color-accent)]/45 transition-fast"
      >
        <KindIcon kind={call.kind} />
        <span className="text-[0.73em] font-semibold text-muted-foreground uppercase tracking-wide">
          {headerLabel}
        </span>
        <span className="flex-1 font-mono text-[0.95em] truncate text-[var(--color-foreground)]" title={path}>
          {shortPath}
        </span>
        {diff && (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.9em] font-semibold">
            <span className="text-green-600">+{diff.added}</span>
            <span className="text-red-600">-{diff.removed}</span>
          </span>
        )}
        {isFile && (
          <span
            role="button"
            tabIndex={0}
            title={t("fileViewer.openFile", "打开文件")}
            onClick={(event) => {
              event.stopPropagation();
              openViewer({ kind: diff ? "diff" : "file", path, diff });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                openViewer({ kind: diff ? "diff" : "file", path, diff });
              }
            }}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-[var(--color-accent)] hover:text-foreground"
          >
            <FileSearch className="h-3.5 w-3.5" />
          </span>
        )}
        {duration && (
          <span className="text-[0.82em] text-muted-foreground shrink-0">{duration}</span>
        )}
        <StatusBadge status={call.status} />
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/40 px-3 py-2">
          <ToolCallCardBody call={call} />
        </div>
      )}
    </div>
  );
});
