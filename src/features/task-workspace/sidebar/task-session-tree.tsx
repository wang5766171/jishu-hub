/**
 * TaskSessionTree —— 侧边栏会话二级树。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §6（需求四 · 会话复用与二级结构）。
 *
 * 结构：
 *   常规会话（由 chat-page 渲染，不在本组件）
 *   ─────────────
 *   任务会话
 *     ├─ 任务 A（标题 + 阶段徽标）
 *     │   ├─ 节点 1（状态图标 + 标题 + agent）
 *     │   └─ 节点 2
 *     └─ 任务 B
 *
 * 交互：
 * - 点任务 → 进入任务主会话（target=main）
 * - 点节点 → 进入节点会话（target=node）
 * - 任务行右键 → 重命名 / 删除（沿用现有 ContextMenu）
 * - 任务行左侧箭头展开/折叠节点列表
 *
 * 数据来源：
 * - 任务列表：由 chat-page 传入（task_launch_list_sessions）
 * - 节点会话：内部调 orchestrator_list_node_sessions（T0 后端已就绪）
 */
import { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, MessageSquare, Pencil, X, Network } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import type { NodeSessionSummary } from "../types";
import { StepStatusIcon } from "../steps/step-status-icon";
import { useTaskNodeSessions } from "./use-task-node-sessions";

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
  tasks: TaskSessionTreeTask[];
  /** 当前激活的任务 ID（高亮） */
  activeTaskId: string | null;
  /** 当前激活的节点 ID（高亮） */
  activeNodeId: string | null;
  /** 活跃任务的真节点标题（来自 taskGraph.snapshot，覆盖 titleMap 回退）。 */
  titleByNodeId?: Record<string, string>;
  /** 点击任务行 */
  onSelectTask: (task: TaskSessionTreeTask) => void;
  /** 点击节点行 */
  onSelectNode: (task: TaskSessionTreeTask, node: NodeSessionSummary) => void;
  /** 重命名（右键菜单） */
  onRenameTask: (task: TaskSessionTreeTask) => void;
  /** 删除（右键菜单） */
  onDeleteTask: (task: TaskSessionTreeTask) => void;
}

// ── 单个任务行（含节点子列表） ──

interface TaskRowProps {
  task: TaskSessionTreeTask;
  isActive: boolean;
  activeNodeId: string | null;
  nodes: NodeSessionSummary[];
  /** 活跃任务的真标题（来自 taskGraph.snapshot，与右侧步骤栏同源，最可信）。 */
  titleByNodeId: Record<string, string>;
  /** 其他任务的回退标题（按 revision 取的占位标题，可能不准）。 */
  titleMap: Record<string, string>;
  agentNames: Record<string, string>;
  onSelectTask: (task: TaskSessionTreeTask) => void;
  onSelectNode: (task: TaskSessionTreeTask, node: NodeSessionSummary) => void;
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
  activeNodeId,
  nodes,
  titleByNodeId,
  titleMap,
  agentNames,
  onSelectTask,
  onSelectNode,
  onRenameTask,
  onDeleteTask,
}: TaskRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(isActive);

  // 激活时自动展开
  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  const hasNodes = nodes.length > 0;
  const phase = phaseLabel[task.current_phase] ?? task.current_phase;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <button
            type="button"
            onClick={() => onSelectTask(task)}
            className={cn(
              "group flex w-full items-center gap-1.5 border-b border-border/10 py-2 pl-2.5 pr-2 text-xs transition-fast",
              isActive
                ? "bg-primary/15 text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
            )}
          >
            <span className="h-5 w-5 shrink-0" />
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[var(--icon-message)]" />
            <span className="min-w-0 flex-1 truncate text-left leading-none">
              {task.title}
            </span>
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
              {phase}
            </span>
            {/* 展开/折叠箭头（移到标题右侧，仅有节点时显示） */}
            {hasNodes ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((v) => !v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    setExpanded((v) => !v);
                  }
                }}
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              >
                {expanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </span>
            ) : (
              <span className="h-5 w-5 shrink-0" />
            )}
          </button>

          {/* 节点子列表 */}
          {expanded && hasNodes && (
            <div className="border-b border-border/10 bg-[var(--color-layer-1)]/30">
              {nodes.map((node) => {
                const title =
                  titleByNodeId[node.node_id] ??
                  node.title ??
                  titleMap[node.node_id] ??
                  node.node_id;
                const isNodeActive = activeNodeId === node.node_id;
                const agentName = node.agent_id ? agentNames[node.agent_id] : null;
                return (
                  <button
                    key={node.node_run_id}
                    type="button"
                    onClick={(e) => {
                      // 阻止冒泡到任务行按钮 / ContextMenuTrigger 包裹层，
                      // 确保只触发节点选中，不触发任务选中
                      //（v0.7.0 需求二-问题2）。
                      e.stopPropagation();
                      onSelectNode(task, node);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 py-1.5 pl-9 pr-2 text-[11px] transition-fast",
                      isNodeActive
                        ? "bg-primary/5 font-medium text-foreground"
                        : "text-muted-foreground/80 hover:bg-accent/30 hover:text-foreground",
                    )}
                  >
                    <StepStatusIcon status={node.status as never} />
                    <span className="min-w-0 flex-1 truncate text-left">{title}</span>
                    {agentName && (
                      <span className="shrink-0 truncate text-[9px] text-muted-foreground/60">
                        {agentName}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

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
  tasks,
  activeTaskId,
  activeNodeId,
  titleByNodeId,
  onSelectTask,
  onSelectNode,
  onRenameTask,
  onDeleteTask,
}: TaskSessionTreeProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  const { sessionsByTask, titleMapsByTask } = useTaskNodeSessions({
    tasks,
    pollInterval: 5000,
  });

  // agent 名称映射（从父传入更合适，但树组件自己处理也可）
  // 这里暂用空 map——agent 显示名由步骤栏覆盖，树内显示 agent_id 短名即可

  const handleSelectNode = useCallback(
    (task: TaskSessionTreeTask, node: NodeSessionSummary) => {
      onSelectNode(task, node);
    },
    [onSelectNode],
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
              activeNodeId={activeTaskId === task.task_id ? activeNodeId : null}
              nodes={sessionsByTask.get(task.task_id) ?? []}
              titleByNodeId={titleByNodeId ?? {}}
              titleMap={titleMapsByTask.get(task.task_id) ?? {}}
              agentNames={{}}
              onSelectTask={onSelectTask}
              onSelectNode={handleSelectNode}
              onRenameTask={onRenameTask}
              onDeleteTask={onDeleteTask}
            />
          ))}
        </>
      )}
    </div>
  );
}
