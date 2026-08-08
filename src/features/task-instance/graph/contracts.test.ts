import { describe, expect, it } from "vitest";
import {
  INTERVENTION_MODES,
  NODE_RUN_STATUSES,
  approvalResolutionDraftSchema,
  getInterventionModeForStatus,
  toBackendApprovalResolution,
} from "./contracts";

describe("task run contracts (approval resolution + node status)", () => {
  it("NODE_RUN_STATUSES covers the full 12-value node run status set", () => {
    // 与后端 orchestrator::domain::run::NodeRunStatus 的 serde snake_case 值同构。
    expect(NODE_RUN_STATUSES).toEqual([
      "blocked",
      "ready",
      "leased",
      "running",
      "awaiting_approval",
      "retry_wait",
      "repairing",
      "succeeded",
      "failed",
      "skipped",
      "cancelled",
      "superseded",
    ]);
  });

  it("getInterventionModeForStatus maps every node run status (switch is exhaustive)", () => {
    // 节点状态 → 干预形态映射（驱动步骤栏状态图标与状态语义）。
    // 若后端新增状态而本表遗漏，此断言会失败（防静默降级）。
    for (const status of NODE_RUN_STATUSES) {
      const mode = getInterventionModeForStatus(status);
      expect(INTERVENTION_MODES).toContain(mode);
    }

    expect(getInterventionModeForStatus("blocked")).toBe("editing");
    expect(getInterventionModeForStatus("ready")).toBe("editing");
    expect(getInterventionModeForStatus("leased")).toBe("queued_intervention");
    expect(getInterventionModeForStatus("running")).toBe("live_steer");
    expect(getInterventionModeForStatus("awaiting_approval")).toBe("approval");
    expect(getInterventionModeForStatus("retry_wait")).toBe("retry_wait");
    expect(getInterventionModeForStatus("repairing")).toBe("repairing");
    expect(getInterventionModeForStatus("succeeded")).toBe("acceptance");
    expect(getInterventionModeForStatus("skipped")).toBe("acceptance");
    expect(getInterventionModeForStatus("failed")).toBe("recovery");
    expect(getInterventionModeForStatus("cancelled")).toBe("historical");
    expect(getInterventionModeForStatus("superseded")).toBe("historical");
  });

  it("approval resolution draft is a frontend-only V1 (comment dropped on backend writeback)", () => {
    const draft = approvalResolutionDraftSchema.parse({
      approval_id: "approval_1",
      decision: "approved",
      comment: "Looks safe to continue.",
    });

    expect(draft.comment).toBe("Looks safe to continue.");
    expect(toBackendApprovalResolution(draft)).toEqual({
      approvalId: "approval_1",
      approved: true,
    });

    const rejected = approvalResolutionDraftSchema.parse({
      approval_id: "approval_2",
      decision: "rejected",
    });
    expect(toBackendApprovalResolution(rejected)).toEqual({
      approvalId: "approval_2",
      approved: false,
    });
  });

  it("approval resolution draft rejects an unknown decision", () => {
    expect(() =>
      approvalResolutionDraftSchema.parse({
        approval_id: "approval_1",
        decision: "maybe",
      }),
    ).toThrow();
  });
});
