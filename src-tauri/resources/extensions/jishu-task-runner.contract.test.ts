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

// ── v0.9.8 需求22（评审修复轮 R2 / C4）：不询问按会话、任务纪律只进任务会话 ──

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

interface HubCall {
  command: string;
  params: Record<string, unknown>;
}

/** hub 对 `runner_capability_plugins` 的回答（`{success, data}` 形状）。 */
const hubAnswer = (data: unknown) => ({ success: true, data });

const TASK_OFF = { enabled: [], taskSession: true, taskId: "task-123", noAsk: false };
const TASK_ON = { enabled: [], taskSession: true, taskId: "task-123", noAsk: true };
const PLAIN = { enabled: [], taskSession: false, taskId: null, noAsk: false };

/** 造 ctx：hub 桥的应答可配（`hubReply === null` = 桥超时没回）；`calls` 记下
 * 扩展发向 hub 的每一次调用。 */
function makeSessionCtx(
  hubReply: unknown,
  calls: HubCall[] = [],
  answer = "蓝色",
) {
  const confirmCalls: string[] = [];
  return {
    confirmCalls,
    sessionManager: {
      getSessionId: () => "sess-contract-test",
      getEntries: () => [] as unknown[],
    },
    ui: {
      select: async (title: string, options: string[]) => {
        if (title.startsWith("\x00hub_invoke:")) {
          calls.push(JSON.parse(title.slice("\x00hub_invoke:".length)) as HubCall);
          return hubReply === null ? null : JSON.stringify(hubReply);
        }
        confirmCalls.push(title);
        return answer;
      },
    },
  };
}

/** 跑一轮 `before_agent_start`，返回注入后的系统提示（undefined = 没有改动）。 */
async function runBeforeAgentStart(hubReply: unknown, calls: HubCall[] = []) {
  const { handlers } = loadExtension();
  const handler = handlers.get("before_agent_start") as Handler;
  const result = await handler({ systemPrompt: "BASE" }, makeSessionCtx(hubReply, calls));
  return (result as { systemPrompt?: string } | void | undefined)?.systemPrompt;
}

describe("jishu-task-runner 任务纪律只注入任务会话（需求22 入口 e）", () => {
  it("普通会话：不注入任务锚点、任务纪律、不询问——系统提示原样", async () => {
    const systemPrompt = await runBeforeAgentStart(hubAnswer(PLAIN));
    expect(systemPrompt).toBeUndefined();
  });

  it("hub 没回答、手里也没有任务号：不注入", async () => {
    expect(await runBeforeAgentStart(null)).toBeUndefined();
    expect(await runBeforeAgentStart({ success: false, error: "boom" })).toBeUndefined();
  });

  it("任务会话、未开不询问：注入锚点与询问版纪律，不含不询问", async () => {
    const systemPrompt = await runBeforeAgentStart(hubAnswer(TASK_OFF));
    expect(systemPrompt).toContain("【任务隔离锚点");
    expect(systemPrompt).toContain("【任务纪律】");
    expect(systemPrompt).not.toContain("不询问模式");
    expect(systemPrompt).toContain("先 ask_user 征得同意");
  });

  it("任务会话、已开不询问：注入不询问版纪律", async () => {
    const systemPrompt = await runBeforeAgentStart(hubAnswer(TASK_ON));
    expect(systemPrompt).toContain("【任务纪律·不询问模式】");
    expect(systemPrompt).toContain("不要向用户提问");
    expect(systemPrompt).not.toContain("先 ask_user 征得同意");
  });

  it("任务号以 hub 的登记为准：第一轮就是真实任务号，不是占位的 draft", async () => {
    const systemPrompt = await runBeforeAgentStart(hubAnswer(TASK_OFF));
    expect(systemPrompt).toContain("当前任务 ID：task-123");
    expect(systemPrompt).not.toContain("draft");
  });

  it("能力查询带上会话身份（会话号 + 项目根）", async () => {
    const calls: HubCall[] = [];
    await runBeforeAgentStart(hubAnswer(TASK_ON), calls);
    expect(calls).toEqual([
      {
        command: "runner_capability_plugins",
        params: { session_id: "sess-contract-test", project_root: process.cwd() },
      },
    ]);
  });

  it("引用格式是通用规则，不再跟着任务纪律走（由 session-context 给所有会话）", async () => {
    const systemPrompt = await runBeforeAgentStart(hubAnswer(TASK_ON));
    expect(systemPrompt).not.toContain("【引用格式】");
  });
});

describe("jishu-task-runner ask_user 按会话的开关提问或放行", () => {
  async function askUser(hubReply: unknown) {
    const { tools, handlers } = loadExtension();
    await (handlers.get("before_agent_start") as Handler)(
      { systemPrompt: "BASE" },
      makeSessionCtx(hubReply),
    );
    const ask = tools.get("ask_user");
    const ctx = makeSessionCtx(hubReply);
    const result = await ask!.execute(
      "call-ask",
      { question: "喜欢的颜色？", options: ["蓝色", "红色"] },
      undefined,
      undefined,
      ctx,
    );
    return { result, asked: ctx.confirmCalls };
  }

  it("未开启的会话：照常提问，结果以「用户回答：」开头（NA-U3）", async () => {
    const { result, asked } = await askUser(hubAnswer(TASK_OFF));
    isAgentToolResult(result, "用户回答：蓝色");
    expect(asked).toEqual(["喜欢的颜色？"]);
  });

  it("普通会话：照常提问——不会被别处打开的开关放行", async () => {
    const { result, asked } = await askUser(hubAnswer(PLAIN));
    isAgentToolResult(result, "用户回答：蓝色");
    expect(asked).toEqual(["喜欢的颜色？"]);
  });

  it("开启的会话：不弹问答，按推荐执行（NA-U4）", async () => {
    const { result, asked } = await askUser(hubAnswer(TASK_ON));
    isAgentToolResult(result, "（不询问模式）已按你的推荐执行：蓝色");
    expect(asked).toEqual([]);
  });

  it("hub 没回答：按「要提问」处理", async () => {
    const { result, asked } = await askUser(null);
    isAgentToolResult(result, "用户回答：蓝色");
    expect(asked).toEqual(["喜欢的颜色？"]);
  });

  it("提问类工具的硬拦截只跟着本会话的开关", async () => {
    const toolCall = async (hubReply: unknown, toolName: string) => {
      const { handlers } = loadExtension();
      await (handlers.get("before_agent_start") as Handler)(
        { systemPrompt: "BASE" },
        makeSessionCtx(hubReply),
      );
      return (handlers.get("tool_call") as Handler)(
        { toolName, input: { question: "继续吗？" } },
        makeSessionCtx(hubReply),
      );
    };
    const blocked = await toolCall(hubAnswer(TASK_ON), "ask_user_question");
    expect(blocked).toMatchObject({ block: true });
    // 普通会话、未开启的任务会话：不拦。
    expect(await toolCall(hubAnswer(PLAIN), "ask_user_question")).toBeUndefined();
    expect(await toolCall(hubAnswer(TASK_OFF), "ask_user_question")).toBeUndefined();
  });
});

// ── v0.9.8 评审修复轮 R3：跨轮缓存（P1-2 不询问每轮重算；P2-11 hub 没回答时的任务会话） ──

/** 同一个扩展实例跨多轮用：hub 的应答可以在两轮之间改（`setReply`），
 * `reply === null` = 桥超时没回。 */
function makeTurnCtx(initialReply: unknown, entries: unknown[] = []) {
  const turns = { reply: initialReply as unknown };
  const confirmCalls: string[] = [];
  const ctx = {
    confirmCalls,
    sessionManager: {
      getSessionId: () => "sess-contract-test",
      getEntries: () => entries,
    },
    ui: {
      select: async (title: string, _options: string[]) => {
        if (title.startsWith("\x00hub_invoke:")) {
          return turns.reply === null ? null : JSON.stringify(turns.reply);
        }
        confirmCalls.push(title);
        return "蓝色";
      },
    },
  };
  return { ctx, setReply: (reply: unknown) => (turns.reply = reply) };
}

const systemPromptOf = (result: unknown) =>
  (result as { systemPrompt?: string } | void | undefined)?.systemPrompt;

/** 会话文件里上一轮留下的任务状态（custom 条目）。 */
const persistedTask = {
  type: "custom",
  customType: "jishu-task-runner",
  data: { taskId: "task-123", goal: "", steps: [] },
};

describe("jishu-task-runner 跨轮缓存（评审修复轮 R3）", () => {
  it("同一扩展实例：先「任务会话 + 开」，后「不是任务会话」——不询问复位", async () => {
    const { handlers, tools } = loadExtension();
    const before = handlers.get("before_agent_start") as Handler;
    const { ctx, setReply } = makeTurnCtx(hubAnswer(TASK_ON));

    expect(systemPromptOf(await before({ systemPrompt: "BASE" }, ctx))).toContain(
      "【任务纪律·不询问模式】",
    );
    // 同一实例的下一轮：hub 说本会话不是任务会话（比如任务已删除、这是分支出来的会话）。
    setReply(hubAnswer(PLAIN));
    expect(systemPromptOf(await before({ systemPrompt: "BASE" }, ctx))).toBeUndefined();

    // ask_user 照常提问，结果以「用户回答：」开头。
    const ask = tools.get("ask_user");
    const result = await ask!.execute(
      "call-ask",
      { question: "喜欢的颜色？", options: ["蓝色", "红色"] },
      undefined,
      undefined,
      ctx,
    );
    isAgentToolResult(result, "用户回答：蓝色");
    expect(ctx.confirmCalls).toEqual(["喜欢的颜色？"]);
    // 提问类工具不再被拦。
    const toolCall = handlers.get("tool_call") as Handler;
    expect(
      await toolCall({ toolName: "ask_user_question", input: { question: "继续吗？" } }, ctx),
    ).toBeUndefined();
  });

  it("同一扩展实例：先「任务会话 + 开」，后 hub 没回答——不询问按关", async () => {
    const { handlers, tools } = loadExtension();
    const before = handlers.get("before_agent_start") as Handler;
    const { ctx, setReply } = makeTurnCtx(hubAnswer(TASK_ON));
    await before({ systemPrompt: "BASE" }, ctx);

    setReply(null);
    const systemPrompt = systemPromptOf(await before({ systemPrompt: "BASE" }, ctx));
    // 仍是任务会话（锚点在），但不询问按关。
    expect(systemPrompt).toContain("【任务隔离锚点");
    expect(systemPrompt).toContain("先 ask_user 征得同意");
    expect(systemPrompt).not.toContain("不询问模式");

    const ask = tools.get("ask_user");
    const result = await ask!.execute(
      "call-ask",
      { question: "喜欢的颜色？", options: ["蓝色", "红色"] },
      undefined,
      undefined,
      ctx,
    );
    isAgentToolResult(result, "用户回答：蓝色");
    expect(ctx.confirmCalls).toEqual(["喜欢的颜色？"]);
    const toolCall = handlers.get("tool_call") as Handler;
    expect(
      await toolCall({ toolName: "ask_user_question", input: { question: "继续吗？" } }, ctx),
    ).toBeUndefined();
  });

  it("hub 没回答、但会话里已有任务号：仍是任务会话（锚点与询问版纪律），不询问按关", async () => {
    const { handlers, tools } = loadExtension();
    // 会话恢复：从会话文件里读回上一轮的任务号（hub 这时也没回答状态查询）。
    await (handlers.get("session_start") as Handler)(
      {},
      makeTurnCtx(null, [persistedTask]).ctx,
    );
    const { ctx } = makeTurnCtx(null, [persistedTask]);
    const systemPrompt = systemPromptOf(
      await (handlers.get("before_agent_start") as Handler)({ systemPrompt: "BASE" }, ctx),
    );
    expect(systemPrompt).toContain("【任务隔离锚点");
    expect(systemPrompt).toContain("当前任务 ID：task-123");
    expect(systemPrompt).toContain("【任务纪律】");
    expect(systemPrompt).toContain("先 ask_user 征得同意");
    expect(systemPrompt).not.toContain("不询问模式");

    const ask = tools.get("ask_user");
    const result = await ask!.execute(
      "call-ask",
      { question: "喜欢的颜色？", options: ["蓝色", "红色"] },
      undefined,
      undefined,
      ctx,
    );
    isAgentToolResult(result, "用户回答：蓝色");
    expect(ctx.confirmCalls).toEqual(["喜欢的颜色？"]);
  });

  it("hub 说过「不是任务会话」，之后又没回答：不会变回任务会话", async () => {
    const { handlers } = loadExtension();
    const before = handlers.get("before_agent_start") as Handler;
    await (handlers.get("session_start") as Handler)(
      {},
      makeTurnCtx(null, [persistedTask]).ctx,
    );
    const { ctx, setReply } = makeTurnCtx(hubAnswer(PLAIN), [persistedTask]);

    expect(systemPromptOf(await before({ systemPrompt: "BASE" }, ctx))).toBeUndefined();
    setReply(null);
    expect(
      systemPromptOf(await before({ systemPrompt: "BASE" }, ctx)),
      "hub 已经说了不是任务会话：一次没回答不该把它变回去",
    ).toBeUndefined();
  });
});
