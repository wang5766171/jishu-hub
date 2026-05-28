import { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Plus, FolderOpen, Settings2, RotateCw, Search, ChevronDown, ChevronUp } from "lucide-react";
import { useInvoke } from "@/hooks/use-invoke";
import { ProjectCard } from "@/components/projects/project-card";
import { ProjectDetail } from "@/components/projects/project-detail";
import { AddProjectDialog } from "@/components/projects/add-project-dialog";
import { MergeDialog } from "@/components/projects/merge-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useAgent } from "@/agents";
import type { Project, ProjectMeta, ProjectMergeInfo } from "@/types";

interface ProjectsPageProps {
  onEnterProject?: (project: Project) => void;
}

export function ProjectsPage({ onEnterProject }: ProjectsPageProps) {
  const { t } = useTranslation();
  const { agents, activeId } = useAgent();
  const { data: projects, loading, refetch } = useInvoke<Project[]>("scan_projects");
  const { data: projectMetas, refetch: refetchMetas } = useInvoke<Record<string, ProjectMeta>>("load_project_metas");
  const { data: merges, refetch: refetchMerges } = useInvoke<ProjectMergeInfo>("get_project_merges");

  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  // Management mode state
  const [managementMode, setManagementMode] = useState(false);
  const [checkedProjects, setCheckedProjects] = useState<Set<string>>(new Set());
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [tagsExpanded, setTagsExpanded] = useState(false);

  const allTags = useMemo(() => {
    if (!projectMetas) return [];
    const tagSet = new Set<string>();
    Object.values(projectMetas).forEach(m => m.tags?.forEach(t => tagSet.add(t)));
    return [...tagSet].sort();
  }, [projectMetas]);

  const TAG_COLLAPSE_LIMIT = 8;

  const projectAgentIds = useMemo(() => {
    const ids = new Set<string>();
    (projects ?? []).forEach(project => {
      (project.agent_ids ?? []).forEach(id => ids.add(id));
    });
    return ids;
  }, [projects]);

  const filterAgents = useMemo(
    () => agents.filter(agent => agent.health.installed || projectAgentIds.has(agent.id)),
    [agents, projectAgentIds]
  );

  useEffect(() => {
    if (selectedAgent !== "all" && !filterAgents.some(agent => agent.id === selectedAgent)) {
      setSelectedAgent("all");
    }
  }, [filterAgents, selectedAgent]);

  const handleProjectAdded = () => {
    refetch();
  };

  const handleCheck = (encodedName: string) => {
    const newChecked = new Set(checkedProjects);
    if (newChecked.has(encodedName)) {
      newChecked.delete(encodedName);
    } else {
      newChecked.add(encodedName);
    }
    setCheckedProjects(newChecked);
  };

  const toggleManagementMode = () => {
    setManagementMode(!managementMode);
    setCheckedProjects(new Set());
  };

  const clearSelection = () => {
    setCheckedProjects(new Set());
  };

  const handleMergeComplete = () => {
    refetch();
    refetchMerges();
    setCheckedProjects(new Set());
    setManagementMode(false);
  };

  // Compute merged count for each project
  const getMergedCount = (encodedName: string): number => {
    if (!merges || !merges[encodedName]) return 0;
    return merges[encodedName].length;
  };

  // Filter projects by search query and selected tag
  const filteredProjects = (() => {
    let result = projects ?? [];
    if (selectedTag) {
      result = result.filter(p => projectMetas?.[p.encoded_name]?.tags?.includes(selectedTag));
    }
    if (selectedAgent !== "all") {
      result = result.filter(p => (p.agent_ids ?? []).includes(selectedAgent));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((p) => {
        const meta = projectMetas?.[p.encoded_name];
        const name = meta?.custom_name?.toLowerCase() || p.name.toLowerCase();
        const tags = meta?.tags?.map(t => t.toLowerCase()) ?? [];
        return name.includes(q) || tags.some(t => t.includes(q)) || p.path.toLowerCase().includes(q);
      });
    }
    return result;
  })();

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-32" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 h-full overflow-auto pb-20">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{t("projects.title")}</h2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => { refetch(); refetchMetas(); refetchMerges(); }} title={t("projects.refresh")}>
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={toggleManagementMode}>
            <Settings2 className="h-4 w-4 mr-1" />
            {managementMode ? "退出管理" : "管理"}
          </Button>
          <Button onClick={() => setAddDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t("projects.addProject")}
          </Button>
        </div>
      </div>

      {projects && projects.length > 0 && (
        <div className="flex flex-col items-center gap-3 pt-1">
          <div className="flex w-full max-w-4xl flex-wrap items-center justify-center gap-3">
            <div className="relative min-w-[280px] flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("projects.search")}
                className="h-9 rounded-[10px] border-border/70 bg-background/80 pl-8 text-sm shadow-sm"
              />
            </div>
            {filterAgents.length > 0 && (
              <div className="flex items-center justify-center gap-1.5 rounded-[10px] border border-border/70 bg-muted/35 p-1 shadow-sm">
                <button
                  onClick={() => setSelectedAgent("all")}
                  className={`inline-flex h-7 items-center rounded-[7px] px-3 text-xs font-medium transition-colors ${
                    selectedAgent === "all"
                      ? "bg-foreground text-background shadow-sm"
                      : "text-muted-foreground hover:bg-background/80 hover:text-foreground"
                  }`}
                >
                  {t("projects.allAgents")}
                </button>
                {filterAgents.map(agent => (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedAgent(selectedAgent === agent.id ? "all" : agent.id)}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-xs font-medium transition-colors ${
                      selectedAgent === agent.id
                        ? "bg-foreground text-background shadow-sm"
                        : "text-muted-foreground hover:bg-background/80 hover:text-foreground"
                    }`}
                  >
                    {agent.id === activeId && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                    {agent.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {allTags.length > 0 && (
            <div className="flex max-w-4xl items-center justify-center gap-1.5 flex-wrap">
              {allTags
                .slice(0, tagsExpanded ? undefined : TAG_COLLAPSE_LIMIT)
                .map(tag => (
                  <button
                    key={tag}
                    onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                    className={`inline-flex h-7 items-center rounded-[7px] px-2.5 text-xs font-medium transition-colors ${
                      selectedTag === tag
                        ? "bg-foreground text-background"
                        : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              {allTags.length > TAG_COLLAPSE_LIMIT && (
                <button
                  onClick={() => setTagsExpanded(!tagsExpanded)}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {tagsExpanded ? (
                    <><ChevronUp className="h-3 w-3" />收起</>
                  ) : (
                    <><ChevronDown className="h-3 w-3" />+{allTags.length - TAG_COLLAPSE_LIMIT}</>
                  )}
                </button>
              )}
              {selectedTag && (
                <button
                  onClick={() => setSelectedTag(null)}
                  className="text-xs text-muted-foreground hover:text-foreground ml-1"
                >
                  清除筛选
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {!projects || projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <FolderOpen className="h-12 w-12 mb-4" />
          <p>{t("projects.noProjects")}</p>
          <p className="text-sm">{t("projects.noProjectsDesc")}</p>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Search className="h-8 w-8 mb-2" />
          <p className="text-sm">{t("projects.noSearchResults")}</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map((project) => (
            <ProjectCard
              key={project.encoded_name}
              project={project}
              selected={selectedProject?.encoded_name === project.encoded_name}
              onClick={() => setSelectedProject(project)}
              meta={projectMetas?.[project.encoded_name]}
              managementMode={managementMode}
              checked={checkedProjects.has(project.encoded_name)}
              onCheck={() => handleCheck(project.encoded_name)}
              mergedCount={getMergedCount(project.encoded_name)}
              onTagClick={(tag) => setSelectedTag(selectedTag === tag ? null : tag)}
              onRefresh={() => { refetch(); refetchMerges(); }}
              onEnterChat={() => onEnterProject?.(project)}
              agentNames={Object.fromEntries(agents.map(agent => [agent.id, agent.display_name]))}
            />
          ))}
        </div>
      )}

      {selectedProject && (
        <ProjectDetail
          project={selectedProject}
          onClose={() => setSelectedProject(null)}
          onViewSessions={(_name) => {}}
          onRemoved={() => { setSelectedProject(null); refetch(); }}
          projectMetas={projectMetas ?? undefined}
          onUpdateMetas={refetchMetas}
          merges={merges ?? undefined}
          onSplit={handleMergeComplete}
          agentNames={Object.fromEntries(agents.map(agent => [agent.id, agent.display_name]))}
        />
      )}

      <AddProjectDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAdded={handleProjectAdded}
      />

      {managementMode && checkedProjects.size >= 2 && (
        <div className="fixed bottom-0 left-0 right-0 border-t bg-background p-3 flex items-center justify-between z-50">
          <span className="text-sm">已选择 {checkedProjects.size} 个项目</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={clearSelection}>取消选择</Button>
            <Button onClick={() => setMergeDialogOpen(true)}>合并项目</Button>
          </div>
        </div>
      )}

      {mergeDialogOpen && checkedProjects.size >= 2 && (
        <MergeDialog
          open={mergeDialogOpen}
          onOpenChange={setMergeDialogOpen}
          selectedProjects={[...checkedProjects]}
          projectNames={Object.fromEntries(projects?.map(p => [p.encoded_name, p.name]) ?? [])}
          onMergeComplete={handleMergeComplete}
        />
      )}
    </div>
  );
}
