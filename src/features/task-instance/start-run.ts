/**
 * startTaskRun —— 启动任务执行（run）的唯一调用点。
 *
 * 背景（T8-P1）：执行启动此前只存在于右侧步骤栏 / 流程画布。需求六「三段合流」要求
 * 会话区也能弹出「是否开始执行」并直接启动，于是把 invoke 细节抽到本模块，
 * 由 TaskSidebar 与 chat-page 会话区共用，避免两份 idempotency_key 拼装逻辑漂移。
 */
import { invokeCommand } from "@/hooks/use-invoke";

export interface StartTaskRunParams {
  taskId: string;
  projectRoot: string;
  revisionId: string;
}

export interface StartTaskRunResult {
  status: string;
  run_id: string;
}

export async function startTaskRun(
  params: StartTaskRunParams,
): Promise<StartTaskRunResult | null> {
  return invokeCommand<StartTaskRunResult>("task_launch_start_run", {
    request: {
      task_id: params.taskId,
      project_root: params.projectRoot,
      revision_id: params.revisionId,
      // 同一 revision 重复点击只会命中同一 run（后端幂等），避免双开。
      idempotency_key: `ui-${params.taskId}-${params.revisionId}`,
    },
  });
}
