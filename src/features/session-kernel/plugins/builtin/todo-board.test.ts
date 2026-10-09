import { describe, expect, it } from "vitest";
import { deriveTodoState } from "./todo-board";

/** v0.9.5 需求12：待办状态推导纯函数——快照胜出语义（与 rpiv 回放同源）、
 * subagent 运行计数、无 todo 数据返回 null。 */
describe("deriveTodoState", () => {
  const todoResult = (id: string, tasks: unknown[]) => ({
    role: "user",
    blocks: [{ type: "tool_result", id, details: { action: "list", tasks, nextId: tasks.length + 1 } }],
  });
  const toolUse = (id: string, name: string) => ({
    role: "assistant",
    blocks: [{ type: "tool_use", id, text: name }],
  });
  const resultFor = (id: string) => ({
    role: "user",
    blocks: [{ type: "tool_result", id, output: "done" }],
  });

  it("最后 todo 快照胜出（多次调用取最新）", () => {
    const state = deriveTodoState([
      todoResult("c1", [{ id: 1, subject: "A", status: "pending" }]),
      todoResult("c2", [
        { id: 1, subject: "A", status: "completed" },
        { id: 2, subject: "B", status: "in_progress", activeForm: "写测试" },
      ]),
    ]);
    expect(state?.tasks).toHaveLength(2);
    expect(state?.tasks[0].status).toBe("completed");
    expect(state?.tasks[1].subject).toBe("B");
  });

  it("subagent 未配对 result 计数运行中；配对后清零", () => {
    const running = deriveTodoState([
      toolUse("s1", "subagent"),
      toolUse("s2", "subagent"),
      todoResult("c1", [{ id: 1, subject: "x", status: "in_progress" }]),
    ]);
    expect(running?.subagentsRunning).toBe(2);
    const settled = deriveTodoState([
      toolUse("s1", "subagent"),
      resultFor("s1"),
      todoResult("c1", [{ id: 1, subject: "x", status: "completed" }]),
    ]);
    expect(settled?.subagentsRunning).toBe(0);
  });

  it("非 todo 工具的 details（无 tasks 字段）不干扰；无 todo 返回 null", () => {
    const none = deriveTodoState([
      toolUse("r1", "read"),
      { role: "user", blocks: [{ type: "tool_result", id: "r1", details: { foo: 1 } }] },
    ]);
    expect(none).toBeNull();
  });
});
