import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { invokeCommand } from "@/hooks/use-invoke";
import { useTranslation } from "react-i18next";
import type { Project } from "@/types";
import { cn } from "@/lib/utils";

/**
 * v0.9.6 需求4：标题栏项目标签（类浏览器 tab strip）。
 *
 * 产品定位（用户裁决）：工作区单项目专注——会话列表只展示当前项目；多项目
 * 并行操作经标题栏标签兼顾：**当前项目标签带操作按钮（关闭）明显区分，
 * 其他「正在对话中」的项目仅标签名+状态标识（无操作按钮），点击直达该项目
 * 的活跃会话**（不经管理页中转，ChatPage 不卸载、事件管线持续存活）。
 *
 * 数据源（后端权威）：`chat_active_sessions` 轮询（3s + 窗口聚焦即拉）——
 * 进程表 turn_active 条目含 project_encoded 归属，覆盖事件管线不在场
 * （管理页）期间启动/结束的回合。实时脉冲来自轮询粒度，回合完成的即时
 * 信号提示列后续迭代。
 */

interface ActiveChatSession {
  sessionId: string;
  agentId: string;
  projectEncoded: string;
}

export interface ProjectTabsProps {
  currentProject: Project | null;
  projects: Project[] | null;
  /** 切到目标项目的指定会话（agentId 对齐该会话所属智能体）。 */
  onSwitchToProject: (project: Project, sessionId: string | null, agentId: string | null) => void;
  /** 关闭当前项目标签（回管理页，复用既有切换流程）。 */
  onCloseCurrentProject: () => void;
  disabled?: boolean;
}

const POLL_INTERVAL_MS = 3000;

export function ProjectTabs({
  currentProject,
  projects,
  onSwitchToProject,
  onCloseCurrentProject,
  disabled,
}: ProjectTabsProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<ActiveChatSession[]>([]);

  // 轮询活跃回合（disabled 时不拉——启动 loading 期等）
  useEffect(() => {
    if (disabled) return;
    let stopped = false;
    const poll = async () => {
      try {
        const rows = await invokeCommand<ActiveChatSession[]>("chat_active_sessions");
        if (!stopped) setActive(Array.isArray(rows) ? rows : []);
      } catch {
        /* 单次失败静默（下次轮询重试） */
      }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [disabled]);

  // 按项目聚合（过滤当前项目与未知项目；同项目多活跃会话取最后一条定位）
  const otherActiveProjects = useMemo(() => {
    const byProject = new Map<string, ActiveChatSession>();
    for (const row of active) {
      if (currentProject && row.projectEncoded === currentProject.encoded_name) continue;
      byProject.set(row.projectEncoded, row);
    }
    const out: { project: Project; sessionId: string; agentId: string }[] = [];
    for (const [encoded, row] of byProject) {
      const project = projects?.find(p => p.encoded_name === encoded);
      if (project) out.push({ project, sessionId: row.sessionId, agentId: row.agentId });
    }
    return out;
  }, [active, currentProject, projects]);

  const handleSwitch = useCallback(
    (entry: { project: Project; sessionId: string; agentId: string }) => {
      onSwitchToProject(entry.project, entry.sessionId, entry.agentId);
    },
    [onSwitchToProject],
  );

  // 无当前项目且无其他活跃项目：整条不渲染（保持单项目专注的默认观感）
  if (!currentProject && otherActiveProjects.length === 0) return null;

  return (
    <div
      className="flex h-full min-w-0 items-end gap-0.5 overflow-x-auto pb-0 pr-2"
      style={{ WebkitAppRegion: "no-drag", scrollbarWidth: "none" } as React.CSSProperties}
    >
      {currentProject && (
        <div
          className={cn(
            "group relative flex h-9 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-t-md border border-b-0 px-3",
            "bg-[var(--color-layer-1)] text-foreground",
          )}
          title={currentProject.path}
        >
          <span className="truncate text-xs font-medium">{currentProject.name}</span>
          <button
            type="button"
            onClick={onCloseCurrentProject}
            className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-60 transition-fast hover:bg-accent hover:opacity-100"
            title={t("titlebar.closeProject", "关闭当前项目")}
            aria-label={t("titlebar.closeProject", "关闭当前项目")}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {otherActiveProjects.map(({ project, sessionId, agentId }) => (
        <button
          key={project.encoded_name}
          type="button"
          onClick={() => handleSwitch({ project, sessionId, agentId })}
          className={cn(
            "flex h-8 max-w-44 min-w-0 shrink items-center gap-1.5 self-end rounded-t-md px-3 text-xs transition-fast",
            "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
          )}
          title={t("titlebar.switchToProject", "切换到该项目", { name: project.name })}
        >
          <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
            <span className="absolute h-2 w-2 animate-ping rounded-full bg-emerald-500/60" />
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          <span className="truncate">{project.name}</span>
        </button>
      ))}
    </div>
  );
}
