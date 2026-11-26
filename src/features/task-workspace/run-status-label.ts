/**
 * 运行状态的统一词面——任务行末尾的标记、流程看板顶栏、执行面板共用这一份。
 *
 * 运行状态是后端的内部取值（running / completed …），界面上只以产品词面出现。
 * 此前词面只写在执行面板里，任务行与看板顶栏各自把取值原文直接显示了出来
 * （中文界面露出 completed）。
 *
 * 没有运行状态、或取值不认识 → null，由调用处决定显示什么（任务行与看板顶栏
 * 不显示，执行面板显示「待执行」）。
 */
import type { TFunction } from "i18next";

export function runStatusLabel(t: TFunction, runStatus: string | null | undefined): string | null {
  switch (runStatus) {
    case "running":
      return t("task.run.running", "执行中");
    case "paused":
      return t("task.run.paused", "已暂停");
    case "awaiting_human":
      return t("task.run.awaitingHuman", "等待审批");
    case "completed":
      return t("task.run.completed", "已完成");
    case "failed":
      return t("task.run.failed", "失败");
    case "cancelled":
      return t("task.run.cancelled", "已取消");
    default:
      return null;
  }
}
