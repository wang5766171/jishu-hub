/**
 * TaskSessionTree —— 侧边栏任务列表。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §6（需求四 · 会话复用与二级结构）。
 *
 * 结构（2026-09-11 用户裁决：三级收敛为二级）：
 *   常规会话（由 chat-page 渲染，不在本组件）
 *   ─────────────
 *   任务会话
 *     ├─ 任务 A（标题 + 阶段徽标 + 运行状态灯）
 *     └─ 任务 B
 *
 * 交互：
 * - 点任务 → 进入任务工作台（阶段会话）；子任务会话**不再在本列表展示**，
 *   统一经会话区能力中心「任务看板」（session.flow 插件）钻入查看——看板
 *   有实时状态与当前选中高亮，信息密度与反馈都优于静态树节点行。
 * - 任务行右键 → 重命名 / 删除（沿用现有 ContextMenu）
 * - 任务行悬停（运行中）→ 取消执行
 *
 * 数据来源：任务列表由 chat-page 传入（task_launch_list_sessions）。
 */
import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, MessageSquare, Pencil, X, Network } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";

export interface TaskSessionTreeTask {
  task_id: string;
  title: string;
  skill_id: string;
  status: string;
  current_phase: string;
  requirement_file?: string | null;
  requirement_session_id?: string | null;
  planning_session_id?: string | null;
  graph_id?: string | null;
  active_run_id?: string | null;
  last_run_id?: string | null;
  run_status?: string | null;
}

export interface TaskSessionTreeProps {
  onCancelTask?: (task: TaskSessionTreeTask) => void;
  tasks: TaskSessionTreeTask[];
  /** 当前激活的任务 ID（高亮） */
  activeTaskId: string | null;
  /** 点击任务行 */
  onSelectTask: (task: TaskSessionTreeTask) => void;
  /** 重命名（右键菜单） */
  onRenameTask: (task: TaskSessionTreeTask) => void;
  /** 删除（右键菜单） */
  onDeleteTask: (task: TaskSessionTreeTask) => void;
}

// ── 单个任务行 ──

interface TaskRowProps {
  /** v0.9.2 需求2 M3-4：运行中任务的悬停取消（由页面承担确认）。 */
  onCancelTask?: (task: TaskSessionTreeTask) => void;
  task: TaskSessionTreeTask;
  isActive: boolean;
  onSelectTask: (task: TaskSessionTreeTask) => void;
  onRenameTask: (task: TaskSessionTreeTask) => void;
  onDeleteTask: (task: TaskSessionTreeTask) => void;
}

const phaseLabel: Record<string, string> = {
  requirements: "需求",
  planning: "规划",
  graph: "流程",
  execution: "执行",
};

const TaskRow = memo(function TaskRow({
  task,
  isActive,
  onSelectTask,
  onRenameTask,
  onDeleteTask,
  onCancelTask,
}: TaskRowProps) {
  const { t } = useTranslation();
  const phase = phaseLabel[task.current_phase] ?? task.current_phase;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <button
            type="button"
            onClick={() => onSelectTask(task)}
            className={cn(
              // 与常规会话项对齐：pl-5(1.25rem) + gap-3，图标 h-3 w-3，避免整体右移。
              "group flex w-full items-center gap-3 border-b border-border/10 py-2 pl-5 pr-2 text-xs transition-fast",
              isActive
                ? "bg-primary/15 text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
            )}
          >
            <MessageSquare className="h-3 w-3 shrink-0 text-[var(--icon-message)]" />
            <span className="min-w-0 flex-1 truncate text-left leading-none pt-[1px]">
              {task.title}
            </span>
            {/* v0.9.2 需求2 M3-4：任务状态灯——执行中呼吸蓝点/完成绿/失败红/取消灰。 */}
            {(() => {
              const running = task.run_status === "running";
              const dotCls =
                running
                  ? "bg-blue-500 animate-pulse"
                  : task.run_status === "completed"
                    ? "bg-emerald-500"
                    : task.run_status === "failed"
                      ? "bg-red-500"
                      : task.run_status === "cancelled"
                        ? "bg-muted-foreground/40"
                        : "";
              if (!dotCls) return null;
              return (
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotCls)}
                  title={task.run_status ?? undefined}
                />
              );
            })()}
            <span className="shrink-0 rounded-full bg-primary/10 px-1 py-0.5 text-[9px] font-medium leading-none text-primary">
              {phase}
            </span>
            {task.run_status === "running" && onCancelTask ? (
              <span
                role="button"
                tabIndex={0}
                title="取消执行"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancelTask(task);
                }}
                className="hidden shrink-0 items-center group-hover:flex"
              >
                <span className="flex h-4 w-4 items-center justify-center rounded text-red-400 hover:bg-red-500/10">
                  <span className="h-2 w-2 rounded-[2px] bg-current" />
                </span>
              </span>
            ) : null}
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onRenameTask(task)}>
          <Pencil className="h-3.5 w-3.5 mr-2" />
          {t("sessions.rename", "重命名")}
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => onDeleteTask(task)}
        >
          <X className="h-3.5 w-3.5 mr-2" />
          {t("tasks.deleteTask", "删除任务")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

// ── 主组件 ──

export function TaskSessionTree({
  onCancelTask,
  tasks,
  activeTaskId,
  onSelectTask,
  onRenameTask,
  onDeleteTask,
}: TaskSessionTreeProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  const handleSelectTask = useCallback(
    (task: TaskSessionTreeTask) => {
      onSelectTask(task);
    },
    [onSelectTask],
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex h-8 w-full items-center gap-2 border-y border-border/20 bg-[var(--color-layer-1)] px-3 text-[11px] font-medium text-muted-foreground"
      >
        <span className="pl-2">{t("sessions.taskConversations", "任务会话")}</span>
        <span className="tabular-nums">({tasks.length})</span>
        <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground">
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </span>
      </button>
      {!collapsed && (
        <>
          {tasks.length === 0 && (
            <div className="flex items-center gap-2 border-b border-border/10 py-3 pl-5 text-[11px] text-muted-foreground/50">
              <Network className="h-3 w-3" />
              <span>{t("sessions.noTasks", "暂无任务")}</span>
            </div>
          )}
          {tasks.map((task) => (
            <TaskRow
              key={task.task_id}
              task={task}
              isActive={activeTaskId === task.task_id}
              onSelectTask={handleSelectTask}
              onRenameTask={onRenameTask}
              onDeleteTask={onDeleteTask}
              onCancelTask={onCancelTask}
            />
          ))}
        </>
      )}
    </div>
  );
}
