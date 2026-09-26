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
import type { ToolCall } from "@/components/observability/tool-call-card/types";
import { KindIcon, kindLabel } from "@/components/observability/tool-call-card/kind-icon";
import { ToolGroup } from "@/components/observability/tool-call-card";
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
              {/* v0.9.5 需求4：分类卡片展示（图 1/图 3）——按工具类型分组，
                  组内默认收起，点击组展开明细（分层折叠）。 */}
              <WorkCategoryList items={segments.workItems} renderOther={renderWorkItems} />
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

// ── 分类卡片（已工作展开后的按类分组——图 1 形态）──

interface WorkCategory {
  key: string;
  label: string;
  icon: React.ReactNode;
  items: RenderItem[];
  callCount: number;
}

/** 工作项按类型分组：tool-group 拆按 kind；非工具块各成组（思考/分隔等）。 */
function groupWorkItems(items: RenderItem[]): WorkCategory[] {
  const groups = new Map<string, WorkCategory>();
  const ensure = (key: string, label: string, icon: React.ReactNode): WorkCategory => {
    let g = groups.get(key);
    if (!g) {
      g = { key, label, icon, items: [], callCount: 0 };
      groups.set(key, g);
    }
    return g;
  };
  for (const item of items) {
    if (item.kind === "tool-group") {
      // 按工具 kind 拆组（同 kind 的调用聚成一类卡）。
      const byKind = new Map<string, ToolCall[]>();
      for (const call of item.calls) {
        const list = byKind.get(call.kind) ?? [];
        list.push(call);
        byKind.set(call.kind, list);
      }
      for (const [kind, calls] of byKind) {
        const g = ensure(kind, kindLabel(kind as never), null);
        g.items.push({ kind: "tool-group", calls });
        g.callCount += calls.length;
      }
    } else {
      const label = item.kind === "block"
        ? item.block.type === "thinking" ? "思考" : item.block.type === "phase_divider" ? "阶段" : "其他"
        : "问答";
      const g = ensure(`blk-${label}`, label, null);
      g.items.push(item);
      g.callCount += 1;
    }
  }
  // 图标（工具类用 KindIcon）。
  for (const g of groups.values()) {
    if (!g.icon && !g.key.startsWith("blk-")) {
      g.icon = <KindIcon kind={g.key as never} />;
    }
  }
  return [...groups.values()];
}

const WorkCategoryList = memo(function WorkCategoryList({
  items,
  renderOther,
}: {
  items: RenderItem[];
  renderOther: (items: RenderItem[]) => React.ReactNode;
}) {
  const categories = groupWorkItems(items);
  return (
    <div className="space-y-1.5">
      {categories.map((cat) => (
        <WorkCategoryCard key={cat.key} category={cat} renderOther={renderOther} />
      ))}
    </div>
  );
});

const WorkCategoryCard = memo(function WorkCategoryCard({
  category,
  renderOther,
}: {
  category: WorkCategory;
  renderOther: (items: RenderItem[]) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isToolCat = !category.key.startsWith("blk-");
  return (
    <div className="overflow-hidden rounded-[6px] border border-border/35 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-fast hover:bg-accent/40"
      >
        {category.icon}
        <span className="font-medium">{category.label}</span>
        <span className="rounded-full bg-background/70 px-1.5 py-0.5 text-[10px]">{category.callCount} 项</span>
        <span className="ml-auto shrink-0">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-border/25 p-1.5">
          {isToolCat
            ? category.items.map((item) =>
                item.kind === "tool-group"
                  ? item.calls.map((call) => (
                      <ToolGroup key={call.id} calls={[call]} />
                    ))
                  : null,
              )
            : renderOther(category.items)}
        </div>
      )}
    </div>
  );
});
