/**
 * 轮组三段式视图（v0.9.5 需求4 P2）——assistant 组的完成态形态：
 *   ①「已工作 N 项」折叠区（默认收起；含工具组/交互/思考/分隔）
 *   ② 正文
 *   ③ 文件改动概览（无改动不渲染）。
 *
 * 布局归宿主（内核）；分类卡/概览卡内容后续可被插件认领（renderers 通道）。
 */
import { memo, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff, Hammer } from "lucide-react";
import type { RenderItem } from "@/components/sessions/message-view";
import { fileChangesSummary, type FileChangeEntry } from "@/features/session-kernel/view-model/build-turn-segments";
import { cn } from "@/lib/utils";

export interface TurnGroupViewProps {
  /** 重组后的三段。 */
  segments: {
    workItems: RenderItem[];
    workCount: number;
    textItems: RenderItem[];
    fileChanges: FileChangeEntry[];
  };
  /** 正文渲染器（复用调用方的块渲染逻辑——搜索高亮等上下文不丢）。 */
  renderTextItems: (items: RenderItem[]) => React.ReactNode;
  /** 工作项渲染器（展开时逐项渲染——复用既有 ToolGroup/块渲染）。 */
  renderWorkItems: (items: RenderItem[]) => React.ReactNode;
}

export const TurnGroupView = memo(function TurnGroupView({
  segments,
  renderTextItems,
  renderWorkItems,
}: TurnGroupViewProps) {
  const [workOpen, setWorkOpen] = useState(false);
  const hasWork = segments.workItems.length > 0;

  return (
    <div className="space-y-2">
      {hasWork && (
        <div
          className="overflow-hidden rounded-[8px] border border-border/40 bg-[var(--tool-card-bg)]"
          data-turn-work
        >
          <button
            type="button"
            onClick={() => setWorkOpen(!workOpen)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition-fast hover:bg-accent/40"
          >
            <Hammer className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">已工作 · {segments.workCount} 项</span>
            <span className="ml-auto shrink-0">
              {workOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </span>
          </button>
          {workOpen && (
            <div className="space-y-1.5 border-t border-border/30 p-2">
              {/* 用户裁决（实测 21:58）：展开直接平铺工具卡与思考（卡自带
                  分类标识——图标+中文名），不加中间分组层（层级简化对齐 zcode）。 */}
              {renderWorkItems(segments.workItems)}
            </div>
          )}
        </div>
      )}
      {renderTextItems(segments.textItems)}
      {segments.fileChanges.length > 0 && (
        <FileChangesCard changes={segments.fileChanges} />
      )}
    </div>
  );
});

const OP_LABEL: Record<FileChangeEntry["op"], string> = {
  edit: "编辑",
  write: "创建",
  delete: "删除",
};

const FileChangesCard = memo(function FileChangesCard({ changes }: { changes: FileChangeEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="overflow-hidden rounded-[8px] border border-border/40 bg-accent/20"
      data-turn-file-changes
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition-fast hover:bg-accent/40"
      >
        <FileDiff className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">文件改动 · {fileChangesSummary(changes)}</span>
        <span className="ml-auto shrink-0">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>
      {open && (
        <ul className="space-y-0.5 border-t border-border/30 px-3 py-2">
          {changes.map((c) => (
            <li key={`${c.op}:${c.path}`} className="flex items-center gap-2 text-[11px]">
              <span
                className={cn(
                  "shrink-0 rounded px-1 py-0.5",
                  c.op === "edit" && "bg-amber-500/15 text-amber-600",
                  c.op === "write" && "bg-emerald-500/15 text-emerald-600",
                  c.op === "delete" && "bg-destructive/15 text-destructive",
                )}
              >
                {OP_LABEL[c.op]}
              </span>
              <span className="truncate font-mono text-muted-foreground" title={c.path}>
                {c.path}
              </span>
              {(c.added || c.removed) > 0 && (
                <span className="ml-auto shrink-0 font-mono">
                  <span className="text-emerald-600">+{c.added}</span>
                  <span className="mx-0.5 text-muted-foreground/50">/</span>
                  <span className="text-destructive">−{c.removed}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
