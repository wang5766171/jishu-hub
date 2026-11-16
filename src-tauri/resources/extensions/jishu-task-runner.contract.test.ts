/**
 * v0.9.8 需求1 测试期修复回归：hub 自带 pi 扩展工具的 execute 返回必须
 * 是 AgentToolResult 对象（content blocks）——裸字符串经 pi agent-loop
 * `content ?? []` 归一后 content 为空数组，模型收不到任何工具结果文本
 * （生产实证：ask_user 两个 toolResult content:[]，模型答完仍「请逐个回答」）。
 * 对照 plugin-invoke / html-preview 的正确写法（已对象形状）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// @earendil-works/pi-ai 经 vitest.config 别名指向 __stubs__/pi-ai.ts（Type 占位构建器）。

import taskRunnerExtension from "./jishu-task-runner";

interface CapturedTool {
  name: string;
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
}

function loadExtension() {
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, unknown>();
  const pi = {
    registerTool: (def: CapturedTool & { name: string }) => tools.set(def.name, def as CapturedTool),
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    appendEntry: vi.fn(),
  };
  taskRunnerExtension(pi as never);
  return { tools, handlers };
}

function makeCtx(answer: string) {
  return {
    sessionManager: {
      getSessionId: () => "sess-contract-test",
      getEntries: () => [] as unknown[],
    },
    ui: {
      select: async (title: string, _options: string[]) => {
        if (title.startsWith("\x00hub_invoke:")) {
          return JSON.stringify({ success: true, data: {} });
        }
        return answer;
      },
    },
  };
}

const isAgentToolResult = (value: unknown, textFragment: string) => {
  expect(typeof value).toBe("object");
  const blocks = (value as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error(`工具结果 content 非非空数组（裸字符串会被 pi 归一为空）: ${JSON.stringify(value)}`);
  }
  expect(blocks[0].type).toBe("text");
  expect(blocks[0].text).toContain(textFragment);
};

describe("jishu-task-runner 工具结果契约（AgentToolResult 对象）", () => {
  let tools: Map<string, CapturedTool>;

  beforeEach(() => {
    ({ tools } = loadExtension());
  });

  it("ask_user：答案经 content blocks 回流（非裸字符串）", async () => {
    const ask = tools.get("ask_user");
    expect(ask).toBeDefined();
    const result = await ask!.execute(
      "call-1",
      { question: "喜欢的颜色？", options: ["蓝色", "红色"] },
      undefined,
      undefined,
      makeCtx("蓝色"),
    );
    isAgentToolResult(result, "用户回答：蓝色");
  });

  it("update_steps：返回对象形状", async () => {
    const update = tools.get("update_steps");
    expect(update).toBeDefined();
    const result = await update!.execute(
      "call-2",
      { goal: "契约测试", steps: [{ id: "s1", title: "步骤一", status: "todo" }] },
      undefined,
      undefined,
      makeCtx(""),
    );
    isAgentToolResult(result, "步骤已更新");
  });

  it("dispatch_to_node：无任务分支同样返回对象形状", async () => {
    const dispatch = tools.get("dispatch_to_node");
    expect(dispatch).toBeDefined();
    const result = await dispatch!.execute(
      "call-3",
      { node_id: "s1", title: "节点一", instruction: "做点事" },
      undefined,
      undefined,
      makeCtx(""),
    );
    isAgentToolResult(result, "任务尚未建立");
  });
});
