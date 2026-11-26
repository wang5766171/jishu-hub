/**
 * v0.9.8 需求22（评审修复轮 R2 / C4）：工具审批扩展的「跳过逐次确认」按
 * 会话——只对本任务是任务会话、且该任务开了「不询问」的会话生效。开关以
 * hub 的任务登记为准（每轮开始时经 hubInvoke 问一次），不再读 Pi
 * settings.json 的全局键。
 *
 * 环境隔离：扩展在模块加载时按 `PI_CODING_AGENT_DIR` 定位 settings.json，
 * 所以先把它指到临时目录再动态加载。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

interface HubCall {
  command: string;
  params: Record<string, unknown>;
}

let agentRoot = "";
let handlers: Map<string, unknown>;

const hubAnswer = (data: unknown) => ({ success: true, data });
const TASK_ON = { enabled: [], taskSession: true, taskId: "task-123", noAsk: true };
const TASK_OFF = { enabled: [], taskSession: true, taskId: "task-123", noAsk: false };
const PLAIN = { enabled: [], taskSession: false, taskId: null, noAsk: false };

async function loadExtension(toolApproval: string) {
  agentRoot = mkdtempSync(join(tmpdir(), "jishu-approval-ext-"));
  mkdirSync(join(agentRoot, "agent"));
  // settings.json 里故意留着旧的全局键 taskNoAsk: true——模拟公司电脑现场：
  // 修复后它不该再有任何作用。
  writeFileSync(
    join(agentRoot, "agent", "settings.json"),
    JSON.stringify({ toolApproval, taskNoAsk: true }),
  );
  process.env.PI_CODING_AGENT_DIR = agentRoot;
  const factory = (await import("./jishu-tool-approval")).default;
  handlers = new Map();
  factory({
    on: (event: string, handler: unknown) => handlers.set(event, handler),
  } as never);
}

function makeCtx(hubReply: unknown, calls: HubCall[] = []) {
  const confirms: string[] = [];
  return {
    confirms,
    sessionManager: { getSessionId: () => "sess-approval" },
    ui: {
      select: async (title: string) => {
        if (title.startsWith("\x00hub_invoke:")) {
          calls.push(JSON.parse(title.slice("\x00hub_invoke:".length)) as HubCall);
          return hubReply === null ? null : JSON.stringify(hubReply);
        }
        return null;
      },
      confirm: async (title: string) => {
        confirms.push(title);
        return true;
      },
    },
  };
}

/** 跑一轮开始 + 一次工具调用，返回：是否弹了确认、审批请求标题。 */
async function approveOnce(hubReply: unknown, calls: HubCall[] = []) {
  const ctx = makeCtx(hubReply, calls);
  const decision = await (handlers.get("tool_call") as Handler)(
    { toolName: "bash", input: { command: "npm test" } },
    ctx,
  );
  return { confirms: ctx.confirms, decision };
}

describe("jishu-tool-approval 不询问按会话（需求22）", () => {
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    if (agentRoot) rmSync(agentRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await loadExtension("smart");
  });

  it("本任务开了不询问：不弹确认直接放行（NA-G1 / NA-U6 的 A）", async () => {
    await (handlers.get("before_agent_start") as Handler)(
      { systemPrompt: "BASE" },
      makeCtx(hubAnswer(TASK_ON)),
    );
    const { confirms, decision } = await approveOnce(hubAnswer(TASK_ON));
    expect(confirms).toEqual([]);
    expect(decision).toBeUndefined();
  });

  it("任务会话但没开：照常逐次确认", async () => {
    await (handlers.get("before_agent_start") as Handler)(
      { systemPrompt: "BASE" },
      makeCtx(hubAnswer(TASK_OFF)),
    );
    const { confirms } = await approveOnce(hubAnswer(TASK_OFF));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain("[jishu-tool-approval]");
  });

  it("普通会话：照常逐次确认——别处打开的开关不会串过来", async () => {
    await (handlers.get("before_agent_start") as Handler)(
      { systemPrompt: "BASE" },
      makeCtx(hubAnswer(PLAIN)),
    );
    const { confirms } = await approveOnce(hubAnswer(PLAIN));
    expect(confirms).toHaveLength(1);
  });

  it("settings.json 里的旧全局键 taskNoAsk:true 不再有任何作用（NA-U7）", async () => {
    // 前置：临时 settings.json 里 taskNoAsk 就是 true（见 loadExtension）。
    // hub 说本会话没开 / 不是任务会话：仍然逐次确认。
    await (handlers.get("before_agent_start") as Handler)(
      { systemPrompt: "BASE" },
      makeCtx(hubAnswer(PLAIN)),
    );
    expect((await approveOnce(hubAnswer(PLAIN))).confirms).toHaveLength(1);
  });

  it("hub 没回答 / 回答出错：按「要审批」处理", async () => {
    await (handlers.get("before_agent_start") as Handler)(
      { systemPrompt: "BASE" },
      makeCtx(null),
    );
    expect((await approveOnce(null)).confirms).toHaveLength(1);
    await (handlers.get("before_agent_start") as Handler)(
      { systemPrompt: "BASE" },
      makeCtx({ success: false, error: "编排库打不开" }),
    );
    expect((await approveOnce({ success: false, error: "x" })).confirms).toHaveLength(1);
  });

  it("本轮还没问过 hub（回合开始事件未到）：按「要审批」处理", async () => {
    expect((await approveOnce(hubAnswer(TASK_ON))).confirms).toHaveLength(1);
  });

  it("向 hub 的查询带会话身份", async () => {
    const calls: HubCall[] = [];
    await (handlers.get("before_agent_start") as Handler)(
      { systemPrompt: "BASE" },
      makeCtx(hubAnswer(TASK_ON), calls),
    );
    expect(calls).toEqual([
      {
        command: "runner_capability_plugins",
        params: { session_id: "sess-approval", project_root: process.cwd() },
      },
    ]);
  });
});
