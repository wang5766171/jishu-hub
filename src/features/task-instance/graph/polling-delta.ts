import type { NodeRun, TaskEvent } from "./use-task-graph";

const APPROVAL_EVENT_TYPES = new Set(["approval_requested", "approval_resolved"]);
const ARTIFACT_EVENT_TYPES = new Set(["artifact_produced"]);

export function hasApprovalDelta(events: TaskEvent[]): boolean {
  return events.some((e) => APPROVAL_EVENT_TYPES.has(e.event_type));
}

export function hasArtifactDelta(events: TaskEvent[]): boolean {
  return events.some((e) => ARTIFACT_EVENT_TYPES.has(e.event_type));
}

export interface PollPlan {
  /** Re-fetch the projection — only when there are new events. */
  refetchProjection: boolean;
  /** Refresh pending approvals — only on approval-relevant deltas. */
  refreshApprovals: boolean;
  /** Refresh artifacts — only on artifact-relevant deltas. */
  refreshArtifacts: boolean;
}

/** Decide what a poll should fetch, given the new events since the last cursor.
 *  Idle (no new events) => fetch nothing. */
export function planPoll(deltaEvents: TaskEvent[]): PollPlan {
  if (deltaEvents.length === 0) {
    return { refetchProjection: false, refreshApprovals: false, refreshArtifacts: false };
  }
  return {
    refetchProjection: true,
    refreshApprovals: hasApprovalDelta(deltaEvents),
    refreshArtifacts: hasArtifactDelta(deltaEvents),
  };
}

/** Deduplicate incoming events against existing events by event_id.
 *  Returns only incoming events whose event_id is NOT already in the existing list.
 *  Preserves the original order of the incoming array. Used before appending events
 *  to state to prevent double-rendering when the same event_id appears in multiple
 *  fetch batches (e.g., cursor overlap or race during run-switch). */
export function filterUnseenEvents(existing: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  const seenIds = new Set(existing.map((e) => e.event_id));
  return incoming.filter((e) => !seenIds.has(e.event_id));
}

/** 引用稳定化合并（F1）：新旧 nodeRuns 逐键浅比较
 *  （node_run_id/status/attempt_count/error 四字段 + 键集合），完全无变化则
 *  复用旧 Record 对象——避免下游 frozenNodeIds 等派生每轮轮询都新建。 */
export function mergeNodeRunsStable(
  prev: Record<string, NodeRun>,
  next: Record<string, NodeRun>,
): Record<string, NodeRun> {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return next;
  for (const key of nextKeys) {
    const p = prev[key];
    const n = next[key];
    if (
      !p ||
      p.node_run_id !== n.node_run_id ||
      p.status !== n.status ||
      p.attempt_count !== n.attempt_count ||
      p.error !== n.error
    ) {
      return next;
    }
  }
  return prev;
}
