import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ExternalLink, Trash2, Settings, ChevronRight } from "lucide-react";
import { MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { useAgent } from "@/agents";
import { useInvoke } from "@/hooks/use-invoke";
import { CLAUDE_MODEL_CATALOG } from "@/agents/config/presets/claude-models";
import { OPENCODE_MODEL_CATALOG } from "@/agents/config/presets/opencode-models";
import { ProjectSettingsForm } from "@/components/projects/project-settings-form";
import { AgentSelect } from "@/components/projects/agent-select";
import { ProjectMetaEditor } from "@/components/projects/project-meta-editor";
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
  // v0.7.0 需求一：管理作用域 agent_id（load_claude_md 必填）。
  const { agents, manageAgentId } = useAgent();
  // 项目配置按「识别本项目的智能体」切换（agent_ids 来自各 agent 的项目扫描，
  // 项目列表筛选同源）；表单内容按各 agent 的 project_settings_surface 适配。
  const projectAgents = agents.filter((a) => (project.agent_ids ?? []).includes(a.id));
  const [settingsAgentId, setSettingsAgentId] = useState<string>("");
  const effectiveSettingsAgentId =
    settingsAgentId && projectAgents.some((a) => a.id === settingsAgentId)
      ? settingsAgentId
      : (projectAgents.find((a) => a.id === manageAgentId)?.id ??
        projectAgents[0]?.id ??
        "");
  const settingsAgent = projectAgents.find((a) => a.id === effectiveSettingsAgentId) ?? null;
  const settingsSurface = settingsAgent?.project_settings_surface ?? { kind: "unsupported" as const, reason: null };

  // v0.7.4：项目默认模型的候选项按 agent 真实列表——model_store（jishu）
  // 取 models.json 扁平 provider/model；claude/opencode 取各自目录。
  const settingsAgentIsModelStore =
    settingsAgent?.config_surface?.kind === "model_store";
  const { data: modelStoreConfig } = useInvoke<{
    providers?: Record<
      string,
      { name?: string; models?: { id: string; name?: string }[] }
    >;
  }>(
    settingsAgentIsModelStore && effectiveSettingsAgentId ? "get_models_config" : "",
    settingsAgentIsModelStore && effectiveSettingsAgentId
      ? { agentId: effectiveSettingsAgentId }
      : undefined,
  );
  const modelOptions: { value: string; label: string; hint?: string }[] =
    settingsAgentIsModelStore
      ? Object.entries(modelStoreConfig?.providers ?? {}).flatMap(([pid, prov]) =>
          (prov.models ?? []).map((m) => ({
            value: `${pid}/${m.id}`,
            label: m.name || m.id,
            hint: prov.name || pid,
          })),
        )
      : settingsSurface.kind === "supported" && settingsSurface.fields?.includes("model")
        ? settingsAgent?.config_surface?.kind === "structured" &&
            settingsAgent.config_surface.model_catalog === "opencode"
          ? OPENCODE_MODEL_CATALOG.map((m) => ({ value: m.value, label: t(m.labelKey) }))
          : CLAUDE_MODEL_CATALOG.map((m) => ({ value: m.value, label: t(m.labelKey) }))
        : [];
  const { data: claudeMd } = useInvoke<string | null>(
    effectiveSettingsAgentId ? "load_claude_md" : "",
    { agentId: effectiveSettingsAgentId, projectPath: project.path },
  );

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
    <div className="absolute inset-y-0 right-0 z-20 w-[28rem] border-l border-border bg-card shadow-lg flex flex-col">
      {confirmDialogNode}
      {/* 折叠手柄：左缘中部（IDE 侧栏实践），点击收起面板；空白处点击同样折叠 */}
      <button
        type="button"
        onClick={onClose}
        title={t("projects.collapsePanel")}
        className="absolute -left-4 top-1/2 z-30 flex h-16 w-4 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-border bg-card text-muted-foreground shadow-md transition-fast hover:text-foreground"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      {/* Header：项目名 + 智能体下拉紧贴其右（信息/配置/终端共用同一选中智能体） */}
      <div className="flex items-center gap-2 border-b border-border p-4">
        <h2 className="min-w-0 truncate font-semibold">{projectMetas?.[project.encoded_name]?.custom_name || project.name}</h2>
        <AgentSelect
          agents={projectAgents}
          value={effectiveSettingsAgentId}
          onChange={setSettingsAgentId}
        />
        <div className="flex-1" />
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
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={!effectiveSettingsAgentId}
                onClick={() =>
                  void invokeCommand("open_in_terminal", {
                    agentId: effectiveSettingsAgentId,
                    projectPath: project.path,
                  }).catch((err) => console.error("open_in_terminal failed:", err))
                }
              >
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
          <div className="space-y-4">
            {projectAgents.length > 0 ? (
              <>
                {settingsSurface.kind === "supported" ? (
                  <ProjectSettingsForm
                    agentId={effectiveSettingsAgentId}
                    projectPath={project.path}
                    surface={settingsSurface}
                    modelOptions={modelOptions}
                  />
                ) : (
                  <p className="rounded-md border border-dashed border-border/40 px-4 py-8 text-center text-sm text-muted-foreground">
                    {settingsSurface.reason ?? t("projects.projectSettingsUnsupported")}
                  </p>
                )}
              </>
            ) : (
              <p className="rounded-md border border-dashed border-border/40 px-4 py-8 text-center text-sm text-muted-foreground">
                {t("projects.noRecognizedAgents", "尚未有智能体识别到该项目")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
