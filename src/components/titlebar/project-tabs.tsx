import { useTranslation } from "react-i18next";
import { Pin, PinOff, X } from "lucide-react";
import type { Project } from "@/types";
import { cn } from "@/lib/utils";
import type { ProjectTabsState, TabLight } from "./use-project-tabs";

/**
 * v0.9.6 需求4：标题栏项目标签（类浏览器 tab strip）+ 补充②固定标签。
 *
 * - 当前项目标签：带操作按钮（关闭=回管理页）明显区分（用户裁决形态）。
 * - 固定标签（补充②，2026-11-03）：切换离开的项目自动固定（回合结束不
 *   消失，手动解除前常驻——修「任务回复完标签就关闭了还没看到结果」）；
 *   带会话状态灯——蓝=进行中 / 绿=完成 / 红=失败；点击直达该项目最近
 *   活跃会话；hover 显解除固定按钮。
 * - 状态与数据由 useProjectTabs（父组件）供给；本组件纯渲染。
 */

export interface ProjectTabsProps {
  currentProject: Project | null;
  projects: Project[] | null;
  tabs: ProjectTabsState;
  /** 切到目标项目的指定会话（agentId 对齐该会话所属智能体）。 */
  onSwitchToProject: (project: Project, sessionId: string | null, agentId: string | null) => void;
  /** 关闭当前项目标签（回管理页，复用既有切换流程）。 */
  onCloseCurrentProject: () => void;
}

const LIGHT_CLASS: Record<TabLight, string> = {
  running: "bg-blue-500",
  done: "bg-emerald-500",
  failed: "bg-red-500",
};

export function ProjectTabs({
  currentProject,
  projects,
  tabs,
  onSwitchToProject,
  onCloseCurrentProject,
}: ProjectTabsProps) {
  const { t } = useTranslation();

  // 固定标签 = pins 中排除当前项目、且项目列表可查（过滤已删除项目）
  const pinnedTabs = tabs.pins
    .filter(enc => enc !== currentProject?.encoded_name)
    .map(enc => {
      const project = projects?.find(p => p.encoded_name === enc);
      return project ? { project, light: tabs.lights[enc], last: tabs.lastSession[enc] } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (!currentProject && pinnedTabs.length === 0) return null;

  return (
    <div
      className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pr-2"
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
      {pinnedTabs.map(({ project, light, last }) => (
        <div
          key={project.encoded_name}
          className={cn(
            "group relative flex h-8 max-w-44 min-w-0 shrink cursor-pointer items-center gap-1.5 self-end rounded-t-md px-3 text-xs transition-fast",
            light === "running"
              ? "bg-accent/30 text-foreground"
              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
          )}
          title={project.path}
          onClick={() => {
            tabs.clearLight(project.encoded_name);
            onSwitchToProject(project, last?.sessionId ?? null, last?.agentId ?? null);
          }}
        >
          {/* 会话状态灯：蓝=进行中 / 绿=完成 / 红=失败（无灯=空闲） */}
          <span className="flex h-2 w-2 shrink-0 items-center justify-center">
            {light && (
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  LIGHT_CLASS[light],
                  light === "running" && "animate-pulse",
                )}
              />
            )}
          </span>
          <span className="truncate">{project.name}</span>
          {/* 解除固定（hover 显示；点击不冒泡到切换） */}
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              tabs.unpinProject(project.encoded_name);
            }}
            className="hidden h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground group-hover:flex hover:bg-accent hover:text-foreground"
            title={t("titlebar.unpinProject", "解除固定")}
            aria-label={t("titlebar.unpinProject", "解除固定")}
          >
            <PinOff className="h-3 w-3" />
          </button>
        </div>
      ))}
      {/* 无当前项目（管理页）但存在固定标签时的视觉锚 */}
      {pinnedTabs.length > 0 && !currentProject && (
        <div
          className="flex items-center gap-1 self-center pl-1 text-muted-foreground/60"
          title={t("titlebar.pinnedHint", "已固定的项目")}
        >
          <Pin className="h-3 w-3" />
        </div>
      )}
    </div>
  );
}
