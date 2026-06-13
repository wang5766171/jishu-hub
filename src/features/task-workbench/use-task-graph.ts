import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { planPoll, filterUnseenEvents } from "./polling-delta";

export type JsonObject = Record<string, unknown>;

interface TaskError {
  code?: string;
  message_key?: string;
  remediation?: string | null;
}

function taskErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const taskError = error as TaskError;
    if (taskError.message_key) {
      return taskError.remediation
        ? `${taskError.message_key} ${taskError.remediation}`
        : taskError.message_key;
    }
  }
  return String(error);
}

export interface TaskGraph {
  graph_id: string;
  title: string;
  goal: string;
  project_root: string;
  owner: string;
  current_draft_revision: string | null;
  created_at: number;
  updated_at: number;
}

export interface GraphNode {
  node_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  node_kind: string;
  input_contract: JsonObject;
  output_contract: JsonObject;
  role_requirement: JsonObject | null;
  capability_requirements: string[];
  agent_assignment_constraint: JsonObject | null;
  policy: JsonObject;
  metadata: JsonObject;
  executable_payload: JsonObject | null;
  loop_config: JsonObject | null;
  approval_gate_config: JsonObject | null;
}

export interface GraphEdge {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  kind: "control_dependency" | "data_dependency";
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphRevision {
  revision_id: string;
  graph_id: string;
  parent_revision_id: string | null;
  schema_version: string;
  canonical_snapshot: {
    json: string;
  };
  content_hash: string;
  skill_refs: JsonObject[];
  template_refs: JsonObject[];
  planner_policy_refs: JsonObject[];
  change_summary: string;
  author: string;
  created_at: number;
}

export type NodeRunStatus =
  | "blocked"
  | "ready"
  | "leased"
  | "running"
  | "awaiting_approval"
  | "retry_wait"
  | "repairing"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "superseded";

export interface NodeRun {
  node_run_id: string;
  run_id: string;
  node_id: string;
  status: NodeRunStatus;
  revision_id: string;
  started_at: number | null;
  finished_at: number | null;
  attempt_count: number;
  error: string | null;
}

export interface GraphRun {
  run_id: string;
  graph_id: string;
  active_revision_id: string;
  status: string;
  run_seq: number;
  budget_state: JsonObject;
  planning_snapshot: JsonObject;
  started_at: number;
  finished_at: number | null;
}

export interface RunRevisionProposal {
  proposal_id: string;
  run_id: string;
  base_revision_id: string;
  candidate_revision_id: string;
  expected_run_seq: number;
  frozen_node_ids: string[];
  superseded_node_ids: string[];
  created_at: number;
}

export interface NodeRunProjection {
  node_run_id: string;
  node_id: string;
  status: NodeRunStatus;
  attempt_count: number;
  current_attempt_id: string | null;
  wake_at: number | null;
  error: string | null;
}

export interface RunProjection {
  run_id: string;
  graph_id: string;
  revision_id: string;
  status: string;
  run_seq: number;
  node_runs: Record<string, NodeRunProjection>;
}

export interface TaskEvent {
  event_id: string;
  run_id: string;
  run_seq: number;
  event_type: string;
  occurred_at: number;
  actor: string;
  payload: JsonObject | null;
}

export interface ApprovalRequest {
  approval_id: string;
  run_id: string;
  node_run_id: string;
  description: string;
  risk_level: string;
  scope: string[];
  resolved: boolean;
  approved: boolean | null;
  created_at: number;
}

export interface ArtifactRef {
  artifact_id: string;
  run_id: string;
  node_run_id: string;
  attempt_id: string;
  name: string;
  artifact_type: string;
  hash: string;
  sensitivity: string;
  created_at: number;
  metadata: JsonObject;
}

export type GraphCommand = {
  op: string;
  command_id: string;
  [key: string]: unknown;
};

export interface RevisionDiff {
  from_revision_id: string;
  to_revision_id: string;
  nodes_added: string[];
  nodes_removed: string[];
  nodes_updated: Array<{ node_id: string; changes: string[] }>;
  edges_added: string[];
  edges_removed: string[];
  policy_changes: JsonObject[];
}

export interface GraphProposal {
  proposal_id: string;
  graph_id: string;
  base_revision_id: string;
  commands: GraphCommand[];
  rationale: string;
  expected_benefits: string[];
  risks: string[];
  warnings: string[];
  diff: RevisionDiff;
  planner_assignment: JsonObject;
  skill_refs: JsonObject[];
  template_refs: JsonObject[];
  planner_policy_refs: JsonObject[];
}

export interface PlanningProgress {
  graph_id: string;
  stage:
    | "preparing_context"
    | "resolving_agent"
    | "generating"
    | "validating"
    | "retrying"
    | "building_proposal"
    | "completed"
    | "failed";
  attempt: number | null;
  max_attempts: number | null;
}

function snapshotFromRevision(revision: GraphRevision): GraphSnapshot {
  return JSON.parse(revision.canonical_snapshot.json) as GraphSnapshot;
}

function nodeRunMapFromProjection(projection: RunProjection): Record<string, NodeRun> {
  const runMap: Record<string, NodeRun> = {};
  Object.values(projection.node_runs).forEach((nodeRun) => {
    runMap[nodeRun.node_id] = {
      node_run_id: nodeRun.node_run_id,
      run_id: projection.run_id,
      node_id: nodeRun.node_id,
      status: nodeRun.status,
      revision_id: projection.revision_id,
      started_at: null,
      finished_at: null,
      attempt_count: nodeRun.attempt_count,
      error: nodeRun.error,
    };
  });
  return runMap;
}

export function useTaskGraph() {
  const [graph, setGraph] = useState<TaskGraph | null>(null);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [revision, setRevision] = useState<GraphRevision | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunRevisionId, setActiveRunRevisionId] = useState<string | null>(null);
  const [activeRunSeq, setActiveRunSeq] = useState<number | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [nodeRuns, setNodeRuns] = useState<Record<string, NodeRun>>({});
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([]);
  const [revisions, setRevisions] = useState<GraphRevision[]>([]);
  const [redoRevisionIds, setRedoRevisionIds] = useState<string[]>([]);
  const [proposal, setProposal] = useState<GraphProposal | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planningProgress, setPlanningProgress] = useState<PlanningProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventRunRef = useRef<string | null>(null);
  const eventCursorRef = useRef(0);

  useEffect(() => {
    if (!graph?.graph_id) return;
    const graphId = graph.graph_id;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<PlanningProgress>("task-planning-progress", (event) => {
      if (!disposed && event.payload.graph_id === graphId) {
        setPlanningProgress(event.payload);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [graph?.graph_id]);

  const loadRunDetails = useCallback(async (runId: string) => {
    if (eventRunRef.current !== runId) {
      eventRunRef.current = runId;
      eventCursorRef.current = 0;
      setEvents([]);
    }
    const [nextEvents, nextApprovals, nextArtifacts] = await Promise.all([
      invoke<TaskEvent[]>("orchestrator_run_events_after", {
        runId,
        afterSeq: eventCursorRef.current,
      }),
      invoke<ApprovalRequest[]>("orchestrator_pending_approvals", { runId }),
      invoke<ArtifactRef[]>("orchestrator_list_artifacts", { runId }),
    ]);
    if (nextEvents.length > 0) {
      eventCursorRef.current = nextEvents[nextEvents.length - 1].run_seq;
      setEvents((current) => {
        const unseen = filterUnseenEvents(current, nextEvents);
        return unseen.length === 0 ? current : [...current, ...unseen];
      });
    }
    setApprovals(nextApprovals);
    setArtifacts(nextArtifacts);
  }, []);

  const restoreLatestRun = useCallback(async (graphId: string) => {
    const runs = await invoke<GraphRun[]>("orchestrator_list_runs", { graphId });
    const active = runs.find((run) =>
      ["running", "paused", "awaiting_human"].includes(run.status),
    );
    const displayed = active ?? runs[0] ?? null;
    setActiveRunId(active?.run_id ?? null);
    setActiveRunRevisionId(active?.active_revision_id ?? null);
    setActiveRunSeq(active?.run_seq ?? null);
    setLastRunId(active ? null : displayed?.run_id ?? null);
    setRunStatus(displayed?.status ?? null);
    if (!displayed) {
      setNodeRuns({});
      setEvents([]);
      setApprovals([]);
      setArtifacts([]);
      return;
    }
    const projection = await invoke<RunProjection>("orchestrator_get_run_projection", {
      runId: displayed.run_id,
    });
    setNodeRuns(nodeRunMapFromProjection(projection));
    await loadRunDetails(displayed.run_id);
  }, [loadRunDetails]);

  const loadGraph = useCallback(async (graphId: string) => {
    setLoading(true);
    setError(null);
    try {
      const g = await invoke<TaskGraph>("orchestrator_get_graph", { graphId });
      setGraph(g);
      
      const revisionPromise = g.current_draft_revision
        ? invoke<GraphRevision>("orchestrator_get_revision", {
            revisionId: g.current_draft_revision,
          })
        : Promise.resolve(null);
      const [rev, revisionList] = await Promise.all([
        revisionPromise,
        invoke<GraphRevision[]>("orchestrator_list_revisions", { graphId }),
      ]);
      if (rev) {
        setRevision(rev);
        setSnapshot(snapshotFromRevision(rev));
      } else {
        setRevision(null);
        setSnapshot({ nodes: [], edges: [] });
      }
      setRevisions(revisionList);
      setRedoRevisionIds([]);
      setProposal(null);
      await restoreLatestRun(graphId);
    } catch (err: unknown) {
      console.error(err);
      setError(taskErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [restoreLatestRun]);

  const clearGraph = useCallback(() => {
    setGraph(null);
    setSnapshot(null);
    setRevision(null);
    setActiveRunId(null);
    setActiveRunRevisionId(null);
    setActiveRunSeq(null);
    setLastRunId(null);
    setRunStatus(null);
    setNodeRuns({});
    setEvents([]);
    setApprovals([]);
    setArtifacts([]);
    setRevisions([]);
    setRedoRevisionIds([]);
    setProposal(null);
    setError(null);
    eventRunRef.current = null;
    eventCursorRef.current = 0;
  }, []);

  const loadLatestGraphForProject = useCallback(async (projectRoot: string) => {
    setLoading(true);
    setError(null);
    try {
      const g = await invoke<TaskGraph | null>("orchestrator_get_latest_graph_for_project", {
        projectRoot,
      });
      if (!g) {
        setGraph(null);
        setRevision(null);
        setSnapshot(null);
        setActiveRunId(null);
        setActiveRunRevisionId(null);
        setActiveRunSeq(null);
        setLastRunId(null);
        setRunStatus(null);
        setNodeRuns({});
        setRedoRevisionIds([]);
        return false;
      }
      setGraph(g);
      const revisionPromise = g.current_draft_revision
        ? invoke<GraphRevision>("orchestrator_get_revision", {
            revisionId: g.current_draft_revision,
          })
        : Promise.resolve(null);
      const [rev, revisionList] = await Promise.all([
        revisionPromise,
        invoke<GraphRevision[]>("orchestrator_list_revisions", {
          graphId: g.graph_id,
        }),
      ]);
      if (rev) {
        setRevision(rev);
        setSnapshot(snapshotFromRevision(rev));
      } else {
        setRevision(null);
        setSnapshot({ nodes: [], edges: [] });
      }
      setRevisions(revisionList);
      setRedoRevisionIds([]);
      await restoreLatestRun(g.graph_id);
      return true;
    } catch (err: unknown) {
      console.error(err);
      setError(taskErrorMessage(err));
      return false;
    } finally {
      setLoading(false);
    }
  }, [restoreLatestRun]);

  const createGraph = useCallback(async (
    title: string,
    goal: string,
    projectRoot: string,
    skillRefs: JsonObject[] = [],
  ) => {
    setLoading(true);
    setError(null);
    try {
      const [g, rev] = await invoke<[TaskGraph, GraphRevision]>("orchestrator_create_graph", {
        input: {
          title,
          goal,
          project_root: projectRoot,
          owner: "local_user",
          skill_refs: skillRefs,
        }
      });
      setGraph(g);
      setRevision(rev);
      setSnapshot(snapshotFromRevision(rev));
      setRevisions([rev]);
      setRedoRevisionIds([]);
      setActiveRunId(null);
      setActiveRunRevisionId(null);
      setActiveRunSeq(null);
      setLastRunId(null);
      setRunStatus(null);
      setNodeRuns({});
      setEvents([]);
      setApprovals([]);
      setArtifacts([]);
      setProposal(null);
      return g;
    } catch (err: unknown) {
      console.error(err);
      setError(taskErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const generateProposal = useCallback(async (instruction?: string) => {
    if (!graph || !revision) return null;
    setPlanning(true);
    setPlanningProgress({
      graph_id: graph.graph_id,
      stage: "preparing_context",
      attempt: null,
      max_attempts: 2,
    });
    setError(null);
    try {
      const nextProposal = await invoke<GraphProposal>("orchestrator_generate_proposal", {
        request: {
          graph_id: graph.graph_id,
          base_revision_id: revision.revision_id,
          instruction: instruction?.trim() || graph.goal,
        },
      });
      setProposal(nextProposal);
      return nextProposal;
    } catch (err: unknown) {
      console.error(err);
      setError(taskErrorMessage(err));
      throw err;
    } finally {
      setPlanning(false);
      setPlanningProgress(null);
    }
  }, [graph, revision]);

  const applyCommands = useCallback(async (commands: GraphCommand[]) => {
    if (!graph || !revision) return;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<{ revision: GraphRevision }>("orchestrator_apply_commands", {
        graphId: graph.graph_id,
        expectedRevisionId: revision.revision_id,
        commands,
        author: "local_user"
      });
      
      const newRev = result.revision as GraphRevision;
      setRevision(newRev);
      setSnapshot(snapshotFromRevision(newRev));
      
      // Update graph draft ref
      setGraph(g => g ? { ...g, current_draft_revision: newRev.revision_id } : null);
      setRevisions((current) => [...current, newRev]);
      setRedoRevisionIds([]);
    } catch (err: unknown) {
      console.error(err);
      setError(taskErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [graph, revision]);

  const checkoutDraftRevision = useCallback(async (targetRevisionId: string) => {
    if (!graph || !revision) return null;
    setLoading(true);
    setError(null);
    try {
      const target = await invoke<GraphRevision>("orchestrator_checkout_draft_revision", {
        graphId: graph.graph_id,
        expectedRevisionId: revision.revision_id,
        targetRevisionId,
      });
      setRevision(target);
      setSnapshot(snapshotFromRevision(target));
      setGraph((current) =>
        current
          ? { ...current, current_draft_revision: target.revision_id }
          : null,
      );
      setProposal(null);
      return target;
    } catch (err: unknown) {
      console.error(err);
      setError(taskErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [graph, revision]);

  const undo = useCallback(async () => {
    if (!revision?.parent_revision_id) return;
    const currentRevisionId = revision.revision_id;
    const target = await checkoutDraftRevision(revision.parent_revision_id);
    if (target) {
      setRedoRevisionIds((current) => [...current, currentRevisionId]);
    }
  }, [checkoutDraftRevision, revision]);

  const redo = useCallback(async () => {
    if (redoRevisionIds.length === 0) return;
    const targetRevisionId = redoRevisionIds[redoRevisionIds.length - 1];
    const target = await checkoutDraftRevision(targetRevisionId);
    if (target) {
      setRedoRevisionIds((current) => current.slice(0, -1));
    }
  }, [checkoutDraftRevision, redoRevisionIds]);

  const acceptProposal = useCallback(async () => {
    if (!proposal || !revision) return;
    if (proposal.base_revision_id !== revision.revision_id) {
      setProposal(null);
      throw new Error("The proposal is stale. Generate it again from the current revision.");
    }
    await applyCommands(proposal.commands);
    setProposal(null);
  }, [applyCommands, proposal, revision]);

  const startRun = useCallback(async () => {
    if (!graph || !revision) return;
    try {
      const run = await invoke<GraphRun>("orchestrator_start_run", {
        graphId: graph.graph_id,
        revisionId: revision.revision_id
      });
      setActiveRunId(run.run_id);
      setActiveRunRevisionId(run.active_revision_id);
      setActiveRunSeq(run.run_seq);
      setLastRunId(null);
      setRunStatus(run.status);
      setNodeRuns({});
      setEvents([]);
      eventRunRef.current = run.run_id;
      eventCursorRef.current = 0;
      setApprovals([]);
      setArtifacts([]);
    } catch (err: unknown) {
      console.error("Failed to start run:", err);
      setError(taskErrorMessage(err));
    }
  }, [graph, revision]);

  const pollRunProjection = useCallback(async () => {
    if (!activeRunId) return;
    try {
      // 0. If the active run changed since the last poll, reset the cursor and
      // event log BEFORE fetching. Otherwise a stale poll scheduled for the
      // previous run could fire after the switch, ingest the old run's events
      // into the new run's stream, and clobber the cursor ref. (Dedup by
      // event_id in Task 1.5 would not catch this — different runs have
      // disjoint event ids.)
      if (eventRunRef.current !== activeRunId) {
        eventRunRef.current = activeRunId;
        eventCursorRef.current = 0;
        setEvents([]);
      }

      // 1. Fetch new events since the last cursor
      const nextEvents = await invoke<TaskEvent[]>("orchestrator_run_events_after", {
        runId: activeRunId,
        afterSeq: eventCursorRef.current,
      });

      // 2. Decide what to fetch based on the delta
      const plan = planPoll(nextEvents);

      // 3. If there are new events, advance cursor and append
      if (nextEvents.length > 0) {
        eventCursorRef.current = nextEvents[nextEvents.length - 1].run_seq;
        setEvents((current) => {
          const unseen = filterUnseenEvents(current, nextEvents);
          return unseen.length === 0 ? current : [...current, ...unseen];
        });
      }

      // 4. Re-fetch projection only if there are new events
      if (plan.refetchProjection) {
        const projection = await invoke<RunProjection>("orchestrator_get_run_projection", {
          runId: activeRunId,
        });
        setNodeRuns(nodeRunMapFromProjection(projection));
        setRunStatus(projection.status);
        setActiveRunRevisionId(projection.revision_id);
        setActiveRunSeq(projection.run_seq);

        // Terminal-status handling
        if (["completed", "failed", "cancelled"].includes(projection.status)) {
          setLastRunId(activeRunId);
          setActiveRunId(null);
          setActiveRunRevisionId(null);
          setActiveRunSeq(null);
        }
      }

      // 5. Conditionally refresh approvals and artifacts
      if (plan.refreshApprovals || plan.refreshArtifacts) {
        const [nextApprovals, nextArtifacts] = await Promise.all([
          plan.refreshApprovals
            ? invoke<ApprovalRequest[]>("orchestrator_pending_approvals", { runId: activeRunId })
            : Promise.resolve([]),
          plan.refreshArtifacts
            ? invoke<ArtifactRef[]>("orchestrator_list_artifacts", { runId: activeRunId })
            : Promise.resolve([]),
        ]);
        if (plan.refreshApprovals) setApprovals(nextApprovals);
        if (plan.refreshArtifacts) setArtifacts(nextArtifacts);
      }
    } catch (err) {
      console.error("Failed to poll run projection:", err);
    }
  }, [activeRunId]);

  const applyDraftToRun = useCallback(async () => {
    if (
      !activeRunId ||
      !revision ||
      !activeRunRevisionId ||
      activeRunSeq === null ||
      revision.revision_id === activeRunRevisionId
    ) {
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      const revisionProposal = await invoke<RunRevisionProposal>(
        "orchestrator_propose_run_revision",
        {
          runId: activeRunId,
          candidateRevisionId: revision.revision_id,
        },
      );
      const updatedRun = await invoke<GraphRun>("orchestrator_apply_run_revision", {
        runId: activeRunId,
        proposalId: revisionProposal.proposal_id,
        expectedRunSeq: revisionProposal.expected_run_seq,
      });
      setActiveRunRevisionId(updatedRun.active_revision_id);
      setActiveRunSeq(updatedRun.run_seq);
      const projection = await invoke<RunProjection>("orchestrator_get_run_projection", {
        runId: activeRunId,
      });
      setNodeRuns(nodeRunMapFromProjection(projection));
      setRunStatus(projection.status);
      await loadRunDetails(activeRunId);
      return updatedRun;
    } catch (err: unknown) {
      console.error(err);
      setError(taskErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [
    activeRunId,
    activeRunRevisionId,
    activeRunSeq,
    loadRunDetails,
    revision,
  ]);

  const pauseRun = useCallback(async () => {
    if (!activeRunId) return;
    await invoke("orchestrator_pause_run", { runId: activeRunId });
    setRunStatus("paused");
  }, [activeRunId]);

  const resumeRun = useCallback(async () => {
    if (!activeRunId) return;
    await invoke("orchestrator_resume_run", { runId: activeRunId });
    setRunStatus("running");
  }, [activeRunId]);

  const cancelRun = useCallback(async () => {
    if (!activeRunId) return;
    const runId = activeRunId;
    await invoke("orchestrator_cancel_run", { runId });
    await loadRunDetails(runId);
    setRunStatus("cancelled");
    setLastRunId(runId);
    setActiveRunId(null);
    setActiveRunRevisionId(null);
    setActiveRunSeq(null);
  }, [activeRunId, loadRunDetails]);

  const resolveApproval = useCallback(async (approvalId: string, approved: boolean) => {
    await invoke("orchestrator_resolve_approval", { approvalId, approved });
    const runId = activeRunId ?? lastRunId;
    if (runId) {
      await loadRunDetails(runId);
    }
  }, [activeRunId, lastRunId, loadRunDetails]);

  return {
    graph,
    snapshot,
    revision,
    activeRunId,
    activeRunRevisionId,
    displayedRunId: activeRunId ?? lastRunId,
    runStatus,
    nodeRuns,
    events,
    approvals,
    artifacts,
    revisions,
    proposal,
    planning,
    planningProgress,
    loading,
    error,
    loadGraph,
    clearGraph,
    loadLatestGraphForProject,
    createGraph,
    generateProposal,
    acceptProposal,
    dismissProposal: () => setProposal(null),
    applyCommands,
    canUndo: !!revision?.parent_revision_id,
    canRedo: redoRevisionIds.length > 0,
    undo,
    redo,
    startRun,
    applyDraftToRun,
    canApplyDraftToRun:
      !!activeRunId &&
      !!revision &&
      !!activeRunRevisionId &&
      revision.revision_id !== activeRunRevisionId,
    pollRunProjection,
    pauseRun,
    resumeRun,
    cancelRun,
    resolveApproval,
  };
}
