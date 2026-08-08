/**
 * contracts —— 执行治理面的状态→干预形态契约（S9 重建）。
 *
 * 设计依据：`01-详细设计.md` §8.3（contracts.ts 为「保留迁移」项）、§12（干预形态）。
 *           `10-实施现状订正与后续路线图.md` §3.5.4 S9：`e245ab54` 删 task-workbench 时
 *           连带删了 161 行 contracts（含 `getInterventionModeForStatus` 整张映射表），
 *           本文件按 B3.5 范围重建——正是 S2 治理面 UI 决定「该给用户什么干预」的依据。
 *
 * 范围说明：原 contracts.ts 还含 `publicConversationCardSchema`（公开投影卡片契约），
 * 那属于「会话卡片化」特性，非 B3.5（执行治理面）范围，暂不重建，待该特性批次落地。
 */
import { z } from "zod";

/**
 * 节点运行状态全集。**必须与后端 `orchestrator::domain::run::NodeRunStatus` 的 serde
 * snake_case 值一致**，且与 `use-task-graph.ts` 的 `NodeRunStatus` 类型同构。
 * 此处作为契约的权威常量；`contracts.test.ts` 断言其覆盖 getInterventionModeForStatus 的全部分支。
 */
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

export type NodeRunStatusContract = (typeof NODE_RUN_STATUSES)[number];

/**
 * 干预形态——决定治理面在该状态下向用户呈现什么交互。
 *
 * | mode | 出现于 status | 治理面表现 |
 * |---|---|---|
 * | editing | blocked/ready | 可编辑（run-前编排） |
 * | queued_intervention | leased | 已排队，干预排队中 |
 * | live_steer | running | 可实时 steer（@steer） |
 * | approval | awaiting_approval | 审批卡（approve/reject） |
 * | retry_wait | retry_wait | 重试等待 + recovery 按钮 |
 * | repairing | repairing | 修复子图进行中 |
 * | acceptance | succeeded/skipped | 验收态（只读） |
 * | recovery | failed | recovery 按钮（retry_now/skip_node/fail_node） |
 * | historical | cancelled/superseded | 历史归档（只读） |
 */
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

export type InterventionMode = (typeof INTERVENTION_MODES)[number];

/**
 * 状态→干预形态映射。治理面据此决定渲染审批卡 / recovery 按钮 / 只读等。
 * `contracts.test.ts` 断言 NODE_RUN_STATUSES 每一项都有显式映射（switch 穷尽）。
 */
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

// ── 审批决策草稿（前端 V1）──
// 设计 §8.3：审批 comment 当前是前端 V1 草稿字段（后端 resolve_approval 暂只收
// approval_id + approved）。schema 约束决策枚举与注释长度，回写时丢弃 comment。

export const approvalResolutionDraftSchema = z.object({
  approval_id: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().trim().max(2000).optional(),
});

export type ApprovalResolutionDraft = z.infer<typeof approvalResolutionDraftSchema>;

/** 后端 resolve_approval IPC 实际接收的载荷（camelCase）。前端在轮询到 pending approval 时静默自动通过（全自动执行，无人工治理面）。 */
export interface BackendApprovalResolution {
  approvalId: string;
  approved: boolean;
}

/** 把前端草稿转为后端 IPC 载荷（丢弃 comment）。 */
export function toBackendApprovalResolution(
  draft: ApprovalResolutionDraft,
): BackendApprovalResolution {
  return {
    approvalId: draft.approval_id,
    approved: draft.decision === "approved",
  };
}
