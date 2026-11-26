/**
 * 任务会话列表的排序——与普通会话同一口径（2026-11-27 用户裁决）。
 *
 * 普通会话按会话文件的最后活动时间排（最近对话在最前，查看不动位置）。任务
 * 行照此：按任务主会话的最后活动时间排；会话不在列表里（还没发过话）或没有
 * 主会话的任务，按实例的 updated_at 兜底——开跑、状态变化、改步骤这类任务
 * 活动仍会把行顶上去。排序键取两者较大值：哪边更近算哪边。
 *
 * 此前列表按实例 updated_at 排，而打开任务会触发一次运行状态回写把 updated_at
 * 顶到当前时刻——「点开看看」就跳到最前（回写侧已在后端做同态幂等，这里是
 * 排序侧的口径对齐）。
 */
export interface TaskOrderSessionLike {
  id: string;
  last_active?: string | null;
}

export interface TaskOrderTaskLike {
  task_id: string;
  task_session_id?: string | null;
  updated_at: number;
}

function lastActiveMs(session: TaskOrderSessionLike): number {
  if (!session.last_active) return 0;
  const ms = Date.parse(session.last_active);
  return Number.isNaN(ms) ? 0 : ms;
}

/** 任务行的排序键：主会话最后活动与实例 updated_at 取较大（毫秒）。 */
export function taskSessionRecency(
  task: TaskOrderTaskLike,
  sessionLastActive: ReadonlyMap<string, number>,
): number {
  const conversation = task.task_session_id
    ? sessionLastActive.get(task.task_session_id) ?? 0
    : 0;
  return Math.max(conversation, task.updated_at);
}

/**
 * 任务行按最近对话排序（降序）。纯函数、稳定排序：键相同保持传入顺序
 * （后端按 updated_at 倒序给，天然是同名次的兜底顺序）。
 */
export function sortTaskSessionsByConversation<T extends TaskOrderTaskLike>(
  tasks: readonly T[],
  sessions: readonly TaskOrderSessionLike[],
): T[] {
  const sessionLastActive = new Map<string, number>();
  for (const session of sessions) {
    sessionLastActive.set(session.id, lastActiveMs(session));
  }
  return [...tasks].sort(
    (a, b) => taskSessionRecency(b, sessionLastActive) - taskSessionRecency(a, sessionLastActive),
  );
}
