import { describe, it, expect } from "vitest";
import { planPoll, hasApprovalDelta, hasArtifactDelta } from "./polling-delta";
import type { TaskEvent } from "./use-task-graph";

describe("polling-delta", () => {
  describe("planPoll", () => {
    it("empty array → all false (idle)", () => {
      const plan = planPoll([]);
      expect(plan).toEqual({
        refetchProjection: false,
        refreshApprovals: false,
        refreshArtifacts: false,
      });
    });

    it("non-relevant events → refetch projection only", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "node_ready",
          occurred_at: 1000,
          actor: "system",
          payload: null,
        },
        {
          event_id: "e2",
          run_id: "r1",
          run_seq: 2,
          event_type: "attempt_progressed",
          occurred_at: 2000,
          actor: "system",
          payload: null,
        },
      ];
      const plan = planPoll(events);
      expect(plan.refetchProjection).toBe(true);
      expect(plan.refreshApprovals).toBe(false);
      expect(plan.refreshArtifacts).toBe(false);
    });

    it("contains approval_requested → refreshApprovals true", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "approval_requested",
          occurred_at: 1000,
          actor: "system",
          payload: null,
        },
      ];
      const plan = planPoll(events);
      expect(plan.refetchProjection).toBe(true);
      expect(plan.refreshApprovals).toBe(true);
      expect(plan.refreshArtifacts).toBe(false);
    });

    it("contains approval_resolved → refreshApprovals true", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "approval_resolved",
          occurred_at: 1000,
          actor: "user",
          payload: null,
        },
      ];
      const plan = planPoll(events);
      expect(plan.refetchProjection).toBe(true);
      expect(plan.refreshApprovals).toBe(true);
      expect(plan.refreshArtifacts).toBe(false);
    });

    it("contains artifact_produced → refreshArtifacts true", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "artifact_produced",
          occurred_at: 1000,
          actor: "system",
          payload: null,
        },
      ];
      const plan = planPoll(events);
      expect(plan.refetchProjection).toBe(true);
      expect(plan.refreshApprovals).toBe(false);
      expect(plan.refreshArtifacts).toBe(true);
    });

    it("mixed approval and artifact events → both true", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "node_ready",
          occurred_at: 1000,
          actor: "system",
          payload: null,
        },
        {
          event_id: "e2",
          run_id: "r1",
          run_seq: 2,
          event_type: "approval_requested",
          occurred_at: 2000,
          actor: "system",
          payload: null,
        },
        {
          event_id: "e3",
          run_id: "r1",
          run_seq: 3,
          event_type: "artifact_produced",
          occurred_at: 3000,
          actor: "system",
          payload: null,
        },
      ];
      const plan = planPoll(events);
      expect(plan.refetchProjection).toBe(true);
      expect(plan.refreshApprovals).toBe(true);
      expect(plan.refreshArtifacts).toBe(true);
    });
  });

  describe("hasApprovalDelta", () => {
    it("returns false for empty array", () => {
      expect(hasApprovalDelta([])).toBe(false);
    });

    it("returns false for non-approval events", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "node_ready",
          occurred_at: 1000,
          actor: "system",
          payload: null,
        },
      ];
      expect(hasApprovalDelta(events)).toBe(false);
    });

    it("returns true for approval_requested", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "approval_requested",
          occurred_at: 1000,
          actor: "system",
          payload: null,
        },
      ];
      expect(hasApprovalDelta(events)).toBe(true);
    });

    it("returns true for approval_resolved", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "approval_resolved",
          occurred_at: 1000,
          actor: "user",
          payload: null,
        },
      ];
      expect(hasApprovalDelta(events)).toBe(true);
    });
  });

  describe("hasArtifactDelta", () => {
    it("returns false for empty array", () => {
      expect(hasArtifactDelta([])).toBe(false);
    });

    it("returns false for non-artifact events", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "node_ready",
          occurred_at: 1000,
          actor: "system",
          payload: null,
        },
      ];
      expect(hasArtifactDelta(events)).toBe(false);
    });

    it("returns true for artifact_produced", () => {
      const events: TaskEvent[] = [
        {
          event_id: "e1",
          run_id: "r1",
          run_seq: 1,
          event_type: "artifact_produced",
          occurred_at: 1000,
          actor: "system",
          payload: null,
        },
      ];
      expect(hasArtifactDelta(events)).toBe(true);
    });
  });
});
