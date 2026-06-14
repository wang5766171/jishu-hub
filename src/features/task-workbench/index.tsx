import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowLeft,
  ClipboardList,
  MessageSquareText,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTaskGraph, type TaskGraph } from "./use-task-graph";
import { GraphEditor } from "./graph-editor";
import { NodeSidebar } from "./node-sidebar";
import { RunInspector } from "./run-inspector";
import { ProposalReview } from "./proposal-review";
import { PlanningProgressOverlay } from "./planning-progress";
import { TaskConversationPanel } from "./task-conversation-panel";

interface TaskPlanSkill {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  installable: boolean;
  valid: boolean;
  error: string | null;
  content_hash: string;
}

interface TaskWorkbenchProps {
  initialProjectPath?: string | null;
  initialGraphId?: string | null;
  onClose?: () => void;
}

type WorkbenchView = "list" | "create" | "graph";

export function TaskWorkbench({
  initialProjectPath,
  initialGraphId,
  onClose,
}: TaskWorkbenchProps) {
  const { t, i18n } = useTranslation();
  const {
    graph,
    snapshot,
    loading,
    error,
    createGraph,
    applyCommands,
    activeRunId,
    displayedRunId,
    runStatus,
    nodeRuns,
    events,
    approvals,
    artifacts,
    revisions,
    proposal,
    planning,
    planningProgress,
    planningText,
    startRun,
    pollRunProjection,
    loadGraph,
    clearGraph,
    pauseRun,
    resumeRun,
    cancelRun,
    resolveApproval,
    generateProposal,
    acceptProposal,
    dismissProposal,
    canUndo,
    canRedo,
    undo,
    redo,
    applyDraftToRun,
    canApplyDraftToRun,
  } = useTaskGraph();
  const [view, setView] = useState<WorkbenchView>("list");
  const [taskGraphs, setTaskGraphs] = useState<TaskGraph[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [runInspectorOpen, setRunInspectorOpen] = useState(false);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [skills, setSkills] = useState<TaskPlanSkill[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [installingSkillIds, setInstallingSkillIds] = useState<string[]>([]);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingInitialPlan, setPendingInitialPlan] = useState<string | null>(null);

  const loadTaskGraphs = useCallback(async () => {
    if (!initialProjectPath) {
      setTaskGraphs([]);
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const items = await invoke<TaskGraph[]>("orchestrator_list_graphs_for_project", {
        projectRoot: initialProjectPath,
      });
      setTaskGraphs(items);
    } catch (loadError) {
      setListError(String(loadError));
    } finally {
      setListLoading(false);
    }
  }, [initialProjectPath]);

  useEffect(() => {
    invoke<TaskPlanSkill[]>("task_plan_skill_list")
      .then((items) => {
        setSkills(items);
        const defaultSkill = items.find((item) => item.id === "jishu-task-planner");
        if (defaultSkill) setSelectedSkillIds([defaultSkill.id]);
      })
      .catch((skillError) => setFormError(String(skillError)));
  }, []);

  useEffect(() => {
    clearGraph();
    setSelectedNodeId(null);
    setRunInspectorOpen(false);
    setConversationOpen(Boolean(initialGraphId));
    if (initialGraphId) {
      setView("graph");
      loadGraph(initialGraphId).catch(console.error);
    } else {
      setView("list");
      loadTaskGraphs().catch(console.error);
    }
  }, [
    clearGraph,
    initialGraphId,
    initialProjectPath,
    loadGraph,
    loadTaskGraphs,
  ]);

  useEffect(() => {
    if (!activeRunId || view !== "graph") return;
    pollRunProjection();
    const interval = setInterval(pollRunProjection, 1000);
    return () => clearInterval(interval);
  }, [activeRunId, pollRunProjection, view]);

  useEffect(() => {
    if (activeRunId) setRunInspectorOpen(true);
  }, [activeRunId]);

  useEffect(() => {
    if (!pendingInitialPlan || !graph || planning) return;
    const instruction = pendingInitialPlan;
    setPendingInitialPlan(null);
    generateProposal(instruction).catch(console.error);
  }, [generateProposal, graph, pendingInitialPlan, planning]);

  const selectedNode = useMemo(
    () => snapshot?.nodes.find((node) => node.node_id === selectedNodeId) ?? null,
    [selectedNodeId, snapshot],
  );
  const selectedSkillsReady = useMemo(
    () =>
      skills
        .filter((skill) => selectedSkillIds.includes(skill.id))
        .every((skill) => skill.installed && skill.valid),
    [selectedSkillIds, skills],
  );

  const installSkill = useCallback(async (skillId: string) => {
    setInstallingSkillIds((current) => [...current, skillId]);
    setFormError(null);
    try {
      const installed = await invoke<TaskPlanSkill>("task_plan_skill_install", {
        skillId,
      });
      setSkills((current) =>
        current.map((skill) => (skill.id === installed.id ? installed : skill)),
      );
    } catch (installError) {
      setFormError(String(installError));
    } finally {
      setInstallingSkillIds((current) =>
        current.filter((currentId) => currentId !== skillId),
      );
    }
  }, []);

  const beginCreate = useCallback(() => {
    clearGraph();
    setSelectedNodeId(null);
    setRunInspectorOpen(false);
    setTitle("");
    setGoal("");
    setFormError(null);
    setPendingInitialPlan(null);
    setView("create");
  }, [clearGraph]);

  const returnToList = useCallback(() => {
    clearGraph();
    setSelectedNodeId(null);
    setRunInspectorOpen(false);
    setView("list");
    loadTaskGraphs().catch(console.error);
  }, [clearGraph, loadTaskGraphs]);

  const openTask = useCallback(
    async (graphId: string) => {
      setSelectedNodeId(null);
      setRunInspectorOpen(false);
      setConversationOpen(true);
      setView("graph");
      await loadGraph(graphId);
    },
    [loadGraph],
  );

  if (view === "list") {
    return (
      <TaskList
        tasks={taskGraphs}
        loading={listLoading}
        error={listError}
        locale={i18n.language}
        projectPath={initialProjectPath}
        onRefresh={loadTaskGraphs}
        onCreate={beginCreate}
        onOpen={openTask}
        onClose={onClose}
      />
    );
  }

  if (view === "create") {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-background">
        <WorkbenchHeader
          title={t("tasks.newTask")}
          subtitle={initialProjectPath || t("tasks.projectPathPlaceholder")}
          onBack={returnToList}
          onClose={onClose}
        />
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6">
          <form
            className="w-full max-w-2xl space-y-5 rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!goal.trim() || !initialProjectPath) return;
              setFormBusy(true);
              setFormError(null);
              try {
                const selected = skills.filter((skill) =>
                  selectedSkillIds.includes(skill.id),
                );
                if (selected.some((skill) => !skill.installed || !skill.valid)) {
                  throw new Error(t("tasks.installSkillFirst"));
                }
                const skillRefs = selected.map((skill) => ({
                  skill_id: skill.id,
                  version_or_hash: skill.content_hash,
                  inputs: {},
                }));
                setPendingInitialPlan(goal.trim());
                await createGraph(
                  title.trim() || goal.trim(),
                  goal.trim(),
                  initialProjectPath,
                  skillRefs,
                );
                setView("graph");
                setConversationOpen(true);
              } catch (submitError) {
                setPendingInitialPlan(null);
                setFormError(String(submitError));
              } finally {
                setFormBusy(false);
              }
            }}
          >
            <div>
              <h2 className="text-xl font-semibold">{t("tasks.startTask")}</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {t("tasks.createDescription")}
              </p>
            </div>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">{t("tasks.taskTitle")}</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("tasks.taskTitlePlaceholder")}
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 outline-none transition focus:ring-2 focus:ring-primary/40"
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">{t("tasks.taskGoal")}</span>
              <textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder={t("tasks.taskGoalPlaceholder")}
                rows={6}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2.5 leading-6 outline-none transition focus:ring-2 focus:ring-primary/40"
              />
            </label>
            {skills.length > 0 && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  {t("tasks.workbench.planningSkills")}
                </legend>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("tasks.workbench.planningSkillsHint")}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {skills.map((skill) => {
                    const checked = selectedSkillIds.includes(skill.id);
                    return (
                      <div
                        key={skill.id}
                        className={cn(
                          "rounded-xl border p-3 text-sm transition",
                          checked
                            ? "border-primary/60 bg-primary/5"
                            : "border-border bg-background hover:border-foreground/20",
                        )}
                      >
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(changeEvent) => {
                              setSelectedSkillIds((current) =>
                                changeEvent.target.checked
                                  ? [...current, skill.id]
                                  : current.filter((id) => id !== skill.id),
                              );
                            }}
                            className="mt-1"
                          />
                          <span>
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{skill.name}</span>
                              <span className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                                skill.installed && skill.valid
                                  ? "bg-emerald-500/10 text-emerald-600"
                                  : "bg-amber-500/10 text-amber-600",
                              )}>
                                {skill.installed && skill.valid
                                  ? t("tasks.installed")
                                  : skill.installed
                                    ? t("tasks.invalidSkill")
                                    : t("tasks.notInstalled")}
                              </span>
                            </span>
                            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                              {skill.description || skill.id}
                            </span>
                            {skill.error && (
                              <span className="mt-1 block text-xs leading-5 text-destructive">
                                {skill.error}
                              </span>
                            )}
                          </span>
                        </label>
                        {(!skill.installed || !skill.valid) && skill.installable && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-3 w-full"
                            disabled={installingSkillIds.includes(skill.id)}
                            onClick={() => void installSkill(skill.id)}
                          >
                            {installingSkillIds.includes(skill.id)
                              ? t("tasks.installingSkill")
                              : skill.installed
                                ? t("tasks.repairSkill")
                                : t("tasks.installSkill")}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={returnToList}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  !goal.trim() ||
                  !initialProjectPath ||
                  formBusy ||
                  !selectedSkillsReady
                }
              >
                {formBusy
                  ? t("tasks.workbench.preparingTask")
                  : t("tasks.createAndPlan")}
              </Button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <WorkbenchHeader
        title={graph?.title || t("tasks.title")}
        subtitle={graph?.goal}
        onBack={returnToList}
        onClose={onClose}
        actions={
          <>
            {displayedRunId && (
              <Button
                type="button"
                size="sm"
                variant={runInspectorOpen ? "secondary" : "outline"}
                onClick={() => setRunInspectorOpen((current) => !current)}
                aria-pressed={runInspectorOpen}
              >
                <Activity className="size-4" />
                {runInspectorOpen
                  ? t("tasks.workbench.hideRunInspector")
                  : t("tasks.workbench.showRunInspector")}
              </Button>
            )}
            {graph && (
              <Button
                type="button"
                size="sm"
                variant={conversationOpen ? "secondary" : "outline"}
                onClick={() => setConversationOpen((current) => !current)}
                aria-pressed={conversationOpen}
              >
                <MessageSquareText className="size-4" />
                {t("tasks.conversation.title")}
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={beginCreate}>
              <Plus className="size-4" />
              {t("tasks.newTask")}
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="relative h-full min-w-0 flex-1">
          {planning && planningProgress ? (
            <PlanningProgressOverlay progress={planningProgress} text={planningText} />
          ) : loading && !graph ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-destructive">
              {error}
            </div>
          ) : snapshot ? (
            <GraphEditor
              snapshot={snapshot}
              graphId={graph?.graph_id ?? null}
              selectedNodeId={selectedNodeId}
              onNodeSelect={(nodeId) => {
                setSelectedNodeId(nodeId);
                if (nodeId) setConversationOpen(true);
              }}
              applyCommands={applyCommands}
              activeRunId={activeRunId}
              nodeRuns={nodeRuns}
              startRun={startRun}
              runStatus={runStatus}
              pauseRun={pauseRun}
              resumeRun={resumeRun}
              cancelRun={cancelRun}
              generateProposal={() => generateProposal()}
              planning={planning}
              canUndo={canUndo}
              canRedo={canRedo}
              undo={undo}
              redo={redo}
              applyDraftToRun={applyDraftToRun}
              canApplyDraftToRun={canApplyDraftToRun}
            />
          ) : null}
        </div>

        {displayedRunId && runInspectorOpen && (
          <RunInspector
            runId={displayedRunId}
            events={events}
            approvals={approvals}
            artifacts={artifacts}
            revisions={revisions}
            currentRevisionId={graph?.current_draft_revision}
            onResolveApproval={resolveApproval}
            onClose={() => setRunInspectorOpen(false)}
          />
        )}

        {selectedNode && (
          <NodeSidebar
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
          />
        )}

        {graph && conversationOpen && (
          <TaskConversationPanel
            graphId={graph.graph_id}
            selectedNodeId={selectedNodeId}
            onClose={() => setConversationOpen(false)}
          />
        )}
      </div>

      {proposal && (
        <ProposalReview
          proposal={proposal}
          accepting={loading}
          onAccept={acceptProposal}
          onDismiss={dismissProposal}
        />
      )}
    </div>
  );
}

interface TaskListProps {
  tasks: TaskGraph[];
  loading: boolean;
  error: string | null;
  locale: string;
  projectPath?: string | null;
  onRefresh: () => Promise<void>;
  onCreate: () => void;
  onOpen: (graphId: string) => Promise<void>;
  onClose?: () => void;
}

function TaskList({
  tasks,
  loading,
  error,
  locale,
  projectPath,
  onRefresh,
  onCreate,
  onOpen,
  onClose,
}: TaskListProps) {
  const { t } = useTranslation();
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-16 items-center justify-between gap-4 border-b border-border/70 px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ClipboardList className="size-5 text-primary" />
            <h1 className="text-lg font-semibold">{t("tasks.title")}</h1>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {projectPath || t("tasks.projectPathPlaceholder")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onRefresh().catch(console.error)}
            disabled={loading}
            aria-label={t("tasks.refreshTaskList")}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            {t("tasks.refresh")}
          </Button>
          <Button type="button" size="sm" onClick={onCreate}>
            <Plus className="size-4" />
            {t("tasks.newTask")}
          </Button>
          {onClose && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onClose}
              aria-label={t("tasks.closeTaskPage")}
              title={t("tasks.closeTaskPage")}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto w-full max-w-5xl">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold tracking-tight">
              {t("tasks.taskList")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("tasks.taskListDescription")}
            </p>
          </div>
          {error && (
            <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {error}
            </div>
          )}
          {loading && tasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : tasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-12 text-center">
              <ClipboardList className="mx-auto size-9 text-muted-foreground/60" />
              <h3 className="mt-4 font-medium">{t("tasks.noTasks")}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                {t("tasks.noTasksDescription")}
              </p>
              <Button type="button" className="mt-5" onClick={onCreate}>
                <Plus className="size-4" />
                {t("tasks.newTask")}
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {tasks.map((task) => (
                <button
                  key={task.graph_id}
                  type="button"
                  onClick={() => onOpen(task.graph_id).catch(console.error)}
                  className="group rounded-2xl border border-border/70 bg-card p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{task.title}</h3>
                      <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">
                        {task.goal}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
                      {t("tasks.openTask")}
                    </span>
                  </div>
                  <div className="mt-5 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                    {t("tasks.updatedAt", {
                      time: formatter.format(new Date(task.updated_at)),
                    })}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface WorkbenchHeaderProps {
  title: string;
  subtitle?: string | null;
  onBack: () => void;
  onClose?: () => void;
  actions?: React.ReactNode;
}

function WorkbenchHeader({
  title,
  subtitle,
  onBack,
  onClose,
  actions,
}: WorkbenchHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-16 items-center justify-between gap-4 border-b border-border/70 bg-background px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={onBack}
          aria-label={t("tasks.backToTasks")}
          title={t("tasks.backToTasks")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          {subtitle && (
            <p className="mt-0.5 max-w-3xl truncate text-xs text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        {onClose && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onClose}
            aria-label={t("tasks.closeTaskPage")}
            title={t("tasks.closeTaskPage")}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
