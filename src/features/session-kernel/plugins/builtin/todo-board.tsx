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
import { CheckCircle2, ChevronRight, ListTodo, Loader2 } from "lucide-react";
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
  /** 分批任务列表（按「旧批全部完成后出现新任务」切批；最后一批为当前批）。 */
  batches: TodoTask[][];
  /** 运行中的 subagent 调用数（tool_use 无配对 result）。 */
  subagentsRunning: number;
}

/** 从消息流推导分批待办状态：重放 todo 快照序列（与 rpiv 回放同源），
 * 批次边界 = ①当前批活跃任务全部完成后出现**真实用户消息**，其后新建
 * 任务开新批（同轮顺序执行 A 完成后建 B 不切批）；②action=clear 封批。
 * 任务状态以各任务最后出现的快照为准（clear 后消失的旧任务保留封存态）。
 * 纯函数便于测试。 */
export function deriveTodoState(
  msgs: ReadonlyArray<{ role: string; blocks: ReadonlyArray<{
    type: string;
    id?: string;
    text?: string;
    details?: Record<string, unknown>;
  }> }>,
): TodoState | null {
  const openSubagentCalls = new Set<string>();
  const batches: TodoTask[][] = [];
  /** 批成员最后已知状态（跨快照累积；封批/收尾时取此）。 */
  const lastById = new Map<number, TodoTask>();
  let currentIds = new Set<number>();
  /** 上批活跃清空后是否已跨过真实用户消息（批次边界的必要条件）。 */
  let userTurnSinceIdle = false;
  let anyTodo = false;

  const sealBatch = () => {
    if (currentIds.size === 0) return;
    batches.push(
      [...currentIds]
        .map((id) => lastById.get(id))
        .filter((t): t is TodoTask => !!t && t.status !== "deleted"),
    );
    currentIds = new Set();
    userTurnSinceIdle = false;
  };

  for (const msg of msgs) {
    // 真实用户消息（含 text 块的 user 消息；toolResult 也挂 user role 需排除）。
    if (msg.role === "user" && msg.blocks.some((b) => b.type === "text")) {
      const active = [...currentIds].filter((id) => lastById.get(id)?.status === "in_progress" || lastById.get(id)?.status === "pending");
      if (active.length === 0) userTurnSinceIdle = true;
    }
    for (const block of msg.blocks) {
      if (block.type === "tool_use") {
        if (block.text === "subagent" && block.id) {
          openSubagentCalls.add(block.id);
        }
      } else if (block.type === "tool_result") {
        if (block.id) openSubagentCalls.delete(block.id);
        const details = block.details as { tasks?: unknown; action?: unknown } | undefined;
        const tasks = details?.tasks;
        if (!Array.isArray(tasks)) continue;
        anyTodo = true;
        const live = (tasks as TodoTask[]).filter((t) => t.status !== "deleted");
        if (details?.action === "clear") {
          sealBatch();
          continue;
        }
        for (const t of live) lastById.set(t.id, t);
        const freshIds = live.filter((t) => !currentIds.has(t.id));
        if (freshIds.length > 0 && currentIds.size > 0 && userTurnSinceIdle) {
          // 上批已清空（活跃为 0）且跨过用户消息 → 新批次。
          sealBatch();
        }
        // 只纳入新任务（封批后的旧任务不得回流新批；未封批时等价全量幂等加）。
        for (const t of freshIds) currentIds.add(t.id);
      }
    }
  }
  sealBatch();
  const visible = batches.flat();
  if (!anyTodo || visible.length === 0) return null;
  return { batches: batches.filter((b) => b.length > 0), subagentsRunning: openSubagentCalls.size };
}

/** 需求13 三轮：胶囊缩略（缩小态与能力中心按钮并排）——信息缩略而非
 * 模块名：ListTodo 图标 + done/total（无数据显示模块名兜底）。 */
function TodoCapsule({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Parameters<typeof deriveTodoState>[0] | null>(null);
  useEffect(() => ctx.subscribe.messages((msgs) => setMessages(msgs)), [ctx]);
  const state = useMemo(() => (messages ? deriveTodoState(messages) : null), [messages]);
  const visible = state ? state.batches.flat() : [];
  const done = visible.filter((task) => task.status === "completed").length;
  return (
    <>
      <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-[11px] font-medium text-foreground/90">
        {visible.length > 0
          ? `${done}/${visible.length}`
          : t("sessionPlugins.todoBoard.title", "待办")}
      </span>
    </>
  );
}

/** 需求12 二轮：新增待办自动打开面板的跨层信号（DOM 事件桥——插件组件
 * 无法直接触达面板层 showPanel；session-panel-layer 监听此事件）。 */
export const OPEN_TODO_PANEL_EVENT = "jishu:open-panel";

function TodoBoardPanel({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const [messages, setMessages] = useState<Parameters<typeof deriveTodoState>[0] | null>(null);

  useEffect(() => ctx.subscribe.messages((msgs) => setMessages(msgs)), [ctx]);

  const state = useMemo(() => (messages ? deriveTodoState(messages) : null), [messages]);

  if (!state || state.batches.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-xs text-muted-foreground">
        {tr("sessionPlugins.todoBoard.empty", "暂无待办——让 agent「创建几条待办并跟踪执行」")}
      </div>
    );
  }

  // 需求12 测试期二轮：分批展示——历史批（全部完成）折叠为可展开条目，
  // 当前批（最后一批，含活跃任务）完整展示。
  const visible = state.batches.flat();
  const completed = visible.filter((task) => task.status === "completed");
  const historicalBatches = state.batches.slice(0, -1);
  const currentBatch = state.batches[state.batches.length - 1];

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
        {historicalBatches.map((batch, i) => {
          const allDone = batch.every((t) => t.status === "completed");
          return (
            <details key={`batch-${i}`} className="group border-b border-border/30 px-2 py-1">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10px] text-muted-foreground">
                <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                {tr("sessionPlugins.todoBoard.batchDone", "已完成批次 · {{n}} 条").replace("{{n}}", String(batch.length))}
              </summary>
              <div className={cn("pt-0.5", !allDone && "opacity-100")}>
                {batch.map(row)}
              </div>
            </details>
          );
        })}
        {state.batches.length > 1 && (
          <div className="px-3 pb-1 pt-2 text-[10px] font-medium text-foreground/80">
            {tr("sessionPlugins.todoBoard.batchCurrent", "当前批次")}
          </div>
        )}
        {currentBatch.map(row)}
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
      defaultSlot: "float",  /* 需求13：悬浮窗类插件默认悬浮形态 */
      CapsuleComponent: TodoCapsule,
      // 需求12 四轮（通用底座声明式）：todo 工具 create 动作触发自动打开
      //（update/list 不打扰）——底座统一监测，本插件零检测代码。
      autoOpenOn: { tool: "todo", inputContains: { action: "create" } },
    },
  ],
};
