/**
 * 任务会话树单测——v0.9.8 评审修复轮 R2（tests/V-用例清单 V6-U5）：
 * 运行中任务行上的「取消执行」走 i18n（原先写死中文，英文界面下露出中文）。
 *
 * 任务行末尾的运行结果标记（RS-U1/U2，2026-11-27 用户裁决「会话列表不需要
 * 显示这个状态」）：任何运行状态下任务行都不显示标记，界面上也不出现运行
 * 状态的内部取值（completed / running …——此前直接原样显示在行尾）。
 */
import i18n from "@/i18n";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
  // 先卸载再切回中文：挂着的组件会在语言切换时重渲染（测试之外的状态更新）
  cleanup();
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

describe("任务行末尾的运行结果标记", () => {
  let seq = 0;
  const row = (run_status: string | null | undefined): TaskSessionTreeTask => {
    seq += 1;
    // 标题里不带英文状态词：下面要断言「界面上没有这些词」，标题不能自己撞上
    return { task_id: `t${seq}`, title: `任务${seq}`, skill_id: "s", status: "active", run_status };
  };
  const mountRows = (tasks: TaskSessionTreeTask[]) =>
    render(
      <TaskSessionTree
        tasks={tasks}
        activeTaskId={null}
        onSelectTask={() => undefined}
        onRenameTask={() => undefined}
        onDeleteTask={() => undefined}
      />,
    );

  it("任何运行状态下任务行都不显示标记——RS-U1", () => {
    const { container } = mountRows([
      row("running"),
      row("paused"),
      row("completed"),
      row("failed"),
      row("cancelled"),
      row(null),
    ]);
    expect(container.querySelectorAll("span.rounded-full.px-1")).toHaveLength(0);
  });

  it("界面上不出现运行状态的内部取值——RS-U2", () => {
    const { container } = mountRows([
      row("running"),
      row("paused"),
      row("completed"),
      row("failed"),
      row("cancelled"),
      row(null),
    ]);
    // 逐个文字节点取、中间夹分隔符再匹配：整段文字里标记是紧跟在标题后面的
    // （「任务1completed」），带词边界的匹配会因此落空
    const texts: string[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      texts.push(node.textContent ?? "");
    }
    expect(texts.length).toBeGreaterThan(6);
    expect(texts.join(" | ")).not.toMatch(
      /\b(running|paused|completed|failed|cancelled|awaiting_human)\b/,
    );
  });
});
