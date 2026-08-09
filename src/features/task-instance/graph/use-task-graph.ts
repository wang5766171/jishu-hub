import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { Message } from "@/types";
import { planPoll, filterUnseenEvents, mergeNodeRunsStable } from "./polling-delta";
import { eventToMessage } from "../run-event-messages";

export type JsonObject = Record<string, unknown>;

interface TaskError {
  code?: string;
  message_key?: string;
  remediation?: string | null;
}

export function taskErrorMessage(error: unknown): string {
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

/**
 * Run 级状态。**必须与后端 `orchestrator::domain::run::RunStatus` 保持一致**
 * （该枚举带 `#[serde(rename_all = "snake_case")]`，故线上值为下划线小写）。
 *
 * 历史坑：此前 runStatus 类型为裸 `string`，`phase-execution-view.tsx` 误按
 * PascalCase 比较（"Running"/"Paused"/"Completed"），导致暂停/恢复按钮永不显示、
 * 状态徽章恒显"待执行"，而 TypeScript 结构上无法报错。改为联合类型以防复发。
 */
export type RunStatusValue =
  | "draft"
  | "validating"
  | "ready"
  | "running"
  | "paused"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "cancelled";

/** Run 终态（不可再流转）。 */
export const TERMINAL_RUN_STATUSES: readonly RunStatusValue[] = [
  "completed",
  "failed",
  "cancelled",
];

const RUN_STATUS_VALUES: readonly RunStatusValue[] = [
  "draft",
  "validating",
  "ready",
  "running",
  "paused",
  "awaiting_human",
  "completed",
  "failed",
  "cancelled",
];

/**
 * 把 IPC 返回的裸字符串收敛为 `RunStatusValue`。
 * 未知值返回 null 并告警——后端新增变体时能被发现，而非静默降级。
 */
export function normalizeRunStatusValue(raw: string | null | undefined): RunStatusValue | null {
  if (!raw) return null;
  if ((RUN_STATUS_VALUES as readonly string[]).includes(raw)) {
    return raw as RunStatusValue;
  }
  console.warn(`[use-task-graph] 未知 run status: ${raw}（前端 RunStatusValue 需同步后端 RunStatus）`);
  return null;
}

/** run 是否已进入终态。 */
export function isTerminalRunStatus(status: RunStatusValue | null | undefined): boolean {
  return status != null && TERMINAL_RUN_STATUSES.includes(status);
}

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
    | "awaiting_input"
    | "validating"
    | "retrying"
    | "building_proposal"
    | "completed"
    | "failed";
  attempt: number | null;
  max_attempts: number | null;
  text?: string;
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
  const { t } = useTranslation();
  const [graph, setGraph] = useState<TaskGraph | null>(null);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [revision, setRevision] = useState<GraphRevision | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunRevisionId, setActiveRunRevisionId] = useState<string | null>(null);
  const [activeRunSeq, setActiveRunSeq] = useState<number | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatusValue | null>(null);
  const [nodeRuns, setNodeRuns] = useState<Record<string, NodeRun>>({});
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([]);
  const [revisions, setRevisions] = useState<GraphRevision[]>([]);
  const [redoRevisionIds, setRedoRevisionIds] = useState<string[]>([]);
  const [proposal, setProposal] = useState<GraphProposal | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planningProgress, setPlanningProgress] = useState<PlanningProgress | null>(null);
  const [planningText, setPlanningText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 最近一次 apply_commands 返回的 RevisionDiff（编排反馈面展示「本次改了什么」）。
  const [lastDiff, setLastDiff] = useState<RevisionDiff | null>(null);
  const eventRunRef = useRef<string | null>(null);
  const eventCursorRef = useRef(0);
  // T8-P1b：自动审批已处理的 approval_id 集合（防重）。用户要求去掉人工审批、全自动执行，
  // 轮询到 pending approval 时前端自动通过，避免卡在审批 gate（此前点击"开始执行"即卡死的根因）。
  const autoApprovedRef = useRef<Set<string>>(new Set());

  // F1：轮询路径统一走同值跳变，runStatus 无变化时不触发下游重渲染。
  const setRunStatusStable = useCallback((next: RunStatusValue | null) => {
    setRunStatus((prev) => (prev === next ? prev : next));
  }, []);

  // 节点标题映射：事件 payload 多数只带 node_id，但 attempt_started 等只带 node_run_id
  //（见 events/mod.rs AttemptStartedPayload —— 无 node_id 字段），需同时按 node_run_id 建索引，
  // 否则这类事件会回退成裸 node_run_id（如 nr_9d…）。nodeRuns 提供 node_run_id↔node_id 关联。
  const nodeTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    if (snapshot) {
      for (const n of snapshot.nodes) map.set(n.node_id, n.title);
    }
    for (const run of Object.values(nodeRuns)) {
      if (run.node_run_id && run.node_id) {
        const title = map.get(run.node_id);
        if (title) map.set(run.node_run_id, title);
      }
    }
    return map;
  }, [snapshot, nodeRuns]);
  const nodeCount = snapshot?.nodes.length ?? 0;

  // F1：主任务会话消息由统一轮询维护的 events 派生（替代已下线的 useRunEventStream）。
  // T8-P1b：投影为主对话口吻（驱动/监控/汇总），传入节点标题与 run 收尾汇总计数。
  const projectedMessages = useMemo(() => {
    const resolved = events.filter((e) => e.event_type === "node_resolved");
    const summary = {
      succeeded: resolved.filter((e) => (e.payload as { final_status?: string })?.final_status === "succeeded").length,
      failed: resolved.filter((e) => (e.payload as { final_status?: string })?.final_status === "failed").length,
    };
    return events
      .map((event) => eventToMessage(event, t, nodeTitleMap, { nodeCount, summary }))
      .filter((m): m is Message => m !== null);
  }, [events, t, nodeTitleMap, nodeCount]);

  useEffect(() => {
    if (!graph?.graph_id) return;
    const graphId = graph.graph_id;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<PlanningProgress>("task-planning-progress", (event) => {
      if (!disposed && event.payload.graph_id === graphId) {
        setPlanningProgress(event.payload);
        if (event.payload.text) {
          setPlanningText((prev) => prev + event.payload.text);
        }
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

  // T8-P1b：自动审批。用户要求去掉人工审批、全自动执行。轮询到 pending approval 时
  // 前端自动通过（记录已处理 id 防重），让流程不被审批 gate 卡死。
  const autoApprovePending = useCallback((pending: ApprovalRequest[]) => {
    for (const a of pending) {
      if (autoApprovedRef.current.has(a.approval_id)) continue;
      autoApprovedRef.current.add(a.approval_id);
      invoke("orchestrator_resolve_approval", { approvalId: a.approval_id, approved: true })
        .catch((err) => console.warn("auto-approve failed", err));
    }
  }, []);

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
    autoApprovePending(nextApprovals);
    setArtifacts(nextArtifacts);
  }, [autoApprovePending]);

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
    setRunStatusStable(normalizeRunStatusValue(displayed?.status));
    if (!displayed) {
      setNodeRuns({});
      setEvents([]);
        setArtifacts([]);
      return;
    }
    const projection = await invoke<RunProjection>("orchestrator_get_run_projection", {
      runId: displayed.run_id,
    });
    setNodeRuns((current) => mergeNodeRunsStable(current, nodeRunMapFromProjection(projection)));
    await loadRunDetails(displayed.run_id);
  }, [loadRunDetails, setRunStatusStable]);

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
    let stoppedByUser = false;
    setPlanning(true);
    setPlanningText("");
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
      const message = taskErrorMessage(err);
      if (message.includes("planner turn was stopped by user")) {
        stoppedByUser = true;
        setPlanningProgress({
          graph_id: graph.graph_id,
          stage: "awaiting_input",
          attempt: null,
          max_attempts: 2,
        });
        return null;
      }
      console.error(err);
      setError(message);
      throw err;
    } finally {
      setPlanning(false);
      if (!stoppedByUser) {
        setPlanningProgress(null);
      }
    }
  }, [graph, revision]);

  const applyCommands = useCallback(async (commands: GraphCommand[]): Promise<RevisionDiff | null> => {
    if (!graph || !revision) return null;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<{ revision: GraphRevision; diff: RevisionDiff | null }>("orchestrator_apply_commands", {
        graphId: graph.graph_id,
        expectedRevisionId: revision.revision_id,
        commands,
        author: "local_user"
      });

      const newRev = result.revision as GraphRevision;
      setRevision(newRev);
      setSnapshot(snapshotFromRevision(newRev));
      // 后端返回本次编排的 RevisionDiff（此前被类型注解丢弃），留作编排反馈面展示。
      setLastDiff(result.diff ?? null);

      // Update graph draft ref
      setGraph(g => g ? { ...g, current_draft_revision: newRev.revision_id } : null);
      setRevisions((current) => [...current, newRev]);
      setRedoRevisionIds([]);
      return result.diff ?? null;
    } catch (err: unknown) {
      console.error(err);
      setError(taskErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [graph, revision]);

  /// S6 前端 DAG 预校验（设计 §12 双重拦截）：提交前 dry-run 校验命令，返回结构化告警
  /// （空数组 = 合法）。与后端 apply_commands 内的 graph_validate 互为双保险。
  const validateCommands = useCallback(async (commands: GraphCommand[]): Promise<string[]> => {
    if (!revision) return [];
    try {
      return await invoke<string[]>("orchestrator_validate_commands", {
        revisionId: revision.revision_id,
        commands,
      });
    } catch (err: unknown) {
      // 校验本身失败（如 revision 不存在）按一处错误上报，不阻塞调用方主流程。
      console.error(err);
      return [taskErrorMessage(err)];
    }
  }, [revision]);

  /// 取两个 revision 之间的 RevisionDiff（编排反馈面 / Revision 历史对比）。
  const getDiff = useCallback(async (fromRevisionId: string, toRevisionId: string): Promise<RevisionDiff | null> => {
    try {
      return await invoke<RevisionDiff>("orchestrator_get_diff", {
        fromRevisionId,
        toRevisionId,
      });
    } catch (err: unknown) {
      console.error(err);
      return null;
    }
  }, []);

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

  const acceptProposal = useCallback(async (selectedCommandIds?: string[]) => {
    if (!proposal || !revision) return;
    if (proposal.base_revision_id !== revision.revision_id) {
      setProposal(null);
      throw new Error("The proposal is stale. Generate it again from the current revision.");
    }
    // §12.5: user may accept all or part of a proposal. Filter to the selected
    // command ids (default: all). An empty selection just dismisses the proposal.
    const selected = selectedCommandIds
      ? proposal.commands.filter((command) => selectedCommandIds.includes(command.command_id))
      : proposal.commands;
    if (selected.length > 0) {
      await applyCommands(selected);
    }
    setProposal(null);
  }, [applyCommands, proposal, revision]);

  // F1 统一轮询（修 B-1/B-6）：本函数由下方轮询 effect 驱动，不再对外导出。
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
        // 引用稳定化：nodeRuns 无实质变化时复用旧对象（frozenNodeIds 等派生不重建）。
        setNodeRuns((current) => mergeNodeRunsStable(current, nodeRunMapFromProjection(projection)));
        const polledStatus = normalizeRunStatusValue(projection.status);
        setRunStatusStable(polledStatus);
        setActiveRunRevisionId(projection.revision_id);
        setActiveRunSeq(projection.run_seq);

        // Terminal-status handling
        if (isTerminalRunStatus(polledStatus)) {
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
        if (plan.refreshApprovals) {
          autoApprovePending(nextApprovals);
        }
        if (plan.refreshArtifacts) setArtifacts(nextArtifacts);
      }
    } catch (err) {
      console.error("Failed to poll run projection:", err);
    }
  }, [activeRunId, setRunStatusStable, autoApprovePending]);

  // F1 轮询主循环：有活跃 run（非终态）时每秒拉增量事件 → planPoll → 按需拉
  // projection。终态由 pollRunProjection 内清 activeRunId，本 effect 随之停止。
  // 空载（无新事件）时本轮零 setState、零额外 IPC。
  useEffect(() => {
    if (!activeRunId) return;
    pollRunProjection().catch(console.error);
    const timer = setInterval(() => {
      pollRunProjection().catch(console.error);
    }, 1000);
    return () => clearInterval(timer);
  }, [activeRunId, pollRunProjection]);

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
      setNodeRuns((current) => mergeNodeRunsStable(current, nodeRunMapFromProjection(projection)));
      setRunStatusStable(normalizeRunStatusValue(projection.status));
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
    setRunStatusStable,
  ]);

  const pauseRun = useCallback(async () => {
    if (!activeRunId) return;
    await invoke("orchestrator_pause_run", { runId: activeRunId });
    setRunStatus("paused");
  }, [activeRunId]);

  const resumeRun = useCallback(async () => {
    // v0.7.0：run 进入终态后 activeRunId 被清空（pollRunProjection L833），但 lastRunId
    // 保留了最后的 run id。用 displayedRunId（activeRunId ?? lastRunId）恢复执行，
    // resume 后重新设 activeRunId 启动轮询，让节点状态实时更新。
    const runId = activeRunId ?? lastRunId;
    if (!runId) return;
    await invoke("orchestrator_resume_run", { runId });
    setActiveRunId(runId);
    setRunStatus("running");
  }, [activeRunId, lastRunId]);

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
    projectedMessages,
    artifacts,
    revisions,
    proposal,
    planning,
    planningProgress,
    planningText,
    loading,
    error,
    lastDiff,
    loadGraph,
    clearGraph,
    loadLatestGraphForProject,
    createGraph,
    generateProposal,
    acceptProposal,
    dismissProposal: () => setProposal(null),
    applyCommands,
    validateCommands,
    getDiff,
    canUndo: !!revision?.parent_revision_id,
    canRedo: redoRevisionIds.length > 0,
    undo,
    redo,
    applyDraftToRun,
    canApplyDraftToRun:
      !!activeRunId &&
      !!revision &&
      !!activeRunRevisionId &&
      revision.revision_id !== activeRunRevisionId,
    pauseRun,
    resumeRun,
    cancelRun,
  };
}
