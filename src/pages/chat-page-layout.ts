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
