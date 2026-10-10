/**
 * 待办面板（v0.9.5 需求12，2026-10-10 测试期改版：rail 细条→dock-panel
 * 右缘标准面板，用户裁决「参考任务看板的形式，在右侧」）——rpiv-todo 的
 * `todo` 工具全量快照（tool_result.details.tasks，与 rpiv 自身回放机制
 * 同源）+ pi-subagents 并行执行指示（subagent tool_use 未配对 result 计数）。
 *
 * 集成（用户裁决）：与 rpiv-todo 在用户层面是**一个「待办」插件**——
 * registry 代理映射（session.todo-board 启用态 ← 插件中心 pi-todo 条目），
 * 开关「待办」= 工具与面板联动。
 * 全屏自动展开：面板层（session-panel-layer）统一承担（进入全屏展开最近
 * 使用的面板），本组件不处理。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionKernelContext, SessionPluginDescriptor } from "../types";

/** rpiv-todo TaskDetails 的最小消费面（tool_result.details）。 */
interface TodoTask {
  id: number;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  activeForm?: string;
  blockedBy?: number[];
}

interface TodoState {
  tasks: TodoTask[];
  /** 运行中的 subagent 调用数（tool_use 无配对 result）。 */
  subagentsRunning: number;
}

/** 从消息流推导待办状态：最后一个 todo 工具调用的 details 快照胜出
 * （与 rpiv 回放同源）；subagent 运行计数 = 未配对 result 的 subagent
 * tool_use。纯函数便于测试。 */
export function deriveTodoState(
  msgs: ReadonlyArray<{ role: string; blocks: ReadonlyArray<{
    type: string;
    id?: string;
    text?: string;
    details?: Record<string, unknown>;
  }> }>,
): TodoState | null {
  let latest: TodoTask[] | null = null;
  const openSubagentCalls = new Set<string>();
  for (const msg of msgs) {
    for (const block of msg.blocks) {
      if (block.type === "tool_use") {
        if (block.text === "subagent" && block.id) {
          openSubagentCalls.add(block.id);
        }
      } else if (block.type === "tool_result") {
        if (block.id) openSubagentCalls.delete(block.id);
        // details.tasks 仅 todo 工具携带（非 todo 工具的 details 无 tasks
        // 字段，天然无扰）。
        const tasks = (block.details as { tasks?: unknown } | undefined)?.tasks;
        if (Array.isArray(tasks)) {
          latest = tasks as TodoTask[];
        }
      }
    }
  }
  if (!latest) return null;
  return { tasks: latest, subagentsRunning: openSubagentCalls.size };
}

function TodoBoardPanel({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const [messages, setMessages] = useState<Parameters<typeof deriveTodoState>[0] | null>(null);

  useEffect(() => ctx.subscribe.messages((msgs) => setMessages(msgs)), [ctx]);

  const state = useMemo(() => (messages ? deriveTodoState(messages) : null), [messages]);

  if (!state || state.tasks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-xs text-muted-foreground">
        {tr("sessionPlugins.todoBoard.empty", "暂无待办——让 agent「创建几条待办并跟踪执行」")}
      </div>
    );
  }

  const visible = state.tasks.filter((task) => task.status !== "deleted");
  const inProgress = visible.filter((task) => task.status === "in_progress");
  const pending = visible.filter((task) => task.status === "pending");
  const completed = visible.filter((task) => task.status === "completed");

  const row = (task: TodoTask) => {
    const blocked =
      task.status === "pending" &&
      (task.blockedBy ?? []).some(
        (dep) => visible.some((x) => x.id === dep && x.status !== "completed"),
      );
    const label =
      task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
    return (
      <div
        key={task.id}
        className={cn(
          "flex items-start gap-2 px-3 py-1.5 text-xs leading-snug",
          task.status === "completed" && "opacity-55",
        )}
      >
        {task.status === "completed" ? (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--icon-success)]" />
        ) : task.status === "in_progress" ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <span
            className={cn(
              "mt-1 h-2.5 w-2.5 shrink-0 rounded-full border border-muted-foreground/50",
              blocked && "border-amber-500/70",
            )}
          />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 break-words",
            task.status === "completed" && "line-through decoration-muted-foreground/60",
            task.status === "in_progress" && "font-medium",
          )}
          title={task.subject}
        >
          {label}
          {blocked && <span className="ml-1 text-amber-600 dark:text-amber-400">⛓</span>}
        </span>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 概要头：进度 + 子代理并行指示。 */}
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono">
          {completed.length}/{visible.length}
        </span>
        {state.subagentsRunning > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-primary">
            <Loader2 className="h-3 w-3 animate-spin" />
            {tr("sessionPlugins.todoBoard.agents", "{{n}} 个子代理执行中").replace(
              "{{n}}",
              String(state.subagentsRunning),
            )}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {inProgress.map(row)}
        {pending.map(row)}
        {completed.map(row)}
      </div>
    </div>
  );
}

export const todoBoardPlugin: SessionPluginDescriptor = {
  id: "session.todo-board",
  displayNameKey: "sessionPlugins.todoBoard.name",
  displayNameFallback: "待办面板",
  descriptionKey: "sessionPlugins.todoBoard.description",
  descriptionFallback: "右缘待办列表面板（rpiv-todo 快照可视化 + 子代理并行指示；随「待办」插件启停）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:messages"],
  mounts: [
    {
      kind: "dock-panel",
      titleKey: "sessionPlugins.todoBoard.title",
      titleFallback: "待办",
      Component: TodoBoardPanel,
      defaultSlot: "right",
    },
  ],
};
