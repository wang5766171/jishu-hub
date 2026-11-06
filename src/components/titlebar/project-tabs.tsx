import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pin, X } from "lucide-react";
import type { Project } from "@/types";
import { cn } from "@/lib/utils";
import type { ProjectTabsState, TabLight } from "./use-project-tabs";

/**
 * v0.9.6 需求4：标题栏项目标签（类浏览器 tab strip）+ 补充②③。
 *
 * - 当前项目标签：带操作按钮（关闭=回管理页）明显区分（用户裁决形态）。
 * - 固定标签（补充②）：切换离开的项目自动固定（回合结束不消失，手动解除
 *   前常驻）；会话状态灯——蓝=进行中 / 绿=完成 / 红=失败；点击直达该项目
 *   最近活跃会话；hover 显解除固定按钮。
 * - 顺序固定 + 拖拽（补充③，2026-11-03）：标签按 pins 顺序渲染（当前项目
 *   不强制首位——多标签场景位置不跳动；当前项目未固定时排末尾）；固定
 *   标签可按住拖拽调整位置（reorderPins 持久化）。
 * - 状态与数据由 useProjectTabs（父组件）供给；本组件纯渲染 + 拖拽交互。
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
  const dragEnc = useRef<string | null>(null);

  // ── 显示序（补充③）：pins 顺序为准（当前项目在其中按其固定位置渲染，
  // 未固定过的当前项目排末尾）——切换项目时标签位置不跳动。 ──
  const orderedEntries: {
    enc: string;
    project: Project | null;
    isCurrent: boolean;
    light?: TabLight;
    last?: { sessionId: string; agentId: string };
  }[] = tabs.pins.map(enc => {
    const isCurrent = enc === currentProject?.encoded_name;
    return {
      enc,
      project: projects?.find(p => p.encoded_name === enc) ?? (isCurrent ? currentProject : null),
      isCurrent,
      light: tabs.lights[enc],
      last: tabs.lastSession[enc],
    };
  });
  if (currentProject && !tabs.pins.includes(currentProject.encoded_name)) {
    orderedEntries.push({ enc: currentProject.encoded_name, project: currentProject, isCurrent: true });
  }
  const visible = orderedEntries.filter(e => e.project);

  if (visible.length === 0) return null;

  // 补充⑧修复（2026-11-04）：根不再 flex-1 占满——按内容宽度收缩，右侧
  // 剩余区域留给外层 drag 拖拽区（占满导致窗口无法拖动，用户实测 BUG）。
  return (
    <div
      className="flex h-full w-fit min-w-0 max-w-full items-end gap-0.5 overflow-x-auto pr-2"
      style={{ WebkitAppRegion: "no-drag", scrollbarWidth: "none" } as React.CSSProperties}
    >
      {visible.map(({ enc, project, isCurrent, light, last }) =>
        isCurrent ? (
          // ── 当前项目标签（带关闭操作；不可拖拽——不在 pins 序中） ──
          <div
            key={enc}
            className={cn(
              "group relative flex h-9 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-t-md border border-b-0 px-3",
              "bg-[var(--color-layer-1)] text-foreground",
            )}
            title={project!.path}
          >
            {/* 补充⑨：当前标签灯——蓝(呼吸)=本会话进行中；绿/红不会出现
                （正在查看不产生未读）；空闲无点占位保留（宽度不变）。 */}
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
            <span className="truncate text-xs font-medium">{project!.name}</span>
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
        ) : (
          // ── 固定标签（可拖拽重排；状态灯；hover 解除固定） ──
          <div
            key={enc}
            draggable
            onDragStart={e => {
              dragEnc.current = enc;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              e.preventDefault();
              if (dragEnc.current && dragEnc.current !== enc) {
                tabs.reorderPins(dragEnc.current, enc);
              }
              dragEnc.current = null;
            }}
            className={cn(
              "group relative flex h-8 max-w-44 min-w-0 shrink cursor-pointer items-center gap-1.5 self-end rounded-t-md px-3 text-xs transition-fast",
              light === "running"
                ? "bg-accent/30 text-foreground"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
            title={project!.path}
            onClick={() => {
              // 补充⑨：查看=已读——清该项目绿/红未读（running 蓝保留）。
              tabs.clearLight(enc);
              onSwitchToProject(project!, last?.sessionId ?? null, last?.agentId ?? null);
            }}
          >
            {/* 状态灯（补充⑨）：蓝(呼吸)=进行中 / 绿=完成未读 / 红=失败未读
                ——未读在查看（点击切换）后消失；空闲无点但占位保留（标签宽度
                不随有无点变化）。 */}
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
            <span className="truncate">{project!.name}</span>
            {/* 关闭标签=取消固定（用户裁决 2026-11-03：出现即默认固定，无需独立
                固定/解除按钮——关闭即取消；hover 显示，点击不冒泡到切换）。 */}
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                tabs.unpinProject(enc);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              title={t("titlebar.closeTab", "关闭标签")}
              aria-label={t("titlebar.closeTab", "关闭标签")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ),
      )}
      {/* 无当前项目（管理页）但存在固定标签时的视觉锚 */}
      {visible.some(e => !e.isCurrent) && !currentProject && (
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
