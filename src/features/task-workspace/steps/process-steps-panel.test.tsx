/**
 * 执行面板顶部的运行状态词面（RS-U6）：面板原本就显示产品词面；运行状态词面
 * 收敛成一处（run-status-label）之后，面板的词面不变——没有运行时仍是「待执行」。
 */
import i18n from "@/i18n";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RunStatusValue } from "@/features/task-instance/graph/use-task-graph";
import { ProcessStepsPanel } from "./process-steps-panel";

const mount = (runStatus: RunStatusValue | null) =>
  render(
    <ProcessStepsPanel
      title="整理文档"
      snapshot={null}
      nodeRuns={{}}
      runStatus={runStatus}
      activeRunId={null}
      graphId="g1"
      instanceActiveRunId={null}
      selectedNodeId={null}
      agentNames={{}}
      onSelectNode={() => undefined}
      onStartRun={() => undefined}
      onPauseRun={() => undefined}
      onResumeRun={() => undefined}
      onCancelRun={() => undefined}
    />,
  );

/** 顶部状态行（状态圆点 + 词面）的文字 */
const statusText = (container: HTMLElement) =>
  container.querySelector("span.rounded-full")?.parentElement?.textContent ?? "";

afterEach(async () => {
  // 先卸载再切回中文：挂着的组件会在语言切换时重渲染（测试之外的状态更新）
  cleanup();
  await i18n.changeLanguage("zh");
});

describe("执行面板顶部的运行状态词面", () => {
  it.each([
    [null, "待执行"],
    ["running", "执行中"],
    ["paused", "已暂停"],
    ["awaiting_human", "等待审批"],
    ["completed", "已完成"],
    ["failed", "失败"],
    ["cancelled", "已取消"],
  ] as const)("运行状态 %s → %s", (runStatus, label) => {
    const { container } = mount(runStatus);
    expect(statusText(container)).toBe(label);
  });

  it("英文界面下待执行显示 Pending", async () => {
    await i18n.changeLanguage("en");
    const { container } = mount(null);
    expect(statusText(container)).toBe("Pending");
  });
});
