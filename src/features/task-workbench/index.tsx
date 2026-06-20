import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowLeft,
  Bot,
  ClipboardList,
  MessageSquareText,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  User,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTaskGraph, type TaskGraph } from "./use-task-graph";
import { GraphEditor } from "./graph-editor";
import { RunInspector } from "./run-inspector";
import { ProposalReview } from "./proposal-review";
import { PlanningProgressOverlay } from "./planning-progress";
import { TaskConversationPanel } from "./task-conversation-panel";
import { InspectorPanel } from "./inspector-panel";
import {
  buildPlanningInstruction,
  createPlanningMessage,
  derivePlanningTitle,
  hasPlanningInput,
  type PlanningChatMessage,
} from "./planning-session";

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
type WorkbenchSurfaceView = "chat" | "canvas" | "split";

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
    chooseRecovery,
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
  const [surfaceView, setSurfaceView] = useState<WorkbenchSurfaceView>("canvas");
  const [title, setTitle] = useState("");
  const [planningMessages, setPlanningMessages] = useState<PlanningChatMessage[]>([]);
  const [planningDraft, setPlanningDraft] = useState("");
  const [skills, setSkills] = useState<TaskPlanSkill[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [installingSkillIds, setInstallingSkillIds] = useState<string[]>([]);
  const [deletingGraphIds, setDeletingGraphIds] = useState<string[]>([]);
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
    setSurfaceView("canvas");
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
    if (proposal && view === "graph") {
      setSurfaceView("split");
    }
  }, [proposal, view]);

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
  const selectedNodeRun = selectedNode ? nodeRuns[selectedNode.node_id] ?? null : null;
  const selectedNodeEvents = useMemo(() => {
    if (!selectedNode) return [];
    return events.filter((event) => {
      const payload = event.payload as Record<string, unknown> | null;
      return payload?.node_id === selectedNode.node_id ||
        (!!selectedNodeRun && payload?.node_run_id === selectedNodeRun.node_run_id);
    });
  }, [events, selectedNode, selectedNodeRun]);
  const selectedNodeApprovals = useMemo(() => {
    if (!selectedNodeRun) return [];
    return approvals.filter((approval) => approval.node_run_id === selectedNodeRun.node_run_id);
  }, [approvals, selectedNodeRun]);
  const selectedNodeArtifacts = useMemo(() => {
    if (!selectedNodeRun) return [];
    return artifacts.filter((artifact) => artifact.node_run_id === selectedNodeRun.node_run_id);
  }, [artifacts, selectedNodeRun]);
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
    setPlanningMessages([]);
    setPlanningDraft("");
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
      setSurfaceView("canvas");
      setView("graph");
      await loadGraph(graphId);
    },
    [loadGraph],
  );

  const deleteTask = useCallback(
    async (task: TaskGraph) => {
      if (!window.confirm(t("tasks.deleteTaskConfirm", { title: task.title }))) {
        return;
      }
      setDeletingGraphIds((current) =>
        current.includes(task.graph_id) ? current : [...current, task.graph_id],
      );
      setListError(null);
      try {
        await invoke("orchestrator_delete_graph", { graphId: task.graph_id });
        setTaskGraphs((current) =>
          current.filter((item) => item.graph_id !== task.graph_id),
        );
        if (graph?.graph_id === task.graph_id) {
          clearGraph();
          setSelectedNodeId(null);
          setRunInspectorOpen(false);
          setSurfaceView("canvas");
          setView("list");
          await loadTaskGraphs();
        }
      } catch (deleteError) {
        setListError(String(deleteError));
      } finally {
        setDeletingGraphIds((current) =>
          current.filter((graphId) => graphId !== task.graph_id),
        );
      }
    },
    [clearGraph, graph?.graph_id, loadTaskGraphs, t],
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
        onDelete={deleteTask}
        deletingGraphIds={deletingGraphIds}
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
        <form
          className="flex min-h-0 flex-1 overflow-hidden"
          onSubmit={async (event) => {
            event.preventDefault();
            const messagesForSubmit = planningDraft.trim()
              ? [...planningMessages, createPlanningMessage(planningDraft)]
              : planningMessages;
            const instruction = buildPlanningInstruction(messagesForSubmit);
            if (!instruction || !initialProjectPath) return;
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
              setPendingInitialPlan(instruction);
              await createGraph(
                derivePlanningTitle(title, messagesForSubmit),
                instruction,
                initialProjectPath,
                skillRefs,
              );
              setView("graph");
              setSurfaceView("split");
            } catch (submitError) {
              setPendingInitialPlan(null);
              setFormError(String(submitError));
            } finally {
              setFormBusy(false);
            }
          }}
        >
          <main className="flex min-w-0 flex-1 flex-col bg-background">
            <div className="border-b border-border/70 px-6 py-4">
              <div className="mx-auto flex max-w-4xl flex-wrap items-end gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold">{t("tasks.startTask")}</h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {t("tasks.createDescription")}
                  </p>
                </div>
                <label className="w-full max-w-xs space-y-1.5 text-sm sm:w-72">
                  <span className="font-medium">{t("tasks.taskTitle")}</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={t("tasks.taskTitlePlaceholder")}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2.5 outline-none transition focus:ring-2 focus:ring-primary/40"
                  />
                </label>
              </div>
            </div>
            <PlanningChatComposer
              messages={planningMessages}
              draft={planningDraft}
              busy={formBusy}
              className="min-h-0 flex-1"
              onDraftChange={setPlanningDraft}
              onAddMessage={() => {
                const message = planningDraft.trim();
                if (!message) return;
                setPlanningMessages((current) => [
                  ...current,
                  createPlanningMessage(message),
                ]);
                setPlanningDraft("");
              }}
            />
            {(error || formError) && (
              <div className="border-t border-border/70 px-6 py-2">
                {error && <p className="text-sm text-destructive">{error}</p>}
                {formError && <p className="text-sm text-destructive">{formError}</p>}
              </div>
            )}
            <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-card/60 px-6 py-3">
              <p className="min-w-0 text-xs leading-5 text-muted-foreground">
                {t("tasks.workbench.planningChat.barrier")}
              </p>
              <div className="flex shrink-0 justify-end gap-2">
                <Button type="button" variant="outline" onClick={returnToList}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !initialProjectPath ||
                    formBusy ||
                    !selectedSkillsReady ||
                    !hasPlanningInput(planningMessages, planningDraft)
                  }
                >
                  {formBusy
                    ? t("tasks.workbench.preparingTask")
                    : t("tasks.createAndPlan")}
                </Button>
              </div>
            </div>
          </main>
          <aside className="hidden w-[22rem] shrink-0 overflow-y-auto border-l border-border/70 bg-card/80 p-4 xl:block">
            {skills.length > 0 && (
              <PlanningSkillSelector
                skills={skills}
                selectedSkillIds={selectedSkillIds}
                installingSkillIds={installingSkillIds}
                onSelectionChange={setSelectedSkillIds}
                onInstallSkill={installSkill}
              />
            )}
          </aside>
        </form>
      </div>
    );
  }

  const unresolvedApprovalCount = approvals.filter((approval) => !approval.resolved).length;
  const failedNodeCount = Object.values(nodeRuns).filter(
    (nodeRun) => nodeRun.status === "failed",
  ).length;

  const graphContent = planning && planningProgress ? (
    <PlanningProgressOverlay
      progress={planningProgress}
      text={planningText}
      onCancel={() => dismissProposal()}
    />
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
      currentRevisionId={graph?.current_draft_revision ?? null}
      selectedNodeId={selectedNodeId}
      onNodeSelect={(nodeId) => {
        setSelectedNodeId(nodeId);
        if (nodeId) setSurfaceView("split");
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
  ) : null;

  const conversationContent = graph ? (
    <TaskConversationPanel
      graphId={graph.graph_id}
      selectedNodeId={selectedNodeId}
      onClose={() => setSurfaceView("canvas")}
      className="w-full border-l-0"
      leadingContent={
        proposal ? (
          <ProposalReview
            proposal={proposal}
            accepting={loading}
            onAccept={acceptProposal}
            onDismiss={dismissProposal}
          />
        ) : null
      }
    />
  ) : null;

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
              <ViewModeSwitcher value={surfaceView} onChange={setSurfaceView} />
            )}
            {graph && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={deletingGraphIds.includes(graph.graph_id)}
                onClick={() => deleteTask(graph).catch(console.error)}
                title={t("tasks.deleteTask")}
              >
                <Trash2 className="size-4" />
                {deletingGraphIds.includes(graph.graph_id)
                  ? t("tasks.deletingTask")
                  : t("tasks.deleteTask")}
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={beginCreate}>
              <Plus className="size-4" />
              {t("tasks.newTask")}
            </Button>
          </>
        }
      />
      <TaskContextBar
        runId={displayedRunId}
        runStatus={runStatus}
        revisionId={graph?.current_draft_revision ?? null}
        approvalCount={unresolvedApprovalCount}
        failedNodeCount={failedNodeCount}
        onApprovalsClick={() => setRunInspectorOpen(true)}
        onFailuresClick={() => setSurfaceView("split")}
      />
      <div className="flex min-h-0 flex-1">
        {surfaceView === "chat" ? (
          <div className="min-w-0 flex-1">{conversationContent}</div>
        ) : surfaceView === "split" ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-[280px] flex-[2] border-b border-border/70">
              {graphContent}
            </div>
            <div className="min-h-[280px] flex-[3]">{conversationContent}</div>
          </div>
        ) : (
          <div className="relative h-full min-w-0 flex-1">{graphContent}</div>
        )}

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
          <InspectorPanel
            node={selectedNode}
            nodeRun={selectedNodeRun}
            events={selectedNodeEvents}
            approvals={selectedNodeApprovals}
            artifacts={selectedNodeArtifacts}
            onChooseRecovery={chooseRecovery}
            onResolveApproval={resolveApproval}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}

interface PlanningChatComposerProps {
  messages: PlanningChatMessage[];
  draft: string;
  busy: boolean;
  className?: string;
  onDraftChange: (value: string) => void;
  onAddMessage: () => void;
}

function PlanningChatComposer({
  messages,
  draft,
  busy,
  className,
  onDraftChange,
  onAddMessage,
}: PlanningChatComposerProps) {
  const { t } = useTranslation();
  return (
    <section className={cn("flex h-full flex-col overflow-hidden bg-background", className)}>
      <div className="border-b border-border/70 px-6 py-3">
        <h3 className="text-sm font-semibold">
          {t("tasks.workbench.planningChat.title")}
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("tasks.workbench.planningChat.description")}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-4xl space-y-4">
          <PlanningChatBubble
            role="assistant"
            content={t("tasks.workbench.planningChat.agentIntro")}
          />
          {messages.map((message) => (
            <PlanningChatBubble
              key={message.id}
              role={message.role}
              content={message.content}
            />
          ))}
        </div>
      </div>
      <div className="border-t border-border/70 bg-background px-6 py-3">
        <div className="mx-auto flex max-w-4xl gap-2 rounded-xl border border-border/70 bg-card px-3 py-2 shadow-sm">
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onAddMessage();
              }
            }}
            disabled={busy}
            placeholder={t("tasks.workbench.planningChat.placeholder")}
            rows={2}
            className="min-h-12 flex-1 resize-y bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <Button
            type="button"
            variant="secondary"
            className="self-end"
            disabled={busy || !draft.trim()}
            onClick={onAddMessage}
          >
            <Send className="size-4" />
            {t("tasks.workbench.planningChat.addMessage")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function PlanningChatBubble({
  role,
  content,
}: {
  role: PlanningChatMessage["role"];
  content: string;
}) {
  const isUser = role === "user";
  const Icon = isUser ? User : Bot;
  return (
    <div className={cn("flex gap-3", isUser && "justify-end")}>
      {!isUser && (
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[82%] rounded-lg border px-3 py-2 text-sm leading-6",
          isUser
            ? "border-primary/25 bg-primary text-primary-foreground"
            : "border-border bg-muted/40 text-foreground",
        )}
      >
        {content}
      </div>
      {isUser && (
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </div>
      )}
    </div>
  );
}

interface PlanningSkillSelectorProps {
  skills: TaskPlanSkill[];
  selectedSkillIds: string[];
  installingSkillIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onInstallSkill: (skillId: string) => void;
}

function PlanningSkillSelector({
  skills,
  selectedSkillIds,
  installingSkillIds,
  onSelectionChange,
  onInstallSkill,
}: PlanningSkillSelectorProps) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-2 rounded-xl border border-border bg-background p-4">
      <legend className="px-1 text-sm font-medium">
        {t("tasks.workbench.planningSkills")}
      </legend>
      <p className="text-xs leading-5 text-muted-foreground">
        {t("tasks.workbench.planningSkillsHint")}
      </p>
      <div className="space-y-2">
        {skills.map((skill) => {
          const checked = selectedSkillIds.includes(skill.id);
          return (
            <div
              key={skill.id}
              className={cn(
                "rounded-lg border p-3 text-sm transition",
                checked
                  ? "border-primary/60 bg-primary/5"
                  : "border-border bg-card hover:border-foreground/20",
              )}
            >
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(changeEvent) => {
                    onSelectionChange(
                      changeEvent.target.checked
                        ? [...selectedSkillIds, skill.id]
                        : selectedSkillIds.filter((id) => id !== skill.id),
                    );
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{skill.name}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-medium",
                        skill.installed && skill.valid
                          ? "bg-emerald-500/10 text-emerald-600"
                          : "bg-amber-500/10 text-amber-600",
                      )}
                    >
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
                  onClick={() => onInstallSkill(skill.id)}
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
  );
}

interface ViewModeSwitcherProps {
  value: WorkbenchSurfaceView;
  onChange: (value: WorkbenchSurfaceView) => void;
}

function ViewModeSwitcher({ value, onChange }: ViewModeSwitcherProps) {
  const { t } = useTranslation();
  const modes: Array<{
    value: WorkbenchSurfaceView;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { value: "chat", icon: MessageSquareText },
    { value: "canvas", icon: ClipboardList },
    { value: "split", icon: Activity },
  ];

  return (
    <div
      className="flex items-center rounded-lg border border-border bg-muted/30 p-0.5"
      aria-label={t("tasks.workbench.viewModes.label")}
    >
      {modes.map((mode) => {
        const Icon = mode.icon;
        const label = t(`tasks.workbench.viewModes.${mode.value}`);
        return (
          <Button
            key={mode.value}
            type="button"
            size="sm"
            variant={value === mode.value ? "secondary" : "ghost"}
            onClick={() => onChange(mode.value)}
            aria-label={label}
            aria-pressed={value === mode.value}
            title={label}
            className="h-7 gap-1.5 px-2"
          >
            <Icon className="size-3.5" />
            <span className="hidden text-xs lg:inline">{label}</span>
          </Button>
        );
      })}
    </div>
  );
}

interface TaskContextBarProps {
  runId: string | null;
  runStatus: string | null;
  revisionId: string | null;
  approvalCount: number;
  failedNodeCount: number;
  onApprovalsClick: () => void;
  onFailuresClick: () => void;
}

function TaskContextBar({
  runId,
  runStatus,
  revisionId,
  approvalCount,
  failedNodeCount,
  onApprovalsClick,
  onFailuresClick,
}: TaskContextBarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-11 items-center gap-2 overflow-x-auto border-b border-border/70 bg-card/70 px-4 py-2 text-xs">
      <ContextPill label={t("tasks.workbench.context.run")} value={runId ?? "-"} />
      <ContextPill
        label={t("tasks.workbench.context.status")}
        value={runStatus ?? t("tasks.workbench.context.notRunning")}
      />
      <ContextPill
        label={t("tasks.workbench.context.revision")}
        value={revisionId ?? "-"}
      />
      <button
        type="button"
        onClick={onApprovalsClick}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 transition hover:bg-muted"
      >
        <span className="text-muted-foreground">
          {t("tasks.workbench.context.approvals")}
        </span>
        <span className="font-mono font-medium">{approvalCount}</span>
      </button>
      <button
        type="button"
        onClick={onFailuresClick}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 transition hover:bg-muted",
          failedNodeCount > 0
            ? "border-destructive/40 bg-destructive/5 text-destructive"
            : "border-border bg-background",
        )}
      >
        <span className={failedNodeCount > 0 ? "" : "text-muted-foreground"}>
          {t("tasks.workbench.context.failures")}
        </span>
        <span className="font-mono font-medium">{failedNodeCount}</span>
      </button>
    </div>
  );
}

function ContextPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-48 truncate font-mono font-medium">{value}</span>
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
  onDelete: (task: TaskGraph) => Promise<void>;
  deletingGraphIds: string[];
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
  onDelete,
  deletingGraphIds,
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
                <article
                  key={task.graph_id}
                  className="group rounded-2xl border border-border/70 bg-card p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{task.title}</h3>
                      <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">
                        {task.goal}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onOpen(task.graph_id).catch(console.error)}
                      >
                        {t("tasks.openTask")}
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        disabled={deletingGraphIds.includes(task.graph_id)}
                        onClick={() => onDelete(task).catch(console.error)}
                        aria-label={t("tasks.deleteTaskWithTitle", {
                          title: task.title,
                        })}
                        title={t("tasks.deleteTask")}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-5 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                    {t("tasks.updatedAt", {
                      time: formatter.format(new Date(task.updated_at)),
                    })}
                  </div>
                </article>
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
