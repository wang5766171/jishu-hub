/**
 * TaskSessionTree —— 侧边栏任务列表。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §6（需求四 · 会话复用与二级结构）。
 *
 * 结构（2026-09-11 用户裁决：三级收敛为二级）：
 *   常规会话（由 chat-page 渲染，不在本组件）
 *   ─────────────
 *   任务会话
 *     ├─ 任务 A（行首会话状态点 + 标题）
 *     └─ 任务 B
 *
 * 2026-11-27 用户裁决：会话列表不显示流程运行结果标记（completed 一类）——
 * 行首会话状态点是会话执行情况的唯一状态信号；流程结果在看板里看。
 *
 * 交互：
 * - 点任务 → 进入任务工作台（阶段会话）；子任务会话**不再在本列表展示**，
 *   统一经会话区能力中心「任务看板」（session.task-board 插件）钻入查看——看板
 *   有实时状态与当前选中高亮，信息密度与反馈都优于静态树节点行。
 * - 任务行右键 → 重命名 / 删除（沿用现有 ContextMenu）
 * - 任务行悬停（运行中）→ 取消执行
 *
 * 数据来源：任务列表由 chat-page 传入（task_launch_list_sessions）。
 */
import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Pencil, X, Network } from "lucide-react";
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
  task_session_id?: string | null;
  graph_id?: string | null;
  active_run_id?: string | null;
  last_run_id?: string | null;
  run_status?: string | null;
  /** runner（无图）任务的步骤清单（结构随实例透传；G 二修后行灯不再消费，
   * 保留字段供看板等消费方）。 */
  stages_json?: string | null;
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
  /** 需2-G 二修（2026-11-11 用户裁决）：行首状态点=会话回合状态（与普通
   * 会话一致）——流式中（streaming）蓝呼吸 / 未读完成（done/failed）绿红 /
   * 空闲占位；任务步骤态不再用作行灯。 */
  isSessionStreaming?: (sessionId: string) => boolean;
  sessionUnreadOf?: (sessionId: string) => "done" | "failed" | undefined;
}

// ── 单个任务行 ──

interface TaskRowProps {
  /** v0.9.2 需求2 M3-4：运行中任务的悬停取消（由页面承担）。 */
  onCancelTask?: (task: TaskSessionTreeTask) => void;
  task: TaskSessionTreeTask;
  isActive: boolean;
  onSelectTask: (task: TaskSessionTreeTask) => void;
  onRenameTask: (task: TaskSessionTreeTask) => void;
  onDeleteTask: (task: TaskSessionTreeTask) => void;
  isSessionStreaming?: (sessionId: string) => boolean;
  sessionUnreadOf?: (sessionId: string) => "done" | "failed" | undefined;
}


const TaskRow = memo(function TaskRow({
  task,
  isActive,
  onSelectTask,
  onRenameTask,
  onDeleteTask,
  onCancelTask,
  isSessionStreaming,
  sessionUnreadOf,
}: TaskRowProps) {
  const { t } = useTranslation();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <button
            type="button"
            // 行上带任务号与任务会话号：自动化用例按它找到确定的一行（标题会重复——都叫「新任务」时
            // 按标题找会点开别的任务）
            data-task-id={task.task_id}
            data-task-session={task.task_session_id ?? undefined}
            onClick={() => onSelectTask(task)}
            className={cn(
              // 与常规会话项对齐：pl-5(1.25rem) + gap-3，图标 h-3 w-3，避免整体右移。
              "group flex w-full items-center gap-3 border-b border-border/10 py-2 pl-5 pr-2 text-xs transition-fast",
              isActive
                ? "bg-primary/15 text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
            )}
          >
            {/* 补充⑪（2026-11-06 用户裁决）：去掉气泡图标——固定占位与常规
                会话行一致（状态灯更突出、行宽不跳、对齐不变）。
                需2-G 二修（2026-11-11 用户裁决）：行首状态点=**会话回合状态**
                （与普通会话完全一致）——流式中蓝呼吸 / 未读完成绿 / 未读失败红
                / 空闲占位；任务步骤态（stages/run_status 派生）不再用作行灯。 */}
            {(() => {
              const sid = task.task_session_id ?? null;
              const streaming = sid ? (isSessionStreaming?.(sid) ?? false) : false;
              const unread = sid && !isActive ? sessionUnreadOf?.(sid) : undefined;
              if (streaming) {
                return (
                  <span className="flex h-3.5 w-3 shrink-0 items-center justify-center">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                  </span>
                );
              }
              if (unread) {
                return (
                  // 评审 P1-11 修复：状态点悬停文案直出中文改 t()。
                  <span
                    className="flex h-3.5 w-3 shrink-0 items-center justify-center"
                    title={unread === "failed" ? t("sessions.taskUnreadFailed", "有失败结果未读") : t("sessions.taskUnreadDone", "有完成结果未读")}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", unread === "failed" ? "bg-red-500" : "bg-emerald-500")} />
                  </span>
                );
              }
              return <span className="flex h-3.5 w-3 shrink-0 items-center justify-center" />;
            })()}
            {/* v0.9.8 需求23 补充轮：pb-[2px] 是字底余量（行高等于字号 + 超出隐藏会裁掉字的下沿），
                与会话侧栏标题同一写法，说明见 chat-sidebar.tsx 的会话标题处 */}
            <span className="min-w-0 flex-1 truncate text-left leading-none pt-[1px] pb-[2px]">
              {task.title}
            </span>
            {task.run_status === "running" && onCancelTask ? (
              <span
                role="button"
                tabIndex={0}
                title={t("sessions.cancelTaskRun", "取消执行")}
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
  isSessionStreaming,
  sessionUnreadOf,
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
              isSessionStreaming={isSessionStreaming}
              sessionUnreadOf={sessionUnreadOf}
            />
          ))}
        </>
      )}
    </div>
  );
}
