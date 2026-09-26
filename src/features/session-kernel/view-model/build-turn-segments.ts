/**
 * 轮级三段式重组器（v0.9.5 需求4 P2）——回放侧 assistant 组的渲染条目
 * 从「块序平铺」重组为三段：
 *   ① workItems（已工作）：工具组/交互卡/思考块/阶段分隔——轮首折叠区；
 *   ② textItems（正文）：非思考 text 块——独立直出；
 *   ③ fileChanges（文件改动概览）：本轮 edit/write/delete 类工具的
 *      路径 + 增删行统计——轮尾概览卡。
 *
 * 架构定位（01 §四 P2 修订）：本模块是 view-model 层的纯函数重组（内核
 * 职责——布局归宿主）；分类卡与概览卡的渲染件走 renderers 注册表与
 * block-renderer 认领的插件接缝（后续插件可定制）。
 */
import type { RenderItem } from "@/components/sessions/message-view";
import type { ToolCall } from "@/components/observability/tool-call-card/types";

/** 文件改动条目（轮尾概览数据）。 */
export interface FileChangeEntry {
  path: string;
  op: "edit" | "write" | "delete";
  added: number;
  removed: number;
}

/** 三段式轮单元。 */
export interface TurnSegments {
  /** ① 已工作（折叠区内容：工具组/交互/思考/分隔）。 */
  workItems: RenderItem[];
  /** 工作项计数（工具调用数 + 思考块数 + 交互数）。 */
  workCount: number;
  /** ② 正文块（直出）。 */
  textItems: RenderItem[];
  /** ③ 文件改动概览（无改动时为空数组）。 */
  fileChanges: FileChangeEntry[];
}

/** 判断渲染条目是否「工作内容」（归折叠区）。 */
function isWorkItem(item: RenderItem): boolean {
  if (item.kind === "tool-group" || item.kind === "interaction") return true;
  if (item.kind === "block") {
    const t = item.block.type;
    return t === "thinking" || t === "phase_divider" || t === "tool_result";
  }
  return false;
}

/** 从工具卡提取文件改动（edit/write/delete 类 + diff 统计）。 */
function extractFileChange(call: ToolCall): FileChangeEntry | null {
  if (call.kind !== "file_edit" && call.kind !== "file_write" && call.kind !== "file_delete") {
    return null;
  }
  const op: FileChangeEntry["op"] =
    call.kind === "file_edit" ? "edit" : call.kind === "file_write" ? "write" : "delete";
  const path =
    (call.input["file_path"] as string) ??
    (call.input["path"] as string) ??
    (call.input["filePath"] as string) ??
    "";
  if (!path) return null;
  const stats = call.view as { changesStat?: { added: number; removed: number } } | undefined;
  return {
    path,
    op,
    added: stats?.changesStat?.added ?? countDiffLines(call, "+"),
    removed: stats?.changesStat?.removed ?? countDiffLines(call, "-"),
  };
}

/** 从 output 的 diff 文本兜底统计增删行（view 未带 changesStat 时）。 */
function countDiffLines(call: ToolCall, sign: "+" | "-"): number {
  const output = call.output ?? "";
  let n = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith(sign) && !line.startsWith(sign + sign)) n += 1;
  }
  return n;
}

/** 重组：平铺 items → 三段。正文保持原相对顺序。 */
export function buildTurnSegments(items: RenderItem[]): TurnSegments {
  const workItems: RenderItem[] = [];
  const textItems: RenderItem[] = [];
  const changeMap = new Map<string, FileChangeEntry>();

  for (const item of items) {
    if (isWorkItem(item)) {
      workItems.push(item);
      if (item.kind === "tool-group") {
        for (const call of item.calls) {
          const change = extractFileChange(call);
          if (!change) continue;
          const key = `${change.op}:${change.path}`;
          const prev = changeMap.get(key);
          if (prev) {
            prev.added += change.added;
            prev.removed += change.removed;
          } else {
            changeMap.set(key, { ...change });
          }
        }
      }
    } else {
      textItems.push(item);
    }
  }

  let workCount = 0;
  for (const item of workItems) {
    if (item.kind === "tool-group") workCount += item.calls.length;
    else workCount += 1;
  }

  return { workItems, workCount, textItems, fileChanges: [...changeMap.values()] };
}

/** 概览行摘要（N 个文件 · +a/−r）。 */
export function fileChangesSummary(changes: FileChangeEntry[]): string {
  if (changes.length === 0) return "";
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    added += c.added;
    removed += c.removed;
  }
  const parts = [`${changes.length} 个文件`];
  if (added || removed) parts.push(`+${added}/−${removed}`);
  return parts.join(" · ");
}
