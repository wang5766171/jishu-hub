import type { TaskEvent } from "./use-task-graph";

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
