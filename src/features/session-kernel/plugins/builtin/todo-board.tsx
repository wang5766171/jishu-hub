/**
 * 待办看板挂件（v0.9.5 需求12）：右上角悬浮待办列表——rpiv-todo 的
 * `todo` 工具全量快照（tool_result.details.tasks，与 rpiv 自身回放机制
 * 同源）+ pi-subagents 并行执行指示（subagent tool_use 未配对 result 计数）。
 *
 * 形态（用户裁决口径）：非看板/流程图——**右上角悬浮列表**；贴边挂件默认
 * 收起（图标 + 进行中 n / 总 m 徽章），点击展开；**全屏自动展开**（退出
 * 恢复收起，手动开合优先于自动）；blockedBy 依赖显示 ⛓ 标识；进行中行
 * 呼吸动效（activeForm 话术）。
 *
 * 集成（用户裁决）：与 rpiv-todo 在用户层面是**一个「待办」插件**——
 * 本挂件不注册独立管理条目（registry 代理映射：session.todo-board 启用态
 * ← 插件中心 pi-todo 条目），开关「待办」= 工具与挂件联动。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckCircle2, ChevronDown, ChevronUp, ListTodo, Loader2 } from "lucide-react";
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
        // details.tasks 仅 todo 工具携带（tool_result 与 tool_use 经 id 配对
        // 的归属这里不区分——非 todo 工具的 details 无 tasks 字段，天然无扰）。
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

function TodoBoardWidget({ ctx }: { ctx: SessionKernelContext }) {
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const [messages, setMessages] = useState<Parameters<typeof deriveTodoState>[0] | null>(null);
  const [open, setOpen] = useState(false);
  /** 用户手动开合标记（手动操作后本会话内不再被全屏联动覆盖）。 */
  const manualRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => ctx.subscribe.messages((msgs) => setMessages(msgs)), [ctx]);

  // 全屏联动（用户裁决：全屏自动展开）：Tauri 窗口 resize 事件查 isFullscreen
  // （浏览器环境守卫同 app.tsx 惯例，纯 vite 预览不炸）。
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    let disposed = false;
    const sync = async () => {
      try {
        const fs = await win.isFullscreen();
        if (!disposed) setFullscreen(fs);
      } catch {
        /* IPC 失败静默 */
      }
    };
    void sync();
    const unlisten = win.onResized(() => void sync());
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!manualRef.current) setOpen(fullscreen);
  }, [fullscreen]);

  const state = useMemo(() => (messages ? deriveTodoState(messages) : null), [messages]);

  // 无待办数据：挂件不可见（与 rpiv 面板空态自动隐藏一致）。
  if (!state || state.tasks.length === 0) return null;

  const visible = state.tasks.filter((task) => task.status !== "deleted");
  const inProgress = visible.filter((task) => task.status === "in_progress");
  const pending = visible.filter((task) => task.status === "pending");
  const completed = visible.filter((task) => task.status === "completed");
  const doneCount = completed.length;

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
          "flex items-start gap-1.5 px-2 py-1 text-[11px] leading-snug",
          task.status === "completed" && "opacity-55",
        )}
      >
        {task.status === "completed" ? (
          <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-[var(--icon-success)]" />
        ) : task.status === "in_progress" ? (
          <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary" />
        ) : (
          <span
            className={cn(
              "mt-1 h-2 w-2 shrink-0 rounded-full border border-muted-foreground/50",
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
    <div className="pointer-events-auto relative">
      {/* 展开面板：会话区右上角悬浮（宿主容器 relative；右偏移让出贴边条）。 */}
      {open && (
        <div className="absolute bottom-full right-3 mb-2 z-30 w-64 rounded-lg border border-border/70 bg-card/95 shadow-lg backdrop-blur">
          <div className="flex items-center gap-1.5 border-b border-border/50 px-2.5 py-1.5">
            <ListTodo className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">
              {tr("sessionPlugins.todoBoard.title", "待办")}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {doneCount}/{visible.length}
            </span>
            {state.subagentsRunning > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-primary">
                <Loader2 className="h-3 w-3 animate-spin" />
                {tr("sessionPlugins.todoBoard.agents", "{{n}} 个子代理执行中").replace(
                  "{{n}}",
                  String(state.subagentsRunning),
                )}
              </span>
            )}
            <button
              type="button"
              className="ml-auto text-muted-foreground hover:text-foreground"
              onClick={() => {
                manualRef.current = true;
                setOpen(false);
              }}
              aria-label={tr("sessionPlugins.todoBoard.collapse", "收起")}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {inProgress.map(row)}
            {pending.map(row)}
            {completed.map(row)}
          </div>
        </div>
      )}
      {/* 收起态：贴边细条按钮（徽章 = 进行中/总数）。 */}
      <button
        type="button"
        className="flex h-8 w-6 flex-col items-center justify-center gap-0.5 rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        onClick={() => {
          manualRef.current = true;
          setOpen((v) => !v);
        }}
        title={tr(
          "sessionPlugins.todoBoard.hint",
          "待办列表（{{done}}/{{total}} 完成）",
        ).replace("{{done}}", String(doneCount)).replace("{{total}}", String(visible.length))}
        aria-label={tr("sessionPlugins.todoBoard.title", "待办")}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        <span
          className={cn(
            "text-[8px] font-mono leading-none",
            inProgress.length > 0 && "text-primary",
          )}
        >
          {doneCount}/{visible.length}
        </span>
      </button>
    </div>
  );
}

export const todoBoardPlugin: SessionPluginDescriptor = {
  id: "session.todo-board",
  displayNameKey: "sessionPlugins.todoBoard.name",
  displayNameFallback: "待办看板",
  descriptionKey: "sessionPlugins.todoBoard.description",
  descriptionFallback: "右上角悬浮待办列表（rpiv-todo 快照可视化 + 子代理并行指示；随「待办」插件启停）",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:messages"],
  mounts: [
    {
      kind: "rail-widget",
      Component: TodoBoardWidget,
      defaultSide: "right",
    },
  ],
};
