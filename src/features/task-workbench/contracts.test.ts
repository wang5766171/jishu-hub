import { describe, expect, it } from "vitest";
import {
  NODE_RUN_STATUSES,
  approvalResolutionDraftSchema,
  getInterventionModeForStatus,
  publicConversationCardSchema,
  toBackendApprovalResolution,
} from "./contracts";

describe("task workbench contracts", () => {
  it("covers every node run status in the intervention matrix", () => {
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

  it("rejects public cards containing forbidden internal fields", () => {
    expect(() =>
      publicConversationCardSchema.parse({
        card_type: "summary",
        card_id: "card_1",
        node_id: "node_1",
        timestamp: 1,
        payload: {
          summary_text: "Implemented the export flow.",
          raw_thinking: "private chain of thought",
        },
      }),
    ).toThrow(/forbidden public projection field/i);

    expect(() =>
      publicConversationCardSchema.parse({
        card_type: "tool",
        card_id: "card_2",
        node_id: "node_1",
        timestamp: 2,
        payload: {
          tool_name: "read_file",
          input_summary: "Read the route file",
          nested: {
            internal_prompt: "system prompt",
          },
        },
      }),
    ).toThrow(/forbidden public projection field/i);
  });

  it("keeps approval comments as a frontend-only V1 draft", () => {
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
  });
});
