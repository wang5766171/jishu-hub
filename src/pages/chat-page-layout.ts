import { computeStepOrder } from "@/features/task-workspace/steps/compute-step-order";
import type { GraphSnapshot } from "@/features/task-instance/graph/use-task-graph";

export function shouldRenderGlobalChatInput({
  projectId,
  taskModeActive,
}: {
  projectId: string | null | undefined;
  /**
   * T8-P1 起语义收敛为「任务模式下输入无处可发」——即任务已激活但既没有
   * conductor 会话也没有选中节点会话。执行阶段本身**不再**隐藏输入：
   * 用户需要能在会话区让主进程调整流程（需求六）。
   */
  taskModeActive: boolean;
}): boolean {
  return Boolean(projectId) && !taskModeActive;
}

/**
 * 阶段 → 主会话区应展示的会话 id。
 *
 * T8-P1 修复：执行阶段此前返回 null，导致主区被清空成纯白，需求/规划内容全部消失。
 * 需求六要求三段合流在同一条会话流里——执行阶段主区仍然是 conductor 会话
 * （规划会话优先，回退需求会话），只是在其下方追加「流程执行」分隔线与 run 事件流。
 */
export function resolvePhaseSessionId(
  instance: {
    requirement_session_id?: string | null;
    planning_session_id?: string | null;
  } | null | undefined,
  phase: string | null | undefined,
): string | null {
  if (!instance) return null;
  if (phase === "requirements") return instance.requirement_session_id ?? null;
  // planning / execution / graph：优先规划会话（含规划产出），回退需求会话。
  return instance.planning_session_id ?? instance.requirement_session_id ?? null;
}

/**
 * 可执行节点的拓扑执行序（v0.9.2 测试期修复节点顺序，A5 簇③ 随迁布局层）：
 * 依赖波次（同层按 node_id 稳定），过滤 goal/循环节点——此前直接用
 * snapshot.nodes 数组序（= LLM 提交计划的数组顺序），动态修订后顺序错乱。
 */
export function orderExecutableNodes(snapshot: GraphSnapshot | null | undefined): GraphSnapshot["nodes"] {
  if (!snapshot) return [];
  const order = computeStepOrder(snapshot);
  const rank = new Map(order.map((id: string, index: number) => [id, index]));
  return snapshot.nodes
    .filter((node) => node.node_kind.toLowerCase() !== "goal" && !node.loop_config)
    .slice()
    .sort((a, b) => (rank.get(a.node_id) ?? order.length) - (rank.get(b.node_id) ?? order.length));
}
