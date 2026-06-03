import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { ProjectsPage } from "./projects-page";
import { ConfigPage } from "./config-page";
import { CommandsPage } from "./commands-page";
import { EnvCheckPage } from "./env-check-page";
import { FolderOpen, Settings, Rocket, ArrowLeft, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ManageTab, Project } from "@/types";

interface ManagePageProps {
  onBack: () => void;
  onEnterProject: (project: Project) => void;
  navigateToProjects?: number;
}

const tabs: { id: ManageTab; icon: typeof FolderOpen; labelKey: string; fallback: string; iconColor: string }[] = [
  { id: "projects", icon: FolderOpen, labelKey: "nav.projects", fallback: "Projects", iconColor: "text-[var(--icon-folder)]" },
  { id: "config", icon: Settings, labelKey: "config.configuration", fallback: "Config", iconColor: "text-[var(--icon-action)]" },
  { id: "commands", icon: Rocket, labelKey: "nav.commands", fallback: "Commands", iconColor: "text-[var(--icon-action)]" },
  { id: "env", icon: Activity, labelKey: "nav.environment", fallback: "Env", iconColor: "text-[var(--icon-env)]" },
];

export function ManagePage({ onBack, onEnterProject, navigateToProjects }: ManagePageProps) {
  const { t } = useTranslation();
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

  return (
    <div className="flex h-full">
      {/* Left: Tab navigation */}
      <div className="w-16 flex flex-col items-center border-r border-border/30 py-4 gap-1" style={{ background: "var(--color-layer-1)" }}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleBack}
          className="mb-4 text-muted-foreground hover:text-foreground"
          title={t("sessions.title")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        {tabs.map(({ id, icon: Icon, labelKey, fallback, iconColor }) => {
          const label = t(labelKey) === labelKey ? fallback : t(labelKey);
          return (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              "flex flex-col items-center gap-1 w-12 py-2 rounded-lg text-xs transition-fast",
              activeTab === id
                ? "bg-accent/80 text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"
            )}
            title={label}
          >
            <Icon className={cn("h-4 w-4", activeTab !== id && iconColor)} />
            <span className="truncate w-full text-center">{label}</span>
          </button>
          );
        })}
      </div>

      {/* Right: Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "projects" && <ProjectsPage onEnterProject={onEnterProject} />}
        {activeTab === "config" && <ConfigPage initialTab="edit" />}
        {activeTab === "commands" && <CommandsPage />}
        {activeTab === "env" && <EnvCheckPage />}
      </div>
    </div>
  );
}
