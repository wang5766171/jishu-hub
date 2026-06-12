import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useTaskGraph } from "./use-task-graph";
import { GraphEditor } from "./graph-editor";
import { NodeSidebar } from "./node-sidebar";
import { RunInspector } from "./run-inspector";
import { ProposalReview } from "./proposal-review";

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
  onClose?: () => void;
}

export function TaskWorkbench({ initialProjectPath, onClose }: TaskWorkbenchProps) {
  const { t } = useTranslation();
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
    startRun,
    pollRunProjection,
    loadLatestGraphForProject,
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [initializedProject, setInitializedProject] = useState<string | null>(null);
  const [skills, setSkills] = useState<TaskPlanSkill[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingInitialPlan, setPendingInitialPlan] = useState<string | null>(null);

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
    if (!initialProjectPath || initializedProject === initialProjectPath) return;
    setInitializedProject(initialProjectPath);
    loadLatestGraphForProject(initialProjectPath).catch(console.error);
  }, [initialProjectPath, initializedProject, loadLatestGraphForProject]);

  useEffect(() => {
    if (!activeRunId) return;
    pollRunProjection();

    const interval = setInterval(() => {
      pollRunProjection();
    }, 1000);

    return () => clearInterval(interval);
  }, [activeRunId, pollRunProjection]);

  useEffect(() => {
    if (!pendingInitialPlan || !graph || planning) return;
    const instruction = pendingInitialPlan;
    setPendingInitialPlan(null);
    generateProposal(instruction).catch(console.error);
  }, [generateProposal, graph, pendingInitialPlan, planning]);

  const selectedNode = snapshot?.nodes.find((n) => n.node_id === selectedNodeId) || null;

  if (!graph && !loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-6">
        <form
          className="w-full max-w-xl space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!goal.trim() || !initialProjectPath) return;
            setFormBusy(true);
            setFormError(null);
            try {
              const selected = skills.filter((skill) => selectedSkillIds.includes(skill.id));
              const resolvedSkills = await Promise.all(
                selected.map(async (skill) => {
                  if (skill.installed && skill.valid) return skill;
                  return invoke<TaskPlanSkill>("task_plan_skill_install", {
                    skillId: skill.id,
                  });
                }),
              );
              const skillRefs = resolvedSkills.map((skill) => ({
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
            } catch (submitError) {
              setPendingInitialPlan(null);
              setFormError(String(submitError));
            } finally {
              setFormBusy(false);
            }
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{t("tasks.startTask")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("tasks.description")}</p>
            </div>
            {onClose && (
              <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
                {t("tasks.close")}
              </button>
            )}
          </div>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">{t("tasks.taskTitle")}</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("tasks.taskTitlePlaceholder")}
              className="w-full rounded-md border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">{t("tasks.taskGoal")}</span>
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder={t("tasks.taskGoalPlaceholder")}
              rows={5}
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
          <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {initialProjectPath || t("tasks.projectPathPlaceholder")}
          </div>
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
                    <label
                      key={skill.id}
                      className={`rounded-lg border p-3 text-sm transition ${
                        checked
                          ? "border-primary/60 bg-primary/5"
                          : "border-border bg-background"
                      }`}
                    >
                      <span className="flex items-start gap-2">
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
                          <span className="font-medium">{skill.name}</span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {skill.description || skill.id}
                          </span>
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <button
            type="submit"
            disabled={!goal.trim() || !initialProjectPath || formBusy}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {formBusy ? t("tasks.workbench.preparingTask") : t("tasks.startTask")}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full bg-background overflow-hidden relative">
      <div className="flex-1 h-full relative">
        {loading && !graph ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full text-destructive">
            {error}
          </div>
        ) : snapshot ? (
          <GraphEditor 
            snapshot={snapshot} 
            onNodeSelect={setSelectedNodeId} 
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

      {displayedRunId && (
        <RunInspector
          runId={displayedRunId}
          events={events}
          approvals={approvals}
          artifacts={artifacts}
          revisions={revisions}
          currentRevisionId={graph?.current_draft_revision}
          onResolveApproval={resolveApproval}
        />
      )}

      {selectedNode && (
        <NodeSidebar node={selectedNode} onClose={() => setSelectedNodeId(null)} />
      )}

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
