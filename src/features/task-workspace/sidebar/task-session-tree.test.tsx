/**
 * 任务会话树单测——v0.9.8 评审修复轮 R2（tests/V-用例清单 V6-U5）：
 * 运行中任务行上的「取消执行」走 i18n（原先写死中文，英文界面下露出中文）。
 */
import i18n from "@/i18n";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskSessionTree, type TaskSessionTreeTask } from "./task-session-tree";

const running: TaskSessionTreeTask = { task_id: "t1", title: "整理文档", skill_id: "s", status: "running", run_status: "running" };
const idle: TaskSessionTreeTask = { task_id: "t2", title: "写周报", skill_id: "s", status: "done", run_status: "completed" };

const mount = (onCancelTask = vi.fn()) =>
  render(
    <TaskSessionTree
      tasks={[running, idle]}
      activeTaskId={null}
      onSelectTask={() => undefined}
      onRenameTask={() => undefined}
      onDeleteTask={() => undefined}
      onCancelTask={onCancelTask}
    />,
  );

afterEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("任务行悬停取消", () => {
  it("「取消执行」走 i18n：中英文各有文案——V6-U5", async () => {
    const utils = mount();
    expect(utils.container.querySelector('[title="取消执行"]')).toBeTruthy();
    await i18n.changeLanguage("en");
    utils.unmount();
    const english = mount();
    expect(english.container.querySelector('[title="Cancel run"]')).toBeTruthy();
    expect(english.container.querySelector('[title="取消执行"]')).toBeNull();
  });

  it("只有运行中的任务行有取消入口；点了取消的是这一条任务", () => {
    const onCancelTask = vi.fn();
    const { container } = mount(onCancelTask);
    const controls = container.querySelectorAll('[title="取消执行"]');
    expect(controls).toHaveLength(1);
    fireEvent.click(controls[0]);
    expect(onCancelTask).toHaveBeenCalledWith(running);
  });
});
