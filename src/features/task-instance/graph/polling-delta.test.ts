import { describe, it, expect } from "vitest";
import { planPoll, hasApprovalDelta, hasArtifactDelta, filterUnseenEvents, mergeNodeRunsStable } from "./polling-delta";
import type { NodeRun, TaskEvent } from "./use-task-graph";

/** Helper to build a minimal TaskEvent for tests */
function mkEvent(event_id: string, run_seq: number): TaskEvent {
  return {
    event_id,
    run_id: "run1",
    run_seq,
    event_type: "test",
    occurred_at: 1000 + run_seq,
    actor: "system",
    payload: null,
  };
}

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

  describe("filterUnseenEvents", () => {
    it("all incoming new → returns all, order preserved", () => {
      const existing: TaskEvent[] = [mkEvent("e1", 1), mkEvent("e2", 2)];
      const incoming: TaskEvent[] = [mkEvent("e3", 3), mkEvent("e4", 4)];
      const result = filterUnseenEvents(existing, incoming);
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.event_id)).toEqual(["e3", "e4"]);
    });

    it("all incoming already seen → returns empty", () => {
      const existing: TaskEvent[] = [mkEvent("e1", 1), mkEvent("e2", 2)];
      const incoming: TaskEvent[] = [mkEvent("e1", 1), mkEvent("e2", 2)];
      const result = filterUnseenEvents(existing, incoming);
      expect(result).toHaveLength(0);
    });

    it("partial overlap → only unseen returned, order preserved", () => {
      const existing: TaskEvent[] = [mkEvent("e1", 1), mkEvent("e2", 2)];
      const incoming: TaskEvent[] = [mkEvent("e2", 2), mkEvent("e3", 3), mkEvent("e1", 1), mkEvent("e4", 4)];
      const result = filterUnseenEvents(existing, incoming);
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.event_id)).toEqual(["e3", "e4"]);
    });

    it("empty existing → returns all incoming", () => {
      const existing: TaskEvent[] = [];
      const incoming: TaskEvent[] = [mkEvent("e1", 1), mkEvent("e2", 2)];
      const result = filterUnseenEvents(existing, incoming);
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.event_id)).toEqual(["e1", "e2"]);
    });

    it("empty incoming → returns empty", () => {
      const existing: TaskEvent[] = [mkEvent("e1", 1), mkEvent("e2", 2)];
      const incoming: TaskEvent[] = [];
      const result = filterUnseenEvents(existing, incoming);
      expect(result).toHaveLength(0);
    });

    it("order preservation is explicit", () => {
      const existing: TaskEvent[] = [mkEvent("e1", 1), mkEvent("e2", 2)];
      const incoming: TaskEvent[] = [mkEvent("e5", 5), mkEvent("e3", 3), mkEvent("e4", 4)];
      const result = filterUnseenEvents(existing, incoming);
      expect(result.map((e) => e.event_id)).toEqual(["e5", "e3", "e4"]);
    });
  });

  describe("mergeNodeRunsStable", () => {
    function mkNodeRun(nodeId: string, overrides: Partial<NodeRun> = {}): NodeRun {
      return {
        node_run_id: `nr-${nodeId}`,
        run_id: "run1",
        node_id: nodeId,
        status: "running",
        revision_id: "rev1",
        started_at: null,
        finished_at: null,
        attempt_count: 1,
        error: null,
        ...overrides,
      };
    }

    it("完全无变化 → 复用旧 Record 引用", () => {
      const prev: Record<string, NodeRun> = {
        n1: mkNodeRun("n1"),
        n2: mkNodeRun("n2", { status: "succeeded", attempt_count: 2 }),
      };
      // 新一轮 projection 展开出的等价对象（引用不同、逐字段相同）。
      const next: Record<string, NodeRun> = {
        n1: mkNodeRun("n1"),
        n2: mkNodeRun("n2", { status: "succeeded", attempt_count: 2 }),
      };
      expect(mergeNodeRunsStable(prev, next)).toBe(prev);
    });

    it("status 变化 → 返回新对象", () => {
      const prev: Record<string, NodeRun> = { n1: mkNodeRun("n1") };
      const next: Record<string, NodeRun> = { n1: mkNodeRun("n1", { status: "succeeded" }) };
      const merged = mergeNodeRunsStable(prev, next);
      expect(merged).toBe(next);
      expect(merged).not.toBe(prev);
    });

    it("attempt_count 变化 → 返回新对象", () => {
      const prev: Record<string, NodeRun> = { n1: mkNodeRun("n1") };
      const next: Record<string, NodeRun> = { n1: mkNodeRun("n1", { attempt_count: 2 }) };
      expect(mergeNodeRunsStable(prev, next)).toBe(next);
    });

    it("error 变化 → 返回新对象", () => {
      const prev: Record<string, NodeRun> = { n1: mkNodeRun("n1") };
      const next: Record<string, NodeRun> = { n1: mkNodeRun("n1", { error: "boom" }) };
      expect(mergeNodeRunsStable(prev, next)).toBe(next);
    });

    it("node_run_id 变化（重试产生新 node_run）→ 返回新对象", () => {
      const prev: Record<string, NodeRun> = { n1: mkNodeRun("n1") };
      const next: Record<string, NodeRun> = {
        n1: mkNodeRun("n1", { node_run_id: "nr-n1-v2" }),
      };
      expect(mergeNodeRunsStable(prev, next)).toBe(next);
    });

    it("键集合变化（新增/移除节点）→ 返回新对象", () => {
      const prev: Record<string, NodeRun> = { n1: mkNodeRun("n1") };
      const grown: Record<string, NodeRun> = { n1: mkNodeRun("n1"), n2: mkNodeRun("n2") };
      expect(mergeNodeRunsStable(prev, grown)).toBe(grown);
      expect(mergeNodeRunsStable(grown, prev)).toBe(prev);
    });
  });
});
