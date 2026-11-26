/**
 * 流程看板顶栏的运行状态（RS-U5）：显示产品词面，不显示后端取值原文
 * （此前顶栏直接显示 completed / running）。
 *
 * 没有流程图时画布区只有一个空态提示，顶栏照常渲染——用例借这条分支只测顶栏。
 */
import i18n from "@/i18n";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RunStatusValue } from "@/features/task-instance/graph/use-task-graph";
import { FlowBoardOverlay } from "./flow-board-overlay";

const mount = (runStatus: RunStatusValue | null) =>
  render(
    <FlowBoardOverlay
      taskTitle="整理文档"
      graphId={null}
      runStarted={runStatus !== null}
      runStatus={runStatus}
      onClose={() => undefined}
      taskGraph={{} as never}
    />,
  );

/** 顶栏（返回钮、标题、模式、运行状态）上的全部文字 */
const headerText = (container: HTMLElement) => container.querySelector("div.h-12")?.textContent ?? "";

afterEach(async () => {
  // 先卸载再切回中文：挂着的组件会在语言切换时重渲染（测试之外的状态更新）
  cleanup();
  await i18n.changeLanguage("zh");
});

describe("流程看板顶栏的运行状态", () => {
  it("流程跑完的任务显示「已完成」，不显示内部取值——RS-U5", () => {
    const { container } = mount("completed");
    expect(headerText(container)).toContain("已完成");
    expect(headerText(container)).not.toMatch(/\bcompleted\b/);
  });

  it("英文界面显示 Completed", async () => {
    await i18n.changeLanguage("en");
    const { container } = mount("completed");
    expect(headerText(container)).toContain("Completed");
  });

  it("五种运行状态各是各的词面；等待审批也有词面", () => {
    const expected: Array<[RunStatusValue, string]> = [
      ["running", "执行中"],
      ["paused", "已暂停"],
      ["awaiting_human", "等待审批"],
      ["completed", "已完成"],
      ["failed", "失败"],
      ["cancelled", "已取消"],
    ];
    for (const [status, label] of expected) {
      const { container, unmount } = mount(status);
      expect(headerText(container), status).toContain(label);
      expect(headerText(container), status).not.toContain(status);
      unmount();
    }
  });

  it("没有运行状态时顶栏不显示状态", () => {
    const { container } = mount(null);
    expect(headerText(container)).not.toMatch(/已完成|待执行|Completed/);
  });
});
