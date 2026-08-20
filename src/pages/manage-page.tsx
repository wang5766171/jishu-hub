import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { ProjectsPage } from "./projects-page";
import { ConfigPage } from "./config-page";
import { CommandsPage } from "./commands-page";
import { EnvCheckPage } from "./env-check-page";
import {
  FolderOpen,
  Rocket,
  ArrowLeft,
  Activity,
  Globe,
  Box,
  ShieldCheck,
  LayoutTemplate,
  Settings2,
  DatabaseBackup,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentConfigSection, ManageTab, Project, ProjectMeta } from "@/types";

interface ManagePageProps {
  onBack: () => void;
  onEnterProject: (project: Project) => void;
  navigateToProjects?: number;
  projects: Project[] | null;
  projectMetas: Record<string, ProjectMeta> | null;
  refetchProjects: (silent?: boolean) => Promise<Project[]>;
  refetchProjectMetas: (silent?: boolean) => Promise<Record<string, ProjectMeta>>;
}

interface ManageMenuItem {
  id: ManageTab;
  icon: typeof FolderOpen;
  labelKey: string;
  fallback: string;
}

// v0.7.4 需求2 R4/R5：侧边栏分组菜单（参考用户截图）——工作区 / 智能体设置 /
// 系统。智能体设置分组下五个子页，每个子页独立页面（configTab 传入 ConfigPage）。
// R5：菜单名与导航键解耦（项目管理/快捷命令/环境检测），备份独立子页。
const menuGroups: { titleKey: string; titleFallback: string; items: ManageMenuItem[] }[] = [
  {
    titleKey: "manage.groupWorkspace",
    titleFallback: "工作区",
    items: [
      { id: "projects", icon: FolderOpen, labelKey: "manage.menuProjects", fallback: "项目管理" },
    ],
  },
  {
    titleKey: "manage.groupAgent",
    titleFallback: "智能体设置",
    items: [
      { id: "agent-models", icon: Box, labelKey: "manage.menuModels", fallback: "模型设置" },
      { id: "agent-behavior", icon: ShieldCheck, labelKey: "manage.menuBehavior", fallback: "行为与权限" },
      { id: "agent-advanced", icon: Settings2, labelKey: "manage.menuAdvanced", fallback: "高级设置" },
      { id: "agent-templates", icon: LayoutTemplate, labelKey: "manage.menuTemplates", fallback: "配置模版" },
      { id: "agent-backups", icon: DatabaseBackup, labelKey: "manage.menuBackups", fallback: "配置备份" },
    ],
  },
  {
    titleKey: "manage.groupSystem",
    titleFallback: "系统",
    items: [
      { id: "commands", icon: Rocket, labelKey: "manage.menuCommands", fallback: "快捷命令" },
      { id: "env", icon: Activity, labelKey: "manage.menuEnv", fallback: "环境检测" },
    ],
  },
];

/** 智能体设置子页 tab → ConfigPage 的 configTab。 */
const agentTabSection: Partial<Record<ManageTab, AgentConfigSection>> = {
  "agent-models": "models",
  "agent-behavior": "behavior",
  "agent-templates": "templates",
  "agent-backups": "backups",
  "agent-advanced": "advanced",
};

/** 反查：AgentConfigSection → 侧边栏 tab id（v0.7.6 需求2：配置页内部
 *  跳转子页，如模型页 env 块「前往高级设置修改」）。 */
const agentSectionTab: Partial<Record<AgentConfigSection, ManageTab>> = {
  models: "agent-models",
  behavior: "agent-behavior",
  templates: "agent-templates",
  backups: "agent-backups",
  advanced: "agent-advanced",
};

export function ManagePage({ onBack, onEnterProject, navigateToProjects, projects, projectMetas, refetchProjects, refetchProjectMetas }: ManagePageProps) {
  const { t, i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState<ManageTab>("projects");
  const prevNavRef = useRef(0);

  useEffect(() => {
    if (navigateToProjects && navigateToProjects !== prevNavRef.current) {
      prevNavRef.current = navigateToProjects;
      setActiveTab("projects");
    }
  }, [navigateToProjects]);

  const handleBack = () => {
    setActiveTab("projects");
    onBack();
  };

  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const agentSection = agentTabSection[activeTab];

  /** 配置页内部跳转（v0.7.6 需求2）：切侧边栏 tab 到目标智能体设置子页。 */
  const handleNavigateAgentSection = (section: AgentConfigSection) => {
    const tab = agentSectionTab[section];
    if (tab) setActiveTab(tab);
  };

  return (
    <div className="flex h-full">
      {/* Left: grouped menu sidebar（v0.7.4 R4：加宽分组菜单） */}
      <div
        className="flex w-52 shrink-0 flex-col border-r border-border/30 py-4"
        style={{ background: "var(--color-layer-1)" }}
      >
        <div className="px-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
            title={t("sessions.title")}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="text-sm">{t("manage.back")}</span>
          </Button>
        </div>

        <nav className="mt-4 flex-1 space-y-5 overflow-y-auto px-3">
          {menuGroups.map((group) => (
            <div key={group.titleKey} className="space-y-1">
              <div className="px-2 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground/70">
                {tr(group.titleKey, group.titleFallback)}
              </div>
              {group.items.map(({ id, icon: Icon, labelKey, fallback }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-fast",
                    activeTab === id
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{tr(labelKey, fallback)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <button
          onClick={() => {
            const newLang = i18n.language.startsWith('zh') ? 'en' : 'zh';
            i18n.changeLanguage(newLang);
          }}
          className="mx-3 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-fast text-muted-foreground hover:bg-accent/30 hover:text-foreground"
          title={i18n.language.startsWith('zh') ? "Switch to English" : "切换到中文"}
        >
          <Globe className="h-4 w-4 shrink-0" />
          <span className="truncate">
            {i18n.language.startsWith('zh') ? "English" : "中文"}
          </span>
        </button>
      </div>

      {/* Right: Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "projects" && (
          <ProjectsPage
            projects={projects}
            projectMetas={projectMetas}
            refetchProjects={refetchProjects}
            refetchProjectMetas={refetchProjectMetas}
            onEnterProject={onEnterProject}
          />
        )}
        {agentSection !== undefined && (
          <ConfigPage
            configTab={agentSection}
            onNavigateSection={handleNavigateAgentSection}
          />
        )}
        {activeTab === "commands" && <CommandsPage />}
        {activeTab === "env" && <EnvCheckPage />}
      </div>
    </div>
  );
}
