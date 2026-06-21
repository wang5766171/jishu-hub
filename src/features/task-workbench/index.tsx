import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  ArrowLeft,
  ClipboardList,
  ChevronDown,
  FolderOpen,
  MessageSquareText,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { ChatInput } from "@/components/sessions/chat-input";
import { MessageView } from "@/components/sessions/message-view";
import { StreamingMessage } from "@/components/sessions/streaming-message";
import { Button } from "@/components/ui/button";
import { invokeCommand } from "@/hooks/use-invoke";
import { useSessionStream, type InteractionSplit } from "@/hooks/use-stream-store";
import { formatInteractionResponseValue } from "@/lib/conversation-interaction";
import { cn } from "@/lib/utils";
import type { ConversationInteractionRequest, ConversationInteractionSubmission, Message } from "@/types";
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
  initialPlanInstruction?: string | null;
  onClose?: () => void;
}

type WorkbenchView = "list" | "create" | "graph";
type WorkbenchSurfaceView = "chat" | "canvas" | "split";
type TaskCreationMode = "discussion" | "direct";

export function TaskWorkbench({
  initialProjectPath,
  initialGraphId,
  initialPlanInstruction,
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
  const [planningMessages, setPlanningMessages] = useState<PlanningChatMessage[]>([]);
  const [planningDraft, setPlanningDraft] = useState("");
  const [planningSessionId, setPlanningSessionId] = useState<string | null>(null);
  const [discussionMessages, setDiscussionMessages] = useState<Message[]>([]);
  const [taskCreationMode, setTaskCreationMode] = useState<TaskCreationMode>("discussion");
  const [skills, setSkills] = useState<TaskPlanSkill[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [deletingGraphIds, setDeletingGraphIds] = useState<string[]>([]);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingInitialPlan, setPendingInitialPlan] = useState<string | null>(null);
  const messageAreaRef = useRef<HTMLDivElement | null>(null);
  const planningStream = useSessionStream(planningSessionId);

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
      setPendingInitialPlan(initialPlanInstruction ?? null);
      loadGraph(initialGraphId).catch(console.error);
    } else {
      setView("create");
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

  const loadDiscussionMessages = useCallback(async (sessionId: string | null) => {
    if (!sessionId || sessionId.startsWith("pending-")) return;
    try {
      const messages = await invokeCommand<Message[]>("get_session_messages", {
        sessionId,
      });
      setDiscussionMessages(messages);
    } catch (loadError) {
      console.warn("Failed to load task planning discussion messages:", loadError);
    }
  }, []);

  useEffect(() => {
    const resolvedId = planningStream?.resolvedId;
    if (resolvedId && resolvedId !== planningSessionId) {
      setPlanningSessionId(resolvedId);
      loadDiscussionMessages(resolvedId).catch(console.error);
    }
  }, [loadDiscussionMessages, planningSessionId, planningStream?.resolvedId]);

  useEffect(() => {
    if (!planningSessionId) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<unknown>("agent-event", (event) => {
      const chunks = Array.isArray(event.payload) ? event.payload : [event.payload];
      for (const raw of chunks) {
        const chunk = raw as {
          session_id?: string;
          data?: { kind?: string; session_id?: string };
        };
        const chunkSessionId = chunk.session_id;
        const resolvedId = chunk.data?.kind === "session_resolved"
          ? chunk.data.session_id
          : null;
        const matches = chunkSessionId === planningSessionId || resolvedId === planningSessionId;
        if (!matches) continue;
        if (resolvedId && resolvedId !== planningSessionId) {
          setPlanningSessionId(resolvedId);
        }
        if (chunk.data?.kind === "turn_complete") {
          window.setTimeout(() => {
            if (!cancelled) {
              loadDiscussionMessages(resolvedId || chunkSessionId || planningSessionId)
                .catch(console.error);
            }
          }, 120);
        }
      }
    }).then((dispose) => {
      unlisten = dispose;
      if (cancelled) dispose();
    }).catch(console.error);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadDiscussionMessages, planningSessionId]);

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
  const planningChatMessages = useMemo(() => {
    return taskCreationMode === "discussion"
      ? discussionMessages
      : planningMessagesToMessages(planningMessages);
  }, [discussionMessages, planningMessages, taskCreationMode]);

  const planningTranscriptMessages = useMemo(
    () => {
      if (planningMessages.length === 0 && !planningText.trim()) return [];
      return planningMessagesToMessages(
        planningText.trim()
          ? [...planningMessages, createPlanningMessage(planningText, "assistant")]
          : planningMessages,
      );
    },
    [planningMessages, planningText],
  );

  const createTaskFromPlanningMessages = useCallback(async (
    messagesForSubmit: PlanningChatMessage[],
  ) => {
    const instruction = buildPlanningInstruction(messagesForSubmit);
    if (!instruction || !initialProjectPath) return;
    setFormBusy(true);
    setFormError(null);
    try {
      const selected = skills.find((skill) => skill.id === selectedSkillIds[0]);
      if (!selected?.installed || !selected.valid) {
        throw new Error(t("tasks.installSkillFirst"));
      }
      const skillRefs = [{
        skill_id: selected.id,
        version_or_hash: selected.content_hash,
        inputs: {},
      }];
      setPendingInitialPlan(instruction);
      await createGraph(
        derivePlanningTitle("", messagesForSubmit),
        instruction,
        initialProjectPath,
        skillRefs,
      );
      setPlanningDraft("");
      setView("graph");
      setSurfaceView("split");
    } catch (submitError) {
      setPendingInitialPlan(null);
      setFormError(String(submitError));
    } finally {
      setFormBusy(false);
    }
  }, [createGraph, initialProjectPath, selectedSkillIds, skills, t]);

  const discussionPlanningMessages = useCallback((): PlanningChatMessage[] => {
    return messagesToPlanningMessages(discussionMessages);
  }, [discussionMessages]);

  const beforePlanningSend = useCallback(async (message: string) => {
    const userMessage = createPlanningMessage(message);
    if (taskCreationMode === "direct") {
      await createTaskFromPlanningMessages([userMessage]);
      return true;
    }
    return false;
  }, [createTaskFromPlanningMessages, taskCreationMode]);

  const handlePlanningMessageSent = useCallback((sessionId: string) => {
    setPlanningSessionId(sessionId);
  }, []);

  const activePlanningInteraction = useMemo(() => {
    const pending = planningStream?.interactionSplits.find((item) => !item.text?.trim());
    if (!pending) return null;
    return interactionSplitToRequest(pending);
  }, [planningStream?.interactionSplits]);

  const handlePlanningInteractionSubmit = useCallback(async (
    submission: ConversationInteractionSubmission,
  ) => {
    if (!planningSessionId || !activePlanningInteraction) return;
    const value = formatInteractionResponseValue(activePlanningInteraction, submission);
    await invokeCommand("respond_chat_interaction", {
      sessionId: planningSessionId,
      requestId: submission.requestId,
      value,
      origin: activePlanningInteraction.origin,
    });
    if (isGenerateTaskConfirmation(activePlanningInteraction, submission)) {
      await createTaskFromPlanningMessages(discussionPlanningMessages());
    }
  }, [
    activePlanningInteraction,
    createTaskFromPlanningMessages,
    discussionPlanningMessages,
    planningSessionId,
  ]);

  const continuePlanning = useCallback(async (message: string) => {
    const nextMessages = [
      ...planningMessages,
      ...(planningText.trim() ? [createPlanningMessage(planningText, "assistant")] : []),
      createPlanningMessage(message),
    ];
    setPlanningMessages(nextMessages);
    const instruction = buildPlanningInstruction(nextMessages);
    if (instruction) {
      await generateProposal(instruction);
    }
  }, [generateProposal, planningMessages, planningText]);

  const beginCreate = useCallback(() => {
    clearGraph();
    setSelectedNodeId(null);
    setRunInspectorOpen(false);
    setPlanningMessages([]);
    setPlanningDraft("");
    setPlanningSessionId(null);
    setDiscussionMessages([]);
    setTaskCreationMode("discussion");
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
      const confirmed = await confirm(
        t("tasks.deleteTaskConfirm", { title: task.title }),
        { title: t("tasks.deleteTask"), kind: "warning" },
      );
      if (!confirmed) {
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
    const projectDisplayName = getProjectDisplayName(initialProjectPath);
    const createComposerFooter = (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/40 bg-muted/45 px-4 py-2.5 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--icon-folder)]" />
          <span className="truncate font-medium text-foreground" title={projectDisplayName}>
            {projectDisplayName}
          </span>
        </span>
        <label className="relative inline-flex min-w-0 items-center gap-1.5">
          <ClipboardList className="h-3.5 w-3.5 shrink-0 text-[var(--icon-action)]" />
          <select
            aria-label={t("tasks.creationMode.label")}
            value={taskCreationMode}
            onChange={(event) => setTaskCreationMode(event.target.value as TaskCreationMode)}
            className="h-6 appearance-none rounded-md border border-input bg-background/80 py-0 pl-2 pr-6 text-xs text-foreground outline-none transition focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
          >
            <option value="discussion">{t("tasks.creationMode.discussion")}</option>
            <option value="direct">{t("tasks.creationMode.direct")}</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground" />
        </label>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="truncate">Jishu Agent</span>
        </span>
        {initialProjectPath && (
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[0.92em]" title={`${t("sessions.projectPath")}: ${initialProjectPath}`}>
            {initialProjectPath}
          </span>
        )}
      </div>
    );

    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-background">
        <WorkbenchHeader
          title={t("tasks.newTask")}
          subtitle={initialProjectPath || t("tasks.projectPathPlaceholder")}
          onBack={returnToList}
          onClose={onClose}
        />
        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onSubmit={async (event) => {
            event.preventDefault();
            const messagesForSubmit = planningDraft.trim()
              ? [...discussionPlanningMessages(), createPlanningMessage(planningDraft)]
              : discussionPlanningMessages();
            await createTaskFromPlanningMessages(messagesForSubmit);
          }}
        >
          <main className="flex min-w-0 flex-1 flex-col bg-background">
            <PlanningChatSurface
              messages={planningChatMessages}
              projectPath={initialProjectPath ?? null}
              busy={formBusy}
              className="min-h-0 flex-1"
              startPrompt={t("tasks.createPrompt", { project: projectDisplayName })}
              contextFooter={createComposerFooter}
              onDraftChange={setPlanningDraft}
              streamSessionId={planningSessionId}
              streamActive={Boolean(planningStream?.isStreaming)}
              scrollContainerRef={messageAreaRef}
              interactionRequest={activePlanningInteraction}
              onInteractionSubmit={handlePlanningInteractionSubmit}
              onBeforeSend={beforePlanningSend}
              onMessageSent={handlePlanningMessageSent}
              useNativeConversation={taskCreationMode === "discussion"}
            />
            {(error || formError) && (
              <div className="border-t border-border/70 px-6 py-2">
                {error && <p className="text-sm text-destructive">{error}</p>}
                {formError && <p className="text-sm text-destructive">{formError}</p>}
              </div>
            )}
          </main>
        </form>
      </div>
    );
  }

  const unresolvedApprovalCount = approvals.filter((approval) => !approval.resolved).length;
  const failedNodeCount = Object.values(nodeRuns).filter(
    (nodeRun) => nodeRun.status === "failed",
  ).length;

  const graphContent = planningProgress ? (
    <PlanningProgressOverlay
      progress={planningProgress}
      text={planningText}
      projectPath={graph?.project_root ?? initialProjectPath ?? null}
      turnActive={planning}
      onSubmitMessage={continuePlanning}
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
      extraMessages={planningTranscriptMessages}
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

interface PlanningChatSurfaceProps {
  messages: Message[];
  projectPath: string | null;
  busy: boolean;
  className?: string;
  startPrompt?: string;
  contextFooter?: ReactNode;
  streamSessionId?: string | null;
  streamActive?: boolean;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  interactionRequest?: ConversationInteractionRequest | null;
  onDraftChange?: (value: string) => void;
  onInteractionSubmit?: (submission: ConversationInteractionSubmission) => void | Promise<void>;
  onBeforeSend?: (message: string) => Promise<boolean | void> | boolean | void;
  onMessageSent?: (sessionId: string, message: string) => void;
  useNativeConversation?: boolean;
}

function PlanningChatSurface({
  messages,
  projectPath,
  busy,
  className,
  startPrompt,
  contextFooter,
  streamSessionId,
  streamActive = false,
  scrollContainerRef,
  interactionRequest,
  onDraftChange,
  onInteractionSubmit,
  onBeforeSend,
  onMessageSent,
  useNativeConversation = false,
}: PlanningChatSurfaceProps) {
  const { t } = useTranslation();
  const empty = messages.length === 0 && !streamActive;
  return (
    <section className={cn("flex h-full flex-col overflow-hidden bg-background", className)}>
      <div
        ref={scrollContainerRef}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-2 py-5",
          empty && "hidden",
        )}
      >
        <MessageView messages={messages} flat />
        {streamSessionId && streamActive && (
          <StreamingMessage
            sessionId={streamSessionId}
            scrollContainerRef={scrollContainerRef}
          />
        )}
      </div>
      <div
        className={cn(
          "bg-background/95",
          empty
            ? "flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10"
            : "border-t border-border/60",
        )}
      >
        {empty && startPrompt && (
          <h1 className="mb-14 w-full max-w-[var(--message-content-max-width)] text-center text-[2rem] font-medium leading-tight tracking-normal text-foreground">
            {startPrompt}
          </h1>
        )}
        <div
          className={cn(
            "w-full transition-transform duration-300 ease-out",
            empty
              ? "max-w-[var(--message-content-max-width)]"
              : "max-w-none translate-y-0",
          )}
        >
          <ChatInput
            sessionId={useNativeConversation ? streamSessionId ?? null : null}
            projectPath={projectPath ?? ""}
            allowFiles={Boolean(projectPath)}
            agentDisplayName="Jishu Agent"
            disabled={busy || !projectPath}
            placeholder={t("tasks.workbench.planningChat.placeholder")}
            onDraftChange={onDraftChange}
            onBeforeSend={onBeforeSend}
            onMessageSent={onMessageSent}
            interactionRequest={interactionRequest}
            onInteractionSubmit={onInteractionSubmit}
            containerClassName={cn(
              empty
                ? "max-w-none px-0 pb-0 pt-0"
                : "px-4 pb-4 pt-3",
            )}
            panelClassName={cn(
              empty
                ? "rounded-[22px] border-border/70 bg-card/98 shadow-[0_18px_48px_rgba(0,0,0,0.10)]"
                : "rounded-2xl bg-card",
            )}
            contextFooter={contextFooter}
          />
        </div>
      </div>
    </section>
  );
}

function getProjectDisplayName(projectPath?: string | null): string {
  if (!projectPath) return "";
  const normalized = projectPath.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || projectPath;
}

function shouldGenerateFromDiscussion(
  message: string,
  currentMessages: PlanningChatMessage[],
): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  const hasPriorUserMessage = currentMessages.some((item) => item.role === "user");
  if (!hasPriorUserMessage) return false;
  return [
    "生成任务流程图",
    "生成流程图",
    "开始生成",
    "确认生成",
    "同意生成",
    "没问题",
    "可以生成",
    "generate workflow",
    "generate task",
    "create workflow",
    "looks good",
  ].some((phrase) => normalized.includes(phrase));
}

void shouldGenerateFromDiscussion;

function interactionSplitToRequest(split: InteractionSplit): ConversationInteractionRequest {
  return {
    requestId: split.requestId,
    prompt: split.prompt,
    options: split.options.map((option) => ({
      optionId: option.option_id,
      label: option.label,
      description: option.description ?? null,
    })),
    allowMultiple: false,
    allowCustomText: true,
    required: true,
    origin: split.origin as ConversationInteractionRequest["origin"],
  };
}

function isGenerateTaskConfirmation(
  request: ConversationInteractionRequest,
  submission: ConversationInteractionSubmission,
): boolean {
  const selectedTexts = submission.selectedOptionIds.map((optionId) => {
    const option = request.options.find((item) => item.optionId === optionId);
    return `${optionId} ${option?.label ?? ""} ${option?.description ?? ""}`;
  });
  const text = [request.prompt, ...selectedTexts, submission.customText]
    .join("\n")
    .toLowerCase();
  return [
    "生成任务",
    "生成流程",
    "流程图",
    "generate workflow",
    "generate task",
    "create workflow",
  ].some((phrase) => text.includes(phrase));
}

function messagesToPlanningMessages(messages: Message[]): PlanningChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) =>
      createPlanningMessage(
        message.content
          .map((block) => {
            if (block.type === "text") return block.text;
            if (block.type === "thinking") return block.thinking;
            if (block.type === "interaction") {
              return [block.prompt, block.answer, ...(block.selected_options ?? [])]
                .filter(Boolean)
                .join("\n");
            }
            return "";
          })
          .filter(Boolean)
          .join("\n")
          .trim(),
        message.role === "user" ? "user" : "assistant",
      ),
    )
    .filter((message) => message.content.length > 0);
}

function planningMessagesToMessages(messages: PlanningChatMessage[]): Message[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({
      role: message.role,
      content: [{ type: "text" as const, text: message.content }],
      timestamp: null,
    }));
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
