import { describe, expect, it } from "vitest";
import { deriveTodoState } from "./todo-board";

/** v0.9.5 需求12：待办状态推导纯函数——快照胜出语义（与 rpiv 回放同源）、
 * subagent 运行计数、批次切分（旧批全部完成后出现新任务 → 新批次）、
 * clear 封批、无 todo 数据返回 null。 */
describe("deriveTodoState", () => {
  const todoResult = (id: string, tasks: unknown[]) => ({
    role: "user",
    blocks: [{ type: "tool_result", id, details: { action: "list", tasks, nextId: tasks.length + 1 } }],
  });
  const clearResult = (id: string) => ({
    role: "user",
    blocks: [{ type: "tool_result", id, details: { action: "clear", tasks: [], nextId: 1 } }],
  });
  const toolUse = (id: string, name: string) => ({
    role: "assistant",
    blocks: [{ type: "tool_use", id, text: name }],
  });
  const resultFor = (id: string) => ({
    role: "user",
    blocks: [{ type: "tool_result", id, output: "done" }],
  });

  it("单批：最后快照状态为准", () => {
    const state = deriveTodoState([
      todoResult("c1", [{ id: 1, subject: "A", status: "pending" }]),
      todoResult("c2", [
        { id: 1, subject: "A", status: "completed" },
        { id: 2, subject: "B", status: "in_progress", activeForm: "写测试" },
      ]),
    ]);
    expect(state?.batches).toHaveLength(1);
    const batch = state?.batches[0] ?? [];
    expect(batch.map((t) => t.subject)).toEqual(["A", "B"]);
    expect(batch[0].status).toBe("completed");
  });

  it("批次切分：旧批全部完成后出现新任务 → 两批（旧批封存新批当前）", () => {
    const state = deriveTodoState([
      todoResult("c1", [
        { id: 1, subject: "批一-1", status: "pending" },
        { id: 2, subject: "批一-2", status: "pending" },
      ]),
      todoResult("c2", [
        { id: 1, subject: "批一-1", status: "completed" },
        { id: 2, subject: "批一-2", status: "completed" },
      ]),
      // 真实用户消息边界（新一轮需求）——批次切换的必要条件
      { role: "user", blocks: [{ type: "text", text: "再来一个新任务" }] },
      todoResult("c3", [
        { id: 1, subject: "批一-1", status: "completed" },
        { id: 2, subject: "批一-2", status: "completed" },
        { id: 3, subject: "批二-1", status: "pending" },
        { id: 4, subject: "批二-2", status: "in_progress" },
      ]),
    ]);
    expect(state?.batches).toHaveLength(2);
    expect(state?.batches[0].map((t) => t.subject)).toEqual(["批一-1", "批一-2"]);
    expect(state?.batches[1].map((t) => t.subject)).toEqual(["批二-1", "批二-2"]);
    expect(state?.batches[1][1].status).toBe("in_progress");
  });

  it("clear 封批：clear 后的新任务归新批", () => {
    const state = deriveTodoState([
      todoResult("c1", [{ id: 1, subject: "旧", status: "in_progress" }]),
      clearResult("c2"),
      todoResult("c3", [{ id: 1, subject: "新", status: "pending" }]),
    ]);
    expect(state?.batches).toHaveLength(2);
    expect(state?.batches[0].map((t) => t.subject)).toEqual(["旧"]);
    expect(state?.batches[1].map((t) => t.subject)).toEqual(["新"]);
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
