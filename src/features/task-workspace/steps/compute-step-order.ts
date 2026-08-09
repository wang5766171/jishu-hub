/**
 * 流程步骤排序（拓扑序）。
 *
 * 设计依据：`docs/task-exec-dev/02-总体设计.md` §4.2 步骤序计算。
 *
 * 要求：
 * 1. Kahn 拓扑排序（依赖边 source→target 表示 source 先于 target 执行）
 * 2. 同层（入度同时归零的节点）内按 node_id 稳定排序，避免步骤栏抖动
 * 3. 环 / 孤立节点兜底追加到末尾（不抛错——画布允许草稿态存在环校验前的状态）
 * 4. 纯函数，同一输入多次调用结果完全一致
 */

import type { GraphSnapshot } from "@/features/task-instance/graph/use-task-graph";

/**
 * 计算步骤的拓扑执行顺序，返回有序的 node_id 数组。
 *
 * @param snapshot 流程图快照（nodes + edges）。edges 的 source→target 语义为"source 先执行"。
 * @param layoutPositions 可选的布局坐标（来自 computeLayout）。若提供，同层内按 y 坐标
 *   再按 x 排序，使步骤栏顺序与画布从上到下、从左到右的视觉一致；不提供则只按 node_id。
 * @returns 有序 node_id 数组。环中的节点按 node_id 排序追加到末尾。
 */
export function computeStepOrder(
  snapshot: GraphSnapshot | null | undefined,
  layoutPositions?: Record<string, { x: number; y: number }> | null,
): string[] {
  if (!snapshot || snapshot.nodes.length === 0) return [];

  const nodeIds = snapshot.nodes.map((n) => n.node_id);
  const nodeSet = new Set(nodeIds);

  // 邻接表 + 入度（仅统计目标节点存在于图中的边）
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    inDegree.set(id, 0);
  }
  for (const edge of snapshot.edges) {
    // 只处理两端都在图中的 control_dependency / data_dependency 边
    if (!nodeSet.has(edge.source_node_id) || !nodeSet.has(edge.target_node_id)) continue;
    adjacency.get(edge.source_node_id)!.push(edge.target_node_id);
    inDegree.set(edge.target_node_id, (inDegree.get(edge.target_node_id) ?? 0) + 1);
  }

  // Kahn 算法：同层按 (layout y → layout x → node_id) 稳定排序
  // 用数组当优先队列（节点数通常 <100，排序开销可忽略）
  const result: string[] = [];
  const remaining = new Set(nodeIds);
  let currentLayer: string[] = [];

  const collectZeroInDegree = (): string[] => {
    const layer: string[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) === 0) {
        layer.push(id);
      }
    }
    return sortLayer(layer);
  };

  /**
   * 同层排序：优先 layout y（画布从上到下），其次 layout x（从左到右），最后 node_id 兜底。
   * 保证同一快照多次计算结果一致。
   */
  const sortLayer = (layer: string[]): string[] => {
    return layer.sort((a, b) => {
      const pa = layoutPositions?.[a];
      const pb = layoutPositions?.[b];
      if (pa && pb) {
        if (Math.abs(pa.y - pb.y) > 1) return pa.y - pb.y;
        if (Math.abs(pa.x - pb.x) > 1) return pa.x - pb.x;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    });
  };

  currentLayer = collectZeroInDegree();

  while (currentLayer.length > 0) {
    for (const id of currentLayer) {
      remaining.delete(id);
      result.push(id);
      // 松弛后继入度
      for (const next of adjacency.get(id) ?? []) {
        const deg = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, deg);
      }
    }
    currentLayer = collectZeroInDegree();
  }

  // 环中剩余节点：按 node_id 稳定排序后追加到末尾（不抛错）
  if (remaining.size > 0) {
    const cycleNodes = Array.from(remaining).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    result.push(...cycleNodes);
  }

  return result;
}

/**
 * 计算可执行步骤节点数（排除 goal/group 根节点）。
 *
 * 与 `process-steps-panel` 的 `stepNodeIds` 过滤同口径，避免步骤数显示与步骤栏不一致。
 * 设计依据：v0.7.0 需求二-问题1（规划 N 节点显示 N+1 步骤，根因是未过滤 Goal 根节点）。
 *
 * @param snapshot 流程图快照。undefined/null 时返回 0。
 * @returns 排除 goal/group 后的节点数。
 */
export function countExecutableSteps(
  snapshot: GraphSnapshot | null | undefined,
): number {
  if (!snapshot) return 0;
  return snapshot.nodes.filter(
    (n) => n.node_kind !== "goal" && n.node_kind !== "group",
  ).length;
}
