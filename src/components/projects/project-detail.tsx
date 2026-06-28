import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { X, ExternalLink, Trash2, Settings } from "lucide-react";
import { MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { ProjectSettingsForm } from "@/components/projects/project-settings-form";
import { ProjectMetaEditor } from "@/components/projects/project-meta-editor";
import { useInvoke } from "@/hooks/use-invoke";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import type { Project, ProjectMeta, ProjectMergeInfo } from "@/types";

interface ProjectDetailProps {
  project: Project;
  onClose: () => void;
  onViewSessions: (encodedName: string) => void;
  onRemoved?: () => void;
  projectMetas?: Record<string, ProjectMeta>;
  onUpdateMetas?: () => void;
  merges?: ProjectMergeInfo;
  onSplit?: () => void;
  agentNames?: Record<string, string>;
}

export function ProjectDetail({ project, onClose, onViewSessions, onRemoved, projectMetas, onUpdateMetas, merges, onSplit, agentNames = {} }: ProjectDetailProps) {
  const collectAllTags = (metas?: Record<string, ProjectMeta>): string[] => {
    if (!metas) return [];
    const tagSet = new Set<string>();
    Object.values(metas).forEach(m => m.tags?.forEach(t => tagSet.add(t)));
    return [...tagSet].sort();
  };
  const { t } = useTranslation();
  const { confirm: confirmDialog, dialogNode: confirmDialogNode } = useConfirmDialog();
  const [activeTab, setActiveTab] = useState<"info" | "config">("info");
  const { data: claudeMd } = useInvoke<string | null>("load_claude_md", { projectPath: project.path });

  const handleRemove = async () => {
    const confirmed = await confirmDialog({
      title: t("projects.title"),
      description: t("projects.removeProjectConfirm"),
      variant: "destructive",
    });
    if (!confirmed) return;
    try {
      await invokeCommand("remove_project", { encodedName: project.encoded_name });
      onRemoved?.();
      onClose();
    } catch (err) {
      console.error("Failed to remove project:", err);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 z-10 w-[28rem] border-l border-border bg-card shadow-lg flex flex-col">
      {confirmDialogNode}
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="font-semibold truncate">{projectMetas?.[project.encoded_name]?.custom_name || project.name}</h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-border">
        <button
          className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === "info"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("info")}
        >
          {t("projectConfig.info")}
        </button>
        <button
          className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === "config"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("config")}
        >
          <Settings className="mr-1.5 inline h-3.5 w-3.5" />
          {t("projectConfig.config")}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeTab === "info" ? (
          <>
            <Card>
              <CardContent className="p-3 space-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">{t("projects.path")}</span>
                  <p className="font-mono text-xs break-all">{project.path}</p>
                </div>
                <Separator />
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("projects.sessions")}</span>
                  <span className="font-medium">{project.session_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("projects.lastActive")}</span>
                  <span className="font-medium">{project.last_active ?? t("common.na")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("projects.claudeMd")}</span>
                  <span className={project.has_claude_md ? "text-green-500" : "text-muted-foreground"}>
                    {project.has_claude_md ? t("common.yes") : t("common.no")}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">{t("projects.agents")}</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(project.agent_ids ?? []).length > 0 ? (
                      (project.agent_ids ?? []).map((id) => (
                        <span key={id} className="rounded-full border border-border/60 bg-muted/60 px-2 py-0.5 text-xs">
                          {agentNames[id] || id}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("common.na")}</span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-3">
                <ProjectMetaEditor
                  encodedName={project.encoded_name}
                  meta={projectMetas?.[project.encoded_name]}
                  allTags={collectAllTags(projectMetas)}
                  onUpdate={() => onUpdateMetas?.()}
                />
              </CardContent>
            </Card>

            {project.has_claude_md && claudeMd && (
              <Card>
                <CardContent className="p-3">
                  <p className="text-sm font-medium mb-2">CLAUDE.md</p>
                  <pre className="text-xs whitespace-pre-wrap break-words max-h-48 overflow-y-auto text-muted-foreground font-mono bg-muted rounded p-2">
                    {claudeMd}
                  </pre>
                </CardContent>
              </Card>
            )}

            <div className="space-y-2">
              <Button className="w-full justify-start gap-2" onClick={() => onViewSessions(project.encoded_name)}>
                <MessageSquare className="h-4 w-4" />
                {t("projects.viewSessions")}
              </Button>
              <Button variant="outline" className="w-full justify-start gap-2" onClick={() => invokeCommand("open_in_terminal", { projectPath: project.path })}>
                <ExternalLink className="h-4 w-4" />
                {t("projects.openInTerminal")}
              </Button>
              <Button variant="ghost" className="w-full justify-start gap-2 text-destructive hover:text-destructive" onClick={handleRemove}>
                <Trash2 className="h-4 w-4" />
                {t("projects.removeProject")}
              </Button>
              {merges && merges[project.encoded_name] && merges[project.encoded_name].length > 0 && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={async () => {
                    try {
                      await invokeCommand("split_project", { primary: project.encoded_name });
                      onSplit?.();
                      onClose();
                    } catch (err) {
                      console.error("Failed to split project:", err);
                    }
                  }}
                >
                  {t("projects.splitProject", { count: merges[project.encoded_name].length })}
                </Button>
              )}
            </div>
          </>
        ) : (
          <ProjectSettingsForm projectPath={project.path} />
        )}
      </div>
    </div>
  );
}
