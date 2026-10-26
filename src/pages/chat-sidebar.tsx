/**
 * 会话左侧栏（v0.9.3 需求10 收官刀①，chat-page 拆解）：项目卡/新建/任务入口/
 * 搜索导航/任务树/常规会话列表（含右键菜单与流式/刷新态）整体组件化。
 * 内联业务（任务删除含孤儿图容错、非活跃任务取消、树回查实例）随组件走；
 * 页面经 props 注入数据与 handlers，交互语义零变化。
 */
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  FolderOpen,
  GitBranch,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PictureInPicture2,
  RotateCw,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import type { RefObject } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { streamStore } from "@/hooks/use-stream-store";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ActivitySpinner } from "@/components/ui/activity-spinner";
import { TaskSessionTree } from "@/features/task-workspace/sidebar/task-session-tree";
import { formatRelativeTime, TerminalIcon } from "./chat-page-utils";
import type { ConfirmDialogOptions } from "@/components/ui/confirm-dialog";
import type { Project, Session, SessionSearchResult } from "@/types";
import type { TaskLaunchInstanceSummary, TaskPhase } from "@/features/task-instance/types";

export interface ChatSidebarProps {
  currentProject: Project | null;
  projectDisplayName: string;
  projectId: string | null;
  projectPath: string | null;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  taskLaunchOpen: boolean;
  // 搜索
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  showMessageSearchControls: boolean;
  messageSearchLabel: string;
  messageSearchTotal: number;
  requestMessageSearchNavigation: (direction: 1 | -1) => void;
  searchResults: SessionSearchResult[];
  // 会话列表
  displaySessions: Session[];
  sessionNames: Record<string, string> | null;
  selectedSession: string | null;
  streamingSessionIds: readonly string[];
  refreshingSessionId: string | null;
  regularSessionsOpen: boolean;
  setRegularSessionsOpen: (fn: (open: boolean) => boolean) => void;
  canForkSession: boolean;
  canDeleteSession: boolean;
  forking: boolean;
  // 任务区
  displayTaskLaunchSessions: TaskLaunchInstanceSummary[];
  activeTaskInstanceId: string | null;
  activeTaskInstanceIdRef: RefObject<string | null>;
  findTaskInstance: (taskId: string) => TaskLaunchInstanceSummary | null;
  openTaskPhaseWorkspace: (task: TaskLaunchInstanceSummary, phase: TaskPhase, readOnly?: boolean) => void;
  handleTaskCancelRun: () => void;
  setTaskLaunchSessions: (fn: (current: TaskLaunchInstanceSummary[]) => TaskLaunchInstanceSummary[]) => void;
  confirmDialog: (options: ConfirmDialogOptions) => Promise<boolean>;
  // 动作
  handleNewSession: () => void;
  handleRefresh: () => void | Promise<void>;
  handleOpenTaskConversation: () => void;
  handleSelectSession: (sessionId: string) => void;
  handleFloatSession: (sessionId: string) => void;
  handleResumeSession: (sessionId: string) => void | Promise<void>;
  handleForkSession: (sessionId: string) => void | Promise<void>;
  handleDeleteSession: (sessionId: string) => void | Promise<void>;
  handleRefreshSession: (sessionId: string) => void | Promise<void>;
  setRenameOpen: (v: boolean) => void;
  setRenameTaskTarget: (task: TaskLaunchInstanceSummary | null) => void;
}

export function ChatSidebar(props: ChatSidebarProps) {
  const {
    currentProject,
    projectDisplayName,
    projectId,
    projectPath,
    sidebarCollapsed,
    setSidebarCollapsed,
    taskLaunchOpen,
    searchQuery,
    setSearchQuery,
    showMessageSearchControls,
    messageSearchLabel,
    messageSearchTotal,
    requestMessageSearchNavigation,
    searchResults,
    displaySessions,
    sessionNames,
    selectedSession,
    streamingSessionIds,
    refreshingSessionId,
    regularSessionsOpen,
    setRegularSessionsOpen,
    canForkSession,
    canDeleteSession,
    forking,
    displayTaskLaunchSessions,
    activeTaskInstanceId,
    activeTaskInstanceIdRef,
    findTaskInstance,
    openTaskPhaseWorkspace,
    handleTaskCancelRun,
    setTaskLaunchSessions,
    confirmDialog,
    handleNewSession,
    handleRefresh,
    handleOpenTaskConversation,
    handleSelectSession,
    handleFloatSession,
    handleResumeSession,
    handleForkSession,
    handleDeleteSession,
    handleRefreshSession,
    setRenameOpen,
    setRenameTaskTarget,
  } = props;
  const { t } = useTranslation();
  return (
    <>
      {/* Left sidebar */}
      <div
        className={cn(
          "chat-sidebar flex flex-col shrink-0",
          sidebarCollapsed ? "w-14" : "w-60"
        )}
      >
        {/* Expanded sidebar */}
        <div className={cn("flex flex-col", sidebarCollapsed && "hidden")} style={{ background: "var(--color-layer-1)" }}>
          {/* Project card */}
          {/* v0.7.3 需求2：项目切换移至输入区 footer（目录旁左右箭头），左上角仅展示项目名 */}
          <div className="flex items-center gap-2 px-3 h-10 border-b border-border/20">
            <FolderOpen className={cn("h-5 w-5 shrink-0 ml-1", currentProject ? "text-[var(--icon-folder)]" : "text-muted-foreground/40")} />
            <span className={cn("truncate text-sm font-semibold flex-1 min-w-0 leading-none pt-[1px]", currentProject ? "text-foreground" : "text-muted-foreground")} title={currentProject ? projectDisplayName : undefined}>
              {currentProject ? projectDisplayName : t("sessions.noProject")}
            </span>
          </div>
          {/* Actions */}
          <div className="flex items-center gap-1.5 px-3 h-11 pt-2 pb-1">
            <button
              onClick={projectId ? handleNewSession : undefined}
              title={projectId ? t("sessions.newSession") : t("sessions.selectProject")}
              className={cn(
                "flex-1 flex items-center gap-2.5 h-8 pl-2 pr-2 rounded-lg transition-fast text-sm text-foreground",
                projectId ? "hover:bg-accent" : "opacity-40 cursor-not-allowed"
              )}
            >
              <SquarePen className="h-3.5 w-3.5 shrink-0 text-[var(--icon-action)]" />
              <span className="truncate leading-none pt-[1px]">{t("sessions.startNewChat")}</span>
            </button>
            <button
              onClick={handleRefresh}
              title={t("sessions.refresh")}
              className="shrink-0 h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent/50 transition-fast text-muted-foreground hover:text-foreground"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="shrink-0 h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent/50 transition-fast text-muted-foreground hover:text-foreground"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="px-3 pb-2">
            <button
              onClick={projectId ? () => handleOpenTaskConversation() : undefined}
              title={projectId ? t("tasks.startTask") : t("sessions.selectProject")}
              className={cn(
                "flex h-8 w-full items-center gap-2.5 rounded-lg pl-2 pr-2 text-sm text-foreground transition-fast",
                projectId ? taskLaunchOpen ? "bg-primary/10 font-medium" : "hover:bg-accent" : "opacity-40 cursor-not-allowed"
              )}
            >
              <ClipboardList className="h-3.5 w-3.5 shrink-0 text-[var(--icon-action)]" />
              <span className="truncate leading-none pt-[1px]">{t("tasks.startTask")}</span>
            </button>
          </div>
          {/* Search */}
          <div className="px-3 h-10 pb-2">
            <div className="relative h-8">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--icon-search)]" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("sessions.searchAll")}
                className="h-full pl-8 pr-7 !text-sm !leading-none shadow-none rounded-lg border-border/40 truncate"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(""); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-fast"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              {showMessageSearchControls && (
                <div className="absolute left-[calc(100%+0.42rem)] top-1/2 z-30 flex h-[2.55rem] -translate-y-1/2 overflow-hidden rounded-[12px] border border-border/50 bg-background/95 shadow-[0_0.45rem_1.25rem_rgba(0,0,0,0.16)] backdrop-blur">
                  <span className="flex min-w-[2.85rem] items-center justify-center px-[0.65rem] text-[0.7rem] font-medium tabular-nums text-muted-foreground leading-none">
                    {messageSearchLabel}
                  </span>
                  <div className="flex h-full w-[1.55rem] flex-col border-l border-border/40">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={messageSearchTotal === 0}
                      onClick={() => requestMessageSearchNavigation(-1)}
                      title={t("sessions.previousMatch")}
                      className="h-1/2 w-full rounded-none px-0 hover:bg-accent/70 disabled:opacity-30"
                    >
                      <ChevronUp className="size-[0.85rem]" strokeWidth={3} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={messageSearchTotal === 0}
                      onClick={() => requestMessageSearchNavigation(1)}
                      title={t("sessions.nextMatch")}
                      className="h-1/2 w-full rounded-none border-t border-border/30 px-0 hover:bg-accent/70 disabled:opacity-30"
                    >
                      <ChevronDown className="size-[0.85rem]" strokeWidth={3} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Collapsed sidebar header */}
        <div className={cn("flex flex-col", !sidebarCollapsed && "hidden")} style={{ background: "var(--color-layer-1)" }}>
          {/* Row 1: Project icon */}
          <div className="flex items-center justify-center h-10 border-b border-border/20" title={currentProject?.name ?? t("sessions.noProject")}>
            <FolderOpen className={cn("h-4 w-4", currentProject ? "text-[var(--icon-folder)]" : "text-muted-foreground/40")} />
          </div>
          {/* Row 2: Expand button */}
          <div className="flex items-center justify-center h-11 pt-2 pb-1">
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent/50 transition-fast text-muted-foreground hover:text-foreground"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </div>
          {/* Row 3: New chat */}
          <div className="flex items-center justify-center h-10 pb-2">
            <button
              onClick={projectId ? handleNewSession : undefined}
              title={projectId ? t("sessions.newSession") : t("sessions.selectProject")}
              className={cn(
                "h-8 w-8 flex items-center justify-center rounded-lg transition-fast",
                projectId ? "hover:bg-accent" : "opacity-40 cursor-not-allowed"
              )}
            >
              <SquarePen className="h-4 w-4 text-[var(--icon-action)]" />
            </button>
          </div>
          <div className="flex items-center justify-center h-10 pb-2">
            <button
              onClick={projectId ? () => handleOpenTaskConversation() : undefined}
              title={projectId ? t("tasks.startTask") : t("sessions.selectProject")}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition-fast",
                projectId ? taskLaunchOpen ? "bg-primary/10" : "hover:bg-accent" : "opacity-40 cursor-not-allowed"
              )}
            >
              <ClipboardList className="h-4 w-4 text-[var(--icon-action)]" />
            </button>
          </div>
        </div>

        {/* Session list: expanded */}
        <div className={cn("flex-1 overflow-y-auto", sidebarCollapsed && "hidden")}>
          {/* v0.9.2 需求6：任务区置于常规会话区之上——conductor 主会话被归入任务
              树后不再"沉底"（任务是有"当前进行时"语义的，会话是历史沉淀）。 */}
          <TaskSessionTree
            tasks={displayTaskLaunchSessions}
            activeTaskId={activeTaskInstanceId}
            onSelectTask={(task) => {
              // 树的 TaskSessionTreeTask 是 TaskLaunchInstanceSummary 的结构子集，
              // 回传时按 task_id 反查完整实例（openTaskPhaseWorkspace 需要 project_root 等字段）。
              const instance = findTaskInstance(task.task_id);
              if (!instance) return;
              const phase: TaskPhase =
                instance.current_phase === "planning"
                  ? "planning"
                  : instance.current_phase === "execution" || instance.current_phase === "graph"
                    ? "execution"
                    : "requirements";
              openTaskPhaseWorkspace(instance, phase);
            }}
            onRenameTask={(task) => setRenameTaskTarget(findTaskInstance(task.task_id))}
            onCancelTask={(task) => {
              // v0.9.2 需求2 M3-4：任务行悬停取消——活跃任务走全景取消（含确认），
              // 非活跃任务按 run_id 直发取消命令。
              if (task.task_id === activeTaskInstanceIdRef.current) {
                handleTaskCancelRun();
              } else if (task.active_run_id) {
                void invokeCommand("orchestrator_cancel_run", { runId: task.active_run_id })
                  .catch((e) => console.warn("cancel run failed:", e));
              }
            }}
            onDeleteTask={async (task) => {
              if (!projectPath) return;
              const confirmed = await confirmDialog({
                title: t("tasks.deleteTask"),
                description: t("tasks.deleteTaskConfirm", { title: task.title }),
                variant: "destructive",
              });
              if (!confirmed) return;
              // v0.9.2 测试期修复：孤儿任务容错——全量重装后 orchestrator.db 被清但项目
              // 侧 TaskInstance 残留（graph_id 引用已不存在的图），orchestrator_delete_graph
              // 会报 NotFound 阻断后续 task_launch_delete_task → 孤儿永远删不掉。
              // 图删除失败不阻断任务实例删除（幂等：图不存在 = 无需清理）。
              if (task.graph_id) {
                try {
                  await invokeCommand("orchestrator_delete_graph", { graphId: task.graph_id });
                } catch {
                  // orphan graph——orchestrator 数据已清，跳过即可
                }
              }
              await invokeCommand("task_launch_delete_task", {
                projectRoot: projectPath,
                taskId: task.task_id,
              });
              setTaskLaunchSessions((current) => current.filter((item) => item.task_id !== task.task_id));
            }}
          />
          <button
            type="button"
            onClick={() => setRegularSessionsOpen((open) => !open)}
            className="flex h-8 w-full items-center gap-2 border-y border-border/20 bg-[var(--color-layer-1)] px-3 text-[11px] font-medium text-muted-foreground"
          >
            <span className="pl-2">{t("sessions.regularConversations")}</span>
            <span className="tabular-nums">({displaySessions.length})</span>
            <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground">
              {regularSessionsOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </span>
          </button>
          {regularSessionsOpen && displaySessions.map((session) => {
            const isActive = session.id === selectedSession;
            const name = sessionNames?.[session.id] || session.display_name || session.id.slice(0, 8);
            const timeStr = session.last_active
              ? formatRelativeTime(session.last_active, t)
              : session.started_at
                ? formatRelativeTime(session.started_at, t)
                : null;
            const searchHit = searchResults.find((r: SessionSearchResult) => r.sessionId === session.id);
            // v0.8.0 需求5：该会话刷新中（右键/头部刷新）——行图标转圈 + 高亮，
            // 让「点击过了」在非选中会话上同样可感知。
            const rowRefreshing = refreshingSessionId === session.id;
            // v0.8.0 需求6：该会话正在流式输出（含后台输出）——行图标换为
            // 加载中动效，无需选中即可从列表分辨哪些会话仍在生成。
            const rowStreaming = streamingSessionIds.includes(session.id);
            return (
              <ContextMenu key={session.id}>
                <ContextMenuTrigger asChild>
                  <button
                    onClick={() => handleSelectSession(session.id)}
                    className={cn(
                      "flex flex-col w-full items-start pl-5 pr-2 py-2 text-xs transition-fast border-b border-border/10",
                      isActive
                        ? "bg-primary/10 text-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                      rowRefreshing && "bg-primary/15",
                    )}
                  >
                    <div className="flex items-center gap-3 w-full">
                      {rowRefreshing ? (
                        <RotateCw className="h-3 w-3 shrink-0 animate-spin text-[var(--icon-action)]" />
                      ) : rowStreaming ? (
                        <ActivitySpinner className="h-3.5 w-3.5 text-[var(--icon-action)]" />
                      ) : (
                        <MessageSquare className="h-3 w-3 shrink-0 text-[var(--icon-message)]" />
                      )}
                      <span className="truncate flex-1 text-left min-w-0 leading-none pt-[1px]">{name}</span>
                      {searchHit ? (
                        <span className="shrink-0 rounded-full bg-primary/20 text-primary px-1.5 py-0.5 text-[9px] font-medium leading-none">
                          {searchHit.matchCount}
                        </span>
                      ) : timeStr ? (
                        <span className={cn(
                          "text-[0.65em] shrink-0 tabular-nums",
                          isActive ? "text-accent-foreground/40" : "text-muted-foreground/40"
                        )}>{timeStr}</span>
                      ) : null}
                    </div>
                    {searchHit && searchHit.previewText && (
                      <div className="mt-1.5 pl-6 w-full text-left">
                        <p className="text-[10px] text-muted-foreground/70 line-clamp-2 leading-tight break-all">
                          {searchHit.previewText}
                        </p>
                      </div>
                    )}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => handleFloatSession(session.id)}>
                    <PictureInPicture2 className="h-3.5 w-3.5 mr-2" />
                    {t("sessions.float", "悬浮窗口")}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleResumeSession(session.id)}>
                    <TerminalIcon className="h-3.5 w-3.5 mr-2" />
                    {t("sessions.openTerminal")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => { handleSelectSession(session.id); setRenameOpen(true); }}>
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    {t("sessions.rename")}
                  </ContextMenuItem>
                  {canForkSession && (
                    <ContextMenuItem
                      disabled={forking || streamStore.isStreaming(session.id)}
                      onClick={() => void handleForkSession(session.id)}
                    >
                      <GitBranch className="h-3.5 w-3.5 mr-2" />
                      {t("sessions.fork", "创建分支")}
                    </ContextMenuItem>
                  )}
                  {canDeleteSession && (
                    <ContextMenuItem onClick={() => void handleDeleteSession(session.id)}>
                      <Trash2 className="h-3.5 w-3.5 mr-2 text-red-400" />
                      {t("sessions.delete")}
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    disabled={streamStore.hasState(session.id) || refreshingSessionId === session.id}
                    onClick={() => void handleRefreshSession(session.id)}
                  >
                    <RotateCw className={cn("h-3.5 w-3.5 mr-2", refreshingSessionId === session.id && "animate-spin")} />
                    {t("sessions.refreshSession", "刷新会话")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>

        {/* Collapsed: empty body */}
        <div className={cn("flex-1", !sidebarCollapsed && "hidden")} />
      </div>
    </>
  );
}
