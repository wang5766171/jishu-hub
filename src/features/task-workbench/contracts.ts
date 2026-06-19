import { z } from "zod";

export const NODE_RUN_STATUSES = [
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
] as const;

export const nodeRunStatusSchema = z.enum(NODE_RUN_STATUSES);
export type NodeRunStatusContract = z.infer<typeof nodeRunStatusSchema>;

export const INTERVENTION_MODES = [
  "editing",
  "queued_intervention",
  "live_steer",
  "approval",
  "retry_wait",
  "repairing",
  "acceptance",
  "recovery",
  "historical",
] as const;

export const interventionModeSchema = z.enum(INTERVENTION_MODES);
export type InterventionMode = z.infer<typeof interventionModeSchema>;

export function getInterventionModeForStatus(
  status: NodeRunStatusContract,
): InterventionMode {
  switch (status) {
    case "blocked":
    case "ready":
      return "editing";
    case "leased":
      return "queued_intervention";
    case "running":
      return "live_steer";
    case "awaiting_approval":
      return "approval";
    case "retry_wait":
      return "retry_wait";
    case "repairing":
      return "repairing";
    case "succeeded":
    case "skipped":
      return "acceptance";
    case "failed":
      return "recovery";
    case "cancelled":
    case "superseded":
      return "historical";
  }
}

export const STEER_DELIVERY_RESULTS = [
  "delivered",
  "queued",
  "downgraded_to_follow_up",
  "unsupported",
  "failed",
] as const;

export const steerDeliveryResultSchema = z.enum(STEER_DELIVERY_RESULTS);
export type SteerDeliveryResult = z.infer<typeof steerDeliveryResultSchema>;

export const PUBLIC_CARD_TYPES = [
  "summary",
  "tool",
  "approval",
  "diff",
  "artifact",
  "warning",
  "error",
] as const;

export const publicCardTypeSchema = z.enum(PUBLIC_CARD_TYPES);
export type PublicCardType = z.infer<typeof publicCardTypeSchema>;

const forbiddenPublicProjectionFields = new Set([
  "raw_thinking",
  "rawThinking",
  "internal_prompt",
  "internalPrompt",
  "private_contract",
  "privateContract",
  "stack_trace",
  "stackTrace",
]);

function findForbiddenPublicField(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findForbiddenPublicField(item);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbiddenPublicProjectionFields.has(key)) return key;
    const nested = findForbiddenPublicField(nestedValue);
    if (nested) return nested;
  }
  return null;
}

export const publicConversationCardSchema = z
  .object({
    card_type: publicCardTypeSchema,
    card_id: z.string().min(1),
    node_id: z.string().min(1).nullable().optional(),
    timestamp: z.number().nonnegative(),
    payload: z.record(z.string(), z.unknown()),
  })
  .superRefine((card, ctx) => {
    const forbiddenField = findForbiddenPublicField(card.payload);
    if (!forbiddenField) return;
    ctx.addIssue({
      code: "custom",
      path: ["payload", forbiddenField],
      message: `Forbidden public projection field: ${forbiddenField}`,
    });
  });

export type PublicConversationCard = z.infer<
  typeof publicConversationCardSchema
>;

export const approvalResolutionDraftSchema = z.object({
  approval_id: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().trim().max(2000).optional(),
});

export type ApprovalResolutionDraft = z.infer<
  typeof approvalResolutionDraftSchema
>;

export interface BackendApprovalResolution {
  approvalId: string;
  approved: boolean;
}

export function toBackendApprovalResolution(
  draft: ApprovalResolutionDraft,
): BackendApprovalResolution {
  return {
    approvalId: draft.approval_id,
    approved: draft.decision === "approved",
  };
}
